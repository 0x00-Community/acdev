mod client;
mod http;
mod ws;

use std::net::TcpListener;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::Duration;

use napi_derive::napi;

pub use client::Client;

use crate::sync::Locked;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const CONNECTIONS: usize = 32;
const HEAD_WAIT: Duration = Duration::from_secs(10);

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

struct Endpoint {
    port: u16,
    token: String,
    browser: String,
    limit: usize,
    head_wait: Duration,
    connections: AtomicUsize,
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
        let endpoint = Self::new(listener, CONNECTIONS, HEAD_WAIT).inspect_err(|e| log::error!("devtools: {e}")).ok()?;
        log::info!("devtools: listening on 127.0.0.1:{}", endpoint.port);
        Some(endpoint)
    }

    fn new(listener: TcpListener, limit: usize, head_wait: Duration) -> std::io::Result<Self> {
        Ok(Self {
            port: listener.local_addr()?.port(),
            token: rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect(),
            browser: uuid::Uuid::new_v4().to_string(),
            limit,
            head_wait,
            connections: AtomicUsize::new(0),
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
            clients.iter().filter(|c| c.target().is_some_and(|id| !current.iter().any(|n| n.id == id))).cloned().collect()
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
