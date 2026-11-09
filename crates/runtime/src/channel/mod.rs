use std::collections::HashMap;
use std::future::poll_fn;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::thread;

use ntex::io::{Handle, Io, IoContext, IoStream, IoTaskStatus, Readiness};
use ntex::util::{BytePages, BytesMut};

pub const OPEN: u8 = 1;
pub const DATA: u8 = 2;
pub const FIN: u8 = 3;
pub const RST: u8 = 4;
pub const WINDOW: u8 = 5;
pub const SHUTDOWN: u8 = 6;
pub const HEADER: usize = 9;
pub const MAX_PAYLOAD: usize = 64 * 1024;
pub const CREDIT: u32 = 256 * 1024;
const CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub stream: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: u8, stream: u32, payload: impl Into<Vec<u8>>) -> Self {
        Self { kind, stream, payload: payload.into() }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER + self.payload.len());
        bytes.push(self.kind);
        bytes.extend_from_slice(&self.stream.to_be_bytes());
        bytes.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        bytes
    }

    pub fn read(from: &mut impl Read) -> io::Result<Option<Self>> {
        let mut head = [0u8; HEADER];
        let mut filled = 0;
        while filled < HEADER {
            match from.read(&mut head[filled..]) {
                Ok(0) if filled == 0 => return Ok(None),
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(n) => filled += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        let stream = u32::from_be_bytes([head[1], head[2], head[3], head[4]]);
        let length = u32::from_be_bytes([head[5], head[6], head[7], head[8]]) as usize;
        if length > MAX_PAYLOAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("a frame of {length} bytes is over {MAX_PAYLOAD}")));
        }
        let mut payload = vec![0; length];
        from.read_exact(&mut payload)?;
        Ok(Some(Self { kind: head[0], stream, payload }))
    }

    fn credit(&self) -> Option<u32> {
        <[u8; 4]>::try_from(self.payload.as_slice()).ok().map(u32::from_be_bytes)
    }
}

#[derive(Default)]
struct Stream {
    inbound: Vec<u8>,
    peer_fin: bool,
    sent_fin: bool,
    detached: bool,
    reset: Option<String>,
    credit: u32,
    reader: Option<Waker>,
    writer: Option<Waker>,
}

impl Stream {
    fn wake(&mut self) {
        for waker in [self.reader.take(), self.writer.take()].into_iter().flatten() {
            waker.wake();
        }
    }
}

#[derive(Default)]
struct Shared {
    streams: Mutex<HashMap<u32, Stream>>,
    out: Mutex<Option<Sender<Frame>>>,
    closed: Mutex<Option<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    fn send(&self, frame: Frame) -> io::Result<()> {
        let sent = lock(&self.out).as_ref().is_some_and(|out| out.send(frame).is_ok());
        if sent { Ok(()) } else { Err(io::Error::new(io::ErrorKind::BrokenPipe, self.closed().unwrap_or_else(|| "the backend channel is closed".into()))) }
    }

    fn closed(&self) -> Option<String> {
        lock(&self.closed).clone()
    }

    fn close(&self, reason: &str) {
        lock(&self.closed).get_or_insert_with(|| reason.to_owned());
        lock(&self.out).take();
        for stream in lock(&self.streams).values_mut() {
            stream.reset.get_or_insert_with(|| reason.to_owned());
            stream.wake();
        }
    }

    fn deliver(&self, frame: Frame) {
        let mut streams = lock(&self.streams);
        let Some(stream) = streams.get_mut(&frame.stream) else {
            drop(streams);
            if matches!(frame.kind, DATA | FIN) {
                _ = self.send(Frame::new(RST, frame.stream, "no such stream"));
            }
            return;
        };
        match frame.kind {
            DATA if stream.detached => {
                streams.remove(&frame.stream);
                drop(streams);
                _ = self.send(Frame::new(RST, frame.stream, "the stream is closed"));
            }
            DATA => {
                stream.inbound.extend_from_slice(&frame.payload);
                stream.wake();
            }
            FIN | RST if stream.detached => {
                streams.remove(&frame.stream);
            }
            FIN => {
                stream.peer_fin = true;
                stream.wake();
            }
            RST => {
                stream.reset.get_or_insert_with(|| String::from_utf8_lossy(&frame.payload).into_owned());
                stream.wake();
            }
            WINDOW => {
                if let Some(grant) = frame.credit() {
                    stream.credit = stream.credit.saturating_add(grant);
                    stream.wake();
                }
            }
            _ => {}
        }
    }
}

fn write_loop(mut to_backend: impl Write, frames: Receiver<Frame>, shared: &Shared) {
    for frame in frames {
        if let Err(e) = to_backend.write_all(&frame.encode()).and_then(|()| to_backend.flush()) {
            shared.close(&format!("cannot write to the backend: {e}"));
            return;
        }
    }
}

fn read_loop(mut from_backend: impl Read, shared: &Shared) {
    loop {
        match Frame::read(&mut from_backend) {
            Ok(Some(frame)) => shared.deliver(frame),
            Ok(None) => return shared.close("the backend closed its channel"),
            Err(e) => return shared.close(&format!("cannot read from the backend: {e}")),
        }
    }
}

pub struct Mux {
    shared: Arc<Shared>,
    next: AtomicU32,
}

impl Mux {
    pub fn start<W, R>(to_backend: W, from_backend: R) -> io::Result<Arc<Self>>
    where
        W: Write + Send + 'static,
        R: Read + Send + 'static,
    {
        let (out, frames) = channel();
        let shared = Arc::new(Shared { out: Mutex::new(Some(out)), ..Shared::default() });
        let writer = shared.clone();
        thread::Builder::new().name("acde-channel-out".into()).spawn(move || write_loop(to_backend, frames, &writer))?;
        let reader = shared.clone();
        thread::Builder::new().name("acde-channel-in".into()).spawn(move || read_loop(from_backend, &reader))?;
        Ok(Arc::new(Self { shared, next: AtomicU32::new(1) }))
    }

    pub fn open(self: &Arc<Self>, port: u16) -> io::Result<Io> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.shared.streams).insert(id, Stream { credit: CREDIT, ..Stream::default() });
        if let Err(e) = self.shared.send(Frame::new(OPEN, id, port.to_be_bytes())) {
            lock(&self.shared.streams).remove(&id);
            return Err(e);
        }
        Ok(Io::new(Link { mux: self.clone(), id }, ntex::SharedCfg::default()))
    }

    pub fn shutdown(&self) -> io::Result<()> {
        self.shared.send(Frame::new(SHUTDOWN, 0, []))
    }

    pub fn close(&self, reason: &str) {
        self.shared.close(reason);
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed().is_some()
    }
}

#[derive(Clone)]
pub enum Route {
    Channel(Arc<Mux>),
    Sockets(PathBuf),
}

static REGISTRY: LazyLock<Mutex<HashMap<String, (u64, Route)>>> = LazyLock::new(Mutex::default);

pub fn register(app: &str, route: Route) -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let generation = NEXT.fetch_add(1, Ordering::Relaxed);
    lock(&REGISTRY).insert(app.to_owned(), (generation, route));
    generation
}

pub fn unregister(app: &str, generation: u64) {
    let mut registry = lock(&REGISTRY);
    if registry.get(app).is_some_and(|(current, _)| *current == generation) {
        registry.remove(app);
    }
}

pub fn lookup(app: &str) -> Option<Route> {
    let registry = lock(&REGISTRY);
    let (_, route) = registry.get(app)?;
    match route {
        Route::Channel(mux) if mux.is_closed() => None,
        route => Some(route.clone()),
    }
}

enum End {
    Close,
    Abort,
}

struct Link {
    mux: Arc<Mux>,
    id: u32,
}

impl Link {
    fn poll_read(&self, cx: &mut Context<'_>, buf: &mut BytesMut) -> Poll<io::Result<usize>> {
        let mut streams = lock(&self.mux.shared.streams);
        let Some(stream) = streams.get_mut(&self.id) else {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::ConnectionReset, "the backend stream is gone")));
        };
        if !stream.inbound.is_empty() {
            let taken = std::mem::take(&mut stream.inbound);
            drop(streams);
            buf.extend_from_slice(&taken);
            _ = self.mux.shared.send(Frame::new(WINDOW, self.id, (taken.len() as u32).to_be_bytes()));
            return Poll::Ready(Ok(taken.len()));
        }
        if let Some(reason) = &stream.reset {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::ConnectionReset, reason.clone())));
        }
        if stream.peer_fin {
            return Poll::Ready(Ok(0));
        }
        stream.reader = Some(cx.waker().clone());
        Poll::Pending
    }

    fn poll_write(&self, cx: &mut Context<'_>, buf: &mut BytePages) -> io::Result<usize> {
        let mut written = 0;
        while let Some(mut page) = buf.take() {
            let mut streams = lock(&self.mux.shared.streams);
            let stream = match streams.get_mut(&self.id) {
                Some(stream) if stream.reset.is_none() => stream,
                Some(stream) => {
                    let reason = stream.reset.clone().unwrap_or_default();
                    buf.prepend(page);
                    return Err(io::Error::new(io::ErrorKind::ConnectionReset, reason));
                }
                None => {
                    buf.prepend(page);
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the backend stream is gone"));
                }
            };
            if stream.credit == 0 {
                stream.writer = Some(cx.waker().clone());
                buf.prepend(page);
                break;
            }
            let take = page.len().min(CHUNK).min(stream.credit as usize);
            stream.credit -= take as u32;
            drop(streams);
            let data = page[..take].to_vec();
            page.advance_to(take);
            if !page.is_empty() {
                buf.prepend(page);
            }
            self.mux.shared.send(Frame::new(DATA, self.id, data))?;
            written += take;
        }
        Ok(written)
    }

    fn end(&self, end: End) {
        let mut streams = lock(&self.mux.shared.streams);
        let Some(stream) = streams.get_mut(&self.id) else { return };
        let frame = match end {
            _ if stream.reset.is_some() => None,
            End::Abort => Some(Frame::new(RST, self.id, "aborted")),
            End::Close if stream.sent_fin => None,
            End::Close => {
                stream.sent_fin = true;
                Some(Frame::new(FIN, self.id, []))
            }
        };
        if stream.reset.is_some() || stream.peer_fin || matches!(end, End::Abort) {
            streams.remove(&self.id);
        } else {
            stream.detached = true;
            stream.inbound.clear();
        }
        drop(streams);
        if let Some(frame) = frame {
            _ = self.mux.shared.send(frame);
        }
    }
}

impl IoStream for Link {
    fn start(self, ctx: IoContext) -> Box<dyn Handle> {
        ntex::rt::spawn_detached(run(Rc::new(self), ctx));
        Box::new(Detached)
    }
}

struct Detached;

impl Handle for Detached {}

async fn run(link: Rc<Link>, ctx: IoContext) {
    let end = poll_fn(|cx| turn(&link, &ctx, cx)).await;
    link.end(end);
    ctx.stopped(None);
}

fn readiness(ready: Poll<Readiness>, go: impl FnOnce() -> Poll<End>) -> Poll<End> {
    match ready {
        Poll::Ready(Readiness::Ready) => go(),
        Poll::Ready(Readiness::Close) => Poll::Ready(End::Close),
        Poll::Ready(Readiness::Terminate) => Poll::Ready(End::Abort),
        Poll::Pending => Poll::Pending,
    }
}

fn turn(link: &Link, ctx: &IoContext, cx: &mut Context<'_>) -> Poll<End> {
    if let Poll::Ready(end) = readiness(ctx.poll_read_ready(cx), || read(link, ctx, cx)) {
        return Poll::Ready(end);
    }
    readiness(ctx.poll_write_ready(cx), || write(link, ctx, cx))
}

fn read(link: &Link, ctx: &IoContext, cx: &mut Context<'_>) -> Poll<End> {
    loop {
        let mut pending = false;
        let status = ctx.with_read_buf(|buf| {
            let result = link.poll_read(cx, buf);
            pending = result.is_pending();
            result
        });
        return match status {
            IoTaskStatus::Io if !pending => continue,
            IoTaskStatus::Io | IoTaskStatus::Pause => Poll::Pending,
            IoTaskStatus::Stop => Poll::Ready(End::Abort),
        };
    }
}

fn write(link: &Link, ctx: &IoContext, cx: &mut Context<'_>) -> Poll<End> {
    let result = ctx.with_write_dst(|buf| link.poll_write(cx, buf));
    if ctx.update_write_status(result) == IoTaskStatus::Stop { Poll::Ready(End::Abort) } else { Poll::Pending }
}

#[cfg(test)]
mod tests;
