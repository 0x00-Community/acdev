use std::cell::RefCell;

use acde_runtime::{NetCall, Networks};

use crate::{bind, offload};

thread_local! {
    static NETWORKS: RefCell<Option<Networks>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, networks: Networks) {
    NETWORKS.with(|n| *n.borrow_mut() = Some(networks));
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

fn networks(scope: &mut v8::PinScope) -> Option<Networks> {
    let networks = NETWORKS.with(|n| n.borrow().clone());
    if networks.is_none() {
        bind::throw_error(scope, "acde.network: not given to this web");
    }
    networks
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: NetCall) {
    let Some(networks) = networks(scope) else { return };
    offload::run(scope, rv, "acde-network", move || networks.call(call), offload::settle_json::<true>);
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
    let sink = offload::json_sink(scope, callback);
    let started = std::thread::Builder::new().name("acde-network".into()).spawn(move || {
        if let Err(e) = networks.listen(sink) {
            log::warn!("acde.network.watch: {e}");
        }
    });
    if let Err(e) = started {
        bind::throw_error(scope, &format!("acde.network.watch: {e}"));
    }
}
