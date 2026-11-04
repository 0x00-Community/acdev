use crate::sync::Locked;
use crate::failure::{Code, Failure, Outcome};
use crate::js::JsFn;
use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Result};
use napi_derive::napi;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{Access, OFlags, access, fcntl_setfl};
use rustix::io::Errno;
use rustix::process::{Pid, Signal, kill_process_group};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    os::fd::OwnedFd,
    os::unix::process::ExitStatusExt,
    process::Child,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

const MAX_TERMINALS: usize = 8;
const ATTACH: Duration = Duration::from_secs(15);
const ENDED: Duration = Duration::from_secs(30);
const CWD_EVERY: Duration = Duration::from_secs(1);
const DRAIN: Duration = Duration::from_millis(300);
const KILL_AFTER: Duration = Duration::from_secs(3);
const BACKLOG_UNITS: usize = 256 * 1024;
const BATCH_BYTES: usize = 256 * 1024;
const LINGER_BYTES: usize = 64 * 1024;
const LINGER: Duration = Duration::from_millis(4);
const MAX_INPUT_UNITS: usize = 64 * 1024;

enum Listener {
    Js(JsFn<Value, 16>),
    Rust(Box<dyn Fn(Value) -> bool + Send + Sync>),
}

impl Listener {
    fn notify(&self, events: Value) -> bool {
        match self {
            Self::Js(callback) => {
                callback.notify(events, ThreadsafeFunctionCallMode::Blocking);
                true
            }
            Self::Rust(sink) => sink(events),
        }
    }
}

#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut start = 0;
        let keep = loop {
            match std::str::from_utf8(&self.pending[start..]) {
                Ok(_) => break 0,
                Err(error) => match error.error_len() {
                    None => break self.pending.len() - start - error.valid_up_to(),
                    Some(len) => start += error.valid_up_to() + len,
                },
            }
        };
        let rest = self.pending.split_off(self.pending.len() - keep);
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending = rest;
        text
    }
    fn end(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned()
    }
}

#[derive(Default)]
struct Deadlines {
    removal: Option<Instant>,
    kill: Option<Instant>,
}

#[derive(Default)]
struct State {
    listeners: Vec<Arc<Listener>>,
    backlog: VecDeque<Value>,
    backlog_units: usize,
    ended: bool,
    closed: bool,
    deadlines: Deadlines,
    input: Vec<u8>,
}

struct Session {
    id: String,
    pid: u32,
    master: Mutex<Option<Arc<OwnedFd>>>,
    wake: Wake,
    state: Mutex<State>,
    home: String,
}

impl Session {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.locked()
    }
    fn master(&self) -> Option<Arc<OwnedFd>> {
        self.master.locked().clone()
    }
    fn wake(&self) {
        self.wake.signal();
    }

    fn output(text: String) -> Value {
        json!({"type": "output", "data": text})
    }

    fn units(event: &Value) -> usize {
        event["data"].as_str().map_or(0, |data| data.encode_utf16().count())
    }

    fn emit(&self, events: Vec<Value>) {
        let events: Vec<Value> = events
            .into_iter()
            .filter(|e| e["type"] != "output" || e["data"].as_str().is_some_and(|d| !d.is_empty()))
            .collect();
        if events.is_empty() {
            return;
        }
        let listeners = {
            let mut state = self.state();
            if state.listeners.is_empty() {
                for event in events {
                    state.backlog_units += Self::units(&event);
                    state.backlog.push_back(event);
                }
                while state.backlog_units > BACKLOG_UNITS
                    && state.backlog.len() > 1
                    && state.backlog[0]["type"] == "output"
                {
                    let dropped = state.backlog.pop_front().unwrap_or_default();
                    state.backlog_units -= Self::units(&dropped);
                }
                return;
            }
            state.listeners.clone()
        };
        let batch = Value::Array(events);
        let gone: Vec<Arc<Listener>> = listeners.into_iter().filter(|listener| !listener.notify(batch.clone())).collect();
        if !gone.is_empty() {
            self.state().listeners.retain(|l| !gone.iter().any(|g| Arc::ptr_eq(l, g)));
        }
    }

    fn hang_up(&self) {
        if self.master.locked().take().is_some() {
            let mut state = self.state();
            if !state.ended {
                state.deadlines.kill = Some(Instant::now() + KILL_AFTER);
            }
        }
        self.wake();
    }

    fn display(&self, path: &str) -> String {
        match path.strip_prefix(self.home.as_str()) {
            Some("") => "~".into(),
            Some(rest) if rest.starts_with('/') => format!("~{rest}"),
            _ => path.into(),
        }
    }
}

struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Registry {
    fn sessions(&self) -> MutexGuard<'_, HashMap<String, Arc<Session>>> {
        self.sessions.locked()
    }
    fn get(&self, id: &str) -> Outcome<Arc<Session>> {
        self.sessions().get(id).cloned().ok_or_else(|| Failure::http(404, "no such terminal"))
    }
    fn close(&self, session: &Session) {
        self.sessions().remove(&session.id);
        let mut state = session.state();
        state.closed = true;
        state.deadlines.removal = None;
        drop(state);
        session.hang_up();
    }
}

struct Io<'a> {
    registry: &'a Registry,
    session: &'a Session,
    child: Child,
    pidfd: Option<OwnedFd>,
    decoder: Utf8Stream,
    exited: Option<(Instant, std::process::ExitStatus)>,
    drained: bool,
    cwd: String,
    next_cwd: Instant,
}

impl Io<'_> {
    fn run(mut self) {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let (closed, ended, deadlines, pending_input) = {
                let state = self.session.state();
                (state.closed, state.ended, [state.deadlines.removal, state.deadlines.kill], !state.input.is_empty())
            };
            if closed && ended && self.exited.is_some() {
                return;
            }
            let master = self.session.master().filter(|_| !self.drained);
            let now = Instant::now();
            let drain = self.exited.filter(|_| !ended).map(|(at, _)| at + DRAIN);
            let cwd = (!ended).then_some(self.next_cwd);
            let cwd = cwd.or((self.pidfd.is_none() && self.exited.is_none()).then(|| now + Duration::from_millis(100)));
            let next = deadlines.into_iter().flatten().chain(drain).chain(cwd).min();
            let timeout = next.and_then(|at| Timespec::try_from(at.saturating_duration_since(now).min(Duration::from_secs(60))).ok());
            let wake = &self.session.wake.read;
            let idle = PollFd::new(wake, PollFlags::empty());
            let events = PollFlags::IN | if pending_input { PollFlags::OUT } else { PollFlags::empty() };
            let mut fds = [
                PollFd::new(wake, PollFlags::IN),
                self.pidfd.as_ref().map_or(idle.clone(), |pidfd| PollFd::new(pidfd, PollFlags::IN)),
                master.as_deref().map_or(idle, |master| PollFd::new(master, events)),
            ];
            _ = poll(&mut fds, timeout.as_ref());
            let [woken, exited, ready] = fds.map(|fd| fd.revents());
            if !woken.is_empty() {
                self.session.wake.drain();
            }
            if let Some(master) = &master {
                if ready.contains(PollFlags::OUT) {
                    self.write(master);
                }
                if ready.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
                    self.read(master, &mut buffer);
                }
            }
            if !exited.is_empty() {
                self.reap();
            }
            self.tick();
        }
    }

    fn write(&self, master: &OwnedFd) {
        let mut state = self.session.state();
        while !state.input.is_empty() {
            match rustix::io::write(master, &state.input) {
                Ok(0) => return,
                Ok(wrote) => _ = state.input.drain(..wrote),
                Err(error) => {
                    if error != Errno::AGAIN {
                        state.input.clear();
                    }
                    return;
                }
            }
        }
    }

    fn read(&mut self, master: &OwnedFd, buffer: &mut [u8]) {
        let (mut text, mut total, started) = (String::new(), 0, Instant::now());
        'batch: loop {
            while total < BATCH_BYTES {
                match rustix::io::read(master, &mut *buffer) {
                    Ok(read) if read > 0 => {
                        total += read;
                        text.push_str(&self.decoder.push(&buffer[..read]));
                    }
                    Err(Errno::AGAIN) => break,
                    _ => {
                        self.drained = true;
                        break 'batch;
                    }
                }
            }
            if total == 0 || total >= LINGER_BYTES || started.elapsed() >= LINGER {
                break;
            }
            let mut more = [PollFd::new(master, PollFlags::IN)];
            if !matches!(poll(&mut more, Some(&Timespec { tv_sec: 0, tv_nsec: 1_000_000 })), Ok(1..)) {
                break;
            }
        }
        self.session.emit(vec![Session::output(text)]);
    }

    fn reap(&mut self) {
        if let Ok(Some(status)) = self.child.try_wait() {
            self.pidfd = None;
            if self.exited.is_none() {
                self.exited = Some((Instant::now(), status));
            }
        }
    }

    fn tick(&mut self) {
        if self.exited.is_none() && self.pidfd.is_none() {
            self.reap();
        }
        let now = Instant::now();
        let (ended, removal, kill) = {
            let state = self.session.state();
            (state.ended, state.deadlines.removal, state.deadlines.kill)
        };
        if !ended && now >= self.next_cwd {
            self.next_cwd = now + CWD_EVERY;
            if let Ok(path) = std::fs::read_link(format!("/proc/{}/cwd", self.session.pid)) {
                let path = self.session.display(&path.to_string_lossy());
                if path != self.cwd {
                    self.cwd = path.clone();
                    self.session.emit(vec![json!({"type": "cwd", "path": path})]);
                }
            }
        }
        if let Some((at, status)) = self.exited.filter(|_| !ended)
            && (self.drained || now >= at + DRAIN)
        {
            self.end(status);
        }
        if removal.is_some_and(|at| now >= at) {
            self.registry.close(self.session);
        }
        if kill.is_some_and(|at| now >= at) {
            self.session.state().deadlines.kill = None;
            if !self.session.state().ended
                && let Some(group) = Pid::from_raw(self.session.pid as i32)
            {
                _ = kill_process_group(group, Signal::KILL);
            }
        }
    }

    fn end(&mut self, status: std::process::ExitStatus) {
        let rest = self.decoder.end();
        let exit = json!({"type": "exit", "code": status.code(), "signal": status.signal()});
        self.session.emit(vec![Session::output(rest), exit]);
        let subscribed = {
            let mut state = self.session.state();
            state.ended = true;
            state.deadlines.kill = None;
            state.deadlines.removal = Some(Instant::now() + if state.listeners.is_empty() { ENDED } else { Duration::ZERO });
            !state.listeners.is_empty()
        };
        self.session.hang_up();
        if subscribed {
            self.registry.close(self.session);
        }
    }
}

#[napi]
pub struct Terminals {
    registry: Arc<Registry>,
    owner: bool,
}

impl Terminals {
    fn size(cols: f64, rows: f64) -> Outcome<(u32, u32)> {
        for (name, value) in [("cols", cols), ("rows", rows)] {
            if value.fract() != 0.0 || !(2.0..=1000.0).contains(&value) {
                return Err(Failure::invalid(format!("{name} must be an integer in [2, 1000]")));
            }
        }
        Ok((cols as u32, rows as u32))
    }

    fn login_shell() -> String {
        std::env::var("SHELL")
            .ok()
            .filter(|shell| shell.starts_with('/'))
            .filter(|shell| access(shell.as_str(), Access::EXEC_OK).is_ok())
            .unwrap_or_else(|| "/bin/bash".into())
    }

    fn start(&self, cols: u32, rows: u32) -> Outcome<String> {
        if self.registry.sessions().len() >= MAX_TERMINALS {
            return Err(Failure::http(429, format!("at most {MAX_TERMINALS} terminals")));
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let file = Self::login_shell();
        let mut command = std::process::Command::new(&file);
        command.arg("-l").envs([("TERM", "xterm-256color"), ("COLORTERM", "truecolor")]).current_dir(&home);
        let (master, child) = crate::pty::spawn(&mut command, cols, rows).map_err(|reason| {
            log::warn!("could not start {file} -l: {reason}");
            Failure::http(500, format!("could not start the terminal: {reason}"))
        })?;
        _ = fcntl_setfl(&master, OFlags::NONBLOCK);
        let wake = Wake::new().map_err(Failure::internal)?;
        let pid = child.id();
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            pid,
            master: Mutex::new(Some(Arc::new(master))),
            wake,
            state: Mutex::new(State {
                deadlines: Deadlines { removal: Some(Instant::now() + ATTACH), kill: None },
                ..State::default()
            }),
            home,
        });
        self.registry.sessions().insert(session.id.clone(), Arc::clone(&session));
        let (registry, id) = (Arc::clone(&self.registry), session.id.clone());
        std::thread::Builder::new()
            .name(format!("terminal-{pid}"))
            .spawn(move || {
                Io {
                    registry: &registry,
                    session: &session,
                    child,
                    pidfd: pidfd(pid),
                    decoder: Utf8Stream::default(),
                    exited: None,
                    drained: false,
                    cwd: String::new(),
                    next_cwd: Instant::now() + CWD_EVERY,
                }
                .run()
            })
            .map_err(Failure::internal)?;
        Ok(id)
    }
}

#[napi]
impl Terminals {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { registry: Arc::new(Registry { sessions: Mutex::default() }), owner: true }
    }

    #[napi]
    pub fn open(&self, cols: f64, rows: f64) -> Result<Value> {
        let (cols, rows) = Self::size(cols, rows)?;
        Ok(json!({"id": self.start(cols, rows)?}))
    }

    #[napi(ts_args_type = "id: string, callback: (events: Array<{ type: 'output', data: string } | { type: 'cwd', path: string } | { type: 'exit', code: number | null, signal: number | null }>) => void")]
    pub fn subscribe(&self, env: Env, id: String, callback: Unknown) -> Result<()> {
        let callback = Listener::Js(JsFn::new(&env, callback)?);
        Ok(self.attach(&id, callback)?)
    }

    #[napi]
    pub fn input(&self, id: String, data: String) -> Result<Value> {
        if data.encode_utf16().count() > MAX_INPUT_UNITS {
            return Err(Failure::invalid("data must be a string of at most 65536 characters").into());
        }
        let session = self.registry.get(&id)?;
        if session.master().is_some() {
            session.state().input.extend_from_slice(data.as_bytes());
            session.wake();
        }
        Ok(json!({"ok": true}))
    }

    #[napi]
    pub fn resize(&self, id: String, cols: f64, rows: f64) -> Result<Value> {
        let (c, r) = Self::size(cols, rows)?;
        let session = self.registry.get(&id)?;
        if let Some(master) = session.master() {
            crate::pty::set_size(&*master, c, r).map_err(|e| Failure::new(500, Code::Service("pty_failed".into()), e))?;
        }
        Ok(json!({"cols": c, "rows": r}))
    }

    #[napi]
    pub fn close(&self, id: String) -> Value {
        if let Ok(session) = self.registry.get(&id) {
            self.registry.close(&session);
        }
        json!({"closed": id})
    }

    #[napi]
    pub fn close_all(&self) {
        let sessions: Vec<_> = self.registry.sessions().values().cloned().collect();
        for session in sessions {
            self.registry.close(&session);
        }
    }
}

impl Terminals {
    pub fn listen(&self, id: &str, sink: impl Fn(Value) -> bool + Send + Sync + 'static) -> Result<()> {
        Ok(self.attach(id, Listener::Rust(Box::new(sink)))?)
    }

    pub fn shared(&self) -> Self {
        Self { registry: Arc::clone(&self.registry), owner: false }
    }

    fn attach(&self, id: &str, listener: Listener) -> Outcome<()> {
        let session = self.registry.get(id)?;
        let ended = {
            let mut state = session.state();
            state.deadlines.removal = None;
            let backlog: Vec<Value> = state.backlog.drain(..).collect();
            state.backlog_units = 0;
            if !backlog.is_empty() {
                listener.notify(Value::Array(backlog));
            }
            state.listeners.push(Arc::new(listener));
            state.ended
        };
        if ended {
            self.registry.close(&session);
        }
        Ok(())
    }
}

impl Default for Terminals {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        if self.owner {
            self.close_all();
        }
    }
}

#[cfg(target_os = "linux")]
fn pidfd(pid: u32) -> Option<OwnedFd> {
    Pid::from_raw(pid as i32).and_then(|pid| rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()).ok())
}

#[cfg(not(target_os = "linux"))]
fn pidfd(_: u32) -> Option<OwnedFd> {
    None
}

struct Wake {
    read: OwnedFd,
    write: OwnedFd,
}

impl Wake {
    #[cfg(target_os = "linux")]
    fn new() -> std::io::Result<Self> {
        let fd = rustix::event::eventfd(0, rustix::event::EventfdFlags::NONBLOCK | rustix::event::EventfdFlags::CLOEXEC)?;
        Ok(Self { write: fd.try_clone()?, read: fd })
    }

    #[cfg(not(target_os = "linux"))]
    fn new() -> std::io::Result<Self> {
        let (read, write) = std::os::unix::net::UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        Ok(Self { read: read.into(), write: write.into() })
    }

    fn signal(&self) {
        _ = rustix::io::write(&self.write, &1u64.to_ne_bytes());
    }

    fn drain(&self) {
        let mut buf = [0u8; 64];
        while matches!(rustix::io::read(&self.read, &mut buf), Ok(n) if n > 0) {}
    }
}
