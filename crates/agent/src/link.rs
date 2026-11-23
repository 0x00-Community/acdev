use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use acde_wire::channel::{API_LEVEL, Channel, Received};
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with};
use serde_json::{Value, json};

pub type Answer = Result<(Value, Option<OwnedFd>), String>;
type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Answer>>>>;

const USERS: &str = "/run/user";
const MANAGER: &str = ".acde-manager";

static SERIALS: AtomicU64 = AtomicU64::new(0);

pub struct Link {
    serial: u64,
    path: PathBuf,
    channel: Channel,
    pending: Pending,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
}

pub fn manager_socket() -> Result<PathBuf, String> {
    let uid = acdevd::seat::active_uid().ok_or("logind names no active session")?;
    let dir = Path::new(USERS).join(&uid);
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut found: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.to_str().is_some_and(|p| p.ends_with(MANAGER))).collect();
    found.sort();
    found.into_iter().next().ok_or_else(|| format!("the active session (user {uid}) has no session manager in {}", dir.display()))
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Link {
    pub fn open(path: &Path, key: &str, events: impl Fn(Value) + Send + 'static) -> Result<Arc<Self>, String> {
        let at = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
        let fd = socket_with(AddressFamily::UNIX, SocketType::SEQPACKET, SocketFlags::CLOEXEC, None).map_err(|e| at(&e))?;
        connect(&fd, &SocketAddrUnix::new(path).map_err(|e| at(&e))?).map_err(|e| at(&e))?;
        let channel = Channel::new(fd);
        channel.send(&json!({ "hello": { "api": API_LEVEL, "pid": std::process::id(), "dev_key": key } }), true).map_err(|e| at(&e))?;
        let welcome = match channel.receive(true).map_err(|e| at(&e))? {
            Received::Frame(frame) => frame,
            Received::Nothing | Received::Closed => return Err(at(&"the session manager closed before its welcome")),
        };
        if welcome["welcome"].is_null() {
            return Err(at(&format!("the session manager refused acdev's agent: {}", welcome["error"]["message"].as_str().unwrap_or("no reason given"))));
        }
        let reader = channel.try_clone().map_err(|e| at(&e))?;
        let (pending, alive) = (Pending::default(), Arc::new(AtomicBool::new(true)));
        let (told, lost) = (pending.clone(), alive.clone());
        let thread = move || {
            read(&reader, &told, events);
            lost.store(false, Ordering::Release);
            locked(&told).clear();
        };
        std::thread::Builder::new().name("acdev-agent-manager".into()).spawn(thread).map_err(|e| at(&e))?;
        Ok(Arc::new(Self { serial: SERIALS.fetch_add(1, Ordering::Relaxed), path: path.to_path_buf(), channel, pending, next: AtomicU64::new(0), alive }))
    }

    pub fn serial(&self) -> u64 {
        self.serial
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn call(&self, method: &str, arg: Value, within: Duration) -> Answer {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tell, answer) = mpsc::channel();
        locked(&self.pending).insert(id, tell);
        let asked = self.channel.send(&json!({ "id": id, "service": "dev", "method": method, "args": [arg] }), true);
        if let Err(why) = asked {
            locked(&self.pending).remove(&id);
            return Err(format!("dev.{method}: {why}"));
        }
        match answer.recv_timeout(within) {
            Ok(answered) => answered.map_err(|why| format!("dev.{method}: {why}")),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                locked(&self.pending).remove(&id);
                Err(format!("dev.{method}: the session manager gave no answer within {} s", within.as_secs_f32()))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("dev.{method}: the session manager went away")),
        }
    }
}

fn read(channel: &Channel, pending: &Pending, events: impl Fn(Value)) {
    loop {
        let (frame, fd) = match channel.receive_with_fd(true) {
            Ok((Received::Frame(frame), fd)) => (frame, fd),
            Ok((Received::Nothing, _)) => continue,
            Ok((Received::Closed, _)) => return log::info!("the session manager closed acdev's agent's channel"),
            Err(why) => return log::warn!("the session manager's channel: {why}"),
        };
        if let Some(event) = frame.get("event") {
            events(event.clone());
            continue;
        }
        let Some(id) = frame["id"].as_u64() else { continue };
        let answered = match frame.get("ok") {
            Some(ok) => Ok((ok.clone(), fd)),
            None => Err(frame["error"]["message"].as_str().unwrap_or("refused").to_string()),
        };
        if let Some(tell) = locked(pending).remove(&id) {
            _ = tell.send(answered);
        }
    }
}
