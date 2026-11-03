use std::cell::RefCell;

use acde_runtime::{FsCall, FsError, FsReply, Workspace};

use crate::bind;
use crate::rt::{self, Msg};

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
    let Some((token, promise)) = bind::promise(scope) else { return };
    let request = method.call(&Args::read(scope, &args));
    let tx = rt::current().sender();
    let lp = rt::current();
    lp.keep_alive(true);
    let started = std::thread::Builder::new().name("acde-fs".into()).spawn(move || {
        let reply = workspace.call(request);
        _ = tx.send(Msg::Task(Box::new(move |scope| settle(scope, token, reply))));
    });
    if let Err(e) = started {
        lp.keep_alive(false);
        bind::forget_promise(token);
        return bind::throw_error(scope, &format!("acde.fs: {e}"));
    }
    rv.set(promise.into());
}

fn settle(scope: &mut v8::PinScope, token: u32, reply: Result<FsReply, FsError>) {
    rt::current().keep_alive(false);
    let Some(resolver) = bind::resolver(scope, token) else { return };
    match reply {
        Ok(FsReply::Json(value)) => {
            let text = bind::string(scope, &value.to_string());
            let value = v8::json::parse(scope, text).unwrap_or_else(|| v8::null(scope).into());
            resolver.resolve(scope, value);
        }
        Ok(FsReply::File { name, data }) => {
            let name = bind::string(scope, &name).into();
            let kind = bind::string(scope, FsReply::OCTETS).into();
            let data = bind::uint8_array(scope, data).into();
            let file = bind::object(scope, &[("name", name), ("contentType", kind), ("data", data)]);
            resolver.resolve(scope, file.into());
        }
        Err(error) => {
            let (message, status, code) = match error {
                FsError::Refused(what) => (format!("this app may not use {what} (not in its manifest's capabilities)"), 403, "forbidden"),
                FsError::Failed(json) => (json, 500, "GenericFailure"),
            };
            let text = bind::string(scope, &message);
            let thrown = v8::Exception::error(scope, text);
            if let Ok(object) = v8::Local::<v8::Object>::try_from(thrown) {
                if status == 403 {
                    let status = v8::Integer::new(scope, status).into();
                    bind::set(scope, object, "status", status);
                }
                let code = bind::string(scope, code).into();
                bind::set(scope, object, "code", code);
            }
            resolver.reject(scope, thrown);
        }
    }
}
