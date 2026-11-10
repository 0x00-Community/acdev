//! The desk: the runtime's one shared table of windows, apps and isolates (AGENTS.md「运行时进程」, step 5). It holds
//! the acde_shell link to the compositor; every isolate gets an `Arc` of it and changes the table, or asks the
//! compositor, on its own thread. The compositor's events become [`Notice`]s here and go to the isolate they are for.

mod app;
mod files;
mod inspect;
mod js;
pub mod wire;
mod open;
mod session;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use acde_model::{Mode, Scope};
use acde_shell::compositor::{Grant, SURFACE_IDS};
use acde_shell::{Notice, Session};
use serde_json::{Value, json};

pub use app::{App, Capabilities, FsCap, Look, LookChange};
pub use inspect::{SnapshotOptions, Step};
pub use open::OpenOptions;
pub use session::End;
pub use js::{broker_object, clear, install};

use crate::isolate::{Grants, Handle, Place, Spec};
use crate::rt::Msg;
use files::{Download, Places, Xdg};

/// A refusal or failure an `acde:` call throws: `status` and `code` as on the Error the page sees.
#[derive(Debug)]
pub struct Failure {
    pub message: String,
    pub status: Option<i32>,
    pub code: &'static str,
}

impl Failure {
    pub(super) fn new(status: i32, code: &'static str, message: impl Into<String>) -> Self {
        Self { message: message.into(), status: Some(status), code }
    }

    pub(super) fn refused(who: &str, what: &str) -> Self {
        Self::new(403, "forbidden", format!("{who} may not use {what} (not in its manifest's capabilities)"))
    }

    pub(super) fn missing(message: impl Into<String>) -> Self {
        Self::new(404, "not_found", message)
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { message, status: None, code: "GenericFailure" }
    }
}

type Done<T> = Result<T, Failure>;

/// A window of the table. All windows are alike to the desk; one it opened for an app (`app`) has its content drawn by
/// that app's isolate, the others by whatever client made them.
struct Record {
    app: Option<Arc<App>>,
    app_id: Option<String>,
    title: Option<String>,
    /// The window isolate whose slot this window is in: a program it started with `launch(…, {slot: true})`.
    owner: Option<u32>,
    menus: Value,
    /// A request waiting for the app's window to start (or reload).
    request: Option<Value>,
    url: Option<String>,
    mode: Mode,
    hidden: bool,
}

/// A running desktop or window isolate.
struct Live {
    place: Place,
    name: String,
    app: Option<Arc<App>>,
    handle: Handle,
    serial: u64,
    /// Windows of the programs in its slots, with their pids.
    owns: HashMap<u32, u32>,
    closing: bool,
    reloading: bool,
    hung: bool,
}

impl Live {
    fn who(&self) -> &str {
        self.app.as_ref().map_or(self.place.name(), |a| a.label.as_str())
    }
}

/// What the desk asks of an isolate's JS and waits for (with a timeout).
#[derive(Clone, Copy)]
pub enum Ask {
    BeforeClose,
    Request,
    Menu,
    Inspect,
    DebugEval,
    DebugStats,
}

impl Ask {
    pub const fn name(self) -> &'static str {
        match self {
            Ask::BeforeClose => "beforeclose",
            Ask::Request => "request",
            Ask::Menu => "menu",
            Ask::Inspect => "inspect",
            Ask::DebugEval => "debug.eval",
            Ask::DebugStats => "debug.stats",
        }
    }
}

#[derive(Default)]
pub(super) struct State {
    pub(super) look: Look,
    apps: Vec<(Arc<App>, bool)>,
    records: HashMap<u32, Record>,
    live: HashMap<u32, Live>,
    claims: VecDeque<(u32, u32)>,
    panels: HashSet<u32>,
    placed: HashMap<u32, String>,
    children: Vec<u32>,
    serial: u64,
    stopped: bool,
}

/// The system objects isolates share (crates/runtime), made the first time a grant needs them.
#[derive(Default)]
struct System {
    workspace: Option<acde_runtime::Workspace>,
    terminals: Option<acde_runtime::Terminals>,
    networks: acde_runtime::Networks,
    office: Option<acde_runtime::OfficeService>,
}

pub struct Desk {
    session: Session,
    socket: String,
    state: Mutex<State>,
    system: Mutex<System>,
    broker: Sender<Msg>,
    next_window: AtomicU32,
    places: Mutex<Places>,
    inspector: Mutex<inspect::Inspector>,
    /// The AT-SPI connection, opened the first time a window no isolate draws is inspected (`None` inside: there is none).
    accessibility: Mutex<Option<Option<Arc<acde_runtime::Accessibility>>>>,
}

impl Desk {
    const HANG: Duration = Duration::from_secs(5);
    const CLOSE_WAIT: Duration = Duration::from_secs(3);
    const BROWSER: &str = "browser";

    /// Connects to the compositor (or starts it here) and starts the desk's thread. `broker` is the Broker's loop.
    pub fn open(broker: Sender<Msg>, look: Look) -> Result<Arc<Self>, String> {
        let (tx, rx) = mpsc::channel::<Notice>();
        let session = Session::open(Box::new(move |notice| _ = tx.send(notice)))?;
        let socket = session.socket_name();
        let places = Places::load(look.storage);
        let desk = Arc::new(Self {
            session,
            socket,
            state: Mutex::new(State { look, ..State::default() }),
            system: Mutex::default(),
            broker,
            next_window: AtomicU32::new(SURFACE_IDS),
            places: Mutex::new(places),
            inspector: Mutex::default(),
            accessibility: Mutex::new(None),
        });
        let weak = Arc::downgrade(&desk);
        std::thread::Builder::new().name("acde-desk".into()).spawn(move || Self::watch(&weak, &rx)).map_err(|e| e.to_string())?;
        Ok(desk)
    }

    pub(super) fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn link(&self) -> &acde_shell::Link {
        &self.session.link
    }

    pub fn socket(&self) -> &str {
        &self.socket
    }

    /// The desk's thread: the compositor's notices as they come, and once a second the hang check.
    fn watch(desk: &Weak<Self>, rx: &Receiver<Notice>) {
        loop {
            let notice = rx.recv_timeout(Duration::from_secs(1));
            let Some(desk) = desk.upgrade() else { return };
            match notice {
                Ok(notice) => desk.notice(notice),
                Err(mpsc::RecvTimeoutError::Timeout) => desk.hangs(),
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    // ---- delivery ----

    /// Posts a message to an isolate's `desk.onMessage` (events, screen, languages, color scheme, visibility).
    fn post(&self, state: &State, window: u32, message: Value) {
        if let Some(live) = state.live.get(&window) {
            match live.handle.in_kernel() {
                Some(kernel) => kernel.message(message),
                None => live.handle.task(Box::new(move |scope| js::message(scope, message))),
            }
        }
    }

    fn to_desktop(&self, state: &State, event: Value) {
        self.post(state, 0, json!({ "type": "events", "events": [event] }));
    }

    fn to_all(&self, state: &State, message: &Value) {
        for live in state.live.values() {
            let message = message.clone();
            match live.handle.in_kernel() {
                Some(kernel) => kernel.message(message),
                None => live.handle.task(Box::new(move |scope| js::message(scope, message))),
            }
        }
    }

    /// Tells the Broker (its `desk.onNotice`): the session ending, the desktop's exit, an isolate's end (its service
    /// calls fail), apps starting and stopping.
    pub(super) fn to_broker(&self, notice: Value) {
        _ = self.broker.send(Msg::Task(Box::new(move |scope| js::broker_notice(scope, notice))));
    }

    /// Asks an isolate's JS (`desk.onAsk`) and gives the answer on the receiver; dropped unanswered when it is gone.
    pub fn ask(&self, window: u32, ask: Ask, payload: Value) -> Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        if let Some(live) = self.state().live.get(&window) {
            match live.handle.in_kernel() {
                Some(kernel) => kernel.ask(ask, payload, tx),
                None => live.handle.task(Box::new(move |scope| js::ask(scope, ask, payload, tx))),
            }
        }
        rx
    }

    // ---- the compositor's notices ----

    fn window_event(kind: &str, window: u32) -> Value {
        json!({ "type": kind, "window": window })
    }

    fn notice(&self, notice: Notice) {
        let mut guard = self.state();
        let state = &mut *guard;
        match notice {
            Notice::Exit => {
                drop(guard);
                return self.to_broker(json!({ "type": "exit" }));
            }
            Notice::Milestone { title, time_ms } => {
                drop(guard);
                return self.to_broker(json!({ "type": "milestone", "title": title, "time": time_ms }));
            }
            Notice::Output { width, height, scale } => {
                let was = state.look.screen();
                (state.look.width, state.look.height, state.look.scale) = (width.into(), height.into(), scale);
                let screen = state.look.screen();
                if screen != was {
                    let mut message = screen;
                    message["type"] = "screen".into();
                    self.to_all(state, &message);
                }
                return;
            }
            Notice::Shortcut { owner, key, scope } => {
                let event = json!({ "type": "shortcut", "window": owner, "key": key, "title": scope.map(Scope::as_str) });
                let to = if scope == Some(Scope::App) && state.live.contains_key(&owner) { owner } else { 0 };
                return self.post(state, to, json!({ "type": "events", "events": [event] }));
            }
            Notice::Gone { window, rect } => {
                if let Some(app) = state.placed.get(&window) {
                    self.places.lock().unwrap_or_else(|e| e.into_inner()).set(app, rect);
                    if !state.records.contains_key(&window) {
                        state.placed.remove(&window);
                    }
                }
                return;
            }
            Notice::InputTarget { .. } => return,
            _ => {}
        }
        let (window, event) = match &notice {
            Notice::Open { window, title, app_id } => (*window, json!({ "type": "windowopen", "window": window, "title": title, "appId": app_id })),
            Notice::Close { window } => (*window, Self::window_event("windowclose", *window)),
            Notice::Title { window, title, app_id } => (*window, json!({ "type": "windowtitle", "window": window, "title": title, "appId": app_id })),
            Notice::Fullscreen { window, on } => (*window, Self::window_event(if *on { "windowfullscreen" } else { "windowunfullscreen" }, *window)),
            Notice::Minimize { window } => (*window, Self::window_event("windowminimize", *window)),
            Notice::Activate { window } => (*window, Self::window_event("windowactivate", *window)),
            Notice::Animated { window } => (*window, Self::window_event("windowanimated", *window)),
            Notice::MinSize { window, width, height } => (*window, json!({ "type": "windowminsize", "window": window, "width": width, "height": height })),
            Notice::Parent { window, parent } => (*window, json!({ "type": "windowparent", "window": window, "parent": parent })),
            _ => return,
        };
        if state.records.get(&window).is_some_and(|r| r.app.is_some()) {
            return self.to_desktop(state, event);
        }
        if let Notice::Open { title, app_id, .. } = notice {
            let claim = state.claims.pop_front();
            let owner = claim.map(|(owner, _)| owner);
            state.records.insert(window, Record { app: None, app_id, title, owner, menus: Value::Array(vec![]), request: None, url: None, mode: Mode::Free, hidden: false });
            if let Some((owner, pid)) = claim
                && let Some(live) = state.live.get_mut(&owner)
            {
                live.owns.insert(window, pid);
                return self.post(state, owner, json!({ "type": "events", "events": [event] }));
            }
            return self.to_desktop(state, event);
        }
        let closed = matches!(notice, Notice::Close { .. });
        let Some(record) = state.records.get_mut(&window) else { return self.to_desktop(state, event) };
        if let Notice::Title { title, app_id, .. } = notice {
            record.title = title.or(record.title.take());
            record.app_id = app_id.or(record.app_id.take());
        }
        let owner = record.owner;
        if closed {
            state.records.remove(&window);
            if let Some(live) = owner.and_then(|o| state.live.get_mut(&o)) {
                live.owns.remove(&window);
            }
        }
        match owner {
            Some(owner) => self.post(state, owner, json!({ "type": "events", "events": [event] })),
            None => self.to_desktop(state, event),
        }
    }

    /// Windows whose current task has run too long (or has come back): `windowhang` / `windowresponsive` to the desktop.
    fn hangs(&self) {
        let mut guard = self.state();
        let state = &mut *guard;
        let mut events = Vec::new();
        for (window, live) in state.live.iter_mut().filter(|(_, l)| !l.closing) {
            let busy = live.handle.busy() >= Self::HANG;
            if live.hung == busy {
                continue;
            }
            live.hung = busy;
            if busy {
                log::warn!("[{}] not answering for {} s", live.name, Self::HANG.as_secs());
            }
            if live.place == Place::Window {
                events.push(Self::window_event(if busy { "windowhang" } else { "windowresponsive" }, *window));
            }
        }
        for event in events {
            self.to_desktop(state, event);
        }
    }

    // ---- isolates ----

    /// A compositor grant: the window id (0 for the desktop) and the token its client claims the surface with.
    fn grant(&self, window: Option<u32>, desktop: bool, mode: Mode, rect: Option<[i32; 4]>, size: Option<[i32; 2]>) -> (u32, u64) {
        use std::hash::{BuildHasher, Hasher};
        let id = if desktop { 0 } else { window.unwrap_or_else(|| self.next_window.fetch_add(1, Ordering::Relaxed)) };
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(id);
        let token = hasher.finish();
        self.link().grant(token, Grant { id, desktop, mode, rect, size });
        (id, token)
    }

    /// The system objects an isolate gets: everything for the desktop (`None`), the manifest's for an app.
    fn grants(&self, caps: Option<&Capabilities>) -> Grants {
        let mut system = self.system.lock().unwrap_or_else(|e| e.into_inner());
        let fs = match caps.map(|c| &c.fs) {
            None => Some(None),
            Some(Some(FsCap::All(true))) => Some(None),
            Some(Some(FsCap::Roots { roots })) => Some(Some(roots.clone())),
            Some(_) => None,
        };
        let all = caps.is_none();
        Grants {
            fs: fs.map(|roots| system.workspace.get_or_insert_with(acde_runtime::Workspace::new).scoped(roots)),
            terminal: (all || caps.is_some_and(|c| c.terminal)).then(|| system.terminals.get_or_insert_with(acde_runtime::Terminals::new).shared()),
            network: (all || caps.is_some_and(|c| c.network)).then(|| system.networks.clone()),
            office: system.office.clone().filter(|_| all || caps.is_some_and(|c| c.office)),
        }
    }

    fn init(state: &State, place: Place, name: &str, window: u32) -> Value {
        let look = &state.look;
        json!({
            "place": place.name(),
            "name": name,
            "window": window,
            "width": look.width,
            "height": look.height,
            "scale": look.scale,
            "screen": look.screen(),
            "reducedMotion": look.reduced_motion,
            "dark": look.dark,
            "languages": look.languages,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn start(self: &Arc<Self>, state: &mut State, place: Place, name: String, window: u32, token: u64, init: Value, app: Option<Arc<App>>, heap_mb: f64, storage: Option<std::path::PathBuf>) -> Result<(), String> {
        state.serial += 1;
        let serial = state.serial;
        let mut env = state.look.env.clone();
        env.push(("WAYLAND_DISPLAY".into(), self.socket.clone()));
        let grants = self.grants(app.as_ref().map(|a| &a.capabilities));
        let spec = Spec { place, name: name.clone(), window, serial, init, heap_mb, env, grants, storage, token, desk: self.clone() };
        let handle = spec.spawn()?;
        state.live.insert(window, Live { place, name, app, handle, serial, owns: HashMap::new(), closing: false, reloading: false, hung: false });
        Ok(())
    }

    /// Starts the desktop isolate (the Broker does, at start and after the desktop stopped or was switched).
    pub fn open_desktop(self: &Arc<Self>, html: Option<String>, standalone: Option<String>, storage: Option<std::path::PathBuf>, heap_mb: f64) -> Result<(), String> {
        let (_, token) = self.grant(None, true, Mode::Fullscreen, None, None);
        let mut guard = self.state();
        let state = &mut *guard;
        let mut init = Self::init(state, Place::Desktop, "desktop", 0);
        init["services"] = state.look.shapes(None);
        init["modules"] = Self::session_modules(None);
        init["resources"] = serde_json::to_value(&state.look.resources).unwrap_or_default();
        init["html"] = html.into();
        init["standalone"] = standalone.into();
        self.start(state, Place::Desktop, "desktop".into(), 0, token, init, None, heap_mb, storage)?;
        let announced: Vec<Value> = state.records.iter().filter(|(_, r)| r.owner.is_none()).flat_map(|(id, r)| Self::announce(*id, r)).collect();
        for event in announced {
            self.to_desktop(state, event);
        }
        Ok(())
    }

    /// The events that tell a (new) desktop about a window it has not heard of.
    fn announce(id: u32, record: &Record) -> Vec<Value> {
        let app = record.app.as_ref().map(|a| a.id.clone()).or(record.app_id.clone());
        let mut events = vec![json!({ "type": "windowopen", "window": id, "appId": app, "title": record.title })];
        if record.menus.as_array().is_some_and(|m| !m.is_empty()) {
            events.push(json!({ "type": "windowmenus", "window": id, "menus": record.menus }));
        }
        events
    }

    fn spawn_window(self: &Arc<Self>, state: &mut State, window: u32, token: u64) -> Result<(), String> {
        let Some(record) = state.records.get_mut(&window) else { return Err(format!("no window {window}")) };
        let Some(app) = record.app.clone() else { return Err(format!("window {window} is not an app's")) };
        let request = record.request.take();
        let url = record.url.clone();
        let hidden = record.hidden;
        state.placed.insert(window, app.id.clone());
        let name = format!("{}#{window}", app.id);
        let mut init = Self::init(state, Place::Window, &name, window);
        let scale = state.look.scale;
        init["width"] = (800.0 * scale).into();
        init["height"] = (600.0 * scale).into();
        init["services"] = state.look.shapes(Some(&app.capabilities));
        init["modules"] = Self::session_modules(Some(&app.capabilities));
        init["resources"] = serde_json::to_value(state.look.resources_for(&app)).unwrap_or_default();
        init["app"] = app.raw.clone();
        init["theme"] = state.look.theme.clone().into();
        init["frame"] = state.look.frame.clone().filter(|_| app.frame).into();
        init["frameStyle"] = std::env::var("ACDE_FRAME_STYLE").ok().filter(|s| s == "mac" || s == "windows").into();
        init["request"] = request.unwrap_or(Value::Null);
        init["url"] = url.into();
        if app.backend.is_some() {
            init["sockets"] = Xdg::app_sockets(&app.id).to_string_lossy().into_owned().into();
        }
        let storage = Xdg::app_storage(&app.id, state.look.storage);
        self.start(state, Place::Window, name, window, token, init, Some(app.clone()), app.heap_mb, storage)?;
        if hidden {
            self.post(state, window, json!({ "type": "visible", "visible": false }));
        }
        Ok(())
    }

    /// An isolate's thread ended (called on that thread, after its isolate is gone).
    pub fn exited(self: &Arc<Self>, window: u32, serial: u64, code: i32, reason: Option<String>) {
        let mut guard = self.state();
        let state = &mut *guard;
        if state.live.get(&window).is_none_or(|l| l.serial != serial) {
            return;
        }
        let Some(live) = state.live.remove(&window) else { return };
        self.to_broker(json!({ "type": "isolateexit", "window": window }));
        if live.place == Place::Desktop {
            drop(guard);
            return self.to_broker(json!({ "type": "desktopexit", "code": code, "reason": reason, "closing": live.closing }));
        }
        state.claims.retain(|(owner, _)| *owner != window);
        self.close_programs(&live.owns);
        if state.stopped && live.closing {
            return;
        }
        if live.reloading && !live.closing && state.records.contains_key(&window) {
            let (mode, size) = state.records.get(&window).map(|r| (r.mode, r.app.as_ref().and_then(|a| a.size))).unwrap_or((Mode::Free, None));
            let (_, token) = self.grant(Some(window), false, mode, None, size.map(|s| s.map(|n| n as i32)));
            if let Err(e) = self.spawn_window(state, window, token) {
                log::error!("[{}] reload: {e}", live.name);
            } else {
                return;
            }
        }
        if !live.closing {
            let why = reason.unwrap_or_else(|| if code == 0 { "exit".into() } else { format!("exit {code}") });
            log::warn!("[{}] stopped ({why})", live.name);
            self.to_desktop(state, json!({ "type": "windowcrash", "window": window, "reason": why }));
        }
        self.forget(state, window);
    }

    fn forget(self: &Arc<Self>, state: &mut State, window: u32) {
        let Some(record) = state.records.remove(&window) else { return };
        self.link().release(window);
        self.to_desktop(state, Self::window_event("windowclose", window));
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(Self::CLOSE_WAIT);
            if let Some(desk) = weak.upgrade() {
                let mut state = desk.state();
                if !state.records.contains_key(&window) {
                    state.placed.remove(&window);
                }
            }
        });
        if let Some(app) = record.app.filter(|a| a.backend.is_some())
            && !Self::running(state, &app.id)
        {
            self.to_broker(json!({ "type": "appstop", "app": app.id }));
        }
    }

    /// Closes the windows in a window's slots, and SIGTERMs their programs if still there after the close wait.
    fn close_programs(&self, owns: &HashMap<u32, u32>) {
        let owned: Vec<(u32, u32)> = owns.iter().map(|(w, p)| (*w, *p)).collect();
        for (id, _) in &owned {
            self.link().close(*id);
        }
        if owned.is_empty() {
            return;
        }
        std::thread::spawn(move || {
            std::thread::sleep(Self::CLOSE_WAIT);
            for (_, pid) in owned.into_iter().filter(|(_, pid)| *pid > 0) {
                if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
                    _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
                }
            }
        });
    }

    fn running(state: &State, app: &str) -> bool {
        state.records.values().any(|r| r.app.as_ref().is_some_and(|a| a.id == app))
    }

    fn running_window(state: &State, app: &str) -> Option<u32> {
        state.records.iter().find(|(_, r)| r.app.as_ref().is_some_and(|a| a.id == app)).map(|(id, _)| *id)
    }

    // ---- apps ----

    pub fn set_apps(&self, apps: Vec<(Arc<App>, bool)>) {
        self.state().apps = apps;
    }

    pub fn change_look(&self, change: LookChange) {
        let mut state = self.state();
        let dark = change.dark;
        let languages = change.languages.clone();
        state.look.apply(change);
        if let Some(dark) = dark {
            self.to_all(&state, &json!({ "type": "colorscheme", "dark": dark }));
        }
        if let Some(Value::Object(mut languages)) = languages {
            languages.insert("type".into(), "languages".into());
            self.to_all(&state, &Value::Object(languages));
        }
    }

    pub fn app_list(&self) -> Value {
        Value::Array(self.state().apps.iter().filter(|(_, available)| *available).map(|(a, _)| a.listing()).collect())
    }

    /// Opens `app` (or hands `request` to its running window when it is single-window): `apps.launch` / `open`.
    pub fn launch(self: &Arc<Self>, app_id: &str, request: Option<Value>, mode: Mode) -> Done<u32> {
        let mut guard = self.state();
        let state = &mut *guard;
        let Some((app, available)) = state.apps.iter().find(|(a, _)| a.id == app_id).cloned() else {
            return Err(Failure::missing(format!("no app {app_id}")));
        };
        if !available {
            return Err(Failure::new(503, "unavailable", format!("{}: the system service it needs is not running", app.label)));
        }
        let running = Self::running_window(state, app_id);
        if !app.multiple
            && let Some(window) = running
        {
            if let Some(request) = request {
                self.deliver(state, window, request);
            }
            return Ok(window);
        }
        let screen = state.look.screen();
        let screen = [screen["width"].as_f64().unwrap_or(0.0), screen["height"].as_f64().unwrap_or(0.0)];
        let rect = (mode == Mode::Free && running.is_none()).then(|| self.places.lock().unwrap_or_else(|e| e.into_inner()).get(app_id, screen)).flatten();
        let size = rect.is_none().then(|| app.size.map(|s| s.map(|n| n as i32))).flatten();
        let (window, token) = self.grant(None, false, mode, rect, size);
        let record = Record { app: Some(app.clone()), app_id: Some(app.id.clone()), title: Some(app.label.clone()), owner: None, menus: Value::Array(vec![]), request, url: None, mode, hidden: false };
        let events = Self::announce(window, &record);
        state.records.insert(window, record);
        self.spawn_window(state, window, token)?;
        for event in events {
            self.to_desktop(state, event);
        }
        if app.backend.is_some() {
            self.to_broker(json!({ "type": "appstart", "app": app.id }));
        }
        Ok(window)
    }

    /// A request for an app's running window: to its `request` handlers, or kept for its next start.
    fn deliver(&self, state: &mut State, window: u32, request: Value) {
        if state.live.contains_key(&window) {
            drop(self.ask_locked(state, window, Ask::Request, request));
        } else if let Some(record) = state.records.get_mut(&window) {
            record.request = Some(request);
        }
    }

    fn ask_locked(&self, state: &State, window: u32, ask: Ask, payload: Value) -> Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        if let Some(live) = state.live.get(&window) {
            match live.handle.in_kernel() {
                Some(kernel) => kernel.ask(ask, payload, tx),
                None => live.handle.task(Box::new(move |scope| js::ask(scope, ask, payload, tx))),
            }
        }
        rx
    }

    /// Shows a window, focuses it and tells the desktop (`windowshow`): opened from outside, as a file handed to it.
    pub fn raise(&self, window: u32) {
        self.hide(window, false);
        self.link().focus(window);
        let state = self.state();
        self.to_desktop(&state, Self::window_event("windowshow", window));
    }

    /// An event for the desktop from the Broker (`appschanged`).
    pub fn tell_desktop(&self, event: Value) {
        let state = self.state();
        self.to_desktop(&state, event);
    }

    pub fn running_app(&self, app: &str) -> bool {
        Self::running(&self.state(), app)
    }

    // ---- what isolates do ----

    fn caller<R>(&self, window: u32, f: impl FnOnce(&State, &Live) -> R) -> Option<R> {
        let state = self.state();
        let live = state.live.get(&window)?;
        Some(f(&state, live))
    }

    /// Whether the caller is the desktop, or else its label (for refusals) and capabilities.
    pub(super) fn rights(&self, window: u32) -> (bool, String, Capabilities) {
        self.caller(window, |_, l| (l.place == Place::Desktop, l.who().to_owned(), l.app.as_ref().map(|a| a.capabilities.clone()).unwrap_or_default()))
            .unwrap_or((false, "an isolate that stopped".into(), Capabilities::default()))
    }

    pub(super) fn desktop_only(&self, caller: u32, what: &str) -> Done<()> {
        let (desktop, who, _) = self.rights(caller);
        if desktop { Ok(()) } else { Err(Failure::refused(&who, what)) }
    }

    pub fn hide(&self, window: u32, hidden: bool) {
        self.link().hide(window, hidden);
        let mut state = self.state();
        let Some(record) = state.records.get_mut(&window) else { return };
        if record.hidden == hidden {
            return;
        }
        record.hidden = hidden;
        self.post(&state, window, json!({ "type": "visible", "visible": !hidden }));
    }

    /// `windows.launch`: starts a program; in the caller's slots when `slot` (a window's, closed with it).
    pub fn start_program(&self, caller: u32, argv: &[String], cwd: Option<&str>, env: &[(String, String)], slot: bool) -> Done<u32> {
        let (desktop, who, caps) = self.rights(caller);
        let slot = slot && !desktop;
        if !desktop && !(if slot { caps.slots } else { caps.launch }) {
            return Err(Failure::refused(&who, if slot { "programs in its slots" } else { "starting programs" }));
        }
        let pid = self.link().launch(argv, cwd, env.iter().map(|(k, v)| (k, v)))?;
        let mut state = self.state();
        state.children.push(pid);
        if slot {
            state.claims.push_back((caller, pid));
        }
        Ok(pid)
    }

    /// The Broker's own starts (input method, autostart, `--launch`): no rights to check, ended with the session.
    pub fn launch_session(&self, argv: &[String], cwd: Option<&str>, env: &[(String, String)]) -> Result<u32, String> {
        let pid = self.link().launch(argv, cwd, env.iter().map(|(k, v)| (k, v)))?;
        self.state().children.push(pid);
        Ok(pid)
    }

    /// The pids of the programs the session started (ended with it).
    pub fn children(&self) -> Vec<u32> {
        std::mem::take(&mut self.state().children)
    }

    fn mine(&self, caller: u32, window: u32) -> bool {
        self.caller(caller, |_, l| l.place == Place::Desktop || l.owns.contains_key(&window)).unwrap_or(false)
    }

    /// `windows.close`: the window is asked to close (its isolate's `beforeclose`, or the client's xdg close).
    pub fn close(self: &Arc<Self>, caller: u32, window: u32) -> Done<bool> {
        if !self.mine(caller, window) {
            let (_, who, _) = self.rights(caller);
            return Err(Failure::refused(&who, &format!("window {window}")));
        }
        Ok(self.close_window(window, false))
    }

    pub fn kill(self: &Arc<Self>, caller: u32, window: u32) -> Done<bool> {
        self.desktop_only(caller, &format!("window {window}"))?;
        Ok(self.close_window(window, true))
    }

    /// Closes a window (blocking: run it off the caller's loop). One whose isolate the desk runs is asked unless `force`,
    /// then its isolate ends; any other is asked by the compositor (the client decides).
    pub fn close_window(self: &Arc<Self>, window: u32, force: bool) -> bool {
        let (live, opened) = {
            let state = self.state();
            let Some(record) = state.records.get(&window) else { return false };
            (state.live.contains_key(&window), record.app.is_some())
        };
        if !live && !opened {
            self.link().close(window);
            return true;
        }
        if live && !force && self.ask(window, Ask::BeforeClose, Value::Null).recv_timeout(Self::CLOSE_WAIT) == Ok(Value::Bool(false)) {
            return false;
        }
        let mut state = self.state();
        match state.live.get_mut(&window) {
            Some(live) => {
                live.closing = true;
                live.handle.terminate();
                drop(state);
                self.wait_gone(window);
            }
            None => self.forget(&mut state, window),
        }
        true
    }

    fn wait_gone(&self, window: u32) {
        let until = std::time::Instant::now() + Self::CLOSE_WAIT;
        while self.state().live.contains_key(&window) && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn invoke_menu(&self, caller: u32, window: u32, menu: Value, item: Value) -> Done<Receiver<Value>> {
        self.desktop_only(caller, &format!("the menus of window {window}"))?;
        Ok(self.ask(window, Ask::Menu, json!([menu, item])))
    }

    pub fn shortcut(&self, caller: u32, combo: String, scope: Option<Scope>, on: bool) -> Done<()> {
        let (desktop, who, _) = self.rights(caller);
        let (scope, owner) = match (desktop, scope) {
            (true, Some(scope @ (Scope::Session | Scope::Desktop))) => (scope, 0),
            (true, None) => (Scope::Desktop, 0),
            (false, None) => (Scope::App, caller),
            (_, Some(scope)) => return Err(Failure::refused(&who, &format!("{} shortcuts", scope.as_str()))),
        };
        if on {
            self.link().shortcut(combo, scope, owner)?;
        } else {
            self.link().unshortcut(combo, scope, owner);
        }
        Ok(())
    }

    /// Saves the screen as a PNG: `path`, or a new file in the user's pictures folder. Blocking (off the caller's loop).
    pub fn screenshot(&self, path: Option<String>) -> Done<Value> {
        let path = path.map(std::path::PathBuf::from).unwrap_or_else(|| {
            let stamp = chrono_stamp();
            Xdg::user("PICTURES", "Pictures").join(format!("截图 {stamp}.png"))
        });
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let shown = path.to_string_lossy().into_owned();
        let (width, height) = self.link().screenshot(shown.clone()).recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())??;
        Ok(json!({ "path": shown, "width": width, "height": height }))
    }

    // ---- panels (the desktop's pinned elements) ----

    pub fn panel_open(&self, caller: u32, rect: [i32; 4]) -> Done<(u32, u64)> {
        self.desktop_only(caller, "pinned panels")?;
        let (window, token) = self.grant(None, false, Mode::Pinned, Some(rect), None);
        self.state().panels.insert(window);
        Ok((window, token))
    }

    pub fn panel_place(&self, caller: u32, window: u32, [x, y, width, height]: [i32; 4]) -> Done<()> {
        self.desktop_only(caller, "pinned panels")?;
        if !self.state().panels.contains(&window) {
            return Err(Failure::refused("the desktop", &format!("window {window}")));
        }
        if width <= 0 || height <= 0 {
            self.link().hide(window, true);
        } else {
            self.link().place(window, [x, y, width, height]);
            self.link().hide(window, false);
        }
        Ok(())
    }

    pub fn panel_close(&self, caller: u32, window: u32) -> Done<()> {
        self.desktop_only(caller, "pinned panels")?;
        if self.state().panels.remove(&window) {
            self.link().release(window);
        }
        Ok(())
    }

    pub fn is_panel(&self, window: u32) -> bool {
        self.state().panels.contains(&window)
    }

    // ---- a window about itself ----

    fn own_record<R>(&self, caller: u32, f: impl FnOnce(&Self, &mut State, u32) -> R) -> Done<R> {
        let mut state = self.state();
        if state.live.get(&caller).is_none_or(|l| l.place != Place::Window) || !state.records.contains_key(&caller) {
            return Err(Failure::from("acde.window: only a window isolate has a window".to_owned()));
        }
        Ok(f(self, &mut state, caller))
    }

    pub fn set_title(&self, caller: u32, title: String) -> Done<()> {
        self.own_record(caller, |desk, state, id| {
            let app = state.records.get(&id).and_then(|r| r.app.as_ref()).map(|a| a.id.clone());
            if let Some(record) = state.records.get_mut(&id) {
                record.title = Some(title.clone());
            }
            desk.to_desktop(state, json!({ "type": "windowtitle", "window": id, "appId": app, "title": title }));
        })
    }

    pub fn set_menus(&self, caller: u32, menus: Value) -> Done<()> {
        self.own_record(caller, |desk, state, id| {
            if let Some(record) = state.records.get_mut(&id) {
                record.menus = menus.clone();
            }
            desk.to_desktop(state, json!({ "type": "windowmenus", "window": id, "menus": menus }));
        })
    }

    /// `minimize` / `requestAttention` / `ready`: told to the desktop, which decides.
    pub fn tell(&self, caller: u32, kind: &'static str) -> Done<()> {
        self.own_record(caller, |desk, state, id| desk.to_desktop(state, Self::window_event(kind, id)))
    }

    /// Ends the window's isolate and starts it again (at `url`, an own-origin page, when given).
    pub fn reload(&self, caller: u32, url: Option<String>) -> Done<bool> {
        self.own_record(caller, |_, state, id| {
            if url.as_deref().is_some_and(|u| !u.starts_with("http://acde.local/")) {
                return false;
            }
            if let (Some(url), Some(record)) = (url, state.records.get_mut(&id)) {
                record.url = Some(url);
            }
            let Some(live) = state.live.get_mut(&id).filter(|l| !l.closing) else { return false };
            live.reloading = true;
            live.handle.terminate();
            true
        })
    }

    /// An http(s) link the page could not open itself: to the `browser` app.
    pub fn open_url(self: &Arc<Self>, caller: u32, url: &str) -> Done<bool> {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Ok(false);
        }
        let name = self.caller(caller, |_, l| l.name.clone()).unwrap_or_default();
        match self.launch(Self::BROWSER, Some(json!({ "url": url })), Mode::Free) {
            Ok(_) => Ok(true),
            Err(e) => {
                log::warn!("[{name}] opens {url}: {}", e.message);
                Ok(false)
            }
        }
    }

    // ---- what a page asks for that is not its own to do ----

    pub fn shown(&self, caller: u32) {
        if self.caller(caller, |_, l| l.place == Place::Desktop) == Some(true) {
            self.to_broker(json!({ "type": "desktopshown" }));
        }
    }

    pub fn download(&self, caller: u32, name: &str, kind: &str, bytes: &[u8]) -> Done<String> {
        let path = Download::save(name, kind, bytes).map_err(|e| format!("download: {e}"))?;
        let shown = path.to_string_lossy().into_owned();
        let state = self.state();
        let (who, app) = state.live.get(&caller).map(|l| (l.name.clone(), l.app.as_ref().map(|a| a.id.clone()))).unwrap_or_default();
        log::info!("[{who}] saved {shown} ({} bytes)", bytes.len());
        let file = path.file_name().map(|n| n.to_string_lossy().into_owned());
        self.to_desktop(&state, json!({ "type": "download", "window": caller, "app": app, "path": shown, "name": file, "size": bytes.len() }));
        Ok(shown)
    }

    pub fn notify(&self, caller: u32, notification: &Value) {
        let text = |key: &str, max: usize| notification.get(key).and_then(Value::as_str).unwrap_or_default().chars().take(max).collect::<String>();
        let icon = text("icon", 256 * 1024);
        let icon = if icon.starts_with("data:image/") || icon.starts_with("http://acde.local/") { icon } else { String::new() };
        let state = self.state();
        let app = state.live.get(&caller).and_then(|l| l.app.clone());
        let event = json!({
            "type": "notification", "window": caller, "app": app.as_ref().map(|a| &a.id), "label": app.as_ref().map(|a| &a.label),
            "title": text("title", 200), "body": text("body", 2000), "icon": icon, "tag": text("tag", 200),
        });
        self.to_desktop(&state, event);
    }

    // ---- services (step 6): calls to the desktop package's services in the Broker ----

    /// A message from the isolate of `window` to the Broker's services.
    pub fn service_to_broker(&self, window: u32, bytes: Vec<u8>) {
        _ = self.broker.send(Msg::Task(Box::new(move |scope| js::broker_service(scope, window, &bytes))));
    }

    /// The Broker's answer (or callback) to the isolate of `window`.
    pub fn service_to_isolate(&self, window: u32, bytes: Vec<u8>) {
        if let Some(live) = self.state().live.get(&window) {
            match live.handle.in_kernel() {
                Some(kernel) => kernel.service(bytes),
                None => live.handle.task(Box::new(move |scope| js::service_in(scope, &bytes))),
            }
        }
    }

    /// Who is calling the Broker's services: `{place, name, app}` (`app`: the manifest, `null` for the desktop).
    pub fn caller_info(&self, window: u32) -> Value {
        self.caller(window, |_, l| json!({ "place": l.place.name(), "name": l.name, "app": l.app.as_ref().map(|a| a.raw.clone()) })).unwrap_or(Value::Null)
    }

    // ---- for the Broker ----

    /// The window table rows the Broker's inspect and debug use: `{id, app, title, page}` (`page`: its isolate runs).
    pub fn records(&self) -> Value {
        let state = self.state();
        let rows = state.records.iter().map(|(id, r)| {
            json!({ "id": id, "app": r.app.as_ref().map(|a| a.id.clone()).or(r.app_id.clone()), "title": r.title, "page": state.live.contains_key(id) })
        });
        Value::Array(rows.collect())
    }

    /// The window a running isolate is for, by its name (`desktop`, `files#1048576`).
    pub fn named(&self, name: &str) -> Option<u32> {
        self.state().live.iter().find(|(_, l)| l.name == name).map(|(w, _)| *w)
    }

    /// Per isolate: its name and the thread's numbers (`cpuMs`, `externalMb`), for `DebugApi.stats`.
    pub fn isolates(&self) -> Vec<(u32, String, f64, f64)> {
        self.state().live.iter().map(|(w, l)| (*w, l.name.clone(), l.handle.cpu_ms(), l.handle.external_mb())).collect()
    }

    pub fn open_office(&self) -> Result<(), String> {
        let mut system = self.system.lock().unwrap_or_else(|e| e.into_inner());
        if system.office.is_none() {
            let workspace = system.workspace.get_or_insert_with(acde_runtime::Workspace::new).scoped(None);
            system.office = Some(acde_runtime::OfficeService::open(&workspace)?);
        }
        Ok(())
    }

    pub fn close_office(&self) {
        if let Some(office) = self.system.lock().unwrap_or_else(|e| e.into_inner()).office.take() {
            office.close();
        }
    }

    /// Ends the desktop's isolate (switching desktops). Blocking.
    pub fn close_desktop(&self) {
        if let Some(live) = self.state().live.get_mut(&0) {
            live.closing = true;
            live.handle.terminate();
        }
        self.wait_gone(0);
    }

    /// Ends every isolate (the session is over) and remembers where the apps' windows were. Blocking.
    pub fn close_all(&self) {
        let rows = self.link().list().0;
        {
            let mut state = self.state();
            state.stopped = true;
            let mut places = self.places.lock().unwrap_or_else(|e| e.into_inner());
            for row in rows {
                if let Some(app) = row.window.and_then(|w| state.placed.get(&w))
                    && matches!(row.mode, Mode::Free | Mode::Fixed)
                {
                    places.set(app, [row.x, row.y, row.width as i32, row.height as i32]);
                }
            }
            places.flush();
            for live in state.live.values_mut() {
                live.closing = true;
                live.handle.terminate();
            }
        }
        let until = std::time::Instant::now() + Self::CLOSE_WAIT;
        while !self.state().live.is_empty() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn quit(&self) {
        self.places.lock().unwrap_or_else(|e| e.into_inner()).flush();
        self.link().quit();
    }
}

/// Local time as `YYYY-MM-DD HH.MM.SS` for a screenshot's name.
fn chrono_stamp() -> String {
    let now = rustix::time::clock_gettime(rustix::time::ClockId::Realtime).tv_sec;
    // SAFETY: localtime_r writes only into `tm`.
    let mut tm: libc_tm::Tm = unsafe { std::mem::zeroed() };
    unsafe { libc_tm::localtime_r(&now, &mut tm) };
    format!("{:04}-{:02}-{:02} {:02}.{:02}.{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

mod libc_tm {
    #[repr(C)]
    pub struct Tm {
        pub tm_sec: i32,
        pub tm_min: i32,
        pub tm_hour: i32,
        pub tm_mday: i32,
        pub tm_mon: i32,
        pub tm_year: i32,
        pub tm_wday: i32,
        pub tm_yday: i32,
        pub tm_isdst: i32,
        pub tm_gmtoff: i64,
        pub tm_zone: *const std::ffi::c_char,
    }

    unsafe extern "C" {
        pub fn localtime_r(time: *const i64, tm: *mut Tm) -> *mut Tm;
    }
}
