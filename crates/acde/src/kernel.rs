use std::collections::{HashMap, VecDeque};
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use acde_window::{Event, Surface};
use jsrt::{Isolate, Kind, Message, Options};
use rustix::event::{EventfdFlags, PollFd, PollFlags, eventfd, poll};
use serde_json::{Value, json};

use crate::desk::{Ask, Desk};
use crate::isolate::{Grants, Place, Spec};
use crate::wire::{Answer, Args, Fail, Reader, Ret, WireArgs, Writer};

const DOM: u8 = 1;
const HOST: u8 = 2;
const SURFACE: u8 = 3;
const OWN: u8 = 4;
const DESK: u8 = 5;
const NATIVES: u8 = 6;
const SYSTEM: u8 = 7;

const OUT_BATCH: u8 = 1;
const OUT_ASYNC: u8 = 2;
const OUT_SERVICE: u8 = 3;
const OUT_ANSWER: u8 = 4;

const IN_RESOLVE: u8 = 1;
const IN_REJECT: u8 = 2;
const IN_MESSAGE: u8 = 3;
const IN_ASK: u8 = 4;
const IN_SERVICE: u8 = 5;
const IN_EVENT: u8 = 6;

const CALL_MODULE: u16 = 2;

pub fn wanted(place: Place) -> bool {
    let asked = std::env::var("ACDE_KERNEL_JS").ok();
    let all = asked.as_deref() == Some("all");
    if (place != Place::Window && !all) || asked.as_deref() == Some("0") {
        return false;
    }
    match rustix::fs::access("/dev/jsrt", rustix::fs::Access::READ_OK | rustix::fs::Access::WRITE_OK) {
        Ok(()) => true,
        Err(e) if asked.as_deref() == Some("1") || all => {
            log::warn!("ACDE_KERNEL_JS={} but /dev/jsrt is not usable ({e}); this isolate runs in userspace V8", asked.as_deref().unwrap_or_default());
            false
        }
        Err(_) => false,
    }
}

/// Rings of a jsrt that splits long messages into parts (it has
/// `call_spin_us`, which came with them); without parts a message must fit
/// in one ring, so the rings are as long as the longest message.
fn ring_size() -> u32 {
    if std::path::Path::new("/sys/module/jsrt/parameters/call_spin_us").exists() { 1 << 20 } else { 16 << 20 }
}
const SPIN: Duration = Duration::from_micros(50);

enum In {
    Message(Value),
    Ask(Ask, Value, Sender<Value>),
    Service(Vec<u8>),
    Done(u32, Result<Ret, Fail>, bool),
    Surface,
    Event(u32, Value),
    Stop,
}

#[derive(Clone)]
pub struct Control {
    tx: Sender<In>,
    wake: Arc<OwnedFd>,
}

fn ring(fd: &OwnedFd) {
    _ = rustix::io::write(fd, &1u64.to_ne_bytes());
}

impl Control {
    fn send(&self, msg: In) {
        if self.tx.send(msg).is_ok() {
            ring(&self.wake);
        }
    }

    pub fn message(&self, message: Value) {
        self.send(In::Message(message));
    }

    pub fn ask(&self, ask: Ask, payload: Value, reply: Sender<Value>) {
        self.send(In::Ask(ask, payload, reply));
    }

    pub fn service(&self, bytes: Vec<u8>) {
        self.send(In::Service(bytes));
    }

    pub fn terminate(&self) {
        self.send(In::Stop);
    }
}

pub fn spawn(spec: Spec) -> Result<crate::isolate::Handle, String> {
    let wake = Arc::new(eventfd(0, EventfdFlags::CLOEXEC | EventfdFlags::NONBLOCK).map_err(|e| format!("eventfd: {e}"))?);
    let (tx, rx) = mpsc::channel();
    let control = Control { tx: tx.clone(), wake: wake.clone() };
    let (ready, started) = mpsc::sync_channel(1);
    let (name, window, serial, desk) = (spec.name.clone(), spec.window, spec.serial, spec.desk.clone());
    std::thread::Builder::new()
        .name("acde-window".to_owned())
        .stack_size(8 << 20)
        .spawn(move || {
            let tid = rustix::thread::gettid().as_raw_nonzero().get();
            _ = ready.send(tid);
            let (code, reason) = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Driver::run(spec, tx, wake, rx))) {
                Ok(ended) => ended,
                Err(panic) => {
                    let message = panic.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
                    log::error!("[{name}] panic: {message}");
                    (crate::isolate::PANICKED, Some(format!("panic: {message}")))
                }
            };
            crate::surface::clear();
            crate::own::clear();
            desk.exited(window, serial, code, reason);
        })
        .map_err(|e| format!("isolate: {e}"))?;
    let tid = started.recv_timeout(Duration::from_secs(10)).map_err(|_| "isolate: its thread did not start".to_owned())?;
    Ok(crate::isolate::Handle::kernel(control, tid))
}

struct Driver {
    iso: Isolate,
    desk: Arc<Desk>,
    window: u32,
    place: Place,
    init: Value,
    env: Vec<(String, String)>,
    token: Option<u64>,
    tx: Sender<In>,
    wake: Arc<OwnedFd>,
    outbox: VecDeque<Vec<u8>>,
    /// Bytes of the front of the outbox already in the ring.
    sent: usize,
    surface: Option<Surface>,
    surface_wait: Option<u32>,
    armed: Arc<AtomicBool>,
    asks: HashMap<u32, Sender<Value>>,
    next_ask: u32,
    kick: bool,
    replied: bool,
    grants: Grants,
    imes: HashMap<u32, acde_runtime::Ime>,
}

impl Driver {
    fn run(spec: Spec, tx: Sender<In>, wake: Arc<OwnedFd>, rx: Receiver<In>) -> (i32, Option<String>) {
        let mem_limit = if spec.heap_mb > 0.0 { (spec.heap_mb * 1024.0 * 1024.0) as u64 } else { 0 };
        let iso = match Isolate::create(&Options { name: spec.name.clone(), mem_limit, stack_size: Spec::STACK as u32, ring_size: ring_size() }) {
            Ok(iso) => iso,
            Err(e) => {
                log::error!("[{}] /dev/jsrt: {e}", spec.name);
                return (1, Some(format!("jsrt: {e}")));
            }
        };
        crate::modules::set_loader(std::rc::Rc::new(crate::dom::PageLoader));
        crate::own::set(spec.storage.clone());
        let mut driver = Driver {
            iso,
            desk: spec.desk.clone(),
            window: spec.window,
            place: spec.place,
            init: spec.init,
            env: spec.env,
            token: Some(spec.token),
            tx,
            wake,
            outbox: VecDeque::new(),
            sent: 0,
            surface: None,
            surface_wait: None,
            armed: Arc::new(AtomicBool::new(false)),
            asks: HashMap::new(),
            next_ask: 0,
            kick: false,
            replied: false,
            grants: spec.grants,
            imes: HashMap::new(),
        };
        let bundle = crate::sys::app_dir().join("kernel.js");
        let source = match std::fs::read_to_string(&bundle) {
            Ok(source) => source,
            Err(e) => {
                log::error!("no kernel bundle at {}: {e}", bundle.display());
                return (1, Some("no kernel.js".to_owned()));
            }
        };
        if let Err(e) = driver.iso.eval(&source, "acde://host/kernel.js", true) {
            return (1, Some(format!("jsrt eval: {e}")));
        }
        driver.lp(&rx)
    }

    fn lp(&mut self, rx: &Receiver<In>) -> (i32, Option<String>) {
        let mut buf = Vec::new();
        let mut ended = false;
        loop {
            while let Some(message) = self.iso.recv(&mut buf) {
                let data = std::mem::take(&mut buf);
                self.engine(message, &data);
                buf = data;
            }
            loop {
                match rx.try_recv() {
                    Ok(In::Stop) | Err(mpsc::TryRecvError::Disconnected) => return (crate::isolate::KILLED, None),
                    Ok(input) => self.input(input),
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            self.flush();
            if self.kick {
                self.kick = false;
                _ = self.iso.kick();
            }
            if ended {
                let code = self.iso.exit_code();
                return (code, (code != 0).then(|| format!("exit {code}")));
            }
            if std::mem::take(&mut self.replied) && self.spin() {
                continue;
            }
            let mut fds = [PollFd::new(&self.iso, PollFlags::IN), PollFd::new(&*self.wake, PollFlags::IN)];
            if let Err(e) = poll(&mut fds, None) {
                if e == rustix::io::Errno::INTR {
                    continue;
                }
                return (1, Some(format!("poll: {e}")));
            }
            let (iso_ready, woken) = (!fds[0].revents().is_empty(), !fds[1].revents().is_empty());
            if woken {
                let mut word = [0u8; 8];
                _ = rustix::io::read(&*self.wake, &mut word);
            }
            if iso_ready {
                match self.iso.wait(Some(Duration::ZERO)) {
                    Ok(None) => ended = true,
                    Ok(Some(events)) => ended |= events.contains(jsrt::Events::EXIT),
                    Err(e) => return (1, Some(format!("jsrt wait: {e}"))),
                }
            }
        }
    }

    fn engine(&mut self, message: Message, data: &[u8]) {
        log::trace!(target: "kernel", "engine {:?} flags {} len {}", message.kind, message.flags, data.len());
        match message.kind {
            Kind::Call if message.flags == CALL_MODULE => {
                let text = String::from_utf8_lossy(data);
                let (specifier, referrer) = text.split_once('\0').unwrap_or((&text, ""));
                log::trace!(target: "kernel", "module {specifier} from {referrer}");
                let reply = match crate::modules::resolve_load(specifier, referrer) {
                    Ok((url, source)) => [url.as_bytes(), b"\0", source.as_bytes()].concat(),
                    Err(e) => [b"\0".as_slice(), e.as_bytes()].concat(),
                };
                self.reply(&reply);
            }
            Kind::Call => {
                let mut r = Reader::new(data);
                let mut w = Writer::default();
                match read_call(&mut r) {
                    Some((iface, name, mut args)) => match self.dispatch(iface, &name, &mut args) {
                        Answer::Now(Ok(ret)) => {
                            w.u8(0);
                            w.ret(&ret);
                        }
                        Answer::Now(Err(fail)) => {
                            w.u8(1);
                            w.ret(&fail.ret());
                        }
                        Answer::Later(work) => match work() {
                            Ok(ret) => {
                                w.u8(0);
                                w.ret(&ret);
                            }
                            Err(fail) => {
                                w.u8(1);
                                w.ret(&fail.ret());
                            }
                        },
                    },
                    None => {
                        w.u8(1);
                        w.ret(&Fail::new("kernel: a malformed call").ret());
                    }
                }
                self.reply(&w.buf);
            }
            Kind::Binary => self.binary(data),
            Kind::Console => {
                let text = String::from_utf8_lossy(data);
                let level = match message.flags {
                    2 => log::Level::Warn,
                    3 => log::Level::Error,
                    4 => log::Level::Debug,
                    _ => log::Level::Info,
                };
                log::log!(target: "js", level, "{text}");
            }
            Kind::Error => log::error!(target: "js", "{}", String::from_utf8_lossy(data)),
            _ => {}
        }
    }

    fn reply(&mut self, data: &[u8]) {
        if let Err(e) = self.iso.reply(data) {
            log::error!("kernel: a reply did not get through: {e}");
        }
        self.kick = true;
        self.replied = true;
    }

    /// After answering a call the engine usually makes another soon:
    /// waiting for it here skips a sleep and a wakeup per call.
    fn spin(&self) -> bool {
        let until = Instant::now() + SPIN;
        while Instant::now() < until {
            if self.iso.pending() {
                return true;
            }
            std::hint::spin_loop();
        }
        false
    }

    fn binary(&mut self, data: &[u8]) {
        let mut r = Reader::new(data);
        match r.u8() {
            Some(OUT_BATCH) => {
                let n = r.u32().unwrap_or(0);
                for _ in 0..n {
                    let Some((iface, name, mut args)) = read_call(&mut r) else {
                        log::error!("kernel: a malformed batch");
                        return;
                    };
                    match self.dispatch(iface, &name, &mut args) {
                        Answer::Now(Err(fail)) => log::warn!(target: "js", "{name}: {}", fail.message),
                        Answer::Later(work) => {
                            if let Err(fail) = work() {
                                log::warn!(target: "js", "{name}: {}", fail.message);
                            }
                        }
                        Answer::Now(Ok(_)) => {}
                    }
                }
            }
            Some(OUT_ASYNC) => {
                let Some(req) = r.u32() else { return };
                let Some((iface, name, mut args)) = read_call(&mut r) else { return };
                if iface == SURFACE && name == "wait" {
                    return self.surface_wait(req);
                }
                if iface == SURFACE && name == "readClipboard" {
                    return self.read_clipboard(req);
                }
                let grants = iface == OWN && (name == "filesOpen" || name == "filesSave");
                match self.dispatch(iface, &name, &mut args) {
                    Answer::Now(result) => self.settle(req, result, grants),
                    Answer::Later(work) => {
                        let (tx, wake) = (self.tx.clone(), self.wake.clone());
                        std::thread::Builder::new()
                            .name("acde-kernel-call".to_owned())
                            .spawn(move || {
                                _ = tx.send(In::Done(req, work(), grants));
                                ring(&wake);
                            })
                            .ok();
                    }
                }
            }
            Some(OUT_SERVICE) => self.desk.service_to_broker(self.window, r.rest().to_vec()),
            Some(OUT_ANSWER) => {
                let Some(token) = r.u32() else { return };
                let value = r.value().map_or(Value::Null, |v| v.to_json());
                if let Some(reply) = self.asks.remove(&token) {
                    _ = reply.send(value);
                }
            }
            _ => log::error!("kernel: an unknown message"),
        }
    }

    fn settle(&mut self, req: u32, result: Result<Ret, Fail>, grants: bool) {
        let mut w = Writer::default();
        match result {
            Ok(ret) => {
                if grants && let Ret::List(items) = &ret {
                    let paths: Vec<String> = items.iter().filter_map(|i| if let Ret::Str(s) = i { Some(s.clone()) } else { None }).collect();
                    crate::own::granted_paths(&paths);
                }
                w.u8(IN_RESOLVE);
                w.u32(req);
                w.ret(&ret);
            }
            Err(fail) => {
                w.u8(IN_REJECT);
                w.u32(req);
                w.ret(&fail.ret());
            }
        }
        self.outbox.push_back(w.buf);
    }

    fn input(&mut self, input: In) {
        let mut w = Writer::default();
        match input {
            In::Message(message) => {
                w.u8(IN_MESSAGE);
                w.json(&message);
            }
            In::Ask(ask, payload, reply) => {
                self.next_ask = self.next_ask.wrapping_add(1);
                self.asks.insert(self.next_ask, reply);
                w.u8(IN_ASK);
                w.u32(self.next_ask);
                w.string(ask.name());
                w.json(&payload);
            }
            In::Service(bytes) => {
                w.u8(IN_SERVICE);
                w.buf.extend_from_slice(&bytes);
            }
            In::Done(req, result, grants) => return self.settle(req, result, grants),
            In::Surface => {
                if let Some(req) = self.surface_wait.take() {
                    self.settle(req, Ok(Ret::Undefined), false);
                }
                return;
            }
            In::Event(token, value) => {
                w.u8(IN_EVENT);
                w.u32(token);
                w.json(&value);
            }
            In::Stop => return,
        }
        self.outbox.push_back(w.buf);
    }

    fn flush(&mut self) {
        while let Some(front) = self.outbox.front() {
            let before = self.sent;
            let done = self.iso.send_from(Kind::Binary, 0, front, &mut self.sent).is_ok();
            self.kick |= self.sent != before || done;
            if !done {
                break;
            }
            self.outbox.pop_front();
            self.sent = 0;
        }
    }

    fn dispatch(&mut self, iface: u8, name: &str, a: &mut WireArgs) -> Answer {
        if log::log_enabled!(target: "kernel", log::Level::Trace) {
            let args: String = format!("{:?}", a.0).chars().take(120).collect();
            log::trace!(target: "kernel", "call {iface} {name} {args}");
        }
        match iface {
            DOM => match crate::dom::with_dom_wire(name, a) {
                Some(result) => Answer::Now(result.map_err(Fail::new)),
                None => Answer::fail(format!("dom: no method {name}")),
            },
            NATIVES => self.natives(name, a),
            HOST => host(name, a),
            SURFACE => self.surface(name, a),
            OWN => crate::own::wire_call(name, a),
            DESK => crate::desk::wire::call(name, a, &self.desk, self.window),
            SYSTEM => self.system(name, a),
            _ => Answer::fail(format!("kernel: no interface {iface}")),
        }
    }

    fn natives(&mut self, name: &str, a: &mut WireArgs) -> Answer {
        match name {
            "init" => {
                let env: serde_json::Map<String, Value> = self.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
                Answer::ok(Ret::Json(json!({
                    "init": self.init,
                    "env": env,
                    "place": self.place.name(),
                    "window": self.window,
                    "storage": crate::own::has_storage(),
                    "grants": {
                        "fs": self.grants.fs.is_some(),
                        "terminal": self.grants.terminal.is_some(),
                        "network": self.grants.network.is_some(),
                        "office": self.grants.office.is_some(),
                    },
                })))
            }
            "createDocument" => {
                let (width, height, scale) = (a.f64(0), a.f64(1), a.f64(2));
                let options = crate::dom::DocumentOptions::from_json(&a.json(3));
                let name = self.init["name"].as_str().unwrap_or("window").to_owned();
                Answer::Now(crate::dom::create(width, height, scale, options, name).map(|()| Ret::Undefined).map_err(Fail::new))
            }
            "claimSurface" => self.claim_surface(),
            _ => Answer::fail(format!("natives: no method {name}")),
        }
    }

    fn system(&mut self, name: &str, a: &mut WireArgs) -> Answer {
        let (tx, wake) = (self.tx.clone(), self.wake.clone());
        let events = move |token: u32, value: Value| {
            let sent = tx.send(In::Event(token, value)).is_ok();
            if sent {
                ring(&wake);
            }
            sent
        };
        let g = &self.grants;
        let answer = match name.split_once('.') {
            Some(("fs", method)) => g.fs.as_ref().map(|fs| crate::fs::wire(fs, method, a)),
            Some(("terminal", method)) => g.terminal.as_ref().map(|t| crate::terminal::wire(t, method, a, events)),
            Some(("network", method)) => g.network.as_ref().map(|n| crate::network::wire(n, method, a, events)),
            Some(("office", method)) => g.office.as_ref().map(|o| crate::office::wire(o, method, a)),
            Some(("ime", method)) => Some(crate::surface::ime_wire(&mut self.imes, method, a, events)),
            _ => None,
        };
        answer.unwrap_or_else(|| Answer::fail(format!("{name}: not given to this window")))
    }

    fn claim_surface(&mut self) -> Answer {
        let Some(token) = self.token.take() else { return Answer::fail("claimSurface: this isolate's surface is already claimed") };
        let Some(render) = crate::dom::render_handle() else { return Answer::fail("claimSurface: this isolate has no document yet") };
        let surface = match Surface::claim(token, render) {
            Ok(surface) => surface,
            Err(e) => return Answer::fail(e),
        };
        let (tx, wake, armed) = (self.tx.clone(), self.wake.clone(), self.armed.clone());
        surface.set_waker(Some(Arc::new(move || {
            if armed.swap(false, Ordering::SeqCst) {
                _ = tx.send(In::Surface);
                ring(&wake);
            }
        })));
        let window = surface.window();
        self.surface = Some(surface);
        Answer::ok(window)
    }

    fn surface_wait(&mut self, req: u32) {
        self.armed.store(true, Ordering::SeqCst);
        let ready = self.surface.as_ref().is_none_or(Surface::has_events);
        if ready {
            self.armed.store(false, Ordering::SeqCst);
            return self.settle(req, Ok(Ret::Undefined), false);
        }
        if let Some(previous) = self.surface_wait.replace(req) {
            self.settle(previous, Ok(Ret::Undefined), false);
        }
    }

    fn read_clipboard(&mut self, req: u32) {
        let Some(surface) = &self.surface else { return self.settle(req, Ok(Ret::Str(String::new())), false) };
        let (tx, wake) = (self.tx.clone(), self.wake.clone());
        surface.read_clipboard(Box::new(move |text| {
            _ = tx.send(In::Done(req, Ok(Ret::Str(text)), false));
            ring(&wake);
        }));
    }

    fn surface(&mut self, name: &str, a: &mut WireArgs) -> Answer {
        let Some(surface) = &self.surface else { return Answer::fail("surface: released") };
        let rect = |a: &mut WireArgs, from: usize| [0, 1, 2, 3].map(|i| a.f64(from + i).round() as i32);
        match name {
            "pump" => {
                if surface.lost() {
                    log::error!("the raster thread of this isolate died; ending it");
                    self.iso.kick().ok();
                    return Answer::fail("surface: lost");
                }
                Answer::ok(Ret::List(surface.pump().into_iter().map(event_ret).collect()))
            }
            "requestFrame" => {
                surface.request_frame();
                Answer::ok(())
            }
            "requestMode" => {
                let mode = match a.str(0).as_str() {
                    "fullscreen" => 0,
                    "free" => 1,
                    "fixed" => 2,
                    "pinned" => 3,
                    other => return Answer::fail(format!("requestMode: no mode {other}")),
                };
                surface.request_mode(mode);
                Answer::ok(())
            }
            "setGrabHint" => {
                let (r, edges) = (rect(a, 0), a.f64(4) as u32);
                surface.set_grab_hint(r, edges);
                Answer::ok(())
            }
            "setBackdrop" => {
                let r = rect(a, 0);
                let effect = [4, 5, 6, 7].map(|i| a.f64(i));
                surface.set_backdrop(r, effect);
                Answer::ok(())
            }
            "requestActivate" => {
                surface.request_activate();
                Answer::ok(())
            }
            "requestGrab" | "releaseGrab" => {
                let kind = match a.str(0).as_str() {
                    "pointer" => 1,
                    "keyboard" => 2,
                    other => return Answer::fail(format!("grab: no kind {other}")),
                };
                surface.request_grab(kind, name == "requestGrab");
                Answer::ok(())
            }
            "openPanel" => {
                let id = a.f64(0) as u32;
                let token: u64 = a.str(1).parse().unwrap_or(0);
                let r = rect(a, 2);
                surface.open_panel(id, token, r);
                Answer::ok(())
            }
            "placePanel" => {
                let id = a.f64(0) as u32;
                let (r, input) = (rect(a, 1), rect(a, 5));
                surface.place_panel(id, r, input);
                Answer::ok(())
            }
            "closePanel" => {
                surface.close_panel(a.f64(0) as u32);
                Answer::ok(())
            }
            "setClipboard" => {
                surface.set_clipboard(a.str(0));
                Answer::ok(())
            }
            "startDrag" => {
                let data: HashMap<String, String> = match a.json(0) {
                    Value::Object(map) => map.into_iter().filter_map(|(k, v)| Some((k, v.as_str()?.to_owned()))).collect(),
                    _ => HashMap::new(),
                };
                surface.start_drag(data, None);
                Answer::ok(())
            }
            _ => Answer::fail(format!("surface: no method {name}")),
        }
    }
}

fn host(name: &str, a: &mut WireArgs) -> Answer {
    match name {
        "readAsset" => Answer::ok(crate::dom::read_asset(&a.str(0)).map(Ret::Bytes)),
        "parseUrl" => {
            let input = a.str(0);
            let base = match a.json(1) {
                Value::Null => None,
                _ => Some(a.str(1)),
            };
            Answer::ok(crate::host::url_fields(&input, base.as_deref()).map_or(Ret::Null, |fields| Ret::Obj(fields.into_iter().map(|(k, v)| (k, Ret::Str(v))).collect())))
        }
        "decode" => {
            let (label, fatal, ignore_bom) = (a.str(1), a.bool(2), a.bool(3));
            match a.with_bytes(0, |bytes| crate::host::decode_label(bytes, &label, fatal, ignore_bom)) {
                Some(result) => Answer::Now(result.map(Ret::Str).map_err(Fail::new)),
                None => Answer::fail("TypeError: decode: not an ArrayBuffer or a view"),
            }
        }
        "print" => {
            let level = crate::host::print_level(a.f64(0));
            log::log!(target: "js", level, "{}", a.str(1));
            Answer::ok(())
        }
        "log" => {
            if let Some(level) = crate::host::log_level(a.f64(0)).filter(|l| *l <= log::max_level()) {
                let (target, text) = (a.str(1), a.str(2));
                log::log!(target: &target, level, "{text}");
            }
            Answer::ok(())
        }
        "logEnabled" => {
            let enabled = crate::host::log_level(a.f64(0)).filter(|l| *l <= log::max_level()).is_some_and(|level| {
                let target = a.str(1);
                log::log_enabled!(target: &target, level)
            });
            Answer::ok(enabled)
        }
        "clock" => Answer::ok(acde_log::now_ms()),
        "addImportMap" => {
            let pairs = |v: &Value| -> Vec<(String, String)> {
                v.as_array().map(|l| l.iter().filter_map(|p| Some((p[0].as_str()?.to_owned(), p[1].as_str()?.to_owned()))).collect()).unwrap_or_default()
            };
            let (imports, scopes) = (a.json(0), a.json(1));
            let scopes = scopes.as_array().map(|l| l.iter().filter_map(|s| Some((s[0].as_str()?.to_owned(), pairs(&s[1])))).collect()).unwrap_or_default();
            crate::modules::add_import_map(pairs(&imports), scopes);
            Answer::ok(())
        }
        _ => Answer::fail(format!("host: no method {name}")),
    }
}

fn read_call(r: &mut Reader) -> Option<(u8, String, WireArgs)> {
    let iface = r.u8()?;
    let name = r.string()?;
    let n = r.u32()? as usize;
    let mut args = Vec::with_capacity(n.min(64));
    for _ in 0..n {
        args.push(r.value()?);
    }
    Some((iface, name, WireArgs(args)))
}

fn event_ret(event: Event) -> Ret {
    let mut fields: Vec<(&'static str, Ret)> = vec![("type", Ret::Str(event.kind.clone()))];
    let numbers = [
        ("window", event.window.map(f64::from)),
        ("x", event.x),
        ("y", event.y),
        ("button", event.button.map(f64::from)),
        ("deltaX", event.delta_x),
        ("deltaY", event.delta_y),
        ("code", event.code.map(f64::from)),
        ("width", event.width),
        ("height", event.height),
        ("time", event.time),
        ("scale", event.scale),
        ("parent", event.parent.map(f64::from)),
    ];
    for (name, value) in numbers {
        if let Some(value) = value {
            fields.push((name, Ret::Num(value)));
        }
    }
    for (name, value) in [("key", &event.key), ("title", &event.title), ("appId", &event.app_id)] {
        if let Some(value) = value {
            fields.push((name, Ret::Str(value.clone())));
        }
    }
    if let Some(mime) = &event.mime {
        fields.push(("mime", Ret::List(mime.iter().map(|m| Ret::Str(m.clone())).collect())));
    }
    if let Some(data) = &event.data {
        crate::own::grant_dropped(data);
        fields.push(("data", Ret::Json(Value::Object(data.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect()))));
    }
    Ret::Obj(fields)
}
