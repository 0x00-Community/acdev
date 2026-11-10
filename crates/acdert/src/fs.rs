use std::cell::RefCell;

use acde_runtime::{FsCall, FsError, FsReply, Workspace};

use crate::bind::{self, Args};
use crate::offload;

type Method = fn(&mut Args) -> FsCall;

const METHODS: [(&str, Method); 15] = [
    ("roots", |_| FsCall::Roots),
    ("list", |a| FsCall::List { root: a.string(0), path: a.text(1), hidden: a.flag(2) }),
    ("preview", |a| FsCall::Preview { root: a.string(0), path: a.string(1) }),
    ("download", |a| FsCall::Download { root: a.string(0), path: a.string(1) }),
    ("locate", |a| FsCall::Locate { path: a.string(0) }),
    ("openPath", |a| FsCall::OpenPath { root: a.string(0), path: a.string(1) }),
    ("mkdir", |a| FsCall::Mkdir { root: a.string(0), path: a.string(1), options: a.json(2) }),
    ("copy", |a| FsCall::Copy { from_root: a.string(0), from_path: a.string(1), to_root: a.string(2), to_dir: a.string(3) }),
    ("rename", |a| FsCall::Rename { root: a.string(0), from: a.string(1), to: a.string(2) }),
    ("delete", |a| FsCall::Delete { root: a.string(0), path: a.string(1) }),
    ("stat", |a| FsCall::Stat { root: a.string(0), path: a.string(1) }),
    ("readText", |a| FsCall::ReadText { root: a.string(0), path: a.string(1) }),
    ("readBytes", |a| FsCall::ReadBytes { root: a.string(0), path: a.string(1) }),
    ("writeFile", |a| FsCall::WriteFile { root: a.string(0), path: a.string(1), data: a.data(2), options: a.json(3) }),
    ("revoke", |a| FsCall::Revoke { root: a.string(0) }),
];

thread_local! {
    static WORKSPACE: RefCell<Option<Workspace>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, workspace: Workspace) {
    WORKSPACE.with(|w| *w.borrow_mut() = Some(workspace));
    let fs = v8::Object::new(scope);
    for (index, (name, _)) in METHODS.iter().enumerate() {
        let data = v8::Integer::new_from_unsigned(scope, index as u32).into();
        bind::method_with(scope, fs, name, call, Some(data));
    }
    bind::set(scope, natives, "fs", fs.into());
}

fn call(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some((_, method)) = args.data().uint32_value(scope).and_then(|i| METHODS.get(i as usize)) else { return };
    let Some(workspace) = WORKSPACE.with(|w| w.borrow().clone()) else {
        return bind::throw_error(scope, "acde.fs: not given to this web");
    };
    let request = method(&mut Args { scope: &mut *scope, args: &args });
    offload::run(scope, &mut rv, "acde-fs", move || workspace.call(request), settle);
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, reply: Result<FsReply, FsError>) {
    match reply {
        Ok(FsReply::Json(value)) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Ok(FsReply::File { name, data }) => {
            let file = crate::js_object!(scope, {"name" => name, "contentType" => FsReply::OCTETS, "data" => data});
            resolver.resolve(scope, file.into());
        }
        Ok(FsReply::Text { text, modified_ms, size }) => {
            let read = crate::js_object!(scope, {"text" => text, "modifiedMs" => modified_ms, "size" => size});
            resolver.resolve(scope, read.into());
        }
        Ok(FsReply::Done) => {
            let done = v8::undefined(scope).into();
            resolver.resolve(scope, done);
        }
        Ok(FsReply::Bytes { data, modified_ms }) => {
            let size = data.len();
            let read = crate::js_object!(scope, {"data" => data, "modifiedMs" => modified_ms, "size" => size});
            resolver.resolve(scope, read.into());
        }
        Err(FsError { status, code, message }) => {
            let thrown = offload::failure(scope, &message, Some(i32::from(status)), code);
            resolver.reject(scope, thrown);
        }
    }
}
