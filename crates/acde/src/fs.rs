use std::cell::RefCell;

use acde_runtime::{FsCall, FsError, FsReply, Workspace};

use crate::{bind, offload};

#[derive(Clone, Copy)]
enum Method {
    State,
    Roots,
    Desktop,
    List,
    Preview,
    Download,
    Locate,
    OpenPath,
    Place,
    Mkdir,
    Write,
    CopyIn,
    Rename,
    Delete,
}

impl Method {
    const TABLE: [Method; 14] = [
        Method::State,
        Method::Roots,
        Method::Desktop,
        Method::List,
        Method::Preview,
        Method::Download,
        Method::Locate,
        Method::OpenPath,
        Method::Place,
        Method::Mkdir,
        Method::Write,
        Method::CopyIn,
        Method::Rename,
        Method::Delete,
    ];

    fn name(self) -> &'static str {
        match self {
            Method::State => "state",
            Method::Roots => "roots",
            Method::Desktop => "desktop",
            Method::List => "list",
            Method::Preview => "preview",
            Method::Download => "download",
            Method::Locate => "locate",
            Method::OpenPath => "openPath",
            Method::Place => "place",
            Method::Mkdir => "mkdir",
            Method::Write => "write",
            Method::CopyIn => "copyIn",
            Method::Rename => "rename",
            Method::Delete => "delete",
        }
    }

    fn call(self, args: &Args) -> FsCall {
        let s = |i: usize| args.text(i).unwrap_or_default();
        match self {
            Method::State => FsCall::State,
            Method::Roots => FsCall::Roots,
            Method::Desktop => FsCall::Desktop,
            Method::List => FsCall::List { root: s(0), path: args.text(1), hidden: args.flag(2) },
            Method::Preview => FsCall::Preview { root: s(0), path: s(1) },
            Method::Download => FsCall::Download { root: s(0), path: s(1) },
            Method::Locate => FsCall::Locate { path: s(0) },
            Method::OpenPath => FsCall::OpenPath { root: s(0), path: s(1) },
            Method::Place => FsCall::Place { root: s(0), path: args.text(1), file: args.text(2) },
            Method::Mkdir => FsCall::Mkdir { root: s(0), path: s(1) },
            Method::Write => FsCall::Write { root: s(0), path: s(1), content: args.text(2), expected_modified_ms: s(3) },
            Method::CopyIn => FsCall::CopyIn { root: s(0), dir: s(1), source: s(2) },
            Method::Rename => FsCall::Rename { root: s(0), from: s(1), to: s(2) },
            Method::Delete => FsCall::Delete { root: s(0), path: s(1) },
        }
    }
}

struct Args(Vec<Option<String>>, Vec<Option<bool>>);

impl Args {
    fn read(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Self {
        let (mut texts, mut flags) = (Vec::new(), Vec::new());
        for i in 0..args.length() {
            let value = args.get(i);
            let given = !value.is_null_or_undefined();
            texts.push(given.then(|| value.to_rust_string_lossy(scope)));
            flags.push(given.then(|| value.boolean_value(scope)));
        }
        Self(texts, flags)
    }

    fn text(&self, i: usize) -> Option<String> {
        self.0.get(i).cloned().flatten()
    }

    fn flag(&self, i: usize) -> Option<bool> {
        self.1.get(i).copied().flatten()
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

fn call(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(method) = args.data().uint32_value(scope).and_then(|i| Method::TABLE.get(i as usize).copied()) else { return };
    let Some(workspace) = WORKSPACE.with(|w| w.borrow().clone()) else {
        return bind::throw_error(scope, "acde.fs: not given to this web");
    };
    let request = method.call(&Args::read(scope, &args));
    offload::run(scope, &mut rv, "acde-fs", move || workspace.call(request), settle);
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, reply: Result<FsReply, FsError>) {
    match reply {
        Ok(FsReply::Json(value)) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Ok(FsReply::File { name, data }) => {
            let name = bind::string(scope, &name).into();
            let kind = bind::string(scope, FsReply::OCTETS).into();
            let data = bind::uint8_array(scope, data).into();
            let file = bind::object(scope, &[("name", name), ("contentType", kind), ("data", data)]);
            resolver.resolve(scope, file.into());
        }
        Err(FsError::Refused(what)) => {
            let thrown = offload::failure(scope, &format!("this app may not use {what} (not in its manifest's capabilities)"), Some(403), "forbidden");
            resolver.reject(scope, thrown);
        }
        Err(FsError::Failed(json)) => {
            let thrown = offload::failure(scope, &json, None, "GenericFailure");
            resolver.reject(scope, thrown);
        }
    }
}

pub fn wire(workspace: &Workspace, name: &str, a: &crate::wire::WireArgs) -> crate::wire::Answer {
    use crate::wire::{Answer, WVal};
    let Some(method) = Method::TABLE.iter().copied().find(|m| m.name() == name) else {
        return Answer::fail(format!("acde.fs: no method {name}"));
    };
    let given = |v: &WVal| !matches!(v, WVal::Undefined | WVal::Null);
    let texts = a.0.iter().map(|v| given(v).then(|| crate::wire::text(v))).collect();
    let flags = a.0.iter().map(|v| given(v).then(|| v.truthy())).collect();
    let request = method.call(&Args(texts, flags));
    let workspace = workspace.clone();
    Answer::Later(Box::new(move || wire_reply(workspace.call(request))))
}

fn wire_reply(reply: Result<FsReply, FsError>) -> Result<crate::wire::Ret, crate::wire::Fail> {
    use crate::wire::{Fail, Ret};
    match reply {
        Ok(FsReply::Json(value)) => Ok(Ret::Json(value)),
        Ok(FsReply::File { name, data }) => Ok(Ret::Obj(vec![("name", Ret::Str(name)), ("contentType", Ret::Str(FsReply::OCTETS.to_owned())), ("data", Ret::Bytes(data))])),
        Err(FsError::Refused(what)) => Err(Fail { message: format!("this app may not use {what} (not in its manifest's capabilities)"), status: Some(403), code: "forbidden".to_owned() }),
        Err(FsError::Failed(json)) => Err(Fail { message: json, status: None, code: "GenericFailure".to_owned() }),
    }
}
