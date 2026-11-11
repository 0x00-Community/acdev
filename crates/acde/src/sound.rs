use std::cell::RefCell;
use std::collections::HashMap;

use acde_runtime::{SoundCall, Sounds};

use crate::rt::{self, Msg};
use crate::{bind, offload};

#[derive(Default)]
struct State {
    sounds: Option<Sounds>,
    watchers: HashMap<u32, v8::Global<v8::Function>>,
    next: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, sounds: Sounds) {
    STATE.with(|s| s.borrow_mut().sounds = Some(sounds));
    let sound = v8::Object::new(scope);
    crate::methods!(scope, sound,
        "state" => state,
        "setDefault" => set_default,
        "setVolume" => set_volume,
        "setMuted" => set_muted,
        "setBalance" => set_balance,
        "setPort" => set_port,
        "setProfile" => set_profile,
        "moveStream" => move_stream,
        "watch" => watch,
    );
    bind::set(scope, natives, "sound", sound.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn sounds(scope: &mut v8::PinScope) -> Option<Sounds> {
    let sounds = STATE.with(|s| s.borrow().sounds.clone());
    if sounds.is_none() {
        bind::throw_error(scope, "acde.audio: not given to this web");
    }
    sounds
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: SoundCall) {
    let Some(sounds) = sounds(scope) else { return };
    offload::run(scope, rv, "acde-sound-call", move || sounds.call(call), settle);
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

fn number(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> f64 {
    args.get(i).number_value(scope).unwrap_or(f64::NAN)
}

fn state(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, SoundCall::State);
}

fn set_default(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, SoundCall::SetDefault { id });
}

fn set_volume(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let volume = number(scope, &args, 1);
    send(scope, &mut rv, SoundCall::SetVolume { id, volume });
}

fn set_muted(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let muted = bind::arg_bool(scope, &args, 1);
    send(scope, &mut rv, SoundCall::SetMuted { id, muted });
}

fn set_balance(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let balance = number(scope, &args, 1);
    send(scope, &mut rv, SoundCall::SetBalance { id, balance });
}

fn set_port(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let port = bind::arg_string(scope, &args, 1);
    send(scope, &mut rv, SoundCall::SetPort { id, port });
}

fn set_profile(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let card = bind::arg_string(scope, &args, 0);
    let profile = bind::arg_string(scope, &args, 1);
    send(scope, &mut rv, SoundCall::SetProfile { card, profile });
}

fn move_stream(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let device = (!args.get(1).is_null_or_undefined()).then(|| bind::arg_string(scope, &args, 1));
    send(scope, &mut rv, SoundCall::MoveStream { id, device });
}

fn watch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "acde.audio.watch: the callback is not a function");
    };
    let Some(sounds) = sounds(scope) else { return };
    let callback = v8::Global::new(scope, callback);
    let token = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let token = s.next.wrapping_add(1).max(1);
        s.next = token;
        s.watchers.insert(token, callback);
        token
    });
    let tx = rt::current().sender();
    let started = std::thread::Builder::new().name("acde-sound-call".into()).spawn(move || {
        let sink = move |state: serde_json::Value| tx.send(Msg::Task(Box::new(move |scope| deliver(scope, token, &state)))).is_ok();
        if let Err(e) = sounds.listen(sink) {
            log::warn!("acde.audio.watch: {e}");
        }
    });
    if let Err(e) = started {
        bind::throw_error(scope, &format!("acde.audio.watch: {e}"));
    }
}

fn deliver(scope: &mut v8::PinScope, token: u32, state: &serde_json::Value) {
    let Some(callback) = STATE.with(|s| s.borrow().watchers.get(&token).cloned()) else { return };
    let value = offload::json(scope, state);
    bind::call(scope, &callback, &[value]);
}

pub fn wire(sounds: &Sounds, name: &str, a: &mut crate::wire::WireArgs, events: impl Fn(u32, serde_json::Value) -> bool + Send + 'static) -> crate::wire::Answer {
    use crate::wire::{Answer, Args, Fail, Ret, WVal};
    let call = match name {
        "state" => SoundCall::State,
        "setDefault" => SoundCall::SetDefault { id: a.str(0) },
        "setVolume" => SoundCall::SetVolume { id: a.str(0), volume: a.f64(1) },
        "setMuted" => SoundCall::SetMuted { id: a.str(0), muted: a.bool(1) },
        "setBalance" => SoundCall::SetBalance { id: a.str(0), balance: a.f64(1) },
        "setPort" => SoundCall::SetPort { id: a.str(0), port: a.str(1) },
        "setProfile" => SoundCall::SetProfile { card: a.str(0), profile: a.str(1) },
        "moveStream" => SoundCall::MoveStream { id: a.str(0), device: (!matches!(a.0.get(1), None | Some(WVal::Undefined | WVal::Null))).then(|| a.str(1)) },
        "watch" => {
            let token = a.f64(0) as u32;
            let sounds = sounds.clone();
            return Answer::Later(Box::new(move || match sounds.listen(move |state| events(token, state)) {
                Ok(()) => Ok(Ret::Undefined),
                Err(message) => Err(Fail { message: format!("acde.audio.watch: {message}"), status: None, code: "GenericFailure".to_owned() }),
            }));
        }
        _ => return Answer::fail(format!("acde.audio: no method {name}")),
    };
    let sounds = sounds.clone();
    Answer::Later(Box::new(move || match sounds.call(call) {
        Ok(serde_json::Value::Null) => Ok(Ret::Undefined),
        Ok(value) => Ok(Ret::Json(value)),
        Err(message) => Err(Fail { message, status: None, code: "GenericFailure".to_owned() }),
    }))
}
