use std::cell::RefCell;

use acde_runtime::{OfficeCall, OfficeService};

use crate::{bind, offload};

thread_local! {
    static OFFICE: RefCell<Option<OfficeService>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, office: OfficeService) {
    OFFICE.with(|o| *o.borrow_mut() = Some(office));
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "server" => server,
        "state" => state,
        "status" => status,
        "save" => save,
        "new" => create,
        "writePage" => write_page,
    );
    bind::set(scope, natives, "office", object.into());
}

pub fn clear() {
    OFFICE.with(|o| o.borrow_mut().take());
}

fn send(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, call: OfficeCall) {
    let Some(office) = OFFICE.with(|o| o.borrow().clone()) else {
        return bind::throw_error(scope, "acde.office: not given to this isolate");
    };
    offload::run(scope, rv, "acde-office", move || office.call(call), settle);
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, reply: Result<serde_json::Value, String>) {
    match reply {
        Ok(value) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Err(message) => {
            let thrown = offload::failure(scope, &message, None, "GenericFailure");
            resolver.reject(scope, thrown);
        }
    }
}

fn text(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> Option<String> {
    (!args.get(i).is_null_or_undefined()).then(|| bind::arg_string(scope, args, i))
}

fn body(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<serde_json::Value> {
    let value = args.get(0);
    if value.is_null_or_undefined() {
        return None;
    }
    let json = v8::json::stringify(scope, value)?.to_rust_string_lossy(scope);
    serde_json::from_str(&json).ok()
}

fn server(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    send(scope, &mut rv, OfficeCall::Server);
}

fn state(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (root, dir, path) = (text(scope, &args, 0), text(scope, &args, 1), text(scope, &args, 2));
    send(scope, &mut rv, OfficeCall::State { root, dir, path });
}

fn status(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let key = bind::arg_string(scope, &args, 0);
    send(scope, &mut rv, OfficeCall::Status { key });
}

fn save(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let body = body(scope, &args);
    send(scope, &mut rv, OfficeCall::Save { body });
}

fn create(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let body = body(scope, &args);
    send(scope, &mut rv, OfficeCall::New { body });
}

/// Where editor pages go: the browser snap reads only its own directory, so there when it is installed.
fn page_dir() -> std::path::PathBuf {
    let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let snap = home.join("snap/firefox/common");
    if snap.is_dir() {
        return snap.join("acde-office");
    }
    let base = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".cache"));
    base.join("acde/office")
}

/// `writePage(key, html)`: the Document Server editor page for one document, as a `file:` URL; pages older than an hour go.
fn write_page(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (key, html) = (bind::arg_string(scope, &args, 0), bind::arg_string(scope, &args, 1));
    match page_file(&key, &html) {
        Ok(url) => rv.set(bind::string(scope, &url).into()),
        Err(e) => bind::throw_error(scope, &e),
    }
}

fn page_file(key: &str, html: &str) -> Result<String, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    const STALE: std::time::Duration = std::time::Duration::from_secs(3600);
    let key: String = key.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let dir = page_dir();
    let written = (|| {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
        for entry in std::fs::read_dir(&dir)?.flatten() {
            let old = entry.path();
            let stale = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE);
            if stale && old.extension().is_some_and(|e| e == "html") {
                _ = std::fs::remove_file(old);
            }
        }
        let file = dir.join(format!("{}.html", if key.is_empty() { "document" } else { &key }));
        std::io::Write::write_all(&mut std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file)?, html.as_bytes())?;
        Ok::<_, std::io::Error>(file)
    })();
    match written.map(url::Url::from_file_path) {
        Ok(Ok(url)) => Ok(url.as_str().to_owned()),
        Ok(Err(())) => Err("office.writePage: not an absolute path".to_owned()),
        Err(e) => Err(format!("office.writePage: {}: {e}", dir.display())),
    }
}

pub fn wire(office: &OfficeService, name: &str, a: &mut crate::wire::WireArgs) -> crate::wire::Answer {
    use crate::wire::{Answer, Args, Fail, Ret, WVal};
    let given = |a: &crate::wire::WireArgs, i: usize| !matches!(a.0.get(i), None | Some(WVal::Undefined | WVal::Null));
    let text = |a: &mut crate::wire::WireArgs, i: usize| given(a, i).then(|| a.str(i));
    let body = |a: &mut crate::wire::WireArgs| given(a, 0).then(|| a.json(0));
    let call = match name {
        "server" => OfficeCall::Server,
        "state" => OfficeCall::State { root: text(a, 0), dir: text(a, 1), path: text(a, 2) },
        "status" => OfficeCall::Status { key: a.str(0) },
        "save" => OfficeCall::Save { body: body(a) },
        "new" => OfficeCall::New { body: body(a) },
        "writePage" => return Answer::Now(page_file(&a.str(0), &a.str(1)).map(Ret::Str).map_err(Fail::new)),
        _ => return Answer::fail(format!("acde.office: no method {name}")),
    };
    let office = office.clone();
    Answer::Later(Box::new(move || office.call(call).map(Ret::Json).map_err(|message| Fail { message, status: None, code: "GenericFailure".to_owned() })))
}
