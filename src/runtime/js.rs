#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use napi::bindgen_prelude::{Either, FromNapiValue, Function, JsValuesTupleIntoVec, Promise, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsValue, Result, Status};
use serde_json::Value;

use crate::runtime::sync::Locked;

const GUARD: &str = r#"(f) => (...args) => {
  const ok = (value) => JSON.stringify({ ok: value === undefined ? null : value })
  const fail = (error) => JSON.stringify({ error: String(error?.message ?? error) })
  try {
    const value = f(...args)
    return value && typeof value.then === 'function' ? Promise.resolve(value).then(ok, fail).catch(fail) : ok(value)
  } catch (error) {
    return fail(error)
  }
}"#;

type Settled = Either<String, Promise<String>>;

pub struct JsFn<A: 'static + JsValuesTupleIntoVec> {
    tsfn: ThreadsafeFunction<A, Settled, A, Status, false, true>,
}

impl<A: 'static + JsValuesTupleIntoVec> JsFn<A> {
    pub fn new(env: &Env, function: Unknown) -> Result<Self> {
        let guard: Function<Unknown, Unknown> = env.run_script(GUARD)?;
        let wrapped = guard.call(function)?;
        let wrapped: Function<A, Settled> = unsafe { Function::from_napi_value(env.raw(), wrapped.raw())? };
        let tsfn = wrapped.build_threadsafe_function::<A>().callee_handled::<false>().weak::<true>().build()?;
        Ok(Self { tsfn })
    }

    pub async fn ask(&self, argument: A) -> std::result::Result<Value, String> {
        let text = async {
            match self.tsfn.call_async(argument).await? {
                Either::A(text) => Ok(text),
                Either::B(promise) => promise.await,
            }
        }
        .await
        .map_err(|error: napi::Error| error.reason)?;
        let mut settled: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
        match settled.get_mut("error").map(Value::take) {
            Some(error) => Err(error.as_str().map_or_else(|| error.to_string(), str::to_owned)),
            None => Ok(settled.get_mut("ok").map(Value::take).unwrap_or_default()),
        }
    }

    pub fn notify(&self, argument: A, mode: ThreadsafeFunctionCallMode) {
        self.tsfn.call(argument, mode);
    }
}

pub type Sink<A> = std::sync::Arc<std::sync::Mutex<Option<JsFn<A>>>>;

pub struct Watch<A: 'static + JsValuesTupleIntoVec> {
    sink: Sink<A>,
    started: std::sync::atomic::AtomicBool,
}

impl<A: 'static + JsValuesTupleIntoVec> Default for Watch<A> {
    fn default() -> Self {
        Self { sink: Sink::default(), started: Default::default() }
    }
}

impl<A: 'static + JsValuesTupleIntoVec> Watch<A> {
    pub fn watch(&self, env: &Env, callback: Unknown, start: impl FnOnce(Sink<A>) -> Result<()>) -> Result<()> {
        use std::sync::atomic::Ordering;
        *self.sink.locked() = Some(JsFn::new(env, callback)?);
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        start(self.sink.clone()).inspect_err(|_| self.started.store(false, Ordering::SeqCst))
    }
}

pub fn notify<A: 'static + JsValuesTupleIntoVec>(sink: &Sink<A>, value: A) {
    if let Some(sink) = sink.locked().as_ref() {
        sink.notify(value, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

pub trait JsText {
    fn js_trim(&self) -> &str;
    fn uri_component(&self) -> String;
    fn units_before(&self, bytes: usize) -> usize;
}

impl JsText for str {
    fn js_trim(&self) -> &str {
        self.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
    }
    fn uri_component(&self) -> String {
        self.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    }
    fn units_before(&self, bytes: usize) -> usize {
        self.char_indices().take_while(|(i, _)| *i < bytes).map(|(_, c)| c.len_utf16()).sum()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod napi_stubs {
    use napi::sys::{Status, napi_env, napi_ref, napi_status, napi_threadsafe_function, napi_threadsafe_function_call_mode};

    fn missing(name: &str) -> napi_status {
        eprintln!("Node-API {name} called in a test without a host");
        Status::napi_generic_failure
    }

    #[unsafe(no_mangle)]
    extern "C" fn napi_call_threadsafe_function(_: napi_threadsafe_function, _: *mut std::ffi::c_void, _: napi_threadsafe_function_call_mode) -> napi_status {
        missing("napi_call_threadsafe_function")
    }

    #[unsafe(no_mangle)]
    extern "C" fn napi_reference_unref(_: napi_env, _: napi_ref, _: *mut u32) -> napi_status {
        missing("napi_reference_unref")
    }

    #[unsafe(no_mangle)]
    extern "C" fn napi_delete_reference(_: napi_env, _: napi_ref) -> napi_status {
        missing("napi_delete_reference")
    }
}
