use std::cell::RefCell;

use acde_runtime::{EntryKind, FsError, PickedFolders, Workspace};

use crate::{bind, offload};

#[derive(Clone, Default)]
pub struct Picker {
    grants: Option<Workspace>,
    folders: PickedFolders,
}

enum Reply {
    Path(Option<String>),
    Entries(Vec<(String, EntryKind)>),
    Kind(Option<EntryKind>),
    Removed(bool),
    Read(Option<(Vec<u8>, i64)>),
    Done,
}

enum Failed {
    Chooser(String),
    Fs(FsError),
}

impl From<FsError> for Failed {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

type Answer = Result<Reply, Failed>;

impl Picker {
    pub fn new(grants: Option<Workspace>) -> Self {
        Self { grants, folders: PickedFolders::default() }
    }

    fn directory(&self, title: &str, writable: bool) -> Answer {
        let Some(picked) = crate::chooser::folder(title).map_err(Failed::Chooser)? else {
            return Ok(Reply::Path(None));
        };
        let path = self.folders.add(&picked)?;
        if let Some(grants) = &self.grants
            && let Err(error) = grants.grant_as(&path, writable)
        {
            log::warn!("granting the picked folder {path}: {}", error.message);
        }
        Ok(Reply::Path(Some(path)))
    }
}

thread_local! {
    static PICKER: RefCell<Option<Picker>> = const { RefCell::new(None) };
}

pub fn adopt(path: &str) -> Result<String, String> {
    let picker = PICKER.with(|p| p.borrow().clone()).ok_or("this web has no file handles")?;
    picker.folders.add(path).map_err(|e| e.message)
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, picker: Picker) {
    PICKER.with(|p| *p.borrow_mut() = Some(picker));
    let object = v8::Object::new(scope);
    crate::methods!(scope, object,
        "directory" => directory,
        "entries" => entries,
        "entry" => entry,
        "remove" => remove,
        "read" => read,
        "write" => write,
        "adopt" => adopt_folder,
    );
    bind::set(scope, natives, "picker", object.into());
}

fn run(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, work: impl FnOnce(Picker) -> Answer + Send + 'static) {
    let Some(picker) = PICKER.with(|p| p.borrow().clone()) else {
        return bind::throw_error(scope, "picker: not given to this web");
    };
    offload::run(scope, rv, "acde-picker", move || work(picker), settle);
}

fn adopt_folder(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    match adopt(&bind::arg_string(scope, &args, 0)) {
        Ok(path) => rv.set(bind::string(scope, &path).into()),
        Err(message) => bind::throw_error(scope, &message),
    }
}

fn kind(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<EntryKind> {
    match value.is_string().then(|| value.to_rust_string_lossy(scope)).as_deref() {
        Some("file") => Some(EntryKind::File),
        Some("directory") => Some(EntryKind::Directory),
        _ => None,
    }
}

fn directory(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let title = bind::arg_string(scope, &args, 0);
    let writable = bind::arg_bool(scope, &args, 1);
    run(scope, &mut rv, move |picker| picker.directory(&title, writable));
}

fn entries(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let dir = bind::arg_string(scope, &args, 0);
    run(scope, &mut rv, move |picker| Ok(Reply::Entries(picker.folders.entries(&dir)?)));
}

fn entry(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (dir, name) = (bind::arg_string(scope, &args, 0), bind::arg_string(scope, &args, 1));
    let create = kind(scope, args.get(2));
    run(scope, &mut rv, move |picker| Ok(Reply::Kind(picker.folders.child(&dir, &name, create)?)));
}

fn remove(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (dir, name) = (bind::arg_string(scope, &args, 0), bind::arg_string(scope, &args, 1));
    let recursive = args.get(2).boolean_value(scope);
    run(scope, &mut rv, move |picker| Ok(Reply::Removed(picker.folders.remove(&dir, &name, recursive)?)));
}

fn read(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let path = bind::arg_string(scope, &args, 0);
    run(scope, &mut rv, move |picker| Ok(Reply::Read(picker.folders.read(&path)?.map(|contents| (contents.data, contents.modified_ms)))));
}

fn write(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let path = bind::arg_string(scope, &args, 0);
    let Some(data) = bind::with_bytes(args.get(1), <[u8]>::to_vec) else {
        return bind::throw_type_error(scope, "picker.write: the data is bytes");
    };
    run(scope, &mut rv, move |picker| {
        picker.folders.write(&path, &data)?;
        Ok(Reply::Done)
    });
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, answer: Answer) {
    let value: v8::Local<v8::Value> = match answer {
        Ok(Reply::Path(Some(path))) => bind::string(scope, &path).into(),
        Ok(Reply::Path(None) | Reply::Kind(None) | Reply::Read(None)) => v8::null(scope).into(),
        Ok(Reply::Kind(Some(kind))) => bind::string(scope, kind.as_str()).into(),
        Ok(Reply::Removed(removed)) => v8::Boolean::new(scope, removed).into(),
        Ok(Reply::Done) => v8::undefined(scope).into(),
        Ok(Reply::Entries(children)) => {
            let list = v8::Array::new(scope, 0);
            for (name, kind) in children.into_iter().filter(|(_, kind)| matches!(kind, EntryKind::File | EntryKind::Directory)) {
                let entry = crate::js_object!(scope, {"name" => name, "kind" => kind.as_str()});
                list.set_index(scope, list.length(), entry.into());
            }
            list.into()
        }
        Ok(Reply::Read(Some((data, modified_ms)))) => crate::js_object!(scope, {"bytes" => data, "lastModified" => modified_ms}).into(),
        Err(Failed::Chooser(message)) => {
            let text = bind::string(scope, &message);
            let error = v8::Exception::error(scope, text);
            resolver.reject(scope, error);
            return;
        }
        Err(Failed::Fs(FsError { status, code, message })) => {
            let error = offload::failure(scope, &message, Some(i32::from(status)), code);
            resolver.reject(scope, error);
            return;
        }
    };
    resolver.resolve(scope, value);
}
