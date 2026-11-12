use std::cell::RefCell;

use crate::rt::{self, Msg};
use crate::{bind, offload};

#[derive(Default)]
struct State {
    battery: Option<v8::Global<v8::Function>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>) {
    let device = v8::Object::new(scope);
    crate::methods!(scope, device,
        "battery" => battery,
        "watchBattery" => watch_battery,
    );
    bind::set(scope, natives, "device", device.into());
}

pub fn clear() {
    STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
}

fn battery(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    offload::run(scope, &mut rv, "acde-battery", status, offload::settle_json::<false>);
}

fn status() -> Result<serde_json::Value, String> {
    cfg_select! {
        target_os = "linux" => Ok(acde_runtime::Battery::open().map_or_else(|_| plugged(), |b| b.status())),
        _ => Ok(plugged()),
    }
}

fn plugged() -> serde_json::Value {
    serde_json::json!({ "charging": true, "level": 1.0, "chargingTime": 0, "dischargingTime": null })
}

fn watch_battery(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "watchBattery: the callback is not a function");
    };
    let callback = v8::Global::new(scope, callback);
    let fresh = STATE.with(|s| s.borrow_mut().battery.replace(callback).is_none());
    if !fresh || !cfg!(target_os = "linux") {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let tx = rt::current().sender();
        let started = std::thread::Builder::new().name("acde-battery".into()).spawn(move || {
            let sink = |status: serde_json::Value| tx.send(Msg::Task(Box::new(move |scope| deliver(scope, &status)))).is_ok();
            if let Err(e) = acde_runtime::Battery::open().and_then(|b| b.watch(sink)) {
                log::debug!("battery watch: {e}");
            }
        });
        if let Err(e) = started {
            log::warn!("battery watch: {e}");
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn deliver(scope: &mut v8::PinScope, status: &serde_json::Value) {
    let Some(callback) = STATE.with(|s| s.borrow().battery.clone()) else { return };
    let value = offload::json(scope, status);
    bind::call(scope, &callback, &[value]);
}
