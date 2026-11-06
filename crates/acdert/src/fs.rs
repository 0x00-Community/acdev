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
    Stat,
    ReadText,
    ReadBytes,
    WriteFile,
}

impl Method {
    const TABLE: [Method; 18] = [
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
        Method::Stat,
        Method::ReadText,
        Method::ReadBytes,
        Method::WriteFile,
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
            Method::Stat => "stat",
            Method::ReadText => "readText",
            Method::ReadBytes => "readBytes",
            Method::WriteFile => "writeFile",
        }
    }

    fn call(self, args: &mut Args) -> FsCall {
        match self {
            Method::State => FsCall::State,
            Method::Roots => FsCall::Roots,
            Method::Desktop => FsCall::Desktop,
            Method::List => FsCall::List { root: args.string(0), path: args.text(1), hidden: args.flag(2) },
            Method::Preview => FsCall::Preview { root: args.string(0), path: args.string(1) },
            Method::Download => FsCall::Download { root: args.string(0), path: args.string(1) },
            Method::Locate => FsCall::Locate { path: args.string(0) },
            Method::OpenPath => FsCall::OpenPath { root: args.string(0), path: args.string(1) },
            Method::Place => FsCall::Place { root: args.string(0), path: args.text(1), file: args.text(2) },
            Method::Mkdir => FsCall::Mkdir { root: args.string(0), path: args.string(1), options: args.json(2) },
            Method::Write => FsCall::Write { root: args.string(0), path: args.string(1), content: args.text(2), expected_modified_ms: args.string(3) },
            Method::CopyIn => FsCall::CopyIn { root: args.string(0), dir: args.string(1), source: args.string(2) },
            Method::Rename => FsCall::Rename { root: args.string(0), from: args.string(1), to: args.string(2) },
            Method::Delete => FsCall::Delete { root: args.string(0), path: args.string(1) },
            Method::Stat => FsCall::Stat { root: args.string(0), path: args.string(1) },
            Method::ReadText => FsCall::ReadText { root: args.string(0), path: args.string(1) },
            Method::ReadBytes => FsCall::ReadBytes { root: args.string(0), path: args.string(1) },
            Method::WriteFile => FsCall::WriteFile { root: args.string(0), path: args.string(1), data: args.data(2), options: args.json(3) },
        }
    }
}

struct Args<'a, 's, 'i, 'v> {
    scope: &'a mut v8::PinScope<'s, 'i>,
    args: &'a v8::FunctionCallbackArguments<'v>,
}

impl<'v> Args<'_, '_, '_, 'v> {
    fn given(&self, i: usize) -> Option<v8::Local<'v, v8::Value>> {
        let value = self.args.get(i32::try_from(i).ok()?);
        (!value.is_null_or_undefined()).then_some(value)
    }

    fn text(&mut self, i: usize) -> Option<String> {
        let value = self.given(i)?;
        Some(value.to_rust_string_lossy(self.scope))
    }

    fn string(&mut self, i: usize) -> String {
        self.text(i).unwrap_or_default()
    }

    fn flag(&mut self, i: usize) -> Option<bool> {
        let value = self.given(i)?;
        Some(value.boolean_value(self.scope))
    }

    fn data(&mut self, i: usize) -> Option<Vec<u8>> {
        let value = self.given(i)?;
        match value.is_string() {
            true => Some(value.to_rust_string_lossy(self.scope).into_bytes()),
            false => bind::with_bytes(value, <[u8]>::to_vec),
        }
    }

    fn json(&mut self, i: usize) -> Option<serde_json::Value> {
        let value = self.given(i)?;
        let text = v8::json::stringify(self.scope, value)?.to_rust_string_lossy(self.scope);
        Some(serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)))
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
    let request = method.call(&mut Args { scope, args: &args });
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
        Ok(FsReply::Text { text, modified_ms, size }) => {
            let text = bind::string(scope, &text).into();
            let modified = v8::Number::new(scope, modified_ms as f64).into();
            let size = v8::Number::new(scope, size as f64).into();
            let read = bind::object(scope, &[("text", text), ("modifiedMs", modified), ("size", size)]);
            resolver.resolve(scope, read.into());
        }
        Ok(FsReply::Bytes { data, modified_ms }) => {
            let size = v8::Number::new(scope, data.len() as f64).into();
            let data = bind::uint8_array(scope, data).into();
            let modified = v8::Number::new(scope, modified_ms as f64).into();
            let read = bind::object(scope, &[("data", data), ("modifiedMs", modified), ("size", size)]);
            resolver.resolve(scope, read.into());
        }
        Err(FsError { status, code, message }) => {
            let thrown = offload::failure(scope, &message, Some(i32::from(status)), code);
            resolver.reject(scope, thrown);
        }
    }
}
