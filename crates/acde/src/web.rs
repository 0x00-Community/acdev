use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::bind;
use crate::rt::{self, Msg};

pub fn app_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ACDE_APP") {
        return PathBuf::from(dir);
    }
    let exe = std::env::current_exe().ok().and_then(|e| std::fs::canonicalize(e).ok()).unwrap_or_default();
    let bin = exe.parent().map(PathBuf::from).unwrap_or_default();
    let installed = bin.join("app/dist");
    if installed.join("broker.js").is_file() {
        return installed;
    }
    bin.join("../../web/packages/acde-host/dist")
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Kind {
    Message = 0,
    Init = 1,
    Exit = 2,
    Busy = 3,
}

impl TryFrom<u8> for Kind {
    type Error = std::io::Error;

    fn try_from(byte: u8) -> std::io::Result<Self> {
        match byte {
            0 => Ok(Self::Message),
            1 => Ok(Self::Init),
            2 => Ok(Self::Exit),
            3 => Ok(Self::Busy),
            other => Err(std::io::Error::other(format!("port frame kind {other}"))),
        }
    }
}

struct Port {
    reader: UnixStream,
    writer: Mutex<UnixStream>,
}

impl TryFrom<UnixStream> for Port {
    type Error = std::io::Error;

    fn try_from(stream: UnixStream) -> std::io::Result<Self> {
        Ok(Self { writer: Mutex::new(stream.try_clone()?), reader: stream })
    }
}

impl Port {
    fn write(&self, kind: Kind, bytes: &[u8]) -> std::io::Result<()> {
        let length = u32::try_from(bytes.len()).map_err(std::io::Error::other)?;
        let mut header = [0u8; 5];
        header[..4].copy_from_slice(&length.to_le_bytes());
        header[4] = kind as u8;
        let mut stream = self.writer.lock().map_err(|_| std::io::Error::other("port lock"))?;
        stream.write_all(&header)?;
        stream.write_all(bytes)
    }

    fn read(&self) -> std::io::Result<Option<(Kind, Vec<u8>)>> {
        let mut stream = &self.reader;
        let mut header = [0u8; 5];
        match stream.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let length = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let mut bytes = vec![0u8; length];
        stream.read_exact(&mut bytes)?;
        Ok(Some((Kind::try_from(header[4])?, bytes)))
    }
}

struct Busy {
    ms: u64,
    at: Instant,
}

struct Handle {
    tx: Sender<Vec<u8>>,
    pid: rustix::process::Pid,
    killed: Arc<AtomicBool>,
    busy: Arc<Mutex<Busy>>,
}

thread_local! {
    static WEBS: RefCell<(u32, HashMap<u32, Handle>)> = RefCell::new(Default::default());
    static PORT: RefCell<Option<Arc<Port>>> = const { RefCell::new(None) };
    static ON_MESSAGE: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

fn call_with(scope: &mut v8::PinScope, function: &v8::Global<v8::Function>, bytes: &[u8]) {
    if let Some(value) = crate::host::deserialize_bytes(scope, bytes) {
        bind::call(scope, function, &[value]);
    }
}

struct Spec {
    name: String,
    init: Vec<u8>,
    heap_mb: f64,
    env: Vec<(String, String)>,
}

impl Spec {
    fn spawn(self, id: u32, on_message: Arc<bind::SendFunction>, on_exit: bind::SendFunction, broker: Sender<Msg>) -> Result<Handle, String> {
        use std::os::unix::process::CommandExt;
        let (ours, theirs) = UnixStream::pair().map_err(|e| format!("spawnWeb: {e}"))?;
        let raw = theirs.as_raw_fd();
        let exe = std::env::current_exe().map_err(|e| format!("spawnWeb: {e}"))?;
        let mut command = std::process::Command::new(exe);
        command.args(["web", &self.name, "--port", &raw.to_string(), "--heap-mb", &self.heap_mb.max(0.0).to_string()]);
        command.env_clear().envs(self.env.iter().map(|(k, v)| (k, v)));
        unsafe {
            command.pre_exec(move || {
                let fd = BorrowedFd::borrow_raw(raw);
                rustix::io::fcntl_setfd(fd, rustix::io::FdFlags::empty())?;
                rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))?;
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|e| format!("spawnWeb: {e}"))?;
        drop(theirs);
        let pid = rustix::process::Pid::from_raw(child.id() as i32).ok_or("spawnWeb: no pid")?;
        let port = Arc::new(Port::try_from(ours).map_err(|e| format!("spawnWeb: {e}"))?);
        port.write(Kind::Init, &self.init).map_err(|e| format!("spawnWeb: {e}"))?;
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let writer = port.clone();
        let label = self.name.clone();
        std::thread::Builder::new()
            .name(format!("acde-port {label}"))
            .spawn(move || {
                for bytes in rx {
                    if writer.write(Kind::Message, &bytes).is_err() {
                        return;
                    }
                }
            })
            .map_err(|e| format!("spawnWeb: {e}"))?;
        let killed = Arc::new(AtomicBool::new(false));
        let busy = Arc::new(Mutex::new(Busy { ms: 0, at: Instant::now() }));
        let (dead, busy_in) = (killed.clone(), busy.clone());
        let name = self.name;
        std::thread::Builder::new()
            .name(format!("acde-port {name}"))
            .spawn(move || {
                let mut reason = None;
                loop {
                    match port.read() {
                        Ok(Some((Kind::Message, bytes))) => {
                            let on_message = on_message.clone();
                            _ = broker.send(Msg::Task(Box::new(move |scope| call_with(scope, &on_message.0, &bytes))));
                        }
                        Ok(Some((Kind::Busy, bytes))) => {
                            let ms = bytes.as_slice().try_into().map(u64::from_le_bytes).unwrap_or(0);
                            if let Ok(mut b) = busy_in.lock() {
                                *b = Busy { ms, at: Instant::now() };
                            }
                        }
                        Ok(Some((Kind::Exit, bytes))) => reason = Some(String::from_utf8_lossy(&bytes).into_owned()),
                        Ok(Some((Kind::Init, _))) => {}
                        Ok(None) => break,
                        Err(e) => {
                            log::warn!("[{name}] port: {e}");
                            break;
                        }
                    }
                }
                let (code, reason) = exit_status(child.wait(), reason);
                let reason = reason.filter(|_| !dead.load(Ordering::SeqCst));
                _ = broker.send(Msg::Task(Box::new(move |scope| {
                    let _on_message = on_message;
                    WEBS.with(|w| w.borrow_mut().1.remove(&id));
                    let code = v8::Integer::new(scope, code).into();
                    let reason: v8::Local<v8::Value> = match &reason {
                        Some(r) => bind::string(scope, r).into(),
                        None => v8::null(scope).into(),
                    };
                    bind::call(scope, &on_exit.0, &[code, reason]);
                    rt::current().keep_alive(false);
                })));
            })
            .map_err(|e| format!("spawnWeb: {e}"))?;
        Ok(Handle { tx, pid, killed, busy })
    }
}

pub fn spawn_web(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    let Some(init) = crate::host::serialize_value(scope, args.get(1)) else { return };
    let heap_mb = bind::arg_f64(scope, &args, 2);
    let env = bind::own_string_pairs(scope, args.get(3));
    let (Ok(on_message), Ok(on_exit)) = (v8::Local::<v8::Function>::try_from(args.get(4)), v8::Local::<v8::Function>::try_from(args.get(5))) else {
        return bind::throw_type_error(scope, "spawnWeb: onMessage and onExit must be functions");
    };
    let on_message = Arc::new(bind::SendFunction(v8::Global::new(scope, on_message)));
    let on_exit = bind::SendFunction(v8::Global::new(scope, on_exit));
    let broker = rt::current();
    let id = WEBS.with(|w| {
        let mut w = w.borrow_mut();
        w.0 = w.0.wrapping_add(1);
        w.0
    });
    let handle = match (Spec { name, init, heap_mb, env }).spawn(id, on_message, on_exit, broker.sender()) {
        Ok(handle) => handle,
        Err(e) => return bind::throw_error(scope, &e),
    };
    broker.keep_alive(true);
    WEBS.with(|w| w.borrow_mut().1.insert(id, handle));
    let obj = v8::Object::new(scope);
    let data: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, id).into();
    crate::methods!(scope, obj, data = data;
        "post" => post_to_web,
        "terminate" => terminate_web,
        "busyMs" => busy_ms,
    );
    rv.set(obj.into());
}

fn with_handle<R>(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, f: impl FnOnce(&Handle) -> R) -> Option<R> {
    let id = args.data().uint32_value(scope)?;
    WEBS.with(|w| w.borrow().1.get(&id).map(f))
}

fn post_to_web(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(bytes) = crate::host::serialize_value(scope, args.get(0)) else { return };
    with_handle(scope, &args, |h| _ = h.tx.send(bytes));
}

fn terminate_web(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_handle(scope, &args, |h| {
        h.killed.store(true, Ordering::SeqCst);
        _ = rustix::process::kill_process(h.pid, rustix::process::Signal::KILL);
    });
}

fn busy_ms(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ms = with_handle(scope, &args, |h| h.busy.lock().map_or(0, |b| if b.ms == 0 { 0 } else { b.ms + b.at.elapsed().as_millis() as u64 })).unwrap_or(0);
    rv.set_double(ms as f64);
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
        let guard = unsafe { &*(data as *const Self) };
        if let Ok(mut reason) = guard.reason.lock() {
            reason.get_or_insert_with(|| "memory".to_owned());
        }
        guard.stopping.store(true, Ordering::SeqCst);
        guard.handle.terminate_execution();
        current + current / 2
    }
}

const BUSY_EVERY: Duration = Duration::from_millis(200);

pub fn main(args: &[String]) -> i32 {
    let name = args.first().cloned().unwrap_or_else(|| "web".into());
    rt::set_web_name(&name);
    let option = |key: &str| args.windows(2).find(|w| w[0] == key).map(|w| w[1].as_str());
    let Some(fd) = option("--port").and_then(|v| v.parse::<i32>().ok()) else {
        log::error!("[{name}] acde web: no --port");
        return 2;
    };
    let heap_mb: f64 = option("--heap-mb").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let stream = UnixStream::from(unsafe { OwnedFd::from_raw_fd(fd) });
    _ = rustix::io::fcntl_setfd(&stream, rustix::io::FdFlags::CLOEXEC);
    let port = match Port::try_from(stream) {
        Ok(port) => Arc::new(port),
        Err(e) => {
            log::error!("[{name}] port: {e}");
            return 1;
        }
    };
    let init = match port.read() {
        Ok(Some((Kind::Init, init))) => init,
        _ => {
            log::error!("[{name}] no WebInit on the port");
            return 1;
        }
    };
    let mut runtime = rt::Runtime::new((heap_mb > 0.0).then_some(heap_mb as usize));
    let handle = runtime.isolate.thread_safe_handle();
    let reason = Arc::new(Mutex::new(None::<String>));
    let stopping = Arc::new(AtomicBool::new(false));
    let guard = HeapGuard::install(&mut runtime, handle, reason.clone(), stopping.clone());
    PORT.with(|p| *p.borrow_mut() = Some(port.clone()));
    let tx = runtime.lp.sender();
    let reader = port.clone();
    let spawned = std::thread::Builder::new().name("acde-port".into()).spawn(move || {
        while let Ok(Some((kind, bytes))) = reader.read() {
            if kind != Kind::Message {
                continue;
            }
            _ = tx.send(Msg::Task(Box::new(move |scope| {
                if let Some(function) = ON_MESSAGE.with(|m| m.borrow().clone()) {
                    call_with(scope, &function, &bytes);
                }
            })));
        }
        _ = tx.send(Msg::Task(Box::new(|_| rt::current().exit(0))));
    });
    if let Err(e) = spawned {
        log::error!("[{name}] {e}");
        return 1;
    }
    let busy = runtime.lp.busy();
    let reporter = port.clone();
    let _ = std::thread::Builder::new().name("acde-busy".into()).spawn(move || {
        let mut last = 0;
        loop {
            std::thread::sleep(BUSY_EVERY);
            let since = busy.load(Ordering::Relaxed);
            let ms = if since == 0 { 0 } else { rt::busy_stamp().saturating_sub(since).max(1) };
            if ms != last && reporter.write(Kind::Busy, &ms.to_le_bytes()).is_err() {
                return;
            }
            last = ms;
        }
    });
    let code = run_web(&mut runtime, init, &stopping);
    if let Some(reason) = reason.lock().ok().and_then(|r| r.clone()) {
        _ = port.write(Kind::Exit, reason.as_bytes());
    }
    ON_MESSAGE.with(|m| *m.borrow_mut() = None);
    #[cfg(target_os = "linux")]
    {
        crate::webgpu::clear();
        crate::webnative::clear();
        crate::audio::clear();
        crate::backend::clear();
    }
    bind::clear_promises();
    drop(runtime);
    drop(guard);
    code
}

fn exit_status(status: std::io::Result<std::process::ExitStatus>, reason: Option<String>) -> (i32, Option<String>) {
    use std::os::unix::process::ExitStatusExt;
    match status {
        Ok(status) => match (status.code(), status.signal()) {
            (Some(code), _) => (code, reason),
            (None, Some(signal)) => (128 + signal, reason.or_else(|| Some(format!("signal {signal}")))),
            (None, None) => (1, reason),
        },
        Err(e) => (1, reason.or_else(|| Some(e.to_string()))),
    }
}

fn run_web(runtime: &mut rt::Runtime, init: Vec<u8>, stopping: &Arc<AtomicBool>) -> i32 {
    crate::modules::set_loader(std::rc::Rc::new(crate::dom::WebLoader));
    let bundle = app_dir().join("web.js");
    let Some(url) = std::fs::canonicalize(&bundle).ok().and_then(|p| url::Url::from_file_path(p).ok()) else {
        log::error!("no web bundle at {}", bundle.display());
        return 1;
    };
    runtime.task(move |scope| {
        let natives = v8::Object::new(scope);
        let host = crate::host::object(scope);
        bind::set(scope, natives, "host", host.into());
        let sys = crate::sys::object(scope, &[]);
        bind::set(scope, natives, "sys", sys.into());
        let create = v8::Function::new(scope, crate::dom::create_document).unwrap();
        bind::set(scope, natives, "createDocument", create.into());
        #[cfg(target_os = "linux")]
        {
            crate::webnative::install(scope, natives);
            crate::webgpu::install(scope, natives);
            crate::audio::install(scope, natives);
        }
        let port = v8::Object::new(scope);
        crate::methods!(scope, port,
            "post" => post_to_broker,
            "onMessage" => set_on_message,
        );
        bind::set(scope, natives, "port", port.into());
        if let Some(init) = crate::host::deserialize_bytes(scope, &init) {
            #[cfg(target_os = "linux")]
            crate::backend::install(scope, natives, init);
            bind::set(scope, natives, "init", init);
        }
        let env: Vec<(String, String)> = std::env::vars().collect();
        let env: Vec<(&str, v8::Local<v8::Value>)> = env.iter().map(|(key, value)| (key.as_str(), bind::string(scope, value).into())).collect();
        let env = bind::object(scope, &env);
        bind::set(scope, natives, "env", env.into());
        crate::sys::boot_module(scope, url.as_str(), natives.into());
    });
    runtime.lp.keep_alive(true);
    runtime.run_until(|| stopping.load(Ordering::SeqCst))
}

fn post_to_broker(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(bytes) = crate::host::serialize_value(scope, args.get(0)) else { return };
    if let Some(port) = PORT.with(|p| p.borrow().clone()) {
        _ = port.write(Kind::Message, &bytes);
    }
}

fn set_on_message(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(function) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "port.onMessage: not a function");
    };
    let function = v8::Global::new(scope, function);
    ON_MESSAGE.with(|m| *m.borrow_mut() = Some(function));
}
