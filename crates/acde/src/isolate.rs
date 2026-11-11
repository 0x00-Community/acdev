//! A desktop or window isolate's thread: its own V8 isolate and event loop in the runtime process. The desk
//! (`desk/`) decides when one starts and ends; this is only the thread, its natives and its accounting.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::bind;
use crate::budget::Budget;
use crate::desk::Desk;
use crate::rt::{self, Msg};

/// Where an isolate is opened: the desktop (behind every window, the desktop's rights) or a window (its manifest's).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Place {
    Desktop,
    Window,
}

impl Place {
    pub const fn name(self) -> &'static str {
        match self {
            Place::Desktop => "desktop",
            Place::Window => "window",
        }
    }
}

/// The exit code of an isolate that panicked (its own thread, or its raster thread).
pub const PANICKED: i32 = 134;

pub const KILLED: i32 = 137;

/// The system objects one isolate is given (crates/runtime, shared by every isolate that has them).
#[derive(Default)]
pub struct Grants {
    pub fs: Option<acde_runtime::Workspace>,
    pub terminal: Option<acde_runtime::Terminals>,
    pub network: Option<acde_runtime::Networks>,
    pub office: Option<acde_runtime::OfficeService>,
    pub system: bool,
    pub sound: Option<acde_runtime::Sounds>,
    pub power: Option<acde_runtime::Power>,
    pub devices: Option<acde_runtime::Devices>,
    pub bluetooth: Option<acde_runtime::Bluetooths>,
}

impl Grants {
    fn install(self, scope: &mut v8::PinScope, natives: v8::Local<v8::Object>) {
        if let Some(fs) = self.fs {
            crate::fs::install(scope, natives, fs);
        }
        if let Some(terminals) = self.terminal {
            crate::terminal::install(scope, natives, terminals);
        }
        if let Some(networks) = self.network {
            crate::network::install(scope, natives, networks);
        }
        if let Some(office) = self.office {
            crate::office::install(scope, natives, office);
        }
        if self.system {
            crate::system::install(scope, natives);
        }
        if let Some(sounds) = self.sound {
            crate::sound::install(scope, natives, sounds);
        }
        if let Some(power) = self.power {
            crate::power::install(scope, natives, power);
        }
        if let Some(devices) = self.devices {
            crate::devices::install(scope, natives, devices);
        }
        if let Some(bluetooth) = self.bluetooth {
            crate::bluetooth::install(scope, natives, bluetooth);
        }
    }
}

/// A running isolate, as the desk holds it.
pub struct Handle {
    engine: Engine,
    killed: Arc<AtomicBool>,
    busy: Arc<AtomicU64>,
    tid: i32,
    budget: Arc<Budget>,
}

enum Engine {
    V8 { tx: Sender<Msg>, isolate: v8::IsolateHandle, stopping: Arc<AtomicBool> },
    Kernel(crate::kernel::Control),
}

struct Started {
    tx: Sender<Msg>,
    isolate: v8::IsolateHandle,
    stopping: Arc<AtomicBool>,
    busy: Arc<AtomicU64>,
    tid: i32,
    budget: Arc<Budget>,
}

impl Handle {
    /// Runs `task` on the isolate's own loop.
    pub fn task(&self, task: Box<dyn FnOnce(&mut v8::PinScope) + Send>) {
        if let Engine::V8 { tx, .. } = &self.engine {
            _ = tx.send(Msg::Task(task));
        }
    }

    pub fn kernel(control: crate::kernel::Control, tid: i32) -> Self {
        Handle { engine: Engine::Kernel(control), killed: Arc::default(), busy: Arc::default(), tid, budget: Budget::new(Spec::EXTERNAL_MB) }
    }

    pub fn in_kernel(&self) -> Option<&crate::kernel::Control> {
        match &self.engine {
            Engine::Kernel(control) => Some(control),
            Engine::V8 { .. } => None,
        }
    }

    /// Stops it, also when it is stuck in JS (exit code 137).
    pub fn terminate(&self) {
        self.killed.store(true, Ordering::SeqCst);
        match &self.engine {
            Engine::V8 { tx, isolate, stopping } => {
                stopping.store(true, Ordering::SeqCst);
                isolate.terminate_execution();
                _ = tx.send(Msg::Wake);
            }
            Engine::Kernel(control) => control.terminate(),
        }
    }

    /// How long its current task has been running (zero when it is waiting).
    pub fn busy(&self) -> Duration {
        let since = self.busy.load(Ordering::Relaxed);
        Duration::from_millis(if since == 0 { 0 } else { rt::busy_stamp().saturating_sub(since).max(1) })
    }

    pub fn cpu_ms(&self) -> f64 {
        let stat = std::fs::read_to_string(format!("/proc/self/task/{}/schedstat", self.tid)).unwrap_or_default();
        stat.split_whitespace().next().and_then(|ns| ns.parse::<u64>().ok()).map_or(0.0, |ns| ns as f64 / 1e6)
    }

    pub fn external_mb(&self) -> f64 {
        self.budget.used() as f64 / (1024.0 * 1024.0)
    }
}

/// What starts an isolate: the desk fills it in.
pub struct Spec {
    pub place: Place,
    pub name: String,
    pub window: u32,
    /// Tells this start from an earlier one of the same window (a reload), so a late exit is not taken for it.
    pub serial: u64,
    pub init: serde_json::Value,
    pub heap_mb: f64,
    pub env: Vec<(String, String)>,
    pub grants: Grants,
    pub storage: Option<PathBuf>,
    /// The compositor grant its surface claims.
    pub token: u64,
    pub desk: Arc<Desk>,
}

impl Spec {
    pub(crate) const STACK: usize = 8 << 20;
    const START_WAIT: Duration = Duration::from_secs(10);

    /// The external memory cap when the manifest gives no `heapMb`: the same as the V8 heap gets then.
    pub(crate) const EXTERNAL_MB: usize = 256;

    /// Starts the thread; when it ends the desk hears of it (`Desk::exited`), on that thread.
    pub fn spawn(self) -> Result<Handle, String> {
        if crate::kernel::wanted(self.place) {
            return crate::kernel::spawn(self);
        }
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let killed = Arc::new(AtomicBool::new(false));
        let dead = killed.clone();
        let (name, window, serial, desk) = (self.name.clone(), self.window, self.serial, self.desk.clone());
        std::thread::Builder::new()
            .name(format!("acde-{}", self.place.name()))
            .stack_size(Self::STACK)
            .spawn(move || {
                let (code, reason) = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.run(&ready))) {
                    Ok(ended) => ended,
                    Err(panic) => {
                        let message = panic.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
                        log::error!("[{name}] panic: {message}");
                        (PANICKED, Some(format!("panic: {message}")))
                    }
                };
                let (code, reason) = if dead.load(Ordering::SeqCst) { (KILLED, None) } else { (code, reason) };
                desk.exited(window, serial, code, reason);
            })
            .map_err(|e| format!("isolate: {e}"))?;
        let Started { tx, isolate, stopping, busy, tid, budget } = started.recv_timeout(Self::START_WAIT).map_err(|_| "isolate: its thread did not start".to_owned())?;
        Ok(Handle { engine: Engine::V8 { tx, isolate, stopping }, killed, busy, tid, budget })
    }

    fn run(self, ready: &std::sync::mpsc::SyncSender<Started>) -> (i32, Option<String>) {
        let heap = (self.heap_mb > 0.0).then_some(self.heap_mb as usize);
        let budget = Budget::new(heap.unwrap_or(Self::EXTERNAL_MB));
        let mut runtime = rt::Runtime::new(heap, Some(&budget), &self.name);
        let isolate = runtime.isolate.thread_safe_handle();
        let reason = Arc::new(Mutex::new(None::<String>));
        let stopping = Arc::new(AtomicBool::new(false));
        let guard = HeapGuard::install(&mut runtime, isolate.clone(), reason.clone(), stopping.clone());
        let tid = rustix::thread::gettid().as_raw_nonzero().get();
        _ = ready.send(Started { tx: runtime.lp.sender(), isolate, stopping: stopping.clone(), busy: runtime.lp.busy(), tid, budget: budget.clone() });
        let Spec { place, window, init, env, grants, storage, token, desk, .. } = self;
        let code = Self::boot(&mut runtime, Natives { place, window, init, env, grants, storage, token, desk }, &stopping, &budget);
        if let Ok(mut reason) = reason.lock() {
            if budget.over() {
                reason.get_or_insert_with(|| "memory".to_owned());
            } else if code == PANICKED {
                reason.get_or_insert_with(|| "panic".to_owned());
            }
        }
        crate::webgpu::clear();
        crate::surface::clear();
        crate::audio::clear();
        crate::backend::clear();
        crate::fs::clear();
        crate::terminal::clear();
        crate::network::clear();
        crate::sound::clear();
        crate::power::clear();
        crate::devices::clear();
        crate::bluetooth::clear();
        crate::office::clear();
        crate::own::clear();
        crate::desk::clear();
        bind::clear_promises();
        drop(runtime);
        drop(guard);
        let reason = reason.lock().ok().and_then(|r| r.clone());
        (code, reason)
    }

    fn boot(runtime: &mut rt::Runtime, natives: Natives, stopping: &Arc<AtomicBool>, budget: &Budget) -> i32 {
        crate::modules::set_loader(std::rc::Rc::new(crate::dom::PageLoader));
        let bundle = crate::sys::app_dir().join("isolate.js");
        let Some(url) = std::fs::canonicalize(&bundle).ok().and_then(|p| url::Url::from_file_path(p).ok()) else {
            log::error!("no isolate bundle at {}", bundle.display());
            return 1;
        };
        runtime.task(move |scope| natives.install(scope, url.as_str()));
        runtime.lp.keep_alive(true);
        let images = std::cell::Cell::new((0usize, std::time::Instant::now()));
        runtime.run_until(|| {
            let (held, at) = images.get();
            if at.elapsed() >= Duration::from_secs(1)
                && let Some(now) = crate::dom::with_dom(|dom| dom.stats().image_bytes as usize)
            {
                budget.hold(held, now);
                images.set((now, std::time::Instant::now()));
            }
            stopping.load(Ordering::SeqCst) || budget.over()
        })
    }
}

/// What the isolate's bundle (`isolate.js`) is booted with.
struct Natives {
    place: Place,
    window: u32,
    init: serde_json::Value,
    env: Vec<(String, String)>,
    grants: Grants,
    storage: Option<PathBuf>,
    token: u64,
    desk: Arc<Desk>,
}

impl Natives {
    fn install(self, scope: &mut v8::PinScope, url: &str) {
        let natives = v8::Object::new(scope);
        let host = crate::host::object(scope);
        bind::set(scope, natives, "host", host.into());
        let create = v8::Function::new(scope, crate::dom::create_document).unwrap();
        bind::set(scope, natives, "createDocument", create.into());
        crate::surface::install(scope, natives, self.token);
        crate::own::install(scope, natives, self.storage);
        self.grants.install(scope, natives);
        crate::webgpu::install(scope, natives);
        crate::audio::install(scope, natives);
        crate::desk::install(scope, natives, self.desk, self.window, self.place);
        let init = crate::offload::json(scope, &self.init);
        crate::backend::install(scope, natives, init);
        bind::set(scope, natives, "init", init);
        let env: Vec<(&str, v8::Local<v8::Value>)> = self.env.iter().map(|(key, value)| (key.as_str(), bind::string(scope, value).into())).collect();
        let env = bind::object(scope, &env);
        bind::set(scope, natives, "env", env.into());
        crate::sys::boot_module(scope, url, natives.into());
    }
}

struct HeapGuard {
    handle: v8::IsolateHandle,
    reason: Arc<Mutex<Option<String>>>,
    stopping: Arc<AtomicBool>,
}

impl HeapGuard {
    fn install(runtime: &mut rt::Runtime, handle: v8::IsolateHandle, reason: Arc<Mutex<Option<String>>>, stopping: Arc<AtomicBool>) -> Box<Self> {
        let guard = Box::new(Self { handle, reason, stopping });
        let data = &*guard as *const Self as *mut std::ffi::c_void;
        runtime.isolate.add_near_heap_limit_callback(Self::near_limit, data);
        guard
    }

    extern "C" fn near_limit(data: *mut std::ffi::c_void, current: usize, _initial: usize) -> usize {
        // SAFETY: `data` is the boxed guard, alive until after the runtime (and so this callback) is dropped.
        let guard = unsafe { &*(data as *const Self) };
        if let Ok(mut reason) = guard.reason.lock() {
            reason.get_or_insert_with(|| "memory".to_owned());
        }
        guard.stopping.store(true, Ordering::SeqCst);
        guard.handle.terminate_execution();
        current + current / 2
    }
}
