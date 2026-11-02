// Copyright 2018-2026 the Deno authors. MIT license.

use std::mem::transmute;
use std::ops::Deref;
use std::os::raw::c_void;
use std::ptr::NonNull;

#[repr(transparent)]
#[derive(Clone, Copy, Debug)]
pub struct NapiValue<'s>(
  Option<NonNull<v8::Value>>,
  std::marker::PhantomData<&'s ()>,
);

pub type napi_value<'s> = NapiValue<'s>;

impl<'s> Deref for napi_value<'s> {
  type Target = Option<v8::Local<'s, v8::Value>>;
  fn deref(&self) -> &Self::Target {
    unsafe { transmute::<&Self, &Self::Target>(self) }
  }
}

impl<'s, T> From<v8::Local<'s, T>> for napi_value<'s>
where
  v8::Local<'s, T>: Into<v8::Local<'s, v8::Value>>,
{
  fn from(v: v8::Local<'s, T>) -> Self {
    Self(Some(NonNull::from(&*v.into())), std::marker::PhantomData)
  }
}

impl<'s, T> From<Option<v8::Local<'s, T>>> for napi_value<'s>
where
  v8::Local<'s, T>: Into<v8::Local<'s, v8::Value>>,
{
  fn from(v: Option<v8::Local<'s, T>>) -> Self {
    if let Some(v) = v {
      NapiValue::from(v)
    } else {
      Self(None, std::marker::PhantomData)
    }
  }
}

const _: () = {
  assert!(
    std::mem::size_of::<napi_value>() == std::mem::size_of::<*mut c_void>()
  );
  unsafe {
    type Src<'a> = napi_value<'a>;
    type Dst = usize;
    assert!(std::mem::size_of::<Src>() == std::mem::size_of::<Dst>());
    union Transmute<'a> {
      src: Src<'a>,
      dst: Dst,
    }
    Transmute {
      src: NapiValue(None, std::marker::PhantomData),
    }
    .dst
  };
};
