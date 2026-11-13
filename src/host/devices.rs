use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::runtime::{DevCall, Devices, Topic};

use crate::host::rt::{self, Msg};
use crate::host::{bind, offload};

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
        let data = v8::Integer::new(scope, i32::try_from(i).unwrap_or(-1)).into();
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
}

fn devices(scope: &mut v8::PinScope) -> Option<Devices> {
    let devices = STATE.with(|s| s.borrow().devices.clone());
    if devices.is_none() {
        bind::throw_error(scope, "acde.devices: not given to this web");
    }
    devices
}

fn parse(name: &str, a: &mut bind::Args) -> Option<DevCall> {
    Some(match name {
        "state" => DevCall::State,
        "mount" => DevCall::Mount { id: a.string(0) },
        "unmount" => DevCall::Unmount { id: a.string(0) },
        "eject" => DevCall::Eject { id: a.string(0) },
        "setAutomount" => DevCall::SetAutomount { patch: a.json(0).unwrap_or_default() },
        "setDeviceAutomount" => DevCall::SetDeviceAutomount { id: a.string(0), patch: a.json(1).unwrap_or_default() },
        "forgetDevice" => DevCall::ForgetDevice { id: a.string(0) },
        "setDefaultPrinter" => DevCall::SetDefaultPrinter { id: a.string(0) },
        "pausePrinter" => DevCall::PausePrinter { id: a.string(0) },
        "resumePrinter" => DevCall::ResumePrinter { id: a.string(0) },
        "jobs" => DevCall::Jobs { printer: a.string(0) },
        "cancelJob" => DevCall::CancelJob { printer: a.string(0), job: i32::try_from(a.count(1)?).ok()? },
        _ => return None,
    })
}

fn call<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue) {
    let index = args.data().int32_value(scope).unwrap_or(-1);
    let Some(name) = usize::try_from(index).ok().and_then(|i| METHODS.get(i)) else { return };
    let Some(devices) = devices(scope) else { return };
    let Some(call) = parse(name, &mut bind::Args { scope: &mut *scope, args: &args }) else {
        return bind::throw_type_error(scope, &format!("acde.devices.{name}: bad arguments"));
    };
    offload::run(scope, &mut rv, "acde-devices", move || devices.call(call), offload::settle_json::<true>);
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
    let token = Arc::new(AtomicU64::new(0));
    let mine = token.clone();
    let id = devices.listen(topic, move |value: serde_json::Value| {
        let id = mine.load(Ordering::Relaxed);
        tx.send(Msg::Task(Box::new(move |scope| deliver(scope, id, &value)))).is_ok()
    });
    token.store(id, Ordering::Relaxed);
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
