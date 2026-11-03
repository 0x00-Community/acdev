use std::cell::RefCell;

use acde_runtime::{OfficeCall, OfficeService};

use crate::{bind, offload};

thread_local! {
    static OFFICE: RefCell<Option<OfficeService>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, office: OfficeService) {
    OFFICE.with(|o| *o.borrow_mut() = Some(office));
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "server" => server,
        "state" => state,
        "status" => status,
        "save" => save,
        "new" => create,
    );
    bind::set(scope, natives, "office", object.into());
}

pub fn clear() {
    OFFICE.with(|o| o.borrow_mut().take());
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: OfficeCall) {
    let Some(office) = OFFICE.with(|o| o.borrow().clone()) else {
        return bind::throw_error(scope, "acde.office: not given to this web");
    };
    offload::run(scope, rv, "acde-office", move || office.call(call), settle);
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, reply: Result<serde_json::Value, String>) {
    match reply {
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

fn text(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> Option<String> {
    (!args.get(i).is_null_or_undefined()).then(|| bind::arg_string(scope, args, i))
}

fn body(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<serde_json::Value> {
    let value = args.get(0);
    if value.is_null_or_undefined() {
        return None;
    }
    let json = v8::json::stringify(scope, value)?.to_rust_string_lossy(scope);
    serde_json::from_str(&json).ok()
}

fn server(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, OfficeCall::Server);
}

fn state(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (root, dir, path) = (text(scope, &args, 0), text(scope, &args, 1), text(scope, &args, 2));
    send(scope, &mut rv, OfficeCall::State { root, dir, path });
}

fn status(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let key = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, OfficeCall::Status { key });
}

fn save(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let body = body(scope, &args);
    send(scope, &mut rv, OfficeCall::Save { body });
}

fn create(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let body = body(scope, &args);
    send(scope, &mut rv, OfficeCall::New { body });
}
