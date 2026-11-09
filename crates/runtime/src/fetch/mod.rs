use crate::channel::Route;
use crate::http::{Incoming, Messages};
use crate::sync::Locked;
use futures_channel::oneshot;
use futures_util::{StreamExt, future::AbortHandle};
use ntex::connect::{Connect, ConnectError};
use ntex::http::{Method, header};
use ntex::io::{Io, Sealed};
use ntex::service::fn_service;
use ntex::time::{Deadline, Millis, Seconds};
use ntex::url::Url;
use ntex::ws::{CloseCode, CloseReason, Codec, Message, WsClient, WsClientConfig};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    future::{Future, poll_fn},
    pin::pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    task::Poll,
    time::{Duration, Instant},
};

const HANDSHAKE: Seconds = Seconds(30);
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

async fn open_app(app: &str, port: u16) -> std::result::Result<Io, String> {
    let until = Instant::now() + READY;
    loop {
        let error = match crate::channel::lookup(app) {
            Some(Route::Channel(mux)) => match mux.open(port) {
                Ok(io) => return Ok(io),
                Err(error) => error.to_string(),
            },
            Some(Route::Sockets(dir)) => {
                let socket = dir.join(format!("{port}.sock"));
                match ntex::rt::unix_connect(&socket, ntex::SharedCfg::default()).await {
                    Ok(io) => return Ok(io),
                    Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => {
                        format!("{}: {error}", socket.display())
                    }
                    Err(error) => return Err(format!("cannot connect to {}: {error}", socket.display())),
                }
            }
            None => "the backend is not running".to_owned(),
        };
        if Instant::now() >= until {
            return Err(format!("cannot reach port {port} of the backend of {app}: {error}"));
        }
        ntex::time::sleep(RETRY).await;
    }
}

impl Dial {
    fn is_local(&self) -> bool {
        !matches!(self, Self::Url(_))
    }

    async fn local(&self) -> std::result::Result<Io, String> {
        match self {
            Self::Socket(socket) => connect(socket).await,
            Self::App { app, port } => open_app(app, *port).await,
            Self::Url(url) => Err(format!("{url} is not a backend")),
        }
    }
}

thread_local! {
    static DIALED: RefCell<HashMap<String, Io>> = RefCell::default();
    static CLIENT: ntex::client::Client = ntex::client::Client::builder()
        .connector(fn_service(async |connect: Connect<Url>| {
            DIALED.with(|dialed| dialed.borrow_mut().remove(connect.host())).ok_or_else(|| ntex::Error::from(ConnectError::Unresolved))
        }))
        .build(ntex::SharedCfg::new("acde-fetch").add(ntex::client::ClientConfig::new().set_h1_connection_limit(0)));
}

fn is_token(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dial {
    Socket(String),
    App { app: String, port: u16 },
    Url(String),
}

impl Dial {
    fn check(self, path: &str, schemes: &[&str]) -> Result<Self, String> {
        fn local_path(path: &str) -> Result<(), String> {
            if !path.starts_with('/') || !path.bytes().all(|b| b.is_ascii_graphic()) {
                return Err("path must start with / and be visible ASCII (percent-encoded)".into());
            }
            Ok(())
        }

        match &self {
            Self::Socket(socket) => {
                if !std::path::Path::new(socket).is_absolute() || socket.contains('\0') {
                    return Err("socket must be an absolute path".into());
                }
                local_path(path)?;
                Ok(self)
            }
            Self::App { app, .. } => {
                if app.is_empty() {
                    return Err("the backend has no app".into());
                }
                local_path(path)?;
                Ok(self)
            }
            Self::Url(url) => {
                let parsed = url::Url::parse(url).map_err(|e| format!("bad URL {url:?}: {e}"))?;
                if !schemes.contains(&parsed.scheme()) || parsed.host_str().is_none_or(str::is_empty) {
                    return Err(format!("cannot reach {url:?}: the URL must be {} with a host", schemes.join(" or ")));
                }
                if !parsed.username().is_empty() || parsed.password().is_some() {
                    return Err(format!("cannot reach {url:?}: credentials in the URL"));
                }
                let mut parsed = parsed;
                parsed.set_fragment(None);
                Ok(Self::Url(parsed.into()))
            }
        }
    }
}

fn headers(pairs: Vec<Vec<String>>, owned: &[&[&str]]) -> Result<(String, Vec<(String, String)>), String> {
    let mut host = "localhost".to_owned();
    let mut kept = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let Ok([name, value]) = <[String; 2]>::try_from(pair) else {
            return Err("a header must be [name, value]".into());
        };
        if !is_token(&name) {
            return Err(format!("bad header name {name:?}"));
        }
        if value.contains(['\r', '\n', '\0']) {
            return Err(format!("bad value of header {name}"));
        }
        let lower = name.to_ascii_lowercase();
        if lower == "host" {
            host = value.trim().to_owned();
        } else if !owned.iter().any(|list| list.contains(&lower.as_str())) {
            kept.push((name, value.trim().to_owned()));
        }
    }
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("bad Host header".into());
    }
    Ok((host, kept))
}

pub(crate) struct Exchange {
    to: Dial,
    method: String,
    path: String,
    host: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

impl Exchange {
    fn new(to: Dial, method: String, path: String, pairs: Vec<Vec<String>>, body: Option<Vec<u8>>) -> Result<Self, String> {
        let to = to.check(&path, &["http", "https"])?;
        if !is_token(&method) {
            return Err("method must be an HTTP token".into());
        }
        let (host, headers) = headers(pairs, &[FRAMING])?;
        Ok(Self { to, method, path, host, headers, body })
    }

    async fn run(self, events: &impl Events) {
        if let Err(Stop::Failed(message)) = self.exchange(events).await {
            events.emit(Event::Error(message)).await;
        }
    }

    async fn exchange(self, events: &impl Events) -> std::result::Result<(), Stop> {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let method = Method::from_bytes(self.method.as_bytes())?;
        let (mut request, dialed) = match &self.to {
            Dial::Socket(_) | Dial::App { .. } => {
                let io = self.to.local().await?;
                let dialed = format!("c{}", NEXT.fetch_add(1, Ordering::Relaxed));
                DIALED.with(|d| d.borrow_mut().insert(dialed.clone(), io));
                let request = CLIENT.with(Clone::clone).request(method, format!("http://{dialed}{}", self.path));
                (request.force_close().set_header(header::HOST, self.host.as_str()), Some(dialed))
            }
            Dial::Url(url) => (crate::http::client().request(method, url.as_str()).no_decompress(), None),
        };
        request = request.timeout(Millis::ZERO);
        for (name, value) in &self.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let sent = match self.body {
            Some(body) => request.send_body(body).await,
            None => request.send().await,
        };
        if let Some(dialed) = dialed {
            DIALED.with(|d| d.borrow_mut().remove(&dialed));
        }
        let mut response = sent?;
        let status = response.status();
        let headers = response.headers().iter().map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).trim().to_owned()));
        let head = Event::Head { status: status.as_u16(), status_text: status.canonical_reason().unwrap_or_default().into(), headers: headers.collect() };
        if !events.emit(head).await {
            return Err(Stop::Gone);
        }
        while let Some(chunk) = response.next().await {
            if !events.emit(Event::Chunk(chunk?.to_vec())).await {
                return Err(Stop::Gone);
            }
        }
        if !events.emit(Event::End).await {
            return Err(Stop::Gone);
        }
        Ok(())
    }
}

pub(crate) struct Upgrade {
    to: Dial,
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
    fn new(to: Dial, path: String, pairs: Vec<Vec<String>>, protocols: Vec<String>) -> Result<Self, String> {
        let to = to.check(&path, &["ws", "wss"])?;
        let (host, headers) = headers(pairs, &[FRAMING, HANDSHAKE_HEADERS])?;
        for (i, protocol) in protocols.iter().enumerate() {
            if !is_token(protocol) || protocols[..i].contains(protocol) {
                return Err(format!("bad or repeated protocol {protocol:?}"));
            }
        }
        Ok(Self { to, path, host, headers, protocols })
    }

    async fn handshake(&self) -> std::result::Result<(Io<Sealed>, Codec, String), String> {
        let mut config = WsClientConfig::new().set_max_frame_size(Messages::FRAME).set_handshake_timeout(HANDSHAKE).set_protocols(&self.protocols);
        if self.to.is_local() {
            config = config.and_then(|c| c.set_header(header::HOST, self.host.as_str()));
        }
        for (name, value) in &self.headers {
            config = config.and_then(|c| c.set_header(name.as_str(), value.as_str()));
        }
        let config = ntex::SharedCfg::new("acde-fetch").add(config.map_err(|error| error.to_string())?).add(crate::http::tls_config());
        let (io, codec, response) = match &self.to {
            Dial::Socket(_) | Dial::App { .. } => {
                let io = Cell::new(Some(self.to.local().await?));
                let client = WsClient::new(format!("http://localhost{}", self.path), config)
                    .connector(fn_service(async move |_: Connect<Url>| io.take().ok_or_else(|| ntex::Error::from(ConnectError::Unresolved))));
                let (io, codec, response) = client.connect().await.map_err(|error| error.to_string())?.into_inner();
                (io.seal(), codec, response)
            }
            Dial::Url(url) if url.starts_with("wss:") => {
                let tls = crate::http::tls().map_err(|error| error.to_string())?;
                let client = WsClient::new(url.as_str(), config).openssl(tls);
                let (io, codec, response) = client.connect().await.map_err(|error| error.to_string())?.into_inner();
                (io.seal(), codec, response)
            }
            Dial::Url(url) => {
                let (io, codec, response) = WsClient::new(url.as_str(), config).connect().await.map_err(|error| error.to_string())?.into_inner();
                (io.seal(), codec, response)
            }
        };
        let protocol = response.header(header::SEC_WEBSOCKET_PROTOCOL).map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        Ok((io, codec, protocol.unwrap_or_default()))
    }

    async fn run(self, commands: async_channel::Receiver<Command>, events: &impl Events) {
        let (io, codec, protocol) = match self.handshake().await {
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

fn close_frame(code: Option<u32>, reason: Option<String>) -> Result<Option<CloseReason>, String> {
    let reason = reason.unwrap_or_default();
    if reason.len() > 123 {
        return Err("the close reason must be at most 123 bytes".into());
    }
    let code = match code {
        Some(code) if code == 1000 || (3000..=4999).contains(&code) => code as u16,
        Some(code) => return Err(format!("close code {code} is neither 1000 nor in 3000-4999")),
        None if reason.is_empty() => return Ok(None),
        None => 1000,
    };
    Ok(Some(CloseReason { code: CloseCode::from(code), description: (!reason.is_empty()).then_some(reason) }))
}

struct Connection {
    task: AbortHandle,
    commands: Option<async_channel::Sender<Command>>,
}

#[derive(Default)]
pub struct FetchClient {
    next: AtomicU32,
    open: Arc<Mutex<HashMap<u32, Connection>>>,
}

impl FetchClient {
    fn start<F>(&self, commands: Option<async_channel::Sender<Command>>, work: impl FnOnce() -> F + Send + 'static) -> u32
    where
        F: Future<Output = ()> + 'static,
    {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let open = Arc::downgrade(&self.open);
        let mut connections = self.open.locked();
        let task = crate::rt::spawn_abortable(async move {
            crate::rt::local(work).await;
            if let Some(open) = open.upgrade() {
                open.locked().remove(&id);
            }
        });
        connections.insert(id, Connection { task, commands });
        id
    }

    fn exchange(&self, exchange: Exchange, events: impl Events) -> u32 {
        self.start(None, move || async move { exchange.run(&events).await })
    }

    fn upgrade(&self, upgrade: Upgrade, events: impl Events) -> u32 {
        let (commands, receiver) = async_channel::unbounded();
        self.start(Some(commands), move || async move { upgrade.run(receiver, &events).await })
    }

    fn command(&self, id: u32, command: Command) {
        if let Some(commands) = self.open.locked().get(&id).and_then(|c| c.commands.as_ref()) {
            commands.try_send(command).ok();
        }
    }

    pub fn request(&self, to: Dial, method: String, path: String, headers: Vec<Vec<String>>, body: Option<Vec<u8>>, deliver: Deliver) -> Result<u32, String> {
        Ok(self.exchange(Exchange::new(to, method, path, headers, body)?, Delivered(deliver)))
    }

    pub fn websocket(&self, to: Dial, path: String, headers: Vec<Vec<String>>, protocols: Vec<String>, deliver: Deliver) -> Result<u32, String> {
        Ok(self.upgrade(Upgrade::new(to, path, headers, protocols)?, Delivered(deliver)))
    }

    pub fn abort(&self, id: u32) {
        if let Some(connection) = self.open.locked().remove(&id) {
            connection.task.abort();
        }
    }

    pub fn send_text(&self, id: u32, text: String) {
        self.command(id, Command::Send(Message::Text(text.into())));
    }

    pub fn send_binary(&self, id: u32, data: Vec<u8>) {
        self.command(id, Command::Send(Message::Binary(data.into())));
    }

    pub fn close(&self, id: u32, code: Option<u32>, reason: Option<String>) -> Result<(), String> {
        self.command(id, Command::Close(close_frame(code, reason)?));
        Ok(())
    }
}

impl Drop for FetchClient {
    fn drop(&mut self) {
        for (_, connection) in self.open.locked().drain() {
            connection.task.abort();
        }
    }
}

#[cfg(test)]
mod tests;
