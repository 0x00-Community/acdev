use std::cell::RefCell;
use std::collections::HashMap;

use acde_runtime::{NetCall, Networks};

use crate::rt::{self, Msg};
use crate::{bind, offload};

#[derive(Default)]
struct State {
    networks: Option<Networks>,
    watchers: HashMap<u32, v8::Global<v8::Function>>,
    next: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, networks: Networks) {
    STATE.with(|s| s.borrow_mut().networks = Some(networks));
    let network = v8::Object::new(scope);
    crate::methods!(scope, network,
        "state" => state,
        "networks" => networks_of,
        "connect" => connect,
        "activate" => activate,
        "disconnect" => disconnect,
        "setWifiEnabled" => set_wifi_enabled,
        "watch" => watch,
    );
    bind::set(scope, natives, "network", network.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn networks(scope: &mut v8::PinScope) -> Option<Networks> {
    let networks = STATE.with(|s| s.borrow().networks.clone());
    if networks.is_none() {
        bind::throw_error(scope, "acde.network: not given to this web");
    }
    networks
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: NetCall) {
    let Some(networks) = networks(scope) else { return };
    offload::run(scope, rv, "acde-network", move || networks.call(call), settle);
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

fn state(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, NetCall::State);
}

fn networks_of(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let scan = bind::arg_bool(scope, &args, 0);
    send(scope, &mut rv, NetCall::Networks { scan });
}

fn connect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ssid = bind::arg_string(scope, &args, 0);
    let password = (!args.get(1).is_null_or_undefined()).then(|| bind::arg_string(scope, &args, 1));
    send(scope, &mut rv, NetCall::Connect { ssid, password });
}

fn activate(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let iface = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, NetCall::Activate { iface });
}

fn disconnect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let iface = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, NetCall::Disconnect { iface });
}

fn set_wifi_enabled(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let on = bind::arg_bool(scope, &args, 0);
    send(scope, &mut rv, NetCall::SetWifiEnabled { on });
}

fn watch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "acde.network.watch: the callback is not a function");
    };
    let Some(networks) = networks(scope) else { return };
    let callback = v8::Global::new(scope, callback);
    let token = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let token = s.next.wrapping_add(1).max(1);
        s.next = token;
        s.watchers.insert(token, callback);
        token
    });
    let tx = rt::current().sender();
    let started = std::thread::Builder::new().name("acde-network".into()).spawn(move || {
        let sink = move |state: serde_json::Value| tx.send(Msg::Task(Box::new(move |scope| deliver(scope, token, &state)))).is_ok();
        if let Err(e) = networks.listen(sink) {
            log::warn!("acde.network.watch: {e}");
        }
    });
    if let Err(e) = started {
        bind::throw_error(scope, &format!("acde.network.watch: {e}"));
    }
}

fn deliver(scope: &mut v8::PinScope, token: u32, state: &serde_json::Value) {
    let Some(callback) = STATE.with(|s| s.borrow().watchers.get(&token).cloned()) else { return };
    let value = offload::json(scope, state);
    bind::call(scope, &callback, &[value]);
}
