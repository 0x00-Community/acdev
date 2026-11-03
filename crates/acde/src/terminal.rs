use std::cell::RefCell;
use std::collections::HashMap;

use acde_runtime::Terminals;

use crate::bind;
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
            let value = json(scope, &value);
            resolver.resolve(scope, value);
        }
        Err(error) => {
            let text = bind::string(scope, &error);
            let thrown = v8::Exception::error(scope, text);
            if let Ok(object) = v8::Local::<v8::Object>::try_from(thrown) {
                let code = bind::string(scope, "GenericFailure").into();
                bind::set(scope, object, "code", code);
            }
            resolver.reject(scope, thrown);
        }
    }
    rv.set(promise.into());
}

fn json<'s>(scope: &mut v8::PinScope<'s, '_>, value: &serde_json::Value) -> v8::Local<'s, v8::Value> {
    let text = bind::string(scope, &value.to_string());
    v8::json::parse(scope, text).unwrap_or_else(|| v8::null(scope).into())
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
    let value = json(scope, events);
    bind::call(scope, &callback, &[value]);
}
