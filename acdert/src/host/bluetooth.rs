use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::runtime::{Bluetooths, BtCall};

use crate::host::rt::{self, Msg};
use crate::host::{bind, offload};

#[derive(Default)]
struct State {
    bluetooth: Option<Bluetooths>,
    changed: Option<v8::Global<v8::Function>>,
    pairing: Option<v8::Global<v8::Function>>,
    wanted: Option<Arc<AtomicBool>>,
    watching: bool,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn owner() -> u64 {
    u64::from(rustix::thread::gettid().as_raw_nonzero().get().unsigned_abs())
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, bluetooth: Bluetooths) {
    STATE.with(|s| s.borrow_mut().bluetooth = Some(bluetooth));
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "state" => state,
        "setPowered" => set_powered,
        "setDiscoverable" => set_discoverable,
        "setName" => set_name,
        "scan" => scan,
        "pair" => pair,
        "answer" => answer,
        "connect" => connect,
        "disconnect" => disconnect,
        "forget" => forget,
        "setTrusted" => set_trusted,
        "setBlocked" => set_blocked,
        "rename" => rename,
        "setOnLogin" => set_on_login,
        "watch" => watch,
        "pairing" => pairing,
    );
    bind::set(scope, natives, "bluetooth", object.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    if let Some(wanted) = &state.wanted {
        wanted.store(false, Ordering::SeqCst);
    }
    if let Some(bluetooth) = &state.bluetooth {
        bluetooth.release(owner());
    }
    drop(state);
}

fn bluetooth(scope: &mut v8::PinScope) -> Option<Bluetooths> {
    let bluetooth = STATE.with(|s| s.borrow().bluetooth.clone());
    if bluetooth.is_none() {
        bind::throw_error(scope, "acde.bluetooth: not given to this web");
    }
    bluetooth
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: BtCall) {
    let Some(bluetooth) = bluetooth(scope) else { return };
    offload::run(scope, rv, "acde-bluetooth", move || bluetooth.call(call), offload::settle_json::<true>);
}

fn given(args: &v8::FunctionCallbackArguments, i: i32) -> bool {
    !args.get(i).is_null_or_undefined()
}

fn state(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, BtCall::State);
}

fn set_powered(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let on = bind::arg_bool(scope, &args, 0);
    send(scope, &mut rv, BtCall::SetPowered { on });
}

fn set_discoverable(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let on = bind::arg_bool(scope, &args, 0);
    let timeout = given(&args, 1).then(|| bind::arg_u32(scope, &args, 1));
    send(scope, &mut rv, BtCall::SetDiscoverable { on, timeout });
}

fn set_name(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, BtCall::SetName { name });
}

fn scan(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let on = bind::arg_bool(scope, &args, 0);
    send(scope, &mut rv, BtCall::Scan { on, owner: owner() });
}

fn pair(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, BtCall::Pair { id });
}

fn answer(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let accept = bind::arg_bool(scope, &args, 1);
    let pin = given(&args, 2).then(|| bind::arg_string(scope, &args, 2));
    send(scope, &mut rv, BtCall::Answer { id, accept, pin });
}

fn connect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, BtCall::Connect { id });
}

fn disconnect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, BtCall::Disconnect { id });
}

fn forget(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, BtCall::Forget { id });
}

fn set_trusted(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let on = bind::arg_bool(scope, &args, 1);
    send(scope, &mut rv, BtCall::SetTrusted { id, on });
}

fn set_blocked(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let on = bind::arg_bool(scope, &args, 1);
    send(scope, &mut rv, BtCall::SetBlocked { id, on });
}

fn rename(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let name = bind::arg_string(scope, &args, 1);
    send(scope, &mut rv, BtCall::Rename { id, name });
}

fn set_on_login(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let mode = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, BtCall::SetOnLogin { mode });
}

fn spawn(scope: &mut v8::PinScope, what: &'static str, work: impl FnOnce() -> Result<(), String> + Send + 'static) {
    let started = std::thread::Builder::new().name("acde-bluetooth".into()).spawn(move || {
        if let Err(e) = work() {
            log::warn!("acde.bluetooth.{what}: {e}");
        }
    });
    if let Err(e) = started {
        bind::throw_error(scope, &format!("acde.bluetooth.{what}: {e}"));
    }
}

fn watch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "acde.bluetooth.watch: the callback is not a function");
    };
    let Some(bluetooth) = bluetooth(scope) else { return };
    let callback = v8::Global::new(scope, callback);
    let start = STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.changed = Some(callback);
        !std::mem::replace(&mut s.watching, true)
    });
    if !start {
        return;
    }
    let tx = rt::current().sender();
    spawn(scope, "watch", move || bluetooth.listen(move |state| tx.send(Msg::Task(Box::new(move |scope| deliver(scope, false, &state)))).is_ok()));
}

fn pairing(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let callback = v8::Local::<v8::Function>::try_from(args.get(0)).ok().map(|c| v8::Global::new(scope, c));
    let Some(bluetooth) = bluetooth(scope) else { return };
    let on = callback.is_some();
    let (wanted, fresh) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.pairing = callback;
        match &s.wanted {
            Some(wanted) => (wanted.clone(), false),
            None => {
                let wanted = Arc::new(AtomicBool::new(false));
                s.wanted = Some(wanted.clone());
                (wanted, true)
            }
        }
    });
    wanted.store(on, Ordering::SeqCst);
    if !fresh {
        return;
    }
    let tx = rt::current().sender();
    spawn(scope, "pairing", move || {
        bluetooth.pairing(move |request| {
            if !wanted.load(Ordering::SeqCst) {
                return Some(false);
            }
            tx.send(Msg::Task(Box::new(move |scope| deliver(scope, true, &request)))).is_ok().then_some(true)
        })
    });
}

fn deliver(scope: &mut v8::PinScope, asked: bool, value: &serde_json::Value) {
    let callback = STATE.with(|s| {
        let s = s.borrow();
        if asked { s.pairing.clone() } else { s.changed.clone() }
    });
    let Some(callback) = callback else { return };
    let value = offload::json(scope, value);
    bind::call(scope, &callback, &[value]);
}
