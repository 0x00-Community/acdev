mod http;
mod ws;

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Once, OnceLock};

use napi_derive::napi;

use crate::sync::Locked;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[napi(object)]
#[derive(Clone, PartialEq)]
pub struct DevToolsTarget {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub url: String,
}

#[napi(object)]
pub struct DevToolsEndpoint {
    pub port: u32,
    pub token: String,
}

#[napi]
pub struct DevTools;

#[napi]
impl DevTools {
    #[napi]
    pub fn open() -> Option<DevToolsEndpoint> {
        endpoint().map(|e| DevToolsEndpoint { port: e.port.into(), token: e.token.clone() })
    }

    #[napi]
    pub fn targets(targets: Vec<DevToolsTarget>) {
        if let Some(endpoint) = endpoint() {
            endpoint.set_targets(targets);
        }
    }
}

pub trait Forward: Send + Sync {
    fn attach(&self, _client: &Client) {}
    fn message(&self, client: &Client, message: &str) -> bool;
    fn detach(&self, _client: &Client) {}
}

pub fn forward(to: Option<Arc<dyn Forward>>) {
    if let Some(endpoint) = endpoint() {
        *endpoint.forward.locked() = to;
    }
}

pub fn address() -> Option<(u16, String)> {
    endpoint().map(|e| (e.port, e.token.clone()))
}

#[derive(Clone)]
pub struct Client(Arc<Connection>);

struct Connection {
    id: u64,
    target: Option<DevToolsTarget>,
    writer: Mutex<TcpStream>,
    open: AtomicBool,
}

impl Client {
    fn new(target: Option<DevToolsTarget>, writer: TcpStream) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(Arc::new(Connection { id: NEXT.fetch_add(1, Ordering::Relaxed), target, writer: Mutex::new(writer), open: AtomicBool::new(true) }))
    }

    pub fn id(&self) -> u64 {
        self.0.id
    }

    pub fn target(&self) -> Option<&str> {
        self.0.target.as_ref().map(|t| t.id.as_str())
    }

    pub fn send(&self, message: &str) -> bool {
        self.frame(ws::TEXT, message.as_bytes())
    }

    pub fn close(&self) {
        self.frame(ws::CLOSE, &1001u16.to_be_bytes());
        _ = self.0.writer.locked().shutdown(std::net::Shutdown::Both);
    }

    fn frame(&self, opcode: u8, payload: &[u8]) -> bool {
        let mut writer = self.0.writer.locked();
        if !self.0.open.load(Ordering::Acquire) {
            return false;
        }
        let sent = ws::write(&mut *writer, opcode, payload).is_ok();
        if !sent || opcode == ws::CLOSE {
            self.0.open.store(false, Ordering::Release);
        }
        sent
    }

    fn pong(&self, payload: &[u8]) {
        let mut writer = self.0.writer.locked();
        if self.0.open.load(Ordering::Acquire) && ws::pong(&mut *writer, payload).is_err() {
            self.0.open.store(false, Ordering::Release);
        }
    }

    fn answer_close(&self, payload: &[u8]) {
        let code = payload.get(..2).unwrap_or(&[0x03, 0xe8]);
        self.frame(ws::CLOSE, code);
    }
}

struct Endpoint {
    port: u16,
    token: String,
    browser: String,
    listener: Mutex<Option<TcpListener>>,
    targets: Mutex<Vec<DevToolsTarget>>,
    clients: Mutex<Vec<Client>>,
    forward: Mutex<Option<Arc<dyn Forward>>>,
}

static ENDPOINT: OnceLock<Option<Endpoint>> = OnceLock::new();

fn endpoint() -> Option<&'static Endpoint> {
    static SERVED: Once = Once::new();
    let endpoint = ENDPOINT.get_or_init(Endpoint::open).as_ref()?;
    SERVED.call_once(|| endpoint.serve());
    Some(endpoint)
}

impl Endpoint {
    fn open() -> Option<Self> {
        std::env::var_os("ACDE_DEV")?;
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(e) => {
                log::error!("devtools: cannot listen on 127.0.0.1: {e}");
                return None;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).ok()?;
        let token = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
        log::info!("devtools: listening on 127.0.0.1:{port}");
        Some(Self {
            port,
            token,
            browser: uuid::Uuid::new_v4().to_string(),
            listener: Mutex::new(Some(listener)),
            targets: Mutex::default(),
            clients: Mutex::default(),
            forward: Mutex::default(),
        })
    }

    fn serve(&'static self) {
        let Some(listener) = self.listener.locked().take() else { return };
        if let Err(e) = std::thread::Builder::new().name("acde-devtools".into()).spawn(move || http::accept(self, listener)) {
            log::error!("devtools thread: {e}");
        }
    }

    fn set_targets(&self, targets: Vec<DevToolsTarget>) {
        let gone: Vec<Client> = {
            let mut current = self.targets.locked();
            if *current == targets {
                return;
            }
            *current = targets;
            let clients = self.clients.locked();
            clients.iter().filter(|c| c.0.target.as_ref().is_some_and(|t| !current.iter().any(|n| n.id == t.id))).cloned().collect()
        };
        for client in gone {
            client.close();
        }
    }

    fn target(&self, id: &str) -> Option<DevToolsTarget> {
        self.targets.locked().iter().find(|t| t.id == id).cloned()
    }

    fn attach(&self, client: &Client) {
        self.clients.locked().push(client.clone());
        let forward = self.forward.locked().clone();
        if let Some(forward) = forward {
            forward.attach(client);
        }
    }

    fn detach(&self, client: &Client) {
        self.clients.locked().retain(|c| c.id() != client.id());
        let forward = self.forward.locked().clone();
        if let Some(forward) = forward {
            forward.detach(client);
        }
    }

    fn forwarded(&self, client: &Client, message: &str) -> bool {
        let forward = self.forward.locked().clone();
        forward.is_some_and(|f| f.message(client, message))
    }
}
