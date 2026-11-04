// Copyright 2018-2026 the Deno authors. MIT license.

#![allow(non_camel_case_types, reason = "matches Node-API naming conventions")]
#![allow(non_upper_case_globals, reason = "matches Node-API naming conventions")]
#![allow(clippy::undocumented_unsafe_blocks, reason = "pervasive FFI unsafe blocks throughout NAPI implementation")]
#![allow(clippy::missing_safety_doc, reason = "Node-API entry points, called by addons")]

pub mod js_native_api;
pub mod node_api;
pub mod util;

use core::ptr::NonNull;
use std::cell::Cell;
use std::cell::RefCell;
pub use std::ffi::CStr;
pub use std::os::raw::c_char;
pub use std::os::raw::c_void;
pub use std::ptr;
use std::rc::Rc;
use std::sync::Arc;

pub use v8;
pub use value::napi_value;

pub mod function;
mod value;

pub type ScopeTask = Box<dyn FnOnce(&mut v8::PinScope<'_, '_>) + Send>;
pub type LocalTask = Box<dyn FnOnce(&mut v8::PinScope<'_, '_>)>;

#[derive(Clone)]
pub struct V8CrossThreadTaskSpawner(Arc<dyn Fn(ScopeTask) + Send + Sync>);

impl V8CrossThreadTaskSpawner {
  pub fn new(spawn: impl Fn(ScopeTask) + Send + Sync + 'static) -> Self {
    Self(Arc::new(spawn))
  }

  pub fn spawn(&self, task: impl FnOnce(&mut v8::PinScope<'_, '_>) + Send + 'static) {
    (self.0)(Box::new(task))
  }
}

#[derive(Clone)]
pub struct V8TaskSpawner(Rc<dyn Fn(LocalTask)>);

impl V8TaskSpawner {
  pub fn new(spawn: impl Fn(LocalTask) + 'static) -> Self {
    Self(Rc::new(spawn))
  }

  pub fn spawn(&self, task: impl FnOnce(&mut v8::PinScope<'_, '_>) + 'static) {
    (self.0)(Box::new(task))
  }
}

#[derive(Clone)]
pub struct ExternalOpsTracker(Arc<dyn Fn(bool) + Send + Sync>);

impl ExternalOpsTracker {
  pub fn new(count: impl Fn(bool) + Send + Sync + 'static) -> Self {
    Self(Arc::new(count))
  }

  pub fn ref_op(&self) {
    (self.0)(true)
  }

  pub fn unref_op(&self) {
    (self.0)(false)
  }
}

pub(crate) fn spawn_blocking(job: impl FnOnce() + Send + 'static) {
  if let Err(e) =
    std::thread::Builder::new().name("acde-napi-work".into()).spawn(job)
  {
    log::error!("acde-napi: cannot start a thread for async work: {e}");
  }
}

pub type napi_status = i32;
pub type napi_env = *mut c_void;
pub type napi_callback_info = *mut c_void;
pub type napi_deferred = *mut c_void;
pub type napi_ref = *mut c_void;
pub type napi_threadsafe_function = *mut c_void;
pub type napi_handle_scope = *mut c_void;
pub type napi_async_work = *mut c_void;

pub const napi_ok: napi_status = 0;
pub const napi_invalid_arg: napi_status = 1;
pub const napi_object_expected: napi_status = 2;
pub const napi_string_expected: napi_status = 3;
pub const napi_name_expected: napi_status = 4;
pub const napi_function_expected: napi_status = 5;
pub const napi_number_expected: napi_status = 6;
pub const napi_boolean_expected: napi_status = 7;
pub const napi_array_expected: napi_status = 8;
pub const napi_generic_failure: napi_status = 9;
pub const napi_pending_exception: napi_status = 10;
pub const napi_cancelled: napi_status = 11;
pub const napi_escape_called_twice: napi_status = 12;
pub const napi_handle_scope_mismatch: napi_status = 13;
pub const napi_callback_scope_mismatch: napi_status = 14;
pub const napi_queue_full: napi_status = 15;
pub const napi_closing: napi_status = 16;
pub const napi_bigint_expected: napi_status = 17;
pub const napi_date_expected: napi_status = 18;
pub const napi_arraybuffer_expected: napi_status = 19;
pub const napi_detachable_arraybuffer_expected: napi_status = 20;
pub const napi_would_deadlock: napi_status = 21;
pub const napi_no_external_buffers_allowed: napi_status = 22;
pub const napi_cannot_run_js: napi_status = 23;

pub static ERROR_MESSAGES: &[&CStr] = &[
  c"",
  c"Invalid argument",
  c"An object was expected",
  c"A string was expected",
  c"A string or symbol was expected",
  c"A function was expected",
  c"A number was expected",
  c"A boolean was expected",
  c"An array was expected",
  c"Unknown failure",
  c"An exception is pending",
  c"The async work item was cancelled",
  c"napi_escape_handle already called on scope",
  c"Invalid handle scope usage",
  c"Invalid callback scope usage",
  c"Thread-safe function queue is full",
  c"Thread-safe function handle is closing",
  c"A bigint was expected",
  c"A date was expected",
  c"An arraybuffer was expected",
  c"A detachable arraybuffer was expected",
  c"Main thread would deadlock",
  c"External buffers are not allowed",
  c"Cannot run JavaScript",
];

pub const NAPI_AUTO_LENGTH: usize = usize::MAX;

pub type napi_addon_register_func =
  unsafe extern "C" fn(env: napi_env, exports: napi_value) -> napi_value;

pub type napi_valuetype = i32;

pub const napi_undefined: napi_valuetype = 0;
pub const napi_null: napi_valuetype = 1;
pub const napi_boolean: napi_valuetype = 2;
pub const napi_number: napi_valuetype = 3;
pub const napi_string: napi_valuetype = 4;
pub const napi_symbol: napi_valuetype = 5;
pub const napi_object: napi_valuetype = 6;
pub const napi_function: napi_valuetype = 7;
pub const napi_external: napi_valuetype = 8;
pub const napi_bigint: napi_valuetype = 9;

pub type napi_threadsafe_function_release_mode = i32;

pub const napi_tsfn_abort: napi_threadsafe_function_release_mode = 1;

pub type napi_threadsafe_function_call_mode = i32;

pub const napi_tsfn_blocking: napi_threadsafe_function_call_mode = 1;

#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
pub struct napi_type_tag {
  pub lower: u64,
  pub upper: u64,
}

pub type napi_callback = unsafe extern "C" fn(
  env: napi_env,
  info: napi_callback_info,
) -> napi_value<'static>;

pub type napi_finalize = unsafe extern "C" fn(
  env: napi_env,
  data: *mut c_void,
  finalize_hint: *mut c_void,
);

pub type napi_async_execute_callback =
  unsafe extern "C" fn(env: napi_env, data: *mut c_void);

pub type napi_async_complete_callback =
  unsafe extern "C" fn(env: napi_env, status: napi_status, data: *mut c_void);

pub type napi_threadsafe_function_call_js = unsafe extern "C" fn(
  env: napi_env,
  js_callback: napi_value,
  context: *mut c_void,
  data: *mut c_void,
);

pub type napi_cleanup_hook = unsafe extern "C" fn(data: *mut c_void);

pub type napi_property_attributes = i32;

pub const napi_writable: napi_property_attributes = 1 << 0;
pub const napi_enumerable: napi_property_attributes = 1 << 1;
pub const napi_configurable: napi_property_attributes = 1 << 2;
pub const napi_static: napi_property_attributes = 1 << 10;

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct napi_property_descriptor<'a> {
  pub utf8name: *const c_char,
  pub name: napi_value<'a>,
  pub method: Option<napi_callback>,
  pub getter: Option<napi_callback>,
  pub setter: Option<napi_callback>,
  pub value: napi_value<'a>,
  pub attributes: napi_property_attributes,
  pub data: *mut c_void,
}

#[repr(C)]
#[derive(Debug)]
pub struct napi_extended_error_info {
  pub error_message: *const c_char,
  pub engine_reserved: *mut c_void,
  pub engine_error_code: i32,
  pub error_code: Cell<napi_status>,
}

#[repr(C)]
#[derive(Debug)]
pub struct napi_node_version {
  pub major: u32,
  pub minor: u32,
  pub patch: u32,
  pub release: *const c_char,
}

pub struct PendingNapiFinalizer {
  pub env: napi_env,
  pub cb: napi_finalize,
  pub data: *mut c_void,
  pub hint: *mut c_void,
}

#[derive(Default)]
pub struct GcFinalizers {
  ready: Vec<PendingNapiFinalizer>,
  drain_requested: bool,
}

impl GcFinalizers {
  fn defer(&mut self, finalizer: PendingNapiFinalizer) -> bool {
    self.ready.push(finalizer);
    !std::mem::replace(&mut self.drain_requested, true)
  }

  fn take(&mut self) -> Vec<PendingNapiFinalizer> {
    self.drain_requested = false;
    std::mem::take(&mut self.ready)
  }
}

#[repr(C)]
#[derive(Debug)]
pub struct InstanceData {
  pub data: *mut c_void,
  pub finalize_cb: Option<napi_finalize>,
  pub finalize_hint: *mut c_void,
}

#[repr(C)]
#[derive(Debug)]
pub struct EnvShared {
  pub instance_data: Option<InstanceData>,
  pub napi_wrap: v8::Global<v8::Private>,
  pub type_tag: v8::Global<v8::Private>,
}

#[repr(C)]
pub struct Env {
  context: NonNull<v8::Context>,
  pub isolate_ptr: v8::UnsafeRawIsolatePtr,
  pub shared: *mut EnvShared,
  pub async_work_sender: V8CrossThreadTaskSpawner,
  gc_finalizer_spawner: V8TaskSpawner,
  gc_finalizers: Rc<RefCell<GcFinalizers>>,
  external_ops_tracker: ExternalOpsTracker,
  pub last_error: napi_extended_error_info,
  pub last_exception: Option<v8::Global<v8::Value>>,
  pub global: v8::Global<v8::Object>,
  pub create_buffer: v8::Global<v8::Function>,
  pub report_error: v8::Global<v8::Function>,
}

unsafe impl Send for Env {}
unsafe impl Sync for Env {}

impl Env {
  pub fn shared(&self) -> &EnvShared {
    unsafe { &*self.shared }
  }

  pub fn shared_mut(&mut self) -> &mut EnvShared {
    unsafe { &mut *self.shared }
  }

  #[inline]
  pub fn isolate(&mut self) -> &mut v8::Isolate {
    unsafe {
      v8::Isolate::ref_from_raw_isolate_ptr_mut_unchecked(&mut self.isolate_ptr)
    }
  }

  pub fn context<'s>(&'s self) -> v8::Local<'s, v8::Context> {
    unsafe {
      std::mem::transmute::<NonNull<v8::Context>, v8::Local<v8::Context>>(
        self.context,
      )
    }
  }

  pub fn threadsafe_function_ref(&mut self) {
    self.external_ops_tracker.ref_op();
  }

  pub fn threadsafe_function_unref(&mut self) {
    self.external_ops_tracker.unref_op();
  }

  pub unsafe fn defer_gc_finalizer(
    env_ptr: *mut Env,
    cb: napi_finalize,
    data: *mut c_void,
    hint: *mut c_void,
  ) {
    let env = unsafe { &*env_ptr };
    let need_schedule =
      env.gc_finalizers.borrow_mut().defer(PendingNapiFinalizer {
        env: env_ptr as napi_env,
        cb,
        data,
        hint,
      });
    if need_schedule {
      let tracker = env.gc_finalizers.clone();
      env.gc_finalizer_spawner.spawn(move |scope| {
        drain_gc_finalizers(scope, &tracker);
      });
    }
  }
}

fn drain_gc_finalizers(
  scope: &mut v8::PinScope,
  tracker: &RefCell<GcFinalizers>,
) {
  let ready = tracker.borrow_mut().take();
  for f in ready {
    v8::tc_scope!(tc, scope);
    unsafe {
      (f.cb)(f.env, f.data, f.hint);
    }
    if !f.env.is_null() {
      let env = unsafe { &mut *(f.env as *mut Env) };
      if let Some(exception) = env.last_exception.take() {
        let exception = v8::Local::new(tc, &exception);
        report_finalizer_exception(tc, exception);
      }
    }
    if let Some(exception) = tc.exception() {
      report_finalizer_exception(tc, exception);
    }
  }
}

fn report_finalizer_exception(
  scope: &v8::PinScope,
  exception: v8::Local<v8::Value>,
) {
  log::error!(
    "Uncaught exception in Node-API finalizer: {}",
    exception.to_rust_string_lossy(scope)
  );
}

pub struct Embedder {
  pub cross_thread: V8CrossThreadTaskSpawner,
  pub local: V8TaskSpawner,
  pub ops: ExternalOpsTracker,
  pub create_buffer: v8::Global<v8::Function>,
  pub report_error: v8::Global<v8::Function>,
}

pub fn open<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  embedder: Embedder,
  register: napi_addon_register_func,
) -> v8::Local<'s, v8::Value> {
  let name = v8::String::new(scope, "napi_wrap").unwrap();
  let napi_wrap = v8::Private::new(scope, Some(name));
  let name = v8::String::new(scope, "type_tag").unwrap();
  let type_tag = v8::Private::new(scope, Some(name));
  let shared = EnvShared {
    instance_data: None,
    napi_wrap: v8::Global::new(scope, napi_wrap),
    type_tag: v8::Global::new(scope, type_tag),
  };
  let context = scope.get_current_context();
  let global = context.global(scope);
  let env = Env {
    isolate_ptr: unsafe { scope.as_raw_isolate_ptr() },
    context: v8::Global::new(scope, context).into_raw(),
    global: v8::Global::new(scope, global),
    create_buffer: embedder.create_buffer,
    report_error: embedder.report_error,
    shared: Box::into_raw(Box::new(shared)),
    async_work_sender: embedder.cross_thread,
    gc_finalizer_spawner: embedder.local,
    gc_finalizers: Default::default(),
    external_ops_tracker: embedder.ops,
    last_error: napi_extended_error_info {
      error_message: std::ptr::null(),
      engine_reserved: std::ptr::null_mut(),
      engine_error_code: 0,
      error_code: Cell::new(napi_ok),
    },
    last_exception: None,
  };
  let env_ptr = Box::into_raw(Box::new(env)) as napi_env;
  let exports = v8::Object::new(scope);
  let returned = unsafe { register(env_ptr, exports.into()) };
  match *returned {
    Some(value) => value,
    None => exports.into(),
  }
}
