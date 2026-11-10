use std::cell::RefCell;
use std::collections::HashMap;

use acde_runtime::Terminals;

use crate::{bind, offload};
use crate::rt::{self, Msg};

#[derive(Default)]
struct State {
    terminals: Option<Terminals>,
    listeners: HashMap<u32, v8::Global<v8::Function>>,
    next: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, terminals: Terminals) {
    STATE.with(|s| s.borrow_mut().terminals = Some(terminals));
    let terminal = v8::Object::new(scope);
    crate::methods!(scope, terminal,
        "open" => open,
        "subscribe" => subscribe,
        "input" => input,
        "resize" => resize,
        "close" => close,
    );
    bind::set(scope, natives, "terminal", terminal.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn with_terminals(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, f: impl FnOnce(&mut v8::PinScope, &Terminals) -> Result<serde_json::Value, String>) {
    let Some(terminals) = STATE.with(|s| s.borrow().terminals.as_ref().map(Terminals::shared)) else {
        return bind::throw_error(scope, "acde.terminal: not given to this web");
    };
    let result = f(scope, &terminals);
    let Some((token, promise)) = bind::promise(scope) else { return };
    let Some(resolver) = bind::resolver(scope, token) else { return };
    match result {
        Ok(value) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Err(error) => {
            let thrown = offload::failure(scope, &error, None, "GenericFailure");
            resolver.reject(scope, thrown);
        }
    }
    rv.set(promise.into());
}

fn open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (cols, rows) = (bind::arg_f64(scope, &args, 0), bind::arg_f64(scope, &args, 1));
    with_terminals(scope, &mut rv, |_, t| t.open(cols, rows).map_err(|e| e.reason.clone()));
}

fn input(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (id, data) = (bind::arg_string(scope, &args, 0), bind::arg_string(scope, &args, 1));
    with_terminals(scope, &mut rv, |_, t| t.input(id, data).map_err(|e| e.reason.clone()));
}

fn resize(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let (cols, rows) = (bind::arg_f64(scope, &args, 1), bind::arg_f64(scope, &args, 2));
    with_terminals(scope, &mut rv, |_, t| t.resize(id, cols, rows).map_err(|e| e.reason.clone()));
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    with_terminals(scope, &mut rv, |_, t| Ok(t.close(id)));
}

fn subscribe(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_string(scope, &args, 0);
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(1)) else {
        return bind::throw_type_error(scope, "acde.terminal.subscribe: the callback is not a function");
    };
    let callback = v8::Global::new(scope, callback);
    let token = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let token = s.next.wrapping_add(1).max(1);
        s.next = token;
        s.listeners.insert(token, callback);
        token
    });
    let tx = rt::current().sender();
    with_terminals(scope, &mut rv, move |_, t| {
        t.listen(&id, move |events| tx.send(Msg::Task(Box::new(move |scope| deliver(scope, token, &events)))).is_ok()).map_err(|e| e.reason.clone())?;
        Ok(serde_json::Value::Null)
    });
}

fn deliver(scope: &mut v8::PinScope, token: u32, events: &serde_json::Value) {
    let Some(callback) = STATE.with(|s| s.borrow().listeners.get(&token).cloned()) else { return };
    let value = offload::json(scope, events);
    bind::call(scope, &callback, &[value]);
}

pub fn wire(terminals: &Terminals, name: &str, a: &mut crate::wire::WireArgs, events: impl Fn(u32, serde_json::Value) -> bool + Send + Sync + 'static) -> crate::wire::Answer {
    use crate::wire::{Answer, Args, Fail, Ret};
    let t = terminals.shared();
    let reply = |r: Result<serde_json::Value, String>| r.map(Ret::Json).map_err(|e| Fail { message: e, status: None, code: "GenericFailure".to_owned() });
    match name {
        "open" => {
            let (cols, rows) = (a.f64(0), a.f64(1));
            Answer::Later(Box::new(move || reply(t.open(cols, rows).map_err(|e| e.reason.clone()))))
        }
        "input" => {
            let (id, data) = (a.str(0), a.str(1));
            Answer::Later(Box::new(move || reply(t.input(id, data).map_err(|e| e.reason.clone()))))
        }
        "resize" => {
            let (id, cols, rows) = (a.str(0), a.f64(1), a.f64(2));
            Answer::Later(Box::new(move || reply(t.resize(id, cols, rows).map_err(|e| e.reason.clone()))))
        }
        "close" => {
            let id = a.str(0);
            Answer::Later(Box::new(move || reply(Ok(t.close(id)))))
        }
        "subscribe" => {
            let (id, token) = (a.str(0), a.f64(1) as u32);
            Answer::Now(reply(t.listen(&id, move |batch| events(token, batch)).map(|()| serde_json::Value::Null).map_err(|e| e.reason.clone())))
        }
        _ => Answer::fail(format!("acde.terminal: no method {name}")),
    }
}
