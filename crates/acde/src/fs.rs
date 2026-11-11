use std::cell::RefCell;

use acde_runtime::{FsCall, FsError, FsReply, Workspace};
use serde_json::Value;

use crate::wire::{Args, V8Args};
use crate::{bind, offload};

#[derive(Clone, Copy)]
enum Method {
    Roots,
    List,
    Preview,
    Download,
    Locate,
    OpenPath,
    Mkdir,
    Copy,
    Rename,
    Delete,
    Stat,
    ReadText,
    ReadBytes,
    WriteFile,
    Revoke,
    ReadRange,
    OpenWrite,
    WriteChunk,
    TruncateWrite,
    CommitWrite,
    AbortWrite,
}

impl Method {
    const TABLE: [Method; 21] = [
        Method::Roots,
        Method::List,
        Method::Preview,
        Method::Download,
        Method::Locate,
        Method::OpenPath,
        Method::Mkdir,
        Method::Copy,
        Method::Rename,
        Method::Delete,
        Method::Stat,
        Method::ReadText,
        Method::ReadBytes,
        Method::WriteFile,
        Method::Revoke,
        Method::ReadRange,
        Method::OpenWrite,
        Method::WriteChunk,
        Method::TruncateWrite,
        Method::CommitWrite,
        Method::AbortWrite,
    ];

    fn name(self) -> &'static str {
        match self {
            Method::Roots => "roots",
            Method::List => "list",
            Method::Preview => "preview",
            Method::Download => "download",
            Method::Locate => "locate",
            Method::OpenPath => "openPath",
            Method::Mkdir => "mkdir",
            Method::Copy => "copy",
            Method::Rename => "rename",
            Method::Delete => "delete",
            Method::Stat => "stat",
            Method::ReadText => "readText",
            Method::ReadBytes => "readBytes",
            Method::WriteFile => "writeFile",
            Method::Revoke => "revoke",
            Method::ReadRange => "readRange",
            Method::OpenWrite => "openWrite",
            Method::WriteChunk => "writeChunk",
            Method::TruncateWrite => "truncateWrite",
            Method::CommitWrite => "commitWrite",
            Method::AbortWrite => "abortWrite",
        }
    }

    fn call(self, a: &mut impl Args) -> FsCall {
        let mut s = |i: usize| Given::text(a, i).unwrap_or_default();
        let (s0, s1, s2, s3) = (s(0), s(1), s(2), s(3));
        match self {
            Method::Roots => FsCall::Roots,
            Method::List => FsCall::List { root: s0, path: Given::text(a, 1), hidden: Given::flag(a, 2) },
            Method::Preview => FsCall::Preview { root: s0, path: s1 },
            Method::Download => FsCall::Download { root: s0, path: s1 },
            Method::Locate => FsCall::Locate { path: s0 },
            Method::OpenPath => FsCall::OpenPath { root: s0, path: s1 },
            Method::Mkdir => FsCall::Mkdir { root: s0, path: s1, options: Given::json(a, 2) },
            Method::Copy => FsCall::Copy { from_root: s0, from_path: s1, to_root: s2, to_dir: s3 },
            Method::Rename => FsCall::Rename { root: s0, from: s1, to: s2 },
            Method::Delete => FsCall::Delete { root: s0, path: s1 },
            Method::Stat => FsCall::Stat { root: s0, path: s1 },
            Method::ReadText => FsCall::ReadText { root: s0, path: s1 },
            Method::ReadBytes => FsCall::ReadBytes { root: s0, path: s1 },
            Method::WriteFile => FsCall::WriteFile { root: s0, path: s1, data: Given::data(a, 2), options: Given::json(a, 3) },
            Method::Revoke => FsCall::Revoke { root: s0 },
            Method::ReadRange => {
                FsCall::ReadRange { root: s0, path: s1, offset: Given::count(a, 2), length: Given::count(a, 3), options: Given::json(a, 4) }
            }
            Method::OpenWrite => FsCall::OpenWrite { root: s0, path: s1, options: Given::json(a, 2) },
            Method::WriteChunk => FsCall::WriteChunk { id: s0, offset: Given::count(a, 1), data: Given::data(a, 2) },
            Method::TruncateWrite => FsCall::TruncateWrite { id: s0, size: Given::count(a, 1) },
            Method::CommitWrite => FsCall::CommitWrite { id: s0 },
            Method::AbortWrite => FsCall::AbortWrite { id: s0 },
        }
    }
}

/// Optional arguments: `undefined` / `null` is "not given".
struct Given;

impl Given {
    fn value(a: &mut impl Args, i: usize) -> Option<Value> {
        Some(a.json(i)).filter(|v| !v.is_null())
    }

    fn text(a: &mut impl Args, i: usize) -> Option<String> {
        match Self::value(a, i)? {
            Value::String(text) => Some(text),
            _ => Some(a.str(i)),
        }
    }

    fn flag(a: &mut impl Args, i: usize) -> Option<bool> {
        Self::value(a, i).map(|_| a.bool(i))
    }

    fn json(a: &mut impl Args, i: usize) -> Option<Value> {
        Self::value(a, i)
    }

    fn count(a: &mut impl Args, i: usize) -> Option<u64> {
        Self::value(a, i)?.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64)
    }

    fn data(a: &mut impl Args, i: usize) -> Option<Vec<u8>> {
        a.with_bytes(i, <[u8]>::to_vec).or_else(|| match Self::value(a, i)? {
            Value::String(text) => Some(text.into_bytes()),
            _ => None,
        })
    }
}

thread_local! {
    static WORKSPACE: RefCell<Option<Workspace>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, workspace: Workspace) {
    WORKSPACE.with(|w| *w.borrow_mut() = Some(workspace));
    let fs = v8::Object::new(scope);
    for (index, method) in Method::TABLE.iter().enumerate() {
        let data = v8::Integer::new_from_unsigned(scope, index as u32).into();
        bind::method_with(scope, fs, method.name(), call, Some(data));
    }
    bind::set(scope, natives, "fs", fs.into());
}

pub fn clear() {
    WORKSPACE.with(|w| w.borrow_mut().take());
}

fn call<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue) {
    let Some(method) = args.data().uint32_value(scope).and_then(|i| Method::TABLE.get(i as usize).copied()) else { return };
    let Some(workspace) = WORKSPACE.with(|w| w.borrow().clone()) else {
        return bind::throw_error(scope, "acde.fs: not given to this web");
    };
    let request = method.call(&mut V8Args { scope: &mut *scope, args: &args });
    offload::run(scope, &mut rv, "acde-fs", move || workspace.call(request), settle);
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, reply: Result<FsReply, FsError>) {
    match reply {
        Ok(FsReply::Json(value)) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Ok(FsReply::Done) => {
            let done = v8::undefined(scope).into();
            resolver.resolve(scope, done);
        }
        Ok(reply) => {
            let value = Reply::of(reply).js(scope);
            resolver.resolve(scope, value);
        }
        Err(FsError { status, code, message }) => {
            let thrown = offload::failure(scope, &message, Some(i32::from(status)), code);
            resolver.reject(scope, thrown);
        }
    }
}

/// The non-JSON replies as plain values, for V8 and for the wire.
struct Reply;

impl Reply {
    fn of(reply: FsReply) -> crate::wire::Ret {
        use crate::wire::Ret as R;
        let ms = |ms: i64| R::Num(ms as f64);
        match reply {
            FsReply::Json(value) => R::Json(value),
            FsReply::Done => R::Undefined,
            FsReply::File { name, data } => R::Obj(vec![("name", R::Str(name)), ("data", R::Bytes(data))]),
            FsReply::Text { text, modified_ms, size, version } => {
                R::Obj(vec![("text", R::Str(text)), ("modifiedMs", ms(modified_ms)), ("size", R::Num(size as f64)), ("version", R::Str(version))])
            }
            FsReply::Bytes { data, modified_ms, version } => {
                let size = R::Num(data.len() as f64);
                R::Obj(vec![("data", R::Bytes(data)), ("modifiedMs", ms(modified_ms)), ("size", size), ("version", R::Str(version))])
            }
            FsReply::Range(range) => R::Obj(vec![
                ("data", R::Bytes(range.data)),
                ("offset", R::Num(range.offset as f64)),
                ("size", R::Num(range.size as f64)),
                ("modifiedMs", ms(range.modified_ms)),
                ("version", R::Str(range.version)),
            ]),
        }
    }
}

pub fn wire(workspace: &Workspace, name: &str, a: &crate::wire::WireArgs) -> crate::wire::Answer {
    use crate::wire::Answer;
    let Some(method) = Method::TABLE.iter().copied().find(|m| m.name() == name) else {
        return Answer::fail(format!("acde.fs: no method {name}"));
    };
    let request = method.call(&mut crate::wire::WireArgs(a.0.clone()));
    let workspace = workspace.clone();
    Answer::Later(Box::new(move || wire_reply(workspace.call(request))))
}

fn wire_reply(reply: Result<FsReply, FsError>) -> Result<crate::wire::Ret, crate::wire::Fail> {
    reply.map(Reply::of).map_err(|FsError { status, code, message }| crate::wire::Fail { message, status: Some(i32::from(status)), code: code.to_owned() })
}
