use serde_json::Value;

use crate::bind;

pub const UNDEFINED: u8 = 0;
pub const NULL: u8 = 1;
pub const FALSE: u8 = 2;
pub const TRUE: u8 = 3;
pub const NUMBER: u8 = 4;
pub const STRING: u8 = 5;
pub const BYTES: u8 = 6;
pub const U32S: u8 = 7;
pub const F64S: u8 = 8;
pub const LIST: u8 = 9;
pub const OBJECT: u8 = 10;
pub const BIGINT: u8 = 11;

pub trait Args {
    fn f64(&mut self, i: usize) -> f64;
    fn bool(&mut self, i: usize) -> bool;
    fn str(&mut self, i: usize) -> String;
    fn with_bytes<R>(&mut self, i: usize, f: impl FnOnce(&[u8]) -> R) -> Option<R>;
    fn json(&mut self, i: usize) -> Value;

    fn id(&mut self, i: usize) -> u32 {
        let n = self.f64(i);
        if n >= 0.0 && n < acde_render::NONE as f64 { n as u32 } else { acde_render::NONE }
    }
}

pub struct V8Args<'a, 's, 'p> {
    pub scope: &'a mut v8::PinScope<'s, 'p>,
    pub args: &'a v8::FunctionCallbackArguments<'s>,
}

impl Args for V8Args<'_, '_, '_> {
    fn f64(&mut self, i: usize) -> f64 {
        bind::arg_f64(self.scope, self.args, i as i32)
    }

    fn bool(&mut self, i: usize) -> bool {
        bind::arg_bool(self.scope, self.args, i as i32)
    }

    fn str(&mut self, i: usize) -> String {
        bind::arg_string(self.scope, self.args, i as i32)
    }

    fn with_bytes<R>(&mut self, i: usize, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
        bind::with_bytes(self.args.get(i as i32), f)
    }

    fn json(&mut self, i: usize) -> Value {
        let value = self.args.get(i as i32);
        if value.is_undefined() {
            return Value::Null;
        }
        v8::json::stringify(self.scope, value).and_then(|s| serde_json::from_str(&s.to_rust_string_lossy(self.scope)).ok()).unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WVal {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Bytes(Vec<u8>),
    U32s(Vec<u32>),
    F64s(Vec<f64>),
    List(Vec<WVal>),
    Obj(Vec<(String, WVal)>),
    BigInt(i64),
}

impl WVal {
    pub fn to_json(&self) -> Value {
        match self {
            WVal::Undefined | WVal::Null => Value::Null,
            WVal::Bool(b) => Value::Bool(*b),
            WVal::Num(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
            WVal::Str(s) => Value::String(s.clone()),
            WVal::Bytes(b) => Value::Array(b.iter().map(|&n| Value::from(n)).collect()),
            WVal::U32s(v) => Value::Array(v.iter().map(|&n| Value::from(n)).collect()),
            WVal::F64s(v) => Value::Array(v.iter().map(|&n| serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)).collect()),
            WVal::List(items) => Value::Array(items.iter().map(WVal::to_json).collect()),
            WVal::Obj(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), v.to_json())).collect()),
            WVal::BigInt(n) => Value::from(*n),
        }
    }

    pub fn as_f64(&self) -> f64 {
        match self {
            WVal::Num(n) => *n,
            WVal::Bool(b) => f64::from(u8::from(*b)),
            WVal::BigInt(n) => *n as f64,
            WVal::Str(s) => s.trim().parse().unwrap_or(f64::NAN),
            WVal::Null => 0.0,
            _ => f64::NAN,
        }
    }

    pub fn truthy(&self) -> bool {
        match self {
            WVal::Undefined | WVal::Null => false,
            WVal::Bool(b) => *b,
            WVal::Num(n) => *n != 0.0 && !n.is_nan(),
            WVal::Str(s) => !s.is_empty(),
            WVal::BigInt(n) => *n != 0,
            _ => true,
        }
    }
}

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }

    pub fn rest(&self) -> &'a [u8] {
        &self.data[self.pos.min(self.data.len())..]
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    pub fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    pub fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    }

    pub fn f64(&mut self) -> Option<f64> {
        self.take(8).map(|b| f64::from_le_bytes(b.try_into().unwrap()))
    }

    pub fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()? as usize;
        self.take(n)
    }

    pub fn string(&mut self) -> Option<String> {
        self.bytes().map(|b| String::from_utf8_lossy(b).into_owned())
    }

    pub fn value(&mut self) -> Option<WVal> {
        Some(match self.u8()? {
            UNDEFINED => WVal::Undefined,
            NULL => WVal::Null,
            FALSE => WVal::Bool(false),
            TRUE => WVal::Bool(true),
            NUMBER => WVal::Num(self.f64()?),
            STRING => WVal::Str(self.string()?),
            BYTES => WVal::Bytes(self.bytes()?.to_vec()),
            U32S => WVal::U32s(self.bytes()?.as_chunks::<4>().0.iter().map(|c| u32::from_le_bytes(*c)).collect()),
            F64S => WVal::F64s(self.bytes()?.as_chunks::<8>().0.iter().map(|c| f64::from_le_bytes(*c)).collect()),
            LIST => {
                let n = self.u32()? as usize;
                let mut items = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    items.push(self.value()?);
                }
                WVal::List(items)
            }
            OBJECT => {
                let n = self.u32()? as usize;
                let mut fields = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    let key = self.string()?;
                    fields.push((key, self.value()?));
                }
                WVal::Obj(fields)
            }
            BIGINT => WVal::BigInt(self.take(8).map(|b| i64::from_le_bytes(b.try_into().unwrap()))?),
            _ => return None,
        })
    }
}

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, n: u8) {
        self.buf.push(n);
    }

    pub fn u32(&mut self, n: u32) {
        self.buf.extend_from_slice(&n.to_le_bytes());
    }

    pub fn f64(&mut self, n: f64) {
        self.buf.extend_from_slice(&n.to_le_bytes());
    }

    pub fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.buf.extend_from_slice(b);
    }

    pub fn string(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }

    pub fn json(&mut self, value: &Value) {
        match value {
            Value::Null => self.u8(NULL),
            Value::Bool(b) => self.u8(if *b { TRUE } else { FALSE }),
            Value::Number(n) => {
                self.u8(NUMBER);
                self.f64(n.as_f64().unwrap_or(f64::NAN));
            }
            Value::String(s) => {
                self.u8(STRING);
                self.string(s);
            }
            Value::Array(items) => {
                self.u8(LIST);
                self.u32(items.len() as u32);
                for item in items {
                    self.json(item);
                }
            }
            Value::Object(fields) => {
                self.u8(OBJECT);
                self.u32(fields.len() as u32);
                for (key, item) in fields {
                    self.string(key);
                    self.json(item);
                }
            }
        }
    }

    pub fn ret(&mut self, ret: &Ret) {
        match ret {
            Ret::Undefined => self.u8(UNDEFINED),
            Ret::Null => self.u8(NULL),
            Ret::Bool(b) => self.u8(if *b { TRUE } else { FALSE }),
            Ret::Num(n) => {
                self.u8(NUMBER);
                self.f64(*n);
            }
            Ret::Str(s) => {
                self.u8(STRING);
                self.string(s);
            }
            Ret::Bytes(b) => {
                self.u8(BYTES);
                self.bytes(b);
            }
            Ret::U32s(v) => {
                self.u8(U32S);
                self.u32((v.len() * 4) as u32);
                for n in v {
                    self.buf.extend_from_slice(&n.to_le_bytes());
                }
            }
            Ret::F64s(v) => {
                self.u8(F64S);
                self.u32((v.len() * 8) as u32);
                for n in v {
                    self.buf.extend_from_slice(&n.to_le_bytes());
                }
            }
            Ret::List(items) => {
                self.u8(LIST);
                self.u32(items.len() as u32);
                for item in items {
                    self.ret(item);
                }
            }
            Ret::Obj(fields) => {
                self.u8(OBJECT);
                self.u32(fields.len() as u32);
                for (key, item) in fields {
                    self.string(key);
                    self.ret(item);
                }
            }
            Ret::Json(value) => self.json(value),
        }
    }
}

pub struct WireArgs(pub Vec<WVal>);

impl WireArgs {
    fn get(&self, i: usize) -> &WVal {
        self.0.get(i).unwrap_or(&WVal::Undefined)
    }
}

impl Args for WireArgs {
    fn f64(&mut self, i: usize) -> f64 {
        self.get(i).as_f64()
    }

    fn bool(&mut self, i: usize) -> bool {
        self.get(i).truthy()
    }

    fn str(&mut self, i: usize) -> String {
        text(self.get(i))
    }

    fn with_bytes<R>(&mut self, i: usize, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
        match self.get(i) {
            WVal::Bytes(b) => Some(f(b)),
            WVal::U32s(v) => {
                let bytes: Vec<u8> = v.iter().flat_map(|n| n.to_ne_bytes()).collect();
                Some(f(&bytes))
            }
            WVal::F64s(v) => {
                let bytes: Vec<u8> = v.iter().flat_map(|n| n.to_ne_bytes()).collect();
                Some(f(&bytes))
            }
            _ => None,
        }
    }

    fn json(&mut self, i: usize) -> Value {
        self.get(i).to_json()
    }
}

pub fn text(v: &WVal) -> String {
    match v {
        WVal::Str(s) => s.clone(),
        WVal::Undefined => "undefined".to_owned(),
        WVal::Null => "null".to_owned(),
        WVal::Bool(b) => b.to_string(),
        WVal::Num(n) => number_string(*n),
        WVal::BigInt(n) => n.to_string(),
        other => other.to_json().to_string(),
    }
}

fn number_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_owned()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() }
    } else if n == n.trunc() && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Ret {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Bytes(Vec<u8>),
    U32s(Vec<u32>),
    F64s(Vec<f64>),
    List(Vec<Ret>),
    Obj(Vec<(&'static str, Ret)>),
    Json(Value),
}

impl Ret {
    pub fn js<'s>(self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
        match self {
            Ret::Undefined => v8::undefined(scope).into(),
            Ret::Null => v8::null(scope).into(),
            Ret::Bool(b) => v8::Boolean::new(scope, b).into(),
            Ret::Num(n) => v8::Number::new(scope, n).into(),
            Ret::Str(s) => bind::string(scope, &s).into(),
            Ret::Bytes(b) => bind::uint8_array(scope, b).into(),
            Ret::U32s(v) => bind::uint32_array(scope, &v).into(),
            Ret::F64s(v) => bind::float64_array(scope, &v).into(),
            Ret::List(items) => {
                let items: Vec<v8::Local<v8::Value>> = items.into_iter().map(|item| item.js(scope)).collect();
                v8::Array::new_with_elements(scope, &items).into()
            }
            Ret::Obj(fields) => {
                let obj = v8::Object::new(scope);
                for (key, item) in fields {
                    let value = item.js(scope);
                    bind::set(scope, obj, key, value);
                }
                obj.into()
            }
            Ret::Json(value) => {
                let text = bind::string(scope, &value.to_string());
                v8::json::parse(scope, text).unwrap_or_else(|| v8::null(scope).into())
            }
        }
    }
}

impl From<()> for Ret {
    fn from(_: ()) -> Self {
        Ret::Undefined
    }
}

impl From<bool> for Ret {
    fn from(b: bool) -> Self {
        Ret::Bool(b)
    }
}

macro_rules! numbers {
    ($($t:ty),*) => {$(
        impl From<$t> for Ret {
            fn from(n: $t) -> Self {
                Ret::Num(n as f64)
            }
        }
    )*};
}
numbers!(u8, u16, u32, i32, u64, i64, f32, f64, usize);

impl From<String> for Ret {
    fn from(s: String) -> Self {
        Ret::Str(s)
    }
}

impl From<&str> for Ret {
    fn from(s: &str) -> Self {
        Ret::Str(s.to_owned())
    }
}

impl From<Vec<String>> for Ret {
    fn from(v: Vec<String>) -> Self {
        Ret::List(v.into_iter().map(Ret::Str).collect())
    }
}

impl From<Vec<u8>> for Ret {
    fn from(v: Vec<u8>) -> Self {
        Ret::Bytes(v)
    }
}

impl From<Value> for Ret {
    fn from(v: Value) -> Self {
        Ret::Json(v)
    }
}

impl<T: Into<Ret>> From<Option<T>> for Ret {
    fn from(v: Option<T>) -> Self {
        v.map_or(Ret::Null, Into::into)
    }
}

#[derive(Debug, Clone)]
pub struct Fail {
    pub message: String,
    pub status: Option<i32>,
    pub code: String,
}

impl Fail {
    pub fn new(message: impl Into<String>) -> Self {
        Fail { message: message.into(), status: None, code: String::new() }
    }

    pub fn ret(&self) -> Ret {
        Ret::Obj(vec![
            ("message", Ret::Str(self.message.clone())),
            ("status", self.status.map_or(Ret::Null, |s| Ret::Num(f64::from(s)))),
            ("code", Ret::Str(self.code.clone())),
        ])
    }
}

pub type Later = Box<dyn FnOnce() -> Result<Ret, Fail> + Send>;

pub enum Answer {
    Now(Result<Ret, Fail>),
    Later(Later),
}

impl Answer {
    pub fn ok(ret: impl Into<Ret>) -> Self {
        Answer::Now(Ok(ret.into()))
    }

    pub fn fail(message: impl Into<String>) -> Self {
        Answer::Now(Err(Fail::new(message)))
    }
}
