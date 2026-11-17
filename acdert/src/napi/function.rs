// Copyright 2018-2026 the Deno authors. MIT license.
use crate::napi::*;

#[repr(C)]
#[derive(Debug)]
pub struct CallbackInfo {
    pub env: *mut Env,
    pub cb: napi_callback,
    pub data: *mut c_void,
}

#[repr(C)]
#[derive(Debug)]
pub struct CallbackInfoScope {
    pub function_info: *const CallbackInfo,
    pub args: *const c_void,
}

impl CallbackInfo {
    fn to_v8<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::BigInt> {
        let words = [self.env as u64, self.cb as usize as u64, self.data as u64];
        v8::BigInt::new_from_words(scope, false, &words).expect("napi: callback data")
    }

    fn from_v8(data: v8::Local<v8::Value>) -> Self {
        let bigint = unsafe { v8::Local::<v8::BigInt>::cast_unchecked(data) };
        let mut words = [0u64; 3];
        bigint.to_words_array(&mut words);
        Self { env: words[0] as *mut Env, cb: unsafe { std::mem::transmute::<usize, napi_callback>(words[1] as usize) }, data: words[2] as *mut c_void }
    }
}

extern "C" fn call_fn(info: *const v8::FunctionCallbackInfo) {
    let v8_callback_info = unsafe { &*info };
    let args = v8::FunctionCallbackArguments::from_function_callback_info(v8_callback_info);
    let mut rv = v8::ReturnValue::from_function_callback_info(v8_callback_info);
    let info = CallbackInfo::from_v8(args.data());
    let mut callback_info_scope = CallbackInfoScope { function_info: &info, args: &args as *const _ as *const c_void };

    let value = unsafe { (info.cb)(info.env as napi_env, &mut callback_info_scope as *mut _ as *mut c_void) };
    if let Some(exc) = unsafe { &mut *info.env }.last_exception.take() {
        v8::callback_scope!(unsafe scope, v8_callback_info);
        let exc = v8::Local::new(scope, exc);
        scope.throw_exception(exc);
        return;
    }
    if let Some(value) = *value {
        rv.set(value);
    }
}

pub fn create_function<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    env: *mut Env,
    name: Option<v8::Local<v8::String>>,
    cb: napi_callback,
    data: *mut c_void,
) -> v8::Local<'s, v8::Function> {
    let info = CallbackInfo { env, cb, data }.to_v8(scope);
    let function = v8::Function::builder_raw(call_fn).data(info.into()).build(scope).unwrap();

    if let Some(v8str) = name {
        function.set_name(v8str);
    }

    function
}

pub fn create_function_template<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    env: *mut Env,
    name: Option<v8::Local<v8::String>>,
    cb: napi_callback,
    cb_info: napi_callback_info,
) -> v8::Local<'s, v8::FunctionTemplate> {
    let info = CallbackInfo { env, cb, data: cb_info }.to_v8(scope);
    let function = v8::FunctionTemplate::builder_raw(call_fn).data(info.into()).build(scope);

    if let Some(v8str) = name {
        function.set_class_name(v8str);
    }

    function
}
