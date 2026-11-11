use std::cell::RefCell;
use std::collections::HashMap;

use acde_runtime::{DevCall, Devices, Topic};

use crate::rt::{self, Msg};
use crate::wire::{Args, V8Args};
use crate::{bind, offload};

#[derive(Default)]
struct State {
    devices: Option<Devices>,
    watchers: HashMap<u64, v8::Global<v8::Function>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

const METHODS: [&str; 12] = [
    "state",
    "mount",
    "unmount",
    "eject",
    "setAutomount",
    "setDeviceAutomount",
    "forgetDevice",
    "setDefaultPrinter",
    "pausePrinter",
    "resumePrinter",
    "jobs",
    "cancelJob",
];

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, devices: Devices) {
    STATE.with(|s| s.borrow_mut().devices = Some(devices));
    let object = v8::Object::new(scope);
    for (i, name) in METHODS.iter().enumerate() {
        let data = v8::Integer::new(scope, i as i32).into();
        bind::method_with(scope, object, name, call, Some(data));
    }
    crate::methods!(scope, object,
        "watch" => watch,
        "unwatch" => unwatch,
    );
    bind::set(scope, natives, "devices", object.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    if let Some(devices) = &state.devices {
        for id in state.watchers.keys() {
            devices.unlisten(*id);
        }
    }
    drop(state);
}

fn devices(scope: &mut v8::PinScope) -> Option<Devices> {
    let devices = STATE.with(|s| s.borrow().devices.clone());
    if devices.is_none() {
        bind::throw_error(scope, "acde.devices: not given to this isolate");
    }
    devices
}

fn parse(name: &str, a: &mut impl Args) -> Option<DevCall> {
    Some(match name {
        "state" => DevCall::State,
        "mount" => DevCall::Mount { id: a.str(0) },
        "unmount" => DevCall::Unmount { id: a.str(0) },
        "eject" => DevCall::Eject { id: a.str(0) },
        "setAutomount" => DevCall::SetAutomount { patch: a.json(0) },
        "setDeviceAutomount" => DevCall::SetDeviceAutomount { id: a.str(0), patch: a.json(1) },
        "forgetDevice" => DevCall::ForgetDevice { id: a.str(0) },
        "setDefaultPrinter" => DevCall::SetDefaultPrinter { id: a.str(0) },
        "pausePrinter" => DevCall::PausePrinter { id: a.str(0) },
        "resumePrinter" => DevCall::ResumePrinter { id: a.str(0) },
        "jobs" => DevCall::Jobs { printer: a.str(0) },
        "cancelJob" => DevCall::CancelJob { printer: a.str(0), job: a.f64(1) as i32 },
        _ => return None,
    })
}

fn call<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue) {
    let index = args.data().int32_value(scope).unwrap_or(-1);
    let Some(name) = usize::try_from(index).ok().and_then(|i| METHODS.get(i)) else { return };
    let Some(devices) = devices(scope) else { return };
    let Some(call) = parse(name, &mut V8Args { scope: &mut *scope, args: &args }) else { return };
    offload::run(scope, &mut rv, "acde-devices", move || devices.call(call), settle);
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, reply: Result<serde_json::Value, String>) {
    match reply {
        Ok(serde_json::Value::Null) => {
            let undefined = v8::undefined(scope).into();
            resolver.resolve(scope, undefined);
        }
        Ok(value) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Err(message) => {
            let thrown = offload::failure(scope, &message, None, "GenericFailure");
            resolver.reject(scope, thrown);
        }
    }
}

fn watch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let kind = bind::arg_string(scope, &args, 0);
    let Some(topic) = Topic::parse(&kind) else {
        return bind::throw_type_error(scope, &format!("acde:devices has no {kind} event"));
    };
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(1)) else {
        return bind::throw_type_error(scope, "acde.devices.watch: the callback is not a function");
    };
    let Some(devices) = devices(scope) else { return };
    let callback = v8::Global::new(scope, callback);
    let tx = rt::current().sender();
    let token = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mine = token.clone();
    let id = devices.listen(topic, move |value: serde_json::Value| {
        let id = mine.load(std::sync::atomic::Ordering::Relaxed);
        tx.send(Msg::Task(Box::new(move |scope| deliver(scope, id, &value)))).is_ok()
    });
    token.store(id, std::sync::atomic::Ordering::Relaxed);
    STATE.with(|s| s.borrow_mut().watchers.insert(id, callback));
    rv.set(v8::Number::new(scope, id as f64).into());
}

fn unwatch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_u64(scope, &args, 0);
    let Some(devices) = devices(scope) else { return };
    devices.unlisten(id);
    STATE.with(|s| s.borrow_mut().watchers.remove(&id));
}

fn deliver(scope: &mut v8::PinScope, id: u64, value: &serde_json::Value) {
    if value.is_null() {
        return;
    }
    let Some(callback) = STATE.with(|s| s.borrow().watchers.get(&id).cloned()) else { return };
    let value = offload::json(scope, value);
    bind::call(scope, &callback, &[value]);
}

pub fn wire(devices: &Devices, name: &str, a: &mut crate::wire::WireArgs, events: impl Fn(u32, serde_json::Value) -> bool + Send + 'static) -> crate::wire::Answer {
    use crate::wire::{Answer, Fail, Ret};
    match name {
        "watch" => {
            let Some(topic) = Topic::parse(&a.str(0)) else { return Answer::fail("acde:devices: no such event") };
            let token = a.f64(1) as u32;
            let id = devices.listen(topic, move |value| events(token, value));
            return Answer::ok(Ret::Num(id as f64));
        }
        "unwatch" => {
            devices.unlisten(a.f64(0) as u64);
            return Answer::ok(());
        }
        _ => {}
    }
    let Some(call) = parse(name, a) else { return Answer::fail(format!("acde.devices: no method {name}")) };
    let devices = devices.clone();
    Answer::Later(Box::new(move || match devices.call(call) {
        Ok(serde_json::Value::Null) => Ok(Ret::Undefined),
        Ok(value) => Ok(Ret::Json(value)),
        Err(message) => Err(Fail { message, status: None, code: "GenericFailure".to_owned() }),
    }))
}
