// Copyright 2018-2026 the Deno authors. MIT license.

#![deny(unsafe_op_in_unsafe_fn)]

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crate::V8CrossThreadTaskSpawner;
use parking_lot::Condvar;
use parking_lot::Mutex;
use napi_sym::napi_sym;

use super::util::SendPtr;
use super::util::get_array_buffer_ptr;
use super::util::make_external_backing_store;
use super::util::napi_clear_last_error;
use super::util::napi_set_last_error;
use crate::check_arg;
use crate::check_env;
use crate::*;

#[napi_sym]
fn napi_add_env_cleanup_hook(
  env: *mut Env,
  fun: Option<napi_cleanup_hook>,
  _arg: *mut c_void,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, fun);
  napi_ok
}

#[napi_sym]
fn napi_remove_env_cleanup_hook(
  env: *mut Env,
  fun: Option<napi_cleanup_hook>,
  _arg: *mut c_void,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, fun);
  napi_ok
}

#[napi_sym]
fn napi_fatal_exception(env: &mut Env, err: napi_value) -> napi_status {
  check_arg!(env, err);

  v8::callback_scope!(unsafe scope, env.context());

  let report_error = v8::Local::new(scope, &env.report_error);

  let this = v8::undefined(scope);
  if report_error
    .call(scope, this.into(), &[err.unwrap()])
    .is_none()
  {
    return napi_generic_failure;
  }

  napi_ok
}

#[napi_sym]
fn napi_fatal_error(
  location: *const c_char,
  location_len: usize,
  message: *const c_char,
  message_len: usize,
) -> napi_status {
  let location = if location.is_null() {
    None
  } else {
    unsafe {
      Some(if location_len == NAPI_AUTO_LENGTH {
        std::ffi::CStr::from_ptr(location).to_str().unwrap()
      } else {
        let slice = std::slice::from_raw_parts(
          location as *const _,
          location_len as usize,
        );
        std::str::from_utf8(slice).unwrap()
      })
    }
  };

  let message = if message_len == NAPI_AUTO_LENGTH {
    unsafe { std::ffi::CStr::from_ptr(message).to_str().unwrap() }
  } else {
    let slice = unsafe {
      std::slice::from_raw_parts(message as *const _, message_len as usize)
    };
    std::str::from_utf8(slice).unwrap()
  };

  if let Some(location) = location {
    log::error!("NODE API FATAL ERROR: {} {}", location, message);
  } else {
    log::error!("NODE API FATAL ERROR: {}", message);
  }

  std::process::abort();
}

fn wrap_buffer<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  env: &Env,
  ab: v8::Local<'s, v8::ArrayBuffer>,
) -> Option<v8::Local<'s, v8::Value>> {
  let create_buffer = v8::Local::new(scope, &env.create_buffer);
  let recv = v8::null(scope).into();
  create_buffer.call(scope, recv, &[ab.into()])
}

#[napi_sym]
fn napi_create_buffer<'s>(
  env: &'s mut Env,
  length: usize,
  data: *mut *mut c_void,
  result: *mut napi_value<'s>,
) -> napi_status {
  check_arg!(env, result);

  v8::callback_scope!(unsafe scope, env.context());

  let ab = v8::ArrayBuffer::new(scope, length);

  let Some(buffer) = wrap_buffer(scope, env, ab) else {
    return napi_generic_failure;
  };

  if !data.is_null() {
    unsafe {
      *data = get_array_buffer_ptr(ab);
    }
  }

  unsafe {
    *result = buffer.into();
  }

  napi_ok
}

#[napi_sym]
fn napi_create_external_buffer<'s>(
  env: &'s mut Env,
  length: usize,
  data: *mut c_void,
  finalize_cb: Option<napi_finalize>,
  finalize_hint: *mut c_void,
  result: *mut napi_value<'s>,
) -> napi_status {
  check_arg!(env, result);

  let store = make_external_backing_store(
    env,
    data,
    length,
    ptr::null_mut(),
    finalize_cb,
    finalize_hint,
  );

  v8::callback_scope!(unsafe scope, env.context());
  let ab = v8::ArrayBuffer::with_backing_store(scope, &store.make_shared());

  let Some(buffer) = wrap_buffer(scope, env, ab) else {
    return napi_generic_failure;
  };

  unsafe {
    *result = buffer.into();
  }

  napi_ok
}

#[napi_sym]
fn napi_create_buffer_copy<'s>(
  env: &'s mut Env,
  length: usize,
  data: *mut c_void,
  result_data: *mut *mut c_void,
  result: *mut napi_value<'s>,
) -> napi_status {
  check_arg!(env, result);

  v8::callback_scope!(unsafe scope, env.context());

  let ab = v8::ArrayBuffer::new(scope, length);

  let Some(buffer) = wrap_buffer(scope, env, ab) else {
    return napi_generic_failure;
  };

  let ptr = get_array_buffer_ptr(ab);
  unsafe {
    std::ptr::copy(data, ptr, length);
  }

  if !result_data.is_null() {
    unsafe {
      *result_data = ptr;
    }
  }

  unsafe {
    *result = buffer.into();
  }

  napi_ok
}

#[napi_sym]
fn napi_is_buffer(
  env: *mut Env,
  value: napi_value,
  result: *mut bool,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, value);
  check_arg!(env, result);

  unsafe {
    *result = value.unwrap().is_array_buffer_view();
  }

  napi_clear_last_error(env)
}

#[napi_sym]
fn napi_get_buffer_info(
  env: *mut Env,
  value: napi_value,
  data: *mut *mut c_void,
  length: *mut usize,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, value);

  let Some(ta) =
    value.and_then(|v| v8::Local::<v8::TypedArray>::try_from(v).ok())
  else {
    return napi_set_last_error(env, napi_invalid_arg);
  };

  if !data.is_null() {
    unsafe {
      *data = ta.data();
    }
  }

  if !length.is_null() {
    unsafe {
      *length = ta.byte_length();
    }
  }

  napi_clear_last_error(env)
}

#[napi_sym]
fn napi_get_node_version(
  env: *mut Env,
  result: *mut *const napi_node_version,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, result);

  const NODE_VERSION: napi_node_version = napi_node_version {
    major: 24,
    minor: 0,
    patch: 0,
    release: c"acde".as_ptr(),
  };

  unsafe {
    *result = &NODE_VERSION as *const napi_node_version;
  }

  napi_clear_last_error(env)
}

fn check_async_resource(
  scope: &mut v8::PinScope,
  resource: napi_value,
  name: napi_value,
) -> Result<(), napi_status> {
  if let Some(v) = *resource
    && v.to_object(scope).is_none()
  {
    return Err(napi_object_expected);
  }
  if name.and_then(|v| v.to_string(scope)).is_none() {
    return Err(napi_string_expected);
  }
  Ok(())
}

struct AsyncWork {
  state: AtomicU8,
  env: *mut Env,
  execute: napi_async_execute_callback,
  complete: Option<napi_async_complete_callback>,
  data: *mut c_void,
}

impl AsyncWork {
  const IDLE: u8 = 0;
  const QUEUED: u8 = 1;
  const RUNNING: u8 = 2;
}

#[napi_sym]
pub(crate) fn napi_create_async_work(
  env: *mut Env,
  async_resource: napi_value,
  async_resource_name: napi_value,
  execute: Option<napi_async_execute_callback>,
  complete: Option<napi_async_complete_callback>,
  data: *mut c_void,
  result: *mut napi_async_work,
) -> napi_status {
  let env_ptr = env;
  let env = check_env!(env);
  check_arg!(env, execute);
  check_arg!(env, result);

  let checked = {
    v8::callback_scope!(unsafe scope, env.context());
    check_async_resource(scope, async_resource, async_resource_name)
  };
  if let Err(status) = checked {
    return napi_set_last_error(env, status);
  }

  let work = Box::new(AsyncWork {
    state: AtomicU8::new(AsyncWork::IDLE),
    env: env_ptr,
    execute: execute.unwrap(),
    complete,
    data,
  });

  unsafe {
    *result = Box::into_raw(work) as _;
  }

  napi_clear_last_error(env)
}

#[napi_sym]
pub(crate) fn napi_delete_async_work(
  env: *mut Env,
  work: napi_async_work,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, work);

  drop(unsafe { Box::<AsyncWork>::from_raw(work as _) });

  napi_clear_last_error(env)
}

#[napi_sym]
pub(crate) fn napi_queue_async_work(
  env: *mut Env,
  work: napi_async_work,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, work);

  let work = unsafe { &*(work as *mut AsyncWork) };

  let result =
    work
      .state
      .try_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
        if state == AsyncWork::IDLE || state == AsyncWork::RUNNING {
          Some(AsyncWork::QUEUED)
        } else {
          None
        }
      });

  if result.is_err() {
    return napi_clear_last_error(env);
  }

  let work = SendPtr(work);
  let sender = env.async_work_sender.clone();
  let tracker = env.external_ops_tracker.clone();

  tracker.ref_op();

  crate::spawn_blocking(move || {
    let work = work.take();
    let work = unsafe { &*work };

    let state = work.state.compare_exchange(
      AsyncWork::QUEUED,
      AsyncWork::RUNNING,
      Ordering::SeqCst,
      Ordering::SeqCst,
    );

    if state.is_ok() {
      unsafe {
        (work.execute)(work.env as _, work.data);
      }

      let _ = work.state.compare_exchange(
        AsyncWork::RUNNING,
        AsyncWork::IDLE,
        Ordering::SeqCst,
        Ordering::Relaxed,
      );
    }

    let complete = work.complete;
    let env_ptr = SendPtr(work.env);
    let data = SendPtr(work.data);

    if let Some(complete) = complete {
      let status = if state.is_ok() {
        napi_ok
      } else if state == Err(AsyncWork::IDLE) {
        napi_cancelled
      } else {
        napi_generic_failure
      };

      sender.spawn(move |_| {
        unsafe {
          complete(env_ptr.take() as _, status, data.take() as _);
        }
        tracker.unref_op();
      });
    } else {
      tracker.unref_op();
    }
  });

  napi_clear_last_error(env)
}

#[napi_sym]
fn napi_cancel_async_work(env: *mut Env, work: napi_async_work) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, work);

  let work = unsafe { &*(work as *mut AsyncWork) };

  let _ = work.state.compare_exchange(
    AsyncWork::QUEUED,
    AsyncWork::IDLE,
    Ordering::SeqCst,
    Ordering::Relaxed,
  );

  napi_clear_last_error(env)
}

extern "C" fn default_call_js_cb(
  env: napi_env,
  js_callback: napi_value,
  _context: *mut c_void,
  _data: *mut c_void,
) {
  if let Some(js_callback) = *js_callback
    && let Ok(js_callback) = v8::Local::<v8::Function>::try_from(js_callback)
  {
    let env = unsafe { &mut *(env as *mut Env) };
    v8::callback_scope!(unsafe scope, env.context());
    let recv = v8::undefined(scope);
    js_callback.call(scope, recv.into(), &[]);
  }
}

struct TsFn {
  env: *mut Env,
  func: Option<v8::Global<v8::Function>>,
  max_queue_size: usize,
  queue_size: Mutex<usize>,
  queue_cond: Condvar,
  thread_count: AtomicUsize,
  thread_finalize_data: *mut c_void,
  thread_finalize_cb: Option<napi_finalize>,
  context: *mut c_void,
  call_js_cb: napi_threadsafe_function_call_js,
  is_closing: AtomicBool,
  is_closed: Arc<AtomicBool>,
  sender: V8CrossThreadTaskSpawner,
  is_ref: AtomicBool,
}

impl Drop for TsFn {
  fn drop(&mut self) {
    assert!(
      self
        .is_closed
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    );

    self.unref();

    if let Some(finalizer) = self.thread_finalize_cb {
      unsafe {
        (finalizer)(self.env as _, self.thread_finalize_data, self.context);
      }
    }
  }
}

impl TsFn {
  pub fn release(
    tsfn: *mut TsFn,
    mode: napi_threadsafe_function_release_mode,
  ) -> napi_status {
    let tsfn = unsafe { &mut *tsfn };

    let result = tsfn.thread_count.try_update(
      Ordering::Relaxed,
      Ordering::Relaxed,
      |x| {
        if x == 0 { None } else { Some(x - 1) }
      },
    );

    if result.is_err() {
      return napi_invalid_arg;
    }

    if mode == napi_tsfn_abort {
      tsfn.is_closing.store(true, Ordering::SeqCst);
      tsfn.queue_cond.notify_all();
    }

    if result == Ok(1) {
      tsfn.is_closing.store(true, Ordering::SeqCst);
      tsfn.queue_cond.notify_all();
      let tsfnptr = SendPtr(tsfn);
      tsfn.sender.spawn(move |_| {
        let tsfn = unsafe { Box::from_raw(tsfnptr.take() as *mut TsFn) };
        drop(tsfn);
      });
    }

    napi_ok
  }

  pub fn ref_(&self) -> napi_status {
    if self
      .is_ref
      .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
      .is_ok()
    {
      let env = unsafe { &mut *self.env };
      env.threadsafe_function_ref();
    }
    napi_ok
  }

  pub fn unref(&self) -> napi_status {
    if self
      .is_ref
      .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
      .is_ok()
    {
      let env = unsafe { &mut *self.env };
      env.threadsafe_function_unref();
    }

    napi_ok
  }

  pub fn call(
    &self,
    data: *mut c_void,
    mode: napi_threadsafe_function_call_mode,
  ) -> napi_status {
    if self.is_closing.load(Ordering::SeqCst) {
      return napi_closing;
    }

    if self.max_queue_size > 0 {
      let mut queue_size = self.queue_size.lock();
      while *queue_size >= self.max_queue_size {
        if mode == napi_tsfn_blocking {
          self.queue_cond.wait(&mut queue_size);

          if self.is_closing.load(Ordering::SeqCst) {
            return napi_closing;
          }
        } else {
          return napi_queue_full;
        }
      }
      *queue_size += 1;
    }

    let is_closed = self.is_closed.clone();
    let tsfn = SendPtr(self);
    let data = SendPtr(data);
    let context = SendPtr(self.context);
    let call_js_cb = self.call_js_cb;
    let env = SendPtr(self.env);

    self.sender.spawn(move |scope: &mut v8::PinScope<'_, '_>| {
      let data = data.take();

      if is_closed.load(Ordering::Relaxed) {
        unsafe {
          call_js_cb(
            env.take() as _,
            None::<v8::Local<v8::Value>>.into(),
            context.take() as _,
            data as _,
          );
        }
      } else {
        let tsfn = tsfn.take();

        let tsfn = unsafe { &*tsfn };

        if tsfn.max_queue_size > 0 {
          let mut queue_size = tsfn.queue_size.lock();
          let size = *queue_size;
          *queue_size -= 1;
          if size == tsfn.max_queue_size {
            tsfn.queue_cond.notify_one();
          }
        }

        let func = tsfn.func.as_ref().map(|f| v8::Local::new(scope, f));

        unsafe {
          (tsfn.call_js_cb)(
            tsfn.env as _,
            func.into(),
            tsfn.context,
            data as _,
          );
        }
      }
    });

    napi_ok
  }
}

#[napi_sym]
#[allow(clippy::too_many_arguments, reason = "private code")]
fn napi_create_threadsafe_function(
  env: *mut Env,
  func: napi_value,
  async_resource: napi_value,
  async_resource_name: napi_value,
  max_queue_size: usize,
  initial_thread_count: usize,
  thread_finalize_data: *mut c_void,
  thread_finalize_cb: Option<napi_finalize>,
  context: *mut c_void,
  call_js_cb: Option<napi_threadsafe_function_call_js>,
  result: *mut napi_threadsafe_function,
) -> napi_status {
  let env = check_env!(env);
  check_arg!(env, async_resource_name);
  if initial_thread_count == 0 {
    return napi_set_last_error(env, napi_invalid_arg);
  }
  check_arg!(env, result);

  let func = {
    v8::callback_scope!(unsafe scope, env.context());
    let func = if let Some(value) = *func {
      let Ok(func) = v8::Local::<v8::Function>::try_from(value) else {
        return napi_set_last_error(env, napi_function_expected);
      };
      Some(v8::Global::new(scope, func))
    } else {
      check_arg!(env, call_js_cb);
      None
    };
    if let Err(status) =
      check_async_resource(scope, async_resource, async_resource_name)
    {
      return napi_set_last_error(env, status);
    }
    func
  };

  let tsfn = Box::new(TsFn {
    env,
    func,
    max_queue_size,
    queue_size: Mutex::new(0),
    queue_cond: Condvar::new(),
    thread_count: AtomicUsize::new(initial_thread_count),
    thread_finalize_data,
    thread_finalize_cb,
    context,
    call_js_cb: call_js_cb.unwrap_or(default_call_js_cb),
    is_closing: AtomicBool::new(false),
    is_closed: Arc::new(AtomicBool::new(false)),
    is_ref: AtomicBool::new(false),
    sender: env.async_work_sender.clone(),
  });

  tsfn.ref_();

  unsafe {
    *result = Box::into_raw(tsfn) as _;
  }

  napi_clear_last_error(env)
}

#[napi_sym]
fn napi_call_threadsafe_function(
  func: napi_threadsafe_function,
  data: *mut c_void,
  is_blocking: napi_threadsafe_function_call_mode,
) -> napi_status {
  assert!(!func.is_null());
  let tsfn = unsafe { &*(func as *mut TsFn) };
  tsfn.call(data, is_blocking)
}

#[napi_sym]
fn napi_release_threadsafe_function(
  tsfn: napi_threadsafe_function,
  mode: napi_threadsafe_function_release_mode,
) -> napi_status {
  assert!(!tsfn.is_null());
  TsFn::release(tsfn as _, mode)
}

#[napi_sym]
fn napi_unref_threadsafe_function(
  _env: &mut Env,
  func: napi_threadsafe_function,
) -> napi_status {
  assert!(!func.is_null());
  let tsfn = unsafe { &*(func as *mut TsFn) };
  tsfn.unref()
}

#[napi_sym]
fn napi_ref_threadsafe_function(
  _env: &mut Env,
  func: napi_threadsafe_function,
) -> napi_status {
  assert!(!func.is_null());
  let tsfn = unsafe { &*(func as *mut TsFn) };
  tsfn.ref_()
}
