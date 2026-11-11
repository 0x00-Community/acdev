use acde_runtime::{SysCall, system_call};

use crate::{bind, offload};

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>) {
    let system = v8::Object::new(scope);
    crate::methods!(scope, system,
        "info" => info,
        "storage" => storage,
        "time" => time,
        "timezones" => timezones,
        "setTimezone" => set_timezone,
        "setNtp" => set_ntp,
        "setHostname" => set_hostname,
        "user" => user,
    );
    bind::set(scope, natives, "system", system.into());
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: SysCall) {
    offload::run(scope, rv, "acde-system", move || system_call(call), settle);
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

fn info(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, SysCall::Info);
}

fn storage(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, SysCall::Storage);
}

fn time(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, SysCall::Time);
}

fn timezones(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, SysCall::Timezones);
}

fn set_timezone(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let zone = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, SysCall::SetTimezone { zone });
}

fn set_ntp(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let on = bind::arg_bool(scope, &args, 0);
    send(scope, &mut rv, SysCall::SetNtp { on });
}

fn set_hostname(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, SysCall::SetHostname { name });
}

fn user(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, SysCall::User);
}

pub fn wire(name: &str, a: &mut crate::wire::WireArgs) -> crate::wire::Answer {
    use crate::wire::{Answer, Args, Fail, Ret};
    let call = match name {
        "info" => SysCall::Info,
        "storage" => SysCall::Storage,
        "time" => SysCall::Time,
        "timezones" => SysCall::Timezones,
        "setTimezone" => SysCall::SetTimezone { zone: a.str(0) },
        "setNtp" => SysCall::SetNtp { on: a.bool(0) },
        "setHostname" => SysCall::SetHostname { name: a.str(0) },
        "user" => SysCall::User,
        _ => return Answer::fail(format!("acde.system: no method {name}")),
    };
    Answer::Later(Box::new(move || match system_call(call) {
        Ok(serde_json::Value::Null) => Ok(Ret::Undefined),
        Ok(value) => Ok(Ret::Json(value)),
        Err(message) => Err(Fail { message, status: None, code: "GenericFailure".to_owned() }),
    }))
}
