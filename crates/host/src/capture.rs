use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use acde_media::capture::{self, Capture, Device, Kind, Mode, Permission};

use crate::bind;
use crate::offload;
use crate::rt::{self, Msg};

#[derive(Clone, Copy, Default)]
pub struct Allowed {
    pub camera: bool,
    pub microphone: bool,
}

impl Allowed {
    fn kind(self, kind: Kind) -> bool {
        match kind {
            Kind::Camera => self.camera,
            Kind::Microphone => self.microphone,
        }
    }
}

#[derive(Default)]
struct State {
    allowed: Allowed,
    salt: String,
    sources: HashMap<u32, Arc<Capture>>,
    next: u32,
    on_ended: Option<v8::Global<v8::Function>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, allowed: Allowed, app: Option<&str>) {
    if !allowed.camera && !allowed.microphone {
        return;
    }
    with_state(|s| {
        s.allowed = allowed;
        s.salt = app.unwrap_or("desktop").to_owned();
    });
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "devices" => devices,
        "permission" => permission,
        "open" => open,
        "close" => close,
        "onEnded" => on_ended,
    );
    bind::set(scope, natives, "capture", object.into());
}

pub fn clear() {
    let state = with_state(std::mem::take);
    drop(state);
}

pub fn source(id: u32) -> Option<Arc<Capture>> {
    with_state(|s| s.sources.get(&id).cloned())
}

fn page_id(salt: &str, id: &str) -> String {
    let mut hash: u64 = 0x9e37_79b9_7f4a_7c15;
    for byte in salt.as_bytes().iter().chain([0u8].iter()).chain(id.as_bytes()) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3).rotate_left(5);
    }
    format!("{hash:016x}{:016x}", hash.wrapping_mul(0x2545_f491_4f6c_dd1d))
}

fn kind_of(name: &str) -> Option<Kind> {
    match name {
        "audioinput" | "microphone" => Some(Kind::Microphone),
        "videoinput" | "camera" => Some(Kind::Camera),
        _ => None,
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Microphone => "audioinput",
        Kind::Camera => "videoinput",
    }
}

fn permission_name(allowed: bool, kind: Kind) -> &'static str {
    match (allowed, capture::permission(kind)) {
        (false, _) => "denied",
        (true, Permission::Granted) => "granted",
        (true, Permission::Denied) => "denied",
        (true, Permission::Prompt) => "prompt",
    }
}

fn permission(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    let Some(kind) = kind_of(&name) else {
        return bind::throw_type_error(scope, "capture.permission: unknown kind");
    };
    let allowed = with_state(|s| s.allowed.kind(kind));
    let state = bind::string(scope, permission_name(allowed, kind));
    rv.set(state.into());
}

struct Listed {
    device: Device,
    exposed: bool,
}

fn devices(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let full = bind::arg_bool(scope, &args, 0);
    let (allowed, salt) = with_state(|s| (s.allowed, s.salt.clone()));
    let list = move || -> (String, Vec<Listed>) {
        let mut listed = Vec::new();
        for kind in [Kind::Microphone, Kind::Camera] {
            if !allowed.kind(kind) {
                continue;
            }
            let exposed = full || capture::permission(kind) == Permission::Granted;
            let found = capture::devices().into_iter().filter(|d| d.kind == kind);
            if exposed {
                listed.extend(found.map(|device| Listed { device, exposed }));
            } else if let Some(device) = found.into_iter().next() {
                listed.push(Listed { device, exposed });
            }
        }
        (salt, listed)
    };
    offload::run(scope, &mut rv, "acde-capture", list, |scope, resolver, (salt, listed)| {
        let array = v8::Array::new(scope, listed.len() as i32);
        for (i, Listed { device, exposed }) in listed.iter().enumerate() {
            let value = describe(scope, &salt, device, *exposed);
            array.set_index(scope, i as u32, value.into());
        }
        resolver.resolve(scope, array.into());
    });
}

fn describe<'s>(scope: &mut v8::PinScope<'s, '_>, salt: &str, device: &Device, exposed: bool) -> v8::Local<'s, v8::Object> {
    let text = |scope: &mut v8::PinScope<'s, '_>, value: &str| -> v8::Local<'s, v8::Value> { bind::string(scope, value).into() };
    let modes = v8::Array::new(scope, device.modes.len() as i32);
    for (i, mode) in device.modes.iter().enumerate() {
        let triple = v8::Array::new(scope, 3);
        for (j, value) in [f64::from(mode.width), f64::from(mode.height), mode.frame_rate].into_iter().enumerate() {
            let number = v8::Number::new(scope, value);
            triple.set_index(scope, j as u32, number.into());
        }
        modes.set_index(scope, i as u32, triple.into());
    }
    let fields: Vec<(&str, v8::Local<v8::Value>)> = vec![
        ("deviceId", if exposed { text(scope, &page_id(salt, &device.id)) } else { text(scope, "") }),
        ("kind", text(scope, kind_name(device.kind))),
        ("label", if exposed { text(scope, &device.label) } else { text(scope, "") }),
        ("groupId", if exposed { text(scope, &page_id(salt, &device.group)) } else { text(scope, "") }),
        (
            "facingMode",
            match device.facing {
                Some(facing) if exposed => text(scope, facing),
                _ => v8::null(scope).into(),
            },
        ),
        ("modes", modes.into()),
        ("channelCount", v8::Number::new(scope, f64::from(device.channels)).into()),
    ];
    bind::object(scope, &fields)
}

struct Opened {
    salt: String,
    capture: Capture,
}

fn open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    let Some(kind) = kind_of(&name) else {
        return bind::throw_type_error(scope, "capture.open: unknown kind");
    };
    let wanted = bind::arg_string(scope, &args, 1);
    let number = |scope: &mut v8::PinScope, i: i32| Some(bind::arg_f64(scope, &args, i)).filter(|n| n.is_finite() && *n > 0.0);
    let (width, height, frame_rate) = (number(scope, 2), number(scope, 3), number(scope, 4));
    let (allowed, salt) = with_state(|s| (s.allowed.kind(kind), s.salt.clone()));
    let work = move || -> Result<Opened, String> {
        if !allowed {
            return Err("NotAllowedError: this app's manifest does not ask for this device".into());
        }
        capture::authorize(kind).map_err(|e| e.to_string())?;
        let candidates: Vec<Device> = capture::devices().into_iter().filter(|d| d.kind == kind).collect();
        let device = if wanted.is_empty() { candidates.first() } else { candidates.iter().find(|d| page_id(&salt, &d.id) == wanted) };
        let device = device.ok_or_else(|| "NotFoundError: the requested device is not there".to_string())?;
        let mode = match (width, height) {
            (Some(width), Some(height)) => Some(Mode { width: width as u32, height: height as u32, frame_rate: frame_rate.unwrap_or(30.0) }),
            _ => None,
        };
        let capture = Capture::open(device, mode).map_err(|e| e.to_string())?;
        if kind == Kind::Camera {
            if capture.first_frame(Duration::from_secs(5)).is_none() {
                return Err(format!("NotReadableError: {} gives no picture", device.label));
            }
            _ = acde_gpu::Gpu::shared();
        }
        Ok(Opened { salt, capture })
    };
    offload::run(scope, &mut rv, "acde-capture", work, opened);
}

fn opened(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, result: Result<Opened, String>) {
    let Opened { salt, capture } = match result {
        Ok(opened) => opened,
        Err(message) => {
            let message = bind::string(scope, &message);
            let error = v8::Exception::error(scope, message);
            resolver.reject(scope, error);
            return;
        }
    };
    let capture = Arc::new(capture);
    let id = with_state(|s| {
        s.next += 1;
        s.sources.insert(s.next, capture.clone());
        s.next
    });
    let tx = rt::current().sender();
    capture.on_end(move |reason| {
        _ = tx.send(Msg::Task(Box::new(move |scope| ended(scope, id, &reason))));
    });
    let device = capture.device();
    let frame = capture.frame().map(|(_, f)| (f.width, f.height));
    let (width, height) = frame.or(capture.mode().map(|m| (m.width, m.height))).unwrap_or((0, 0));
    let frame_rate = capture.mode().map_or(0.0, |m| m.frame_rate);
    let summary = describe(scope, &salt, device, true);
    let extra: [(&str, f64); 4] = [("source", f64::from(id)), ("width", f64::from(width)), ("height", f64::from(height)), ("frameRate", frame_rate)];
    for (name, value) in extra {
        let value = v8::Number::new(scope, value);
        bind::set(scope, summary, name, value.into());
    }
    resolver.resolve(scope, summary.into());
}

fn ended(scope: &mut v8::PinScope, id: u32, reason: &str) {
    let Some(callback) = with_state(|s| s.sources.contains_key(&id).then(|| s.on_ended.clone()).flatten()) else { return };
    let callback = v8::Local::new(scope, callback);
    let id = v8::Integer::new_from_unsigned(scope, id).into();
    let reason = bind::string(scope, reason).into();
    bind::call(scope, callback, &[id, reason]);
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_u32(scope, &args, 0);
    with_state(|s| s.sources.remove(&id));
}

fn on_ended(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "capture.onEnded: not a function");
    };
    let callback = v8::Global::new(scope, callback);
    with_state(|s| s.on_ended = Some(callback));
}
