use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::mem::MaybeUninit;

#[macro_export]
macro_rules! methods {
    ($scope:expr, $obj:expr, data = $data:expr; $($name:literal => $f:expr),* $(,)?) => {
        $( $crate::bind::method_with($scope, $obj, $name, $f, Some($data)); )*
    };
    ($scope:expr, $obj:expr, $($name:literal => $f:expr),* $(,)?) => {
        $( $crate::bind::method($scope, $obj, $name, $f); )*
    };
}

pub struct SendFunction(pub v8::Global<v8::Function>);

unsafe impl Send for SendFunction {}
unsafe impl Sync for SendFunction {}

pub fn string<'s>(scope: &mut v8::PinScope<'s, '_>, text: &str) -> v8::Local<'s, v8::String> {
    v8::String::new(scope, text).unwrap_or_else(|| v8::String::empty(scope))
}

pub fn key<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str) -> v8::Local<'s, v8::String> {
    v8::String::new_from_utf8(scope, name.as_bytes(), v8::NewStringType::Internalized).unwrap_or_else(|| v8::String::empty(scope))
}

pub fn method(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str, callback: impl v8::MapFnTo<v8::FunctionCallback>) {
    method_with(scope, obj, name, callback, None);
}

pub fn method_with(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str, callback: impl v8::MapFnTo<v8::FunctionCallback>, data: Option<v8::Local<v8::Value>>) {
    let key = key(scope, name);
    let mut builder = v8::Function::builder(callback);
    if let Some(data) = data {
        builder = builder.data(data);
    }
    let function = builder.build(scope).expect("acdert: function");
    function.set_name(key);
    obj.set(scope, key.into(), function.into());
}

pub fn call<'s>(scope: &mut v8::PinScope<'s, '_>, function: impl v8::Handle<Data = v8::Function>, args: &[v8::Local<v8::Value>]) -> Option<v8::Local<'s, v8::Value>> {
    let function = v8::Local::new(scope, function);
    let recv = v8::undefined(scope);
    function.call(scope, recv.into(), args)
}

pub fn object<'s>(scope: &mut v8::PinScope<'s, '_>, fields: &[(&str, v8::Local<'s, v8::Value>)]) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    for &(name, value) in fields {
        set(scope, obj, name, value);
    }
    obj
}

pub fn strings(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<String>> {
    let list = v8::Local::<v8::Array>::try_from(value).ok()?;
    (0..list.length()).map(|i| list.get_index(scope, i).filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope))).collect()
}

pub fn own_string_pairs(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Vec<(String, String)> {
    let Ok(obj) = v8::Local::<v8::Object>::try_from(value) else { return Vec::new() };
    let Some(names) = obj.get_own_property_names(scope, Default::default()) else { return Vec::new() };
    (0..names.length())
        .filter_map(|i| {
            let name = names.get_index(scope, i)?;
            let value = obj.get(scope, name).filter(|v| v.is_string())?;
            Some((name.to_rust_string_lossy(scope), value.to_rust_string_lossy(scope)))
        })
        .collect()
}

thread_local! {
    static PROMISES: RefCell<(u32, HashMap<u32, v8::Global<v8::PromiseResolver>>)> = RefCell::new(Default::default());
}

pub fn promise<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<(u32, v8::Local<'s, v8::Promise>)> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let resolver = v8::Global::new(scope, resolver);
    let token = PROMISES.with(|p| {
        let mut p = p.borrow_mut();
        p.0 = p.0.wrapping_add(1).max(1);
        let token = p.0;
        p.1.insert(token, resolver);
        token
    });
    Some((token, promise))
}

pub fn resolver<'s>(scope: &mut v8::PinScope<'s, '_>, token: u32) -> Option<v8::Local<'s, v8::PromiseResolver>> {
    let resolver = PROMISES.with(|p| p.borrow_mut().1.remove(&token))?;
    Some(v8::Local::new(scope, resolver))
}

pub fn forget_promise(token: u32) {
    PROMISES.with(|p| p.borrow_mut().1.remove(&token));
}

pub fn clear_promises() {
    let promises = PROMISES.with(|p| std::mem::take(&mut p.borrow_mut().1));
    drop(promises);
}

pub fn set(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str, value: v8::Local<v8::Value>) {
    let key = key(scope, name);
    obj.set(scope, key.into(), value);
}

pub fn get<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<v8::Object>, name: &str) -> Option<v8::Local<'s, v8::Value>> {
    let key = key(scope, name);
    obj.get(scope, key.into())
}

pub fn throw_error(scope: &mut v8::PinScope, message: &str) {
    let message = string(scope, message);
    let error = v8::Exception::error(scope, message);
    scope.throw_exception(error);
}

pub fn throw_type_error(scope: &mut v8::PinScope, message: &str) {
    let message = string(scope, message);
    let error = v8::Exception::type_error(scope, message);
    scope.throw_exception(error);
}

pub fn throw_range_error(scope: &mut v8::PinScope, message: &str) {
    let message = string(scope, message);
    let error = v8::Exception::range_error(scope, message);
    scope.throw_exception(error);
}

pub fn arg_string(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    let value = args.get(i);
    if value.is_undefined() {
        return String::new();
    }
    value.to_rust_string_lossy(scope)
}

pub fn arg_str<'a, const N: usize>(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32, buffer: &'a mut [MaybeUninit<u8>; N]) -> Cow<'a, str> {
    let value = args.get(i);
    if value.is_undefined() {
        return Cow::Borrowed("");
    }
    let string = match v8::Local::<v8::String>::try_from(value) {
        Ok(string) => string,
        Err(_) => match value.to_string(scope) {
            Some(string) => string,
            None => return Cow::Borrowed(""),
        },
    };
    string.to_rust_cow_lossy(scope, buffer)
}

pub fn arg_f64(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> f64 {
    args.get(i).number_value(scope).unwrap_or(f64::NAN)
}

pub fn arg_u32(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> u32 {
    let n = arg_f64(scope, args, i);
    if n.is_finite() && n >= 0.0 { n as u32 } else { 0 }
}

#[cfg(target_os = "linux")]
pub fn arg_u64(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> u64 {
    let n = arg_f64(scope, args, i);
    if n.is_finite() && n >= 0.0 { n as u64 } else { 0 }
}

pub fn arg_bool(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> bool {
    args.get(i).boolean_value(scope)
}

pub fn with_bytes<R>(value: v8::Local<v8::Value>, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
        let mut storage = [0u8; v8::TYPED_ARRAY_MAX_SIZE_IN_HEAP];
        return Some(f(view.get_contents(&mut storage)));
    }
    if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
        let len = buffer.byte_length();
        return Some(match buffer.data() {
            Some(data) => f(unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, len) }),
            None => f(&[]),
        });
    }
    None
}

pub fn bytes(value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    with_bytes(value, <[u8]>::to_vec)
}

pub fn uint8_array<'s>(scope: &mut v8::PinScope<'s, '_>, data: Vec<u8>) -> v8::Local<'s, v8::Uint8Array> {
    let len = data.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(data).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Uint8Array::new(scope, buffer, 0, len).expect("acdert: Uint8Array")
}

fn array_buffer<'s, T: Copy>(scope: &mut v8::PinScope<'s, '_>, data: &[T]) -> v8::Local<'s, v8::ArrayBuffer> {
    let len = std::mem::size_of_val(data);
    let buffer = v8::ArrayBuffer::new(scope, len);
    if let Some(target) = buffer.data()
        && len > 0
    {
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr() as *const u8, target.as_ptr() as *mut u8, len) };
    }
    buffer
}

pub fn uint32_array<'s>(scope: &mut v8::PinScope<'s, '_>, data: &[u32]) -> v8::Local<'s, v8::Uint32Array> {
    let buffer = array_buffer(scope, data);
    v8::Uint32Array::new(scope, buffer, 0, data.len()).expect("acdert: Uint32Array")
}

pub fn float32_array<'s>(scope: &mut v8::PinScope<'s, '_>, data: &[f32]) -> v8::Local<'s, v8::Float32Array> {
    let buffer = array_buffer(scope, data);
    v8::Float32Array::new(scope, buffer, 0, data.len()).expect("acdert: Float32Array")
}

pub fn float64_array<'s>(scope: &mut v8::PinScope<'s, '_>, data: &[f64]) -> v8::Local<'s, v8::Float64Array> {
    let buffer = array_buffer(scope, data);
    v8::Float64Array::new(scope, buffer, 0, data.len()).expect("acdert: Float64Array")
}

pub fn run_script<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str, url: &str) -> Option<v8::Local<'s, v8::Value>> {
    let name = string(scope, url);
    let text = string(scope, source);
    let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, -1, None, false, false, false, None);
    let script = v8::Script::compile(scope, text, Some(&origin))?;
    script.run(scope)
}
