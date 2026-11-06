use std::ffi::c_void;

use acde_runtime as _;
#[cfg(target_os = "linux")]
use acde_shell as _;

use crate::rt;

unsafe extern "C" {
    fn napi_register_module_v1(env: *mut c_void, exports: *mut c_void) -> *mut c_void;
}

const CREATE_BUFFER: &str = "(buffer, offset, length) => new Uint8Array(buffer, offset, length)";

pub fn exports<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
    let lp = rt::current();
    let local = lp.clone();
    let create_buffer = crate::bind::run_script(scope, CREATE_BUFFER, "acde:napi").expect("acdert: create_buffer");
    let create_buffer = v8::Local::<v8::Function>::try_from(create_buffer).expect("acdert: create_buffer");
    let report_error = v8::Function::new(scope, |scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue| {
        rt::report(scope, args.get(0));
    })
    .expect("acdert: report_error");
    let embedder = acde_napi::Embedder {
        cross_thread: lp.spawner(),
        local: acde_napi::V8TaskSpawner::new(move |task| local.spawn_local(task)),
        ops: lp.ops(),
        create_buffer: v8::Global::new(scope, create_buffer),
        report_error: v8::Global::new(scope, report_error),
    };
    let register: acde_napi::napi_addon_register_func =
        unsafe { std::mem::transmute(napi_register_module_v1 as unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void) };
    acde_napi::open(scope, embedder, register)
}
