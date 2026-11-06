use crate::failure::{Failure, Outcome};
use crate::http::{Body, Head, Incoming, Messages, Request};
use crate::sync::Locked;
use futures_channel::oneshot;
use ntex::io::Io;
use ntex::time::{Deadline, Millis};
use ntex::ws::{CloseCode, CloseReason, Message};
use std::{
    collections::HashMap,
    future::{Future, poll_fn},
    pin::pin,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU32, Ordering},
    },
    task::Poll,
    time::{Duration, Instant},
};

const HEAD_LIMIT: u64 = 64 * 1024;
const READ: usize = 64 * 1024;
const HANDSHAKE: Duration = Duration::from_secs(30);
const CLOSING: Duration = Duration::from_secs(5);
const READY: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_millis(50);
const FRAMING: &[&str] = &["connection", "content-length", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "host"];
const HANDSHAKE_HEADERS: &[&str] =
    &["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "sec-websocket-accept"];

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Head { status: u16, status_text: String, headers: Vec<(String, String)> },
    Chunk(Vec<u8>),
    End,
    Open { protocol: String, extensions: String },
    Text(String),
    Binary(Vec<u8>),
    Close { code: u16, reason: String, clean: bool },
    Error(String),
}

pub(crate) trait Events: Send + Sync + 'static {
    fn emit(&self, event: Event) -> impl Future<Output = bool> + Send;
}

pub type Deliver = Arc<dyn Fn(Event, oneshot::Sender<()>) -> bool + Send + Sync>;

struct Delivered(Deliver);

impl Events for Delivered {
    async fn emit(&self, event: Event) -> bool {
        let (taken, wait) = oneshot::channel();
        (self.0)(event, taken) && wait.await.is_ok()
    }
}

impl Events for async_channel::Sender<Event> {
    async fn emit(&self, event: Event) -> bool {
        self.send(event).await.is_ok()
    }
}

enum Stop {
    Gone,
    Failed(String),
}

impl<E: std::fmt::Display> From<E> for Stop {
    fn from(error: E) -> Self {
        Self::Failed(error.to_string())
    }
}

async fn connect(socket: &str) -> std::result::Result<Io, String> {
    let until = Instant::now() + READY;
    loop {
        let error = match ntex::rt::unix_connect(socket, ntex::SharedCfg::default()).await {
            Ok(io) => return Ok(io),
            Err(error) => error,
        };
        let waiting = matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused)
            && std::path::Path::new(socket).parent().is_some_and(std::path::Path::is_dir);
        if !waiting || Instant::now() >= until {
            return Err(format!("cannot connect to {socket}: {error}"));
        }
        ntex::time::sleep(RETRY).await;
    }
}

fn is_token(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn target(socket: &str, path: &str) -> Outcome<()> {
    if !socket.starts_with('/') || socket.contains('\0') {
        return Err(Failure::invalid("socket must be an absolute path"));
    }
    if !path.starts_with('/') || !path.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(Failure::invalid("path must start with / and be visible ASCII (percent-encoded)"));
    }
    Ok(())
}

fn headers(pairs: Vec<Vec<String>>, owned: &[&[&str]]) -> Outcome<(String, Vec<(String, String)>)> {
    let mut host = "localhost".to_owned();
    let mut kept = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let Ok([name, value]) = <[String; 2]>::try_from(pair) else {
            return Err(Failure::invalid("a header must be [name, value]"));
        };
        if !is_token(&name) {
            return Err(Failure::invalid(format!("bad header name {name:?}")));
        }
        if value.contains(['\r', '\n', '\0']) {
            return Err(Failure::invalid(format!("bad value of header {name}")));
        }
        let lower = name.to_ascii_lowercase();
        if lower == "host" {
            host = value.trim().to_owned();
        } else if !owned.iter().any(|list| list.contains(&lower.as_str())) {
            kept.push((name, value.trim().to_owned()));
        }
    }
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(Failure::invalid("bad Host header"));
    }
    Ok((host, kept))
}

pub(crate) struct Exchange {
    socket: String,
    method: String,
    path: String,
    host: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

impl Exchange {
    fn new(socket: String, method: String, path: String, pairs: Vec<Vec<String>>, body: Option<Vec<u8>>) -> Outcome<Self> {
        target(&socket, &path)?;
        if !is_token(&method) {
            return Err(Failure::invalid("method must be an HTTP token"));
        }
        let (host, headers) = headers(pairs, &[FRAMING])?;
        Ok(Self { socket, method, path, host, headers, body })
    }

    async fn run(self, events: &impl Events) {
        if let Err(Stop::Failed(message)) = self.exchange(events).await {
            events.emit(Event::Error(message)).await;
        }
    }

    async fn exchange(&self, events: &impl Events) -> std::result::Result<(), Stop> {
        let io = connect(&self.socket).await?;
        let request = Request {
            method: &self.method,
            path: &self.path,
            host: &self.host,
            headers: self.headers.iter().map(|(name, value)| (name.as_str(), value.clone())).collect(),
            body: self.body.as_deref(),
        };
        let queued = io.encode_slice(&request.encode());
        let send = async {
            queued?;
            io.flush(true).await
        };
        let receive = async {
            let head = loop {
                let head = Head::read(&io, HEAD_LIMIT).await?;
                match head.status {
                    101 => return Err(Stop::Failed("the server switched protocols".into())),
                    100..=199 => continue,
                    _ => break head,
                }
            };
            let framing = head.framing(&self.method)?;
            let Head { status, reason, headers } = head;
            if !events.emit(Event::Head { status, status_text: reason, headers }).await {
                return Err(Stop::Gone);
            }
            let (mut body, mut buffer) = (Body::new(framing), vec![0; READ]);
            while let Some(read) = body.next(&io, &mut buffer).await? {
                if !events.emit(Event::Chunk(buffer[..read].to_vec())).await {
                    return Err(Stop::Gone);
                }
            }
            if !events.emit(Event::End).await {
                return Err(Stop::Gone);
            }
            Ok(())
        };
        let (sent, received) = futures_lite::future::zip(send, receive).await;
        match (sent, received) {
            (Err(error), Err(Stop::Failed(_))) => Err(Stop::Failed(format!("sending the request failed: {error}"))),
            (_, received) => received,
        }
    }
}

pub(crate) struct Upgrade {
    socket: String,
    path: String,
    host: String,
    headers: Vec<(String, String)>,
    protocols: Vec<String>,
}

enum Command {
    Send(Message),
    Close(Option<CloseReason>),
}

enum Step {
    Frame(std::result::Result<Option<Incoming>, String>),
    Command(Option<Command>),
    Timeout,
}

impl Upgrade {
    fn new(socket: String, path: String, pairs: Vec<Vec<String>>, protocols: Vec<String>) -> Outcome<Self> {
        target(&socket, &path)?;
        let (host, headers) = headers(pairs, &[FRAMING, HANDSHAKE_HEADERS])?;
        for (i, protocol) in protocols.iter().enumerate() {
            if !is_token(protocol) || protocols[..i].contains(protocol) {
                return Err(Failure::invalid(format!("bad or repeated protocol {protocol:?}")));
            }
        }
        Ok(Self { socket, path, host, headers, protocols })
    }

    async fn handshake(&self) -> std::result::Result<(Io, String), String> {
        let key = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(rand::random::<[u8; 16]>())
        };
        let mut headers = vec![
            ("Connection", "Upgrade".to_owned()),
            ("Upgrade", "websocket".to_owned()),
            ("Sec-WebSocket-Version", "13".to_owned()),
            ("Sec-WebSocket-Key", key.clone()),
        ];
        if !self.protocols.is_empty() {
            headers.push(("Sec-WebSocket-Protocol", self.protocols.join(", ")));
        }
        headers.extend(self.headers.iter().map(|(name, value)| (name.as_str(), value.clone())));
        let request = Request { method: "GET", path: &self.path, host: &self.host, headers, body: None };
        let io = connect(&self.socket).await?;
        let sent = io.encode_slice(&request.encode());
        match sent {
            Ok(()) => io.flush(true).await,
            Err(error) => Err(error),
        }
        .map_err(|error| format!("sending the handshake failed: {error}"))?;
        let head = Head::read(&io, HEAD_LIMIT).await.map_err(|error| format!("bad handshake response: {error}"))?;
        if head.status != 101 {
            return Err(format!("the server answered {} {} instead of switching to WebSocket", head.status, head.reason).trim_end().to_owned());
        }
        let has = |name: &str, token: &str| head.header(name).is_some_and(|value| value.split(',').any(|v| v.trim().eq_ignore_ascii_case(token)));
        if !has("upgrade", "websocket") || !has("connection", "upgrade") {
            return Err("the server's handshake has no Upgrade: websocket / Connection: Upgrade".into());
        }
        let accept = ntex::ws::hash_key(key.as_bytes()).map_err(|error| error.to_string())?;
        if head.header("sec-websocket-accept") != Some(accept.as_str()) {
            return Err("the server's Sec-WebSocket-Accept does not match the key".into());
        }
        let protocol = head.header("sec-websocket-protocol").unwrap_or_default().to_owned();
        if !protocol.is_empty() && !self.protocols.contains(&protocol) {
            return Err(format!("the server chose protocol {protocol:?}, which was not offered"));
        }
        if head.header("sec-websocket-extensions").is_some_and(|value| !value.trim().is_empty()) {
            return Err("the server chose an extension that was not offered".into());
        }
        Ok((io, protocol))
    }

    async fn run(self, commands: async_channel::Receiver<Command>, events: &impl Events) {
        let opened = ntex::time::timeout(HANDSHAKE, self.handshake()).await.unwrap_or_else(|()| Err("the WebSocket handshake timed out".into()));
        let (io, protocol) = match opened {
            Ok(opened) => opened,
            Err(message) => {
                if events.emit(Event::Error(message)).await {
                    events.emit(Event::Close { code: 1006, reason: String::new(), clean: false }).await;
                }
                return;
            }
        };
        if !events.emit(Event::Open { protocol, extensions: String::new() }).await {
            return;
        }
        let codec = Messages::codec();
        let mut messages = Messages::default();
        let mut commands = Some(commands);
        let mut deadline = Deadline::new(Millis::ZERO);
        let (mut armed, mut sent) = (false, false);
        let mut received: Option<Option<CloseReason>> = None;
        let arm = |deadline: &mut Deadline, armed: &mut bool| {
            if !std::mem::replace(armed, true) {
                deadline.reset(CLOSING);
            }
        };
        let end = loop {
            let step = {
                let mut frame = pin!(messages.next(&io, &codec));
                let mut command = pin!(async {
                    let Some(commands) = &commands else { return std::future::pending().await };
                    if io.write_ready().await.is_err() {
                        return None;
                    }
                    commands.recv().await.ok()
                });
                poll_fn(|cx| {
                    if let Poll::Ready(frame) = frame.as_mut().poll(cx) {
                        return Poll::Ready(Step::Frame(frame));
                    }
                    if let Poll::Ready(command) = command.as_mut().poll(cx) {
                        return Poll::Ready(Step::Command(command));
                    }
                    if armed && deadline.poll_elapsed(cx).is_ready() {
                        return Poll::Ready(Step::Timeout);
                    }
                    Poll::Pending
                })
                .await
            };
            match step {
                Step::Frame(Ok(Some(Incoming::Text(text)))) if received.is_none() => {
                    if !events.emit(Event::Text(text)).await {
                        return;
                    }
                }
                Step::Frame(Ok(Some(Incoming::Binary(data)))) if received.is_none() => {
                    if !events.emit(Event::Binary(data)).await {
                        return;
                    }
                }
                Step::Frame(Ok(Some(Incoming::Ping(data)))) => {
                    if !sent {
                        _ = io.encode(Message::Pong(data), &codec);
                    }
                }
                Step::Frame(Ok(Some(Incoming::Close(frame)))) => {
                    received.get_or_insert(frame.clone());
                    arm(&mut deadline, &mut armed);
                    if !std::mem::replace(&mut sent, true) {
                        commands = None;
                        _ = io.encode(Message::Close(frame), &codec);
                    }
                }
                Step::Frame(Ok(Some(_))) => {}
                Step::Frame(Ok(None)) => {
                    break if received.is_some() { None } else { Some("the connection closed without a closing handshake".into()) };
                }
                Step::Frame(Err(error)) => break if received.is_some() { None } else { Some(error) },
                Step::Command(Some(Command::Send(message))) => {
                    if io.encode(message, &codec).is_err() {
                        commands = None;
                    }
                }
                Step::Command(Some(Command::Close(frame))) => {
                    sent = true;
                    commands = None;
                    if io.encode(Message::Close(frame), &codec).is_ok() {
                        arm(&mut deadline, &mut armed);
                    }
                }
                Step::Command(None) => commands = None,
                Step::Timeout => break Some("the closing handshake timed out".into()),
            }
        };
        let close = match (end, received) {
            (None, Some(frame)) => {
                let (code, reason) = frame.map_or((1005, String::new()), |frame| (frame.code.into(), frame.description.unwrap_or_default()));
                Event::Close { code, reason, clean: true }
            }
            (error, _) => {
                if let Some(message) = error
                    && !events.emit(Event::Error(message)).await
                {
                    return;
                }
                Event::Close { code: 1006, reason: String::new(), clean: false }
            }
        };
        events.emit(close).await;
    }
}

fn close_frame(code: Option<u32>, reason: Option<String>) -> Outcome<Option<CloseReason>> {
    let reason = reason.unwrap_or_default();
    if reason.len() > 123 {
        return Err(Failure::invalid("the close reason must be at most 123 bytes"));
    }
    let code = match code {
        Some(code) if code == 1000 || (3000..=4999).contains(&code) => code as u16,
        Some(code) => return Err(Failure::invalid(format!("close code {code} is neither 1000 nor in 3000-4999"))),
        None if reason.is_empty() => return Ok(None),
        None => 1000,
    };
    Ok(Some(CloseReason { code: CloseCode::from(code), description: (!reason.is_empty()).then_some(reason) }))
}

struct Connection {
    task: crate::rt::Task,
    commands: Option<async_channel::Sender<Command>>,
}

pub(crate) struct Connections {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Connection>>,
}

impl Connections {
    fn new() -> Arc<Self> {
        Arc::new(Self { next: AtomicU32::new(1), open: Mutex::default() })
    }

    fn start<F>(self: &Arc<Self>, commands: Option<async_channel::Sender<Command>>, work: impl FnOnce() -> F + Send + 'static) -> u32
    where
        F: Future<Output = ()> + 'static,
    {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let me: Weak<Self> = Arc::downgrade(self);
        let mut open = self.open.locked();
        let task = crate::rt::spawn_abortable(async move {
            crate::rt::local(work).await;
            if let Some(me) = me.upgrade() {
                me.open.locked().remove(&id);
            }
        });
        open.insert(id, Connection { task, commands });
        id
    }

    fn request(self: &Arc<Self>, exchange: Exchange, events: impl Events) -> u32 {
        self.start(None, move || async move { exchange.run(&events).await })
    }

    fn websocket(self: &Arc<Self>, upgrade: Upgrade, events: impl Events) -> u32 {
        let (commands, receiver) = async_channel::unbounded();
        self.start(Some(commands), move || async move { upgrade.run(receiver, &events).await })
    }

    fn abort(&self, id: u32) {
        if let Some(connection) = self.open.locked().remove(&id) {
            connection.task.abort();
        }
    }

    fn command(&self, id: u32, command: Command) {
        if let Some(commands) = self.open.locked().get(&id).and_then(|c| c.commands.as_ref()) {
            commands.try_send(command).ok();
        }
    }

    fn abort_all(&self) {
        for (_, connection) in self.open.locked().drain() {
            connection.task.abort();
        }
    }
}

pub struct UnixClient {
    connections: Arc<Connections>,
}

impl UnixClient {
    pub fn new() -> Self {
        Self { connections: Connections::new() }
    }

    pub fn request(
        &self,
        socket: String,
        method: String,
        path: String,
        headers: Vec<Vec<String>>,
        body: Option<Vec<u8>>,
        deliver: Deliver,
    ) -> Result<u32, String> {
        let exchange = Exchange::new(socket, method, path, headers, body).map_err(|e| e.message)?;
        Ok(self.connections.request(exchange, Delivered(deliver)))
    }

    pub fn abort(&self, id: u32) {
        self.connections.abort(id);
    }

    pub fn websocket(&self, socket: String, path: String, headers: Vec<Vec<String>>, protocols: Vec<String>, deliver: Deliver) -> Result<u32, String> {
        let upgrade = Upgrade::new(socket, path, headers, protocols).map_err(|e| e.message)?;
        Ok(self.connections.websocket(upgrade, Delivered(deliver)))
    }

    pub fn send_text(&self, id: u32, text: String) {
        self.connections.command(id, Command::Send(Message::Text(text.into())));
    }

    pub fn send_binary(&self, id: u32, data: Vec<u8>) {
        self.connections.command(id, Command::Send(Message::Binary(data.into())));
    }

    pub fn close(&self, id: u32, code: Option<u32>, reason: Option<String>) -> Result<(), String> {
        let frame = close_frame(code, reason).map_err(|e| e.message)?;
        self.connections.command(id, Command::Close(frame));
        Ok(())
    }
}

impl Default for UnixClient {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for UnixClient {
    fn drop(&mut self) {
        self.connections.abort_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::frames;
    use std::io::{BufRead, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream as StdStream};
    use std::path::PathBuf;
    use std::time::Duration;

    fn serve(name: &str, answer: impl FnOnce(StdStream) + Send + 'static) -> (String, std::thread::JoinHandle<()>) {
        let dir = std::env::temp_dir().join(format!("acde-unixhttp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        let path: PathBuf = dir.join(name);
        let listener = UnixListener::bind(&path).expect("bind");
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            answer(stream);
        });
        (path.to_string_lossy().into_owned(), server)
    }

    fn read_head(stream: &StdStream) -> (Vec<String>, std::io::BufReader<StdStream>) {
        let mut reader = std::io::BufReader::new(stream.try_clone().expect("clone"));
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("request line");
            let line = line.trim_end_matches(['\r', '\n']).to_owned();
            if line.is_empty() {
                return (lines, reader);
            }
            lines.push(line);
        }
    }

    fn request(socket: &str, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> Exchange {
        Exchange {
            socket: socket.into(),
            method: method.into(),
            path: path.into(),
            host: "localhost".into(),
            headers: headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(),
            body: body.map(<[u8]>::to_vec),
        }
    }

    type Received = async_channel::Receiver<Event>;

    fn channel() -> (async_channel::Sender<Event>, Received) {
        async_channel::bounded(8)
    }

    fn recv(events: &Received) -> Option<Event> {
        let events = events.clone();
        let received = crate::rt::block_on(async move { ntex::time::timeout(Duration::from_secs(10), events.recv()).await });
        received.expect("the executor").expect("an event or the end in time").ok()
    }

    fn next(events: &Received) -> Event {
        recv(events).expect("an event")
    }

    #[test]
    fn get_with_content_length() {
        let (socket, server) = serve("3000.sock", |mut stream| {
            let (lines, _) = read_head(&stream);
            assert_eq!(lines[0], "GET /api/x?y=1 HTTP/1.1");
            assert!(lines.contains(&"Host: localhost".to_owned()), "{lines:?}");
            assert!(lines.contains(&"Connection: close".to_owned()), "{lines:?}");
            assert!(lines.contains(&"Accept: text/plain".to_owned()), "{lines:?}");
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Thing: a b\r\n\r\nhello").expect("answer");
        });
        let (sender, events) = channel();
        Connections::new().request(request(&socket, "GET", "/api/x?y=1", &[("Accept", "text/plain")], None), sender);
        let Event::Head { status, status_text, headers } = next(&events) else { panic!("head first") };
        assert_eq!((status, status_text.as_str()), (200, "OK"));
        assert!(headers.contains(&("x-thing".into(), "a b".into())));
        assert_eq!(next(&events), Event::Chunk(b"hello".to_vec()));
        assert_eq!(next(&events), Event::End);
        assert!(recv(&events).is_none(), "nothing after end");
        server.join().expect("server");
    }

    #[test]
    fn chunked_body_arrives_in_pieces() {
        let (go, wait) = std::sync::mpsc::channel::<()>();
        let (socket, server) = serve("0.sock", move |mut stream| {
            read_head(&stream);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").expect("head");
            stream.write_all(b"d\r\ndata: first\n\n\r\n").expect("first");
            wait.recv().expect("go");
            stream.write_all(b"e;ext=1\r\ndata: second\n\n\r\n0\r\nX-Trailer: t\r\n\r\n").expect("second");
            let mut rest = Vec::new();
            stream.read_to_end(&mut rest).ok();
        });
        let (sender, events) = channel();
        Connections::new().request(request(&socket, "GET", "/events", &[], None), sender);
        assert!(matches!(next(&events), Event::Head { status: 200, .. }));
        assert_eq!(next(&events), Event::Chunk(b"data: first\n\n".to_vec()));
        go.send(()).expect("go");
        assert_eq!(next(&events), Event::Chunk(b"data: second\n\n".to_vec()));
        assert_eq!(next(&events), Event::End);
        server.join().expect("server");
    }

    #[test]
    fn post_body_and_read_to_close() {
        let (socket, server) = serve("8080.sock", |mut stream| {
            let (lines, mut reader) = read_head(&stream);
            assert_eq!(lines[0], "POST /api/echo HTTP/1.1");
            assert!(lines.contains(&"Host: localhost:8080".to_owned()), "{lines:?}");
            let length: usize = lines.iter().find_map(|l| l.strip_prefix("Content-Length: ")).expect("length").parse().expect("number");
            let mut body = vec![0; length];
            reader.read_exact(&mut body).expect("body");
            stream.write_all(b"HTTP/1.1 201 Created\r\n\r\n").expect("head");
            stream.write_all(&body).expect("echo");
        });
        let (sender, events) = channel();
        let mut exchange = request(&socket, "POST", "/api/echo", &[("Content-Type", "application/json")], Some(br#"{"a":1}"#));
        exchange.host = "localhost:8080".into();
        Connections::new().request(exchange, sender);
        assert!(matches!(next(&events), Event::Head { status: 201, .. }));
        let mut body = Vec::new();
        loop {
            match next(&events) {
                Event::Chunk(data) => body.extend(data),
                Event::End => break,
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(body, br#"{"a":1}"#);
        server.join().expect("server");
    }

    #[test]
    fn abort_drops_the_connection() {
        let (closed, seen) = std::sync::mpsc::channel();
        let (socket, server) = serve("1.sock", move |mut stream| {
            read_head(&stream);
            stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").expect("head");
            let mut rest = [0u8; 16];
            closed.send(stream.read(&mut rest).map(|n| n == 0).unwrap_or(true)).ok();
        });
        let connections = Connections::new();
        let (sender, events) = channel();
        let id = connections.request(request(&socket, "GET", "/slow", &[], None), sender);
        assert!(matches!(next(&events), Event::Head { status: 200, .. }));
        connections.abort(id);
        assert!(seen.recv_timeout(Duration::from_secs(10)).expect("server saw the end"));
        assert!(recv(&events).is_none(), "no event after abort");
        assert!(connections.open.locked().is_empty());
        server.join().expect("server");
    }

    #[test]
    fn missing_socket_is_an_error_event() {
        let (sender, events) = channel();
        Connections::new().request(request("/nonexistent/acde/3000.sock", "GET", "/", &[], None), sender);
        let Event::Error(message) = next(&events) else { panic!("an error") };
        assert!(message.contains("/nonexistent/acde/3000.sock") && message.contains("No such file"), "{message}");
        assert!(recv(&events).is_none());
    }

    #[test]
    fn socket_bound_later_is_waited_for() {
        let dir = std::env::temp_dir().join(format!("acde-unixhttp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        let path = dir.join("3000.sock");
        let (sender, events) = channel();
        Connections::new().request(request(&path.to_string_lossy(), "GET", "/", &[], None), sender);
        std::thread::sleep(Duration::from_millis(200));
        let listener = UnixListener::bind(&path).expect("bind");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            read_head(&stream);
            stream.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").expect("answer");
        });
        assert!(matches!(next(&events), Event::Head { status: 204, .. }));
        assert_eq!(next(&events), Event::End);
        server.join().expect("server");
    }

    #[test]
    fn early_end_is_an_error() {
        let (socket, server) = serve("2.sock", |mut stream| {
            read_head(&stream);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc").expect("short");
        });
        let (sender, events) = channel();
        Connections::new().request(request(&socket, "GET", "/", &[], None), sender);
        assert!(matches!(next(&events), Event::Head { status: 200, .. }));
        assert_eq!(next(&events), Event::Chunk(b"abc".to_vec()));
        assert!(matches!(next(&events), Event::Error(_)));
        server.join().expect("server");
    }

    #[test]
    fn options_are_checked() {
        let options = |headers: Vec<Vec<String>>, path: &str| Exchange::new("/run/x.sock".into(), "GET".into(), path.into(), headers, None);
        let pair = |n: &str, v: &str| vec![n.to_owned(), v.to_owned()];
        assert!(options(vec![pair("Bad Name", "x")], "/").is_err());
        assert!(options(vec![pair("X", "a\r\nInjected: 1")], "/").is_err());
        assert!(options(vec![], "no-slash").is_err());
        assert!(options(vec![], "/a b").is_err());
        let exchange = options(vec![pair("Host", "localhost:3000"), pair("Content-Length", "9"), pair("X-A", "b")], "/").expect("valid");
        assert_eq!(exchange.host, "localhost:3000");
        assert_eq!(exchange.headers, vec![("X-A".to_owned(), "b".to_owned())]);
        assert!(close_frame(Some(1001), None).is_err());
        assert!(close_frame(Some(4000), Some("x".repeat(124))).is_err());
        assert!(close_frame(None, None).expect("no code").is_none());
        assert_eq!(close_frame(None, Some("bye".into())).expect("1000").map(|f| u16::from(f.code)), Some(1000));
    }

    fn upgrade(socket: &str, protocols: &[&str]) -> Upgrade {
        Upgrade {
            socket: socket.into(),
            path: "/ws".into(),
            host: "localhost".into(),
            headers: vec![("Origin".into(), "http://acde.local".into())],
            protocols: protocols.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn accept(stream: &mut StdStream, protocol: Option<&str>) -> (Vec<String>, std::io::BufReader<StdStream>) {
        let (lines, reader) = read_head(stream);
        assert_eq!(lines[0], "GET /ws HTTP/1.1");
        assert!(lines.contains(&"Upgrade: websocket".to_owned()), "{lines:?}");
        let key = lines.iter().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).expect("key");
        let accept = ntex::ws::hash_key(key.as_bytes()).expect("key");
        let protocol = protocol.map(|p| format!("Sec-WebSocket-Protocol: {p}\r\n")).unwrap_or_default();
        let answer =
            format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{protocol}\r\n");
        stream.write_all(answer.as_bytes()).expect("handshake");
        (lines, reader)
    }

    #[test]
    fn websocket_echo_and_client_close() {
        let (socket, server) = serve("3000.sock", |mut stream| {
            let (lines, mut reader) = accept(&mut stream, Some("v2"));
            assert!(lines.contains(&"Origin: http://acde.local".to_owned()), "{lines:?}");
            assert!(lines.contains(&"Sec-WebSocket-Protocol: chat, v2".to_owned()), "{lines:?}");
            loop {
                match frames::read(&mut reader, true) {
                    (true, opcode @ (1 | 2), data) => stream.write_all(&frames::write(true, opcode, &data, false)).expect("echo"),
                    (true, 8, close) => {
                        stream.write_all(&frames::write(true, 8, &close, false)).expect("close");
                        return;
                    }
                    other => panic!("{other:?}"),
                }
            }
        });
        let connections = Connections::new();
        let (sender, events) = channel();
        let id = connections.websocket(upgrade(&socket, &["chat", "v2"]), sender);
        connections.command(id, Command::Send(Message::Text("hello 你好".into())));
        assert_eq!(next(&events), Event::Open { protocol: "v2".into(), extensions: String::new() });
        assert_eq!(next(&events), Event::Text("hello 你好".into()));
        let big: Vec<u8> = (0..300_000u32).map(|i| i as u8).collect();
        connections.command(id, Command::Send(Message::Binary(big.clone().into())));
        assert_eq!(next(&events), Event::Binary(big));
        connections.command(id, Command::Close(close_frame(Some(4000), Some("done".into())).expect("frame")));
        assert_eq!(next(&events), Event::Close { code: 4000, reason: "done".into(), clean: true });
        assert!(recv(&events).is_none());
        server.join().expect("server");
    }

    #[test]
    fn websocket_fragments_ping_and_server_close() {
        let (socket, server) = serve("4000.sock", |mut stream| {
            let mut answer = Vec::new();
            let (lines, mut reader) = {
                let (lines, reader) = read_head(&stream);
                assert!(!lines.iter().any(|l| l.starts_with("Sec-WebSocket-Protocol")), "no protocol offered");
                let key = lines.iter().find_map(|l| l.strip_prefix("Sec-WebSocket-Key: ")).expect("key");
                let accept = ntex::ws::hash_key(key.as_bytes()).expect("key");
                answer.extend(
                    format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n")
                        .into_bytes(),
                );
                (lines, reader)
            };
            assert_eq!(lines[0], "GET /ws HTTP/1.1");
            answer.extend(frames::write(false, 1, "frag".as_bytes(), false));
            stream.write_all(&answer).expect("handshake");
            stream.write_all(&frames::write(false, 0, "men".as_bytes(), false)).expect("continuation");
            stream.write_all(&frames::write(true, 0, "ted ✓".as_bytes(), false)).expect("last");
            stream.write_all(&frames::write(true, 9, b"ping!", false)).expect("ping");
            assert_eq!(frames::read(&mut reader, true), (true, 10, b"ping!".to_vec()), "pong with the ping's payload");
            let mut close = 4001u16.to_be_bytes().to_vec();
            close.extend_from_slice(b"bye");
            stream.write_all(&frames::write(true, 8, &close, false)).expect("close");
            assert_eq!(frames::read(&mut reader, true), (true, 8, close), "the close answered with its code");
            stream.shutdown(std::net::Shutdown::Both).ok();
        });
        let (sender, events) = channel();
        Connections::new().websocket(upgrade(&socket, &[]), sender);
        assert_eq!(next(&events), Event::Open { protocol: String::new(), extensions: String::new() });
        assert_eq!(next(&events), Event::Text("fragmented ✓".into()));
        assert_eq!(next(&events), Event::Close { code: 4001, reason: "bye".into(), clean: true });
        server.join().expect("server");
    }

    #[test]
    fn websocket_refused_and_missing() {
        let (socket, server) = serve("5000.sock", |mut stream| {
            read_head(&stream);
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").expect("answer");
        });
        let (sender, events) = channel();
        Connections::new().websocket(upgrade(&socket, &[]), sender);
        let Event::Error(message) = next(&events) else { panic!("an error") };
        assert!(message.contains("404"), "{message}");
        assert_eq!(next(&events), Event::Close { code: 1006, reason: String::new(), clean: false });
        server.join().expect("server");

        let (sender, events) = channel();
        Connections::new().websocket(upgrade("/nonexistent/acde/1.sock", &[]), sender);
        assert!(matches!(next(&events), Event::Error(message) if message.contains("No such file")));
        assert!(matches!(next(&events), Event::Close { code: 1006, clean: false, .. }));
    }
}
