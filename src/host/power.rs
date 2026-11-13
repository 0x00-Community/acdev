use std::cell::RefCell;
use std::collections::HashMap;

use crate::runtime::{Power, PowerCall};

use crate::host::rt::{self, Msg};
use crate::host::{bind, offload};

#[derive(Default)]
struct State {
    power: Option<Power>,
    watchers: HashMap<u32, v8::Global<v8::Function>>,
    next: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, power: Power) {
    STATE.with(|s| s.borrow_mut().power = Some(power));
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "state" => state,
        "setProfile" => set_profile,
        "configure" => configure,
        "setScreenOff" => set_screen_off,
        "setSleep" => set_sleep,
        "suspend" => suspend,
        "hibernate" => hibernate,
        "setBrightness" => set_brightness,
        "setChargeLimit" => set_charge_limit,
        "watch" => watch,
    );
    bind::set(scope, natives, "power", object.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn power(scope: &mut v8::PinScope) -> Option<Power> {
    let power = STATE.with(|s| s.borrow().power.clone());
    if power.is_none() {
        bind::throw_error(scope, "acde.power: not given to this web");
    }
    power
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: PowerCall) {
    let Some(power) = power(scope) else { return };
    offload::run(scope, rv, "acde-power-call", move || power.call(call), offload::settle_json::<true>);
}

fn seconds(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<u32> {
    if value.is_null_or_undefined() {
        return None;
    }
    value.number_value(scope).filter(|n| n.is_finite() && *n > 0.0).map(|n| n.round().min(f64::from(u32::MAX)) as u32)
}

fn state(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, PowerCall::State);
}

fn set_profile(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let profile = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, PowerCall::SetProfile { profile });
}

fn configure(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let patch = v8::json::stringify(scope, args.get(0)).map(|s| s.to_rust_string_lossy(scope)).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    send(scope, &mut rv, PowerCall::Configure { patch });
}

fn set_screen_off(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let seconds = seconds(scope, args.get(0));
    send(scope, &mut rv, PowerCall::SetScreenOff { seconds });
}

fn set_sleep(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let seconds = seconds(scope, args.get(0));
    send(scope, &mut rv, PowerCall::SetSleep { seconds });
}

fn suspend(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, PowerCall::Suspend);
}

fn hibernate(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, PowerCall::Hibernate);
}

fn set_brightness(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let value = args.get(0).number_value(scope).unwrap_or(f64::NAN);
    send(scope, &mut rv, PowerCall::SetBrightness { value });
}

fn set_charge_limit(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let end = seconds(scope, args.get(0));
    send(scope, &mut rv, PowerCall::SetChargeLimit { end });
}

fn watch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "acde.power.watch: the callback is not a function");
    };
    let Some(power) = power(scope) else { return };
    let callback = v8::Global::new(scope, callback);
    let token = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let token = s.next.wrapping_add(1).max(1);
        s.next = token;
        s.watchers.insert(token, callback);
        token
    });
    let tx = rt::current().sender();
    let sink = move |event: serde_json::Value| tx.send(Msg::Task(Box::new(move |scope| deliver(scope, token, &event)))).is_ok();
    if let Err(e) = power.listen(sink) {
        bind::throw_error(scope, &format!("acde.power.watch: {e}"));
    }
}

fn deliver(scope: &mut v8::PinScope, token: u32, event: &serde_json::Value) {
    let Some(callback) = STATE.with(|s| s.borrow().watchers.get(&token).cloned()) else { return };
    let value = offload::json(scope, event);
    bind::call(scope, &callback, &[value]);
}
