//! What a desktop or window isolate gets of its own instead of the Broker's `sys`: ending itself, its page storage
//! file, and the files the user handed it (picked in the portal's chooser or dropped on it). Every path is fixed or
//! granted in Rust; the page names nothing else on disk.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::{bind, offload};

#[derive(Default)]
struct Own {
    storage: Option<PathBuf>,
    granted: HashSet<PathBuf>,
}

thread_local! {
    static OWN: RefCell<Own> = RefCell::new(Own::default());
}

/// Which chooser the portal shows.
#[derive(Clone, Copy)]
enum Pick {
    Open,
    Save,
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, storage: Option<PathBuf>) {
    let has_storage = storage.is_some();
    OWN.with(|o| *o.borrow_mut() = Own { storage, granted: HashSet::new() });
    let own = v8::Object::new(scope);
    crate::methods!(scope, own, "exit" => exit);
    if has_storage {
        let storage = v8::Object::new(scope);
        crate::methods!(scope, storage,
            "read" => storage_read,
            "write" => storage_write,
            "aside" => storage_aside,
        );
        bind::set(scope, own, "storage", storage.into());
    }
    let files = v8::Object::new(scope);
    let open = v8::Integer::new(scope, Pick::Open as i32).into();
    let save = v8::Integer::new(scope, Pick::Save as i32).into();
    bind::method_with(scope, files, "open", pick, Some(open));
    bind::method_with(scope, files, "save", pick, Some(save));
    crate::methods!(scope, files,
        "read" => read,
        "write" => write,
    );
    bind::set(scope, own, "files", files.into());
    bind::set(scope, natives, "own", own.into());
}

pub fn clear() {
    OWN.with(|o| *o.borrow_mut() = Own::default());
}

/// A drop on this isolate's surface hands it the dropped local files.
pub fn grant_dropped(data: &std::collections::HashMap<String, String>) {
    let Some(uris) = data.get("text/uri-list") else { return };
    let paths = uris.lines().filter_map(|line| url::Url::parse(line.trim()).ok()?.to_file_path().ok());
    OWN.with(|o| o.borrow_mut().granted.extend(paths));
}

fn exit(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let code = args.get(0).int32_value(scope).unwrap_or(0);
    crate::rt::current().exit(code);
    scope.terminate_execution();
}

fn storage_path(scope: &mut v8::PinScope) -> Option<PathBuf> {
    let path = OWN.with(|o| o.borrow().storage.clone());
    if path.is_none() {
        bind::throw_error(scope, "storage: this isolate has no storage file");
    }
    path
}

fn storage_read(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(path) = storage_path(scope) else { return };
    match std::fs::read_to_string(&path) {
        Ok(text) => rv.set(bind::string(scope, &text).into()),
        Err(_) => rv.set_null(),
    }
}

fn storage_write(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(path) = storage_path(scope) else { return };
    let text = bind::arg_string(scope, &args, 0);
    if let Err(e) = write_private(&path, text.as_bytes()) {
        bind::throw_error(scope, &format!("{}: {e}", path.display()));
    }
}

fn storage_aside(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(path) = storage_path(scope) else { return };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let mut aside = path.clone().into_os_string();
    aside.push(format!(".bad-{stamp}"));
    let aside = PathBuf::from(aside);
    _ = std::fs::rename(&path, &aside);
    rv.set(bind::string(scope, &aside.to_string_lossy()).into());
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut temp = path.to_path_buf().into_os_string();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
    file.write_all(bytes)?;
    std::fs::rename(&temp, path)
}

fn pick(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let which = if args.data().int32_value(scope) == Some(Pick::Save as i32) { Pick::Save } else { Pick::Open };
    let options = v8::json::stringify(scope, args.get(0)).map(|s| s.to_rust_string_lossy(scope)).unwrap_or_default();
    let options: serde_json::Value = serde_json::from_str(&options).unwrap_or(serde_json::Value::Null);
    offload::run(scope, &mut rv, "acde-pick", move || picked(which, options), settle_pick);
}

fn picked(which: Pick, options: serde_json::Value) -> Result<Vec<String>, String> {
    let chooser = acde_runtime::FileChooser::connect()?;
    let paths = match which {
        Pick::Open => chooser.pick_open(options)?,
        Pick::Save => chooser.pick_save(options)?.map(|path| vec![path]),
    };
    Ok(paths.unwrap_or_default())
}

fn settle_pick(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, value: Result<Vec<String>, String>) {
    match value {
        Ok(paths) => {
            OWN.with(|o| o.borrow_mut().granted.extend(paths.iter().map(PathBuf::from)));
            let list: Vec<v8::Local<v8::Value>> = paths.iter().map(|p| bind::string(scope, p).into()).collect();
            let list = v8::Array::new_with_elements(scope, &list);
            resolver.resolve(scope, list.into());
        }
        Err(message) => {
            let error = offload::failure(scope, &message, None, "portal_unavailable");
            resolver.reject(scope, error);
        }
    }
}

fn granted(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<PathBuf> {
    let path = PathBuf::from(bind::arg_string(scope, args, 0));
    if OWN.with(|o| o.borrow().granted.contains(&path)) {
        return Some(path);
    }
    let error = offload::failure(scope, "not a file the user picked or dropped", Some(403), "forbidden");
    scope.throw_exception(error);
    None
}

fn read(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(path) = granted(scope, &args) else { return };
    let limit = args.get(1).number_value(scope).filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64);
    let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file() && limit.is_none_or(|limit| m.len() <= limit));
    let Some((meta, bytes)) = meta.and_then(|meta| Some((meta, std::fs::read(&path).ok()?))) else {
        return rv.set_null();
    };
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let bytes = bind::uint8_array(scope, bytes).into();
    let modified = v8::Number::new(scope, modified).into();
    rv.set(bind::object(scope, &[("bytes", bytes), ("lastModified", modified)]).into());
}

fn write(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(path) = granted(scope, &args) else { return };
    let written = bind::with_bytes(args.get(1), |bytes| std::fs::write(&path, bytes));
    match written {
        Some(Ok(())) => {}
        Some(Err(e)) => bind::throw_error(scope, &format!("{}: {e}", path.display())),
        None => bind::throw_type_error(scope, "files.write: the data is bytes"),
    }
}

pub fn set(storage: Option<PathBuf>) {
    OWN.with(|o| *o.borrow_mut() = Own { storage, granted: HashSet::new() });
}

pub fn has_storage() -> bool {
    OWN.with(|o| o.borrow().storage.is_some())
}

pub fn wire_call(name: &str, a: &mut crate::wire::WireArgs) -> crate::wire::Answer {
    use crate::wire::{Answer, Args, Fail, Ret};
    let storage = || OWN.with(|o| o.borrow().storage.clone()).ok_or_else(|| Fail::new("storage: this isolate has no storage file"));
    let granted = |path: String| {
        let path = PathBuf::from(path);
        if OWN.with(|o| o.borrow().granted.contains(&path)) {
            Ok(path)
        } else {
            Err(Fail { message: "not a file the user picked or dropped".to_owned(), status: Some(403), code: "forbidden".to_owned() })
        }
    };
    match name {
        "storageRead" => Answer::Now(storage().map(|path| std::fs::read_to_string(&path).map_or(Ret::Null, Ret::Str))),
        "storageWrite" => {
            let text = a.str(0);
            Answer::Now(storage().and_then(|path| write_private(&path, text.as_bytes()).map(|()| Ret::Undefined).map_err(|e| Fail::new(format!("{}: {e}", path.display())))))
        }
        "storageAside" => Answer::Now(storage().map(|path| {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
            let mut aside = path.clone().into_os_string();
            aside.push(format!(".bad-{stamp}"));
            let aside = PathBuf::from(aside);
            _ = std::fs::rename(&path, &aside);
            Ret::Str(aside.to_string_lossy().into_owned())
        })),
        "filesOpen" | "filesSave" => {
            let which = if name == "filesSave" { Pick::Save } else { Pick::Open };
            let options = a.json(0);
            Answer::Later(Box::new(move || match picked(which, options) {
                Ok(paths) => Ok(Ret::List(paths.into_iter().map(Ret::Str).collect())),
                Err(message) => Err(Fail { message, status: None, code: "portal_unavailable".to_owned() }),
            }))
        }
        "filesRead" => {
            let path = match granted(a.str(0)) {
                Ok(path) => path,
                Err(fail) => return Answer::Now(Err(fail)),
            };
            let limit = Some(a.f64(1)).filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64);
            let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file() && limit.is_none_or(|limit| m.len() <= limit));
            let Some((meta, bytes)) = meta.and_then(|meta| Some((meta, std::fs::read(&path).ok()?))) else { return Answer::ok(Ret::Null) };
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            Answer::ok(Ret::Obj(vec![("bytes", Ret::Bytes(bytes)), ("lastModified", Ret::Num(modified))]))
        }
        "filesWrite" => {
            let path = match granted(a.str(0)) {
                Ok(path) => path,
                Err(fail) => return Answer::Now(Err(fail)),
            };
            match a.with_bytes(1, |bytes| std::fs::write(&path, bytes)) {
                Some(Ok(())) => Answer::ok(()),
                Some(Err(e)) => Answer::fail(format!("{}: {e}", path.display())),
                None => Answer::fail("files.write: the data is bytes"),
            }
        }
        _ => Answer::fail(format!("own: no method {name}")),
    }
}

pub fn granted_paths(paths: &[String]) {
    OWN.with(|o| o.borrow_mut().granted.extend(paths.iter().map(PathBuf::from)));
}
