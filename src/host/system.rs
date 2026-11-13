use crate::runtime::{SysCall, system_call};

use crate::host::{bind, offload};

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
    offload::run(scope, rv, "acde-system", move || system_call(call), offload::settle_json::<true>);
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
