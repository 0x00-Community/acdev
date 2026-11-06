use std::cell::RefCell;

use crate::bind;
use crate::rt::{self, Msg};

thread_local! {
    static CALLBACKS: RefCell<bind::Slab<v8::Global<v8::Function>>> = RefCell::default();
}

pub type Settle<T> = fn(&mut v8::PinScope, v8::Local<v8::PromiseResolver>, T);

pub fn run<T: Send + 'static>(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, thread: &str, work: impl FnOnce() -> T + Send + 'static, settle: Settle<T>) {
    let Some((token, promise)) = bind::promise(scope) else { return };
    let lp = rt::current();
    let tx = lp.sender();
    lp.keep_alive(true);
    let started = std::thread::Builder::new().name(thread.into()).spawn(move || {
        let value = work();
        _ = tx.send(Msg::Task(Box::new(move |scope| {
            rt::current().keep_alive(false);
            if let Some(resolver) = bind::resolver(scope, token) {
                settle(scope, resolver, value);
            }
        })));
    });
    if let Err(e) = started {
        lp.keep_alive(false);
        bind::forget_promise(token);
        return bind::throw_error(scope, &format!("{thread}: {e}"));
    }
    rv.set(promise.into());
}

pub fn settle_json<const NULL_IS_UNDEFINED: bool>(
    scope: &mut v8::PinScope,
    resolver: v8::Local<v8::PromiseResolver>,
    reply: Result<serde_json::Value, String>,
) {
    match reply {
        Ok(serde_json::Value::Null) if NULL_IS_UNDEFINED => {
            let undefined = v8::undefined(scope).into();
            resolver.resolve(scope, undefined);
        }
        Ok(value) => {
            let value = json(scope, &value);
            resolver.resolve(scope, value);
        }
        Err(message) => {
            let thrown = failure(scope, &message, None, "GenericFailure");
            resolver.reject(scope, thrown);
        }
    };
}

pub fn json_sink(scope: &mut v8::PinScope, callback: v8::Local<v8::Function>) -> impl Fn(serde_json::Value) -> bool + Send + Sync + 'static {
    let token = CALLBACKS.with(|c| c.borrow_mut().add(v8::Global::new(scope, callback)));
    let tx = rt::current().sender();
    move |value| {
        let deliver = move |scope: &mut v8::PinScope| {
            let Some(callback) = CALLBACKS.with(|c| c.borrow().get(&token).cloned()) else { return };
            let value = json(scope, &value);
            bind::call(scope, &callback, &[value]);
        };
        tx.send(Msg::Task(Box::new(deliver))).is_ok()
    }
}

pub fn clear() {
    let callbacks = CALLBACKS.with(|c| std::mem::take(&mut *c.borrow_mut()));
    drop(callbacks);
}

pub fn json<'s>(scope: &mut v8::PinScope<'s, '_>, value: &serde_json::Value) -> v8::Local<'s, v8::Value> {
    let text = bind::string(scope, &value.to_string());
    v8::json::parse(scope, text).unwrap_or_else(|| v8::null(scope).into())
}

pub fn failure<'s>(scope: &mut v8::PinScope<'s, '_>, message: &str, status: Option<i32>, code: &str) -> v8::Local<'s, v8::Value> {
    let text = bind::string(scope, message);
    let thrown = v8::Exception::error(scope, text);
    if let Ok(object) = v8::Local::<v8::Object>::try_from(thrown) {
        if let Some(status) = status {
            let status = v8::Integer::new(scope, status).into();
            bind::set(scope, object, "status", status);
        }
        let code = bind::string(scope, code).into();
        bind::set(scope, object, "code", code);
    }
    thrown
}
