use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use acde_runtime::{Power, PowerCall};
use serde_json::Value;

use crate::Display;
use crate::rt::{self, Msg};
use crate::{bind, offload};

const NAME: &str = "acde.display";
const NOT_HERE: &str = "acde.display: this runtime has no compositor to configure (only acdebin-system's session has)";
const NIGHT_LIGHT: &str = "acde.display.setNightLight: there is no night light yet";
const BRIGHTNESS: std::ops::RangeInclusive<f64> = 0.0..=1.0;

#[derive(Default)]
struct State {
    display: Option<Arc<dyn Display>>,
    power: Option<Power>,
    watchers: HashMap<u32, v8::Global<v8::Function>>,
    next: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, display: Option<Arc<dyn Display>>, power: Power) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.display = display;
        s.power = Some(power);
    });
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "state" => state,
        "configure" => configure,
        "setBrightness" => set_brightness,
        "setNightLight" => set_night_light,
        "watch" => watch,
    );
    bind::set(scope, natives, "display", object.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn display() -> Result<Arc<dyn Display>, String> {
    STATE.with(|s| s.borrow().display.clone()).ok_or_else(|| NOT_HERE.to_owned())
}

fn with_backlight(mut state: Value) -> Value {
    if let Some(displays) = state["displays"].as_array_mut() {
        for each in displays.iter_mut().filter(|d| d["builtin"].as_bool() == Some(true)) {
            each["brightness"] = acde_runtime::backlight_brightness().map_or(Value::Null, Value::from);
        }
    }
    state
}

fn call(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, work: impl FnOnce(Arc<dyn Display>) -> Result<Value, String> + Send + 'static) {
    match display() {
        Ok(display) => offload::run(scope, rv, "acde-display-call", move || work(display), offload::settle_json::<true>),
        Err(e) => bind::throw_error(scope, &e),
    }
}

fn state(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    call(scope, &mut rv, |display| display.state().map(with_backlight));
}

fn configure(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let patch: Value =
        v8::json::stringify(scope, args.get(1)).map(|s| s.to_rust_string_lossy(scope)).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if !patch.is_object() {
        return bind::throw_type_error(scope, &format!("{NAME}.configure: the patch is an object"));
    }
    call(scope, &mut rv, move |display| display.configure(&id, &patch).map(|()| Value::Null));
}

fn set_brightness(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let value = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    if !BRIGHTNESS.contains(&value) {
        return bind::throw_range_error(scope, &format!("{NAME}.setBrightness: {value} is not in 0..1"));
    }
    let Some(power) = STATE.with(|s| s.borrow().power.clone()) else { return bind::throw_error(scope, NOT_HERE) };
    call(scope, &mut rv, move |display| {
        let state = with_backlight(display.state()?);
        let found = state["displays"].as_array().and_then(|list| list.iter().find(|d| d["id"].as_str() == Some(id.as_str())).cloned());
        let found = found.ok_or_else(|| format!("{NAME}: no display {id}"))?;
        if found["brightness"].is_null() {
            return Err(format!("{NAME}: the brightness of {id} cannot be set here (only a built-in backlight)"));
        }
        power.call(PowerCall::SetBrightness { value })
    });
}

fn set_night_light(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    bind::throw_error(scope, NIGHT_LIGHT);
}

fn watch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, &format!("{NAME}.watch: the callback is not a function"));
    };
    let display = match display() {
        Ok(display) => display,
        Err(e) => return bind::throw_error(scope, &e),
    };
    let callback = v8::Global::new(scope, callback);
    let token = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let token = s.next.wrapping_add(1).max(1);
        s.next = token;
        s.watchers.insert(token, callback);
        token
    });
    let tx = rt::current().sender();
    display.listen(Box::new(move |state: Value| {
        let state = with_backlight(state);
        tx.send(Msg::Task(Box::new(move |scope| deliver(scope, token, &state)))).is_ok()
    }));
}

fn deliver(scope: &mut v8::PinScope, token: u32, state: &Value) {
    let Some(callback) = STATE.with(|s| s.borrow().watchers.get(&token).cloned()) else { return };
    let value = offload::json(scope, state);
    bind::call(scope, &callback, &[value]);
}
