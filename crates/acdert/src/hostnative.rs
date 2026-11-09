use std::cell::RefCell;
use std::sync::Arc;

use acde_hostwin::{FileFilter, Grant, InjectEvent, Injected, OpenRequest, SaveRequest, Shell};

use crate::bind;
use crate::rt::{self, Msg};

thread_local! {
    static SHELL: RefCell<Option<Shell>> = const { RefCell::new(None) };
    static CALLBACK: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

pub fn exports<'s>(scope: &mut v8::PinScope<'s, '_>, native: Option<v8::Local<'s, v8::Value>>) -> v8::Local<'s, v8::Value> {
    let obj = native.and_then(|n| v8::Local::<v8::Object>::try_from(n).ok()).unwrap_or_else(|| v8::Object::new(scope));
    let shell = v8::Object::new(scope);
    crate::methods!(scope, shell,
        "broker" => broker,
    );
    let hosted = v8::Boolean::new(scope, true);
    bind::set(scope, shell, "hosted", hosted.into());
    bind::set(scope, obj, "Shell", shell.into());
    let chooser = v8::Object::new(scope);
    crate::methods!(scope, chooser,
        "open" => chooser_open,
    );
    bind::set(scope, obj, "FileChooser", chooser.into());
    obj.into()
}

fn with<R>(scope: &mut v8::PinScope, f: impl FnOnce(&Shell) -> R) -> Option<R> {
    let result = SHELL.with(|s| s.borrow().as_ref().map(f));
    if result.is_none() {
        bind::throw_error(scope, "Shell: not open");
    }
    result
}

fn broker(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(shell) = Shell::open() else {
        return bind::throw_error(scope, "Shell.broker: no host windows");
    };
    SHELL.with(|s| *s.borrow_mut() = Some(shell));
    let obj = v8::Object::new(scope);
    crate::methods!(scope, obj,
        "pump" => pump,
        "onEvents" => on_events,
        "grant" => grant,
        "place" => place,
        "release" => release,
        "focus" => focus,
        "hide" => hide,
        "setState" => set_state,
        "close" => close,
        "launch" => launch,
        "screenshot" => screenshot,
        "stats" => stats,
        "windows" => windows,
        "animate" => animate,
        "shortcut" => shortcut,
        "unshortcut" => unshortcut,
        "inject" => inject,
        "quit" => quit,
        "capture" => capture,
        "devRespond" => dev_respond,
        "notify" => notify,
        "answerFolder" => answer_folder,
        "answerOpen" => answer_open,
        "answerSave" => answer_save,
        "readClipboard" => read_clipboard,
        "writeClipboard" => write_clipboard,
    );
    #[cfg(any(windows, target_os = "macos"))]
    crate::methods!(scope, obj,
        "openDefault" => open_default,
    );
    let name = bind::string(scope, "");
    bind::set(scope, obj, "socketName", name.into());
    let hosted = v8::Boolean::new(scope, true);
    bind::set(scope, obj, "hosted", hosted.into());
    rv.set(obj.into());
}

fn pump(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(events) = with(scope, Shell::pump) else {
        return;
    };
    let list = v8::Array::new(scope, events.len() as i32);
    for (i, event) in events.into_iter().enumerate() {
        let event = crate::webnative::event_object(scope, event);
        list.set_index(scope, i as u32, event.into());
    }
    rv.set(list.into());
}

fn on_events(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "onEvents: not a function");
    };
    let callback = v8::Global::new(scope, callback);
    CALLBACK.with(|c| *c.borrow_mut() = Some(callback));
    let tx = rt::current().sender();
    let waker: acde_hostwin::Waker = Arc::new(move || {
        _ = tx.send(Msg::Task(Box::new(call_back)));
    });
    with(scope, |shell| shell.set_waker(Some(waker)));
}

fn call_back(scope: &mut v8::PinScope) {
    let Some(callback) = CALLBACK.with(|c| c.borrow().clone()) else {
        return;
    };
    let callback = v8::Local::new(scope, callback);
    bind::call(scope, callback, &[]);
}

fn numbers(scope: &mut v8::PinScope, value: Option<v8::Local<v8::Value>>) -> Option<Vec<f64>> {
    let array = v8::Local::<v8::Array>::try_from(value?).ok()?;
    (0..array.length()).map(|i| array.get_index(scope, i).and_then(|v| v.number_value(scope))).collect()
}

fn grant(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let mut wanted = Grant::default();
    if let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        wanted.desktop = bind::get(scope, options, "desktop").is_some_and(|v| v.boolean_value(scope));
        wanted.hidden = bind::get(scope, options, "hidden").is_some_and(|v| v.boolean_value(scope));
        wanted.window = bind::get(scope, options, "window").and_then(|v| v.number_value(scope)).filter(|n| n.is_finite()).map(|n| n as u32);
        wanted.mode = bind::get(scope, options, "mode").filter(|v| v.is_string()).and_then(|v| v.to_rust_string_lossy(scope).parse().ok());
        let rect = bind::get(scope, options, "rect");
        wanted.rect = numbers(scope, rect).and_then(|r| <[f64; 4]>::try_from(r).ok());
        let size = bind::get(scope, options, "size");
        wanted.size = numbers(scope, size).and_then(|s| <[f64; 2]>::try_from(s).ok());
        wanted.parent = bind::get(scope, options, "parent").and_then(|v| v.number_value(scope)).filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u32);
        wanted.modal = bind::get(scope, options, "modal").is_some_and(|v| v.boolean_value(scope));
    }
    let Some((window, token)) = with(scope, |shell| shell.grant(wanted)) else {
        return;
    };
    let window = v8::Number::new(scope, f64::from(window));
    let token = v8::BigInt::new_from_u64(scope, token);
    let obj = bind::object(scope, &[("window", window.into()), ("token", token.into())]);
    rv.set(obj.into());
}

fn place(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    let rect = [1, 2, 3, 4].map(|i| bind::arg_f64(scope, &args, i));
    with(scope, |shell| shell.place(window, rect));
}

macro_rules! by_window {
    ($($name:ident),*) => {$(
        fn $name(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
            let window = bind::arg_f64(scope, &args, 0) as u32;
            with(scope, |shell| shell.$name(window));
        }
    )*};
}

by_window!(release, focus, close, animate);

fn hide(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    let hidden = bind::arg_bool(scope, &args, 1);
    with(scope, |shell| shell.hide(window, hidden));
}

fn set_state(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    match bind::arg_string(scope, &args, 1).parse::<acde_hostwin::WindowState>() {
        Ok(state) => {
            with(scope, |shell| shell.set_state(window, state));
        }
        Err(e) => bind::throw_type_error(scope, &format!("setState: {e}")),
    }
}

fn launch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let argv = bind::strings(scope, args.get(0)).unwrap_or_default();
    let options = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    let cwd = options.and_then(|o| bind::get(scope, o, "cwd")).filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope));
    let env = match options.and_then(|o| bind::get(scope, o, "env")) {
        Some(env) => bind::own_string_pairs(scope, env),
        None => Vec::new(),
    };
    match with(scope, |shell| shell.launch(&argv, cwd.as_deref(), &env)) {
        Some(Ok(pid)) => rv.set(v8::Number::new(scope, f64::from(pid)).into()),
        Some(Err(e)) => bind::throw_error(scope, &e),
        None => {}
    }
}

fn screenshot(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let path = std::path::PathBuf::from(bind::arg_string(scope, &args, 0));
    if with(scope, |_| ()).is_none() {
        return;
    }
    crate::offload::run(
        scope,
        &mut rv,
        "acde-screenshot",
        move || Shell::open().ok_or_else(|| "Shell: not open".to_owned()).and_then(|shell| shell.screenshot(path)),
        settle_screenshot,
    );
}

fn settle_screenshot(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, done: Result<(u32, u32), String>) {
    match done {
        Ok((width, height)) => {
            let width = num(scope, f64::from(width));
            let height = num(scope, f64::from(height));
            let obj = bind::object(scope, &[("width", width), ("height", height)]);
            resolver.resolve(scope, obj.into());
        }
        Err(e) => {
            let error = crate::offload::failure(scope, &format!("screenshot: {e}"), None, "screenshot");
            resolver.reject(scope, error);
        }
    }
}

fn stats(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(stats) = with(scope, Shell::stats) else {
        return;
    };
    let fields: Vec<(&str, v8::Local<v8::Value>)> = stats.into_iter().map(|(k, v)| (k, v8::Number::new(scope, v).into())).collect();
    rv.set(bind::object(scope, &fields).into());
}

fn windows(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(list) = with(scope, Shell::windows) else {
        return;
    };
    let pid = f64::from(std::process::id());
    let array = v8::Array::new(scope, list.len() as i32);
    for (i, w) in list.into_iter().enumerate() {
        let id = num(scope, f64::from(w.id));
        let window = num(scope, f64::from(w.id));
        let canvas = num(scope, 0.0);
        let mode = bind::string(scope, w.mode.as_str());
        let state = bind::string(scope, w.state.as_str());
        let [x, y, width, height] = [num(scope, w.rect[0]), num(scope, w.rect[1]), num(scope, w.rect[2]), num(scope, w.rect[3])];
        let z = num(scope, w.z as f64);
        let focus = v8::Boolean::new(scope, w.focus);
        let hidden = v8::Boolean::new(scope, w.hidden);
        let pid = num(scope, pid);
        let parent = match w.parent {
            Some(p) => num(scope, f64::from(p)),
            None => v8::null(scope).into(),
        };
        let modal = v8::Boolean::new(scope, w.modal);
        let fields = [
            ("id", id),
            ("window", window),
            ("canvas", canvas),
            ("mode", mode.into()),
            ("state", state.into()),
            ("x", x),
            ("y", y),
            ("width", width),
            ("height", height),
            ("z", z),
            ("focus", focus.into()),
            ("hidden", hidden.into()),
            ("pid", pid),
            ("parent", parent),
            ("modal", modal.into()),
        ];
        let obj = bind::object(scope, &fields);
        array.set_index(scope, i as u32, obj.into());
    }
    rv.set(array.into());
}

fn num<'s>(scope: &mut v8::PinScope<'s, '_>, value: f64) -> v8::Local<'s, v8::Value> {
    v8::Number::new(scope, value).into()
}

fn shortcut_call(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, on: bool) {
    let combo = bind::arg_string(scope, args, 0);
    let kind = bind::arg_string(scope, args, 1);
    let owner = bind::arg_f64(scope, args, 2) as u32;
    if let Some(Err(e)) = with(scope, |shell| shell.shortcut(&combo, &kind, owner, on)) {
        bind::throw_error(scope, &e);
    }
}

fn shortcut(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    shortcut_call(scope, &args, true);
}

fn unshortcut(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    shortcut_call(scope, &args, false);
}

fn injected(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Injected, String> {
    let options = v8::Local::<v8::Object>::try_from(value).map_err(|_| "inject: not an object".to_owned())?;
    let kind = bind::get(scope, options, "type").filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
    let source = bind::get(scope, options, "source").filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope));
    let mut number =
        |name: &str| bind::get(scope, options, name).filter(|v| !v.is_null_or_undefined()).and_then(|v| v.number_value(scope)).filter(|n| n.is_finite());
    let (x, y, dx, dy) = (number("x"), number("y"), number("dx"), number("dy"));
    let (button, code) = (number("button").map(|b| b as u32), number("code").map(|c| c as u32));
    Injected::try_from(InjectEvent { kind, x, y, button, dx, dy, source, code })
}

fn inject(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    match injected(scope, args.get(0)) {
        Ok(event) => _ = with(scope, |shell| shell.inject(event)),
        Err(e) => bind::throw_error(scope, &e),
    }
}

fn capture(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    if with(scope, |_| ()).is_none() {
        return;
    }
    crate::offload::run(
        scope,
        &mut rv,
        "acde-capture",
        move || Shell::open().ok_or_else(|| "Shell: not open".to_owned()).and_then(|shell| shell.capture(window)),
        settle_capture,
    );
}

fn settle_capture(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, shot: Result<acde_hostwin::Shot, String>) {
    use base64::Engine;
    match shot {
        Ok(shot) => {
            let width = num(scope, f64::from(shot.width));
            let height = num(scope, f64::from(shot.height));
            let png = bind::string(scope, &base64::engine::general_purpose::STANDARD.encode(&shot.png));
            let obj = bind::object(scope, &[("width", width), ("height", height), ("png", png.into())]);
            resolver.resolve(scope, obj.into());
        }
        Err(e) => {
            let error = crate::offload::failure(scope, &format!("capture: {e}"), None, "capture");
            resolver.reject(scope, error);
        }
    }
}

fn dev_respond(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_f64(scope, &args, 0);
    if !id.is_finite() || id.fract() != 0.0 {
        return bind::throw_type_error(scope, "devRespond: the id is an integer");
    }
    let ok = bind::arg_bool(scope, &args, 1);
    let payload = bind::arg_string(scope, &args, 2);
    let result = if ok { Ok(payload.as_str()) } else { Err(payload.as_str()) };
    if let Some(Err(e)) = with(scope, |_| acde_hostwin::dev_respond(id as i64, result)) {
        bind::throw_error(scope, &e);
    }
}

fn notify(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let title = bind::arg_string(scope, &args, 0);
    let body = bind::arg_string(scope, &args, 1);
    let subtitle = bind::arg_string(scope, &args, 2);
    if let Some(Err(e)) = with(scope, |_| acde_hostwin::notify(&title, &body, &subtitle)) {
        bind::throw_error(scope, &e);
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn open_default(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let target = bind::arg_string(scope, &args, 0);
    if with(scope, |_| ()).is_none() {
        return;
    }
    crate::offload::run(scope, &mut rv, "acde-open", move || acde_hostwin::open_default(&target), settle_default);
}

#[cfg(any(windows, target_os = "macos"))]
fn settle_default(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, done: Result<(), acde_hostwin::OpenError>) {
    let error = match done {
        Ok(()) => {
            let undefined = v8::undefined(scope).into();
            resolver.resolve(scope, undefined);
            return;
        }
        Err(acde_hostwin::OpenError::Refused(message)) => crate::offload::failure(scope, &message, Some(403), "refused"),
        Err(acde_hostwin::OpenError::Failed(message)) => crate::offload::failure(scope, &message, Some(500), "failed"),
    };
    resolver.reject(scope, error);
}

fn answer_folder(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let answer = args.get(0);
    let path = (!answer.is_null_or_undefined()).then(|| std::path::PathBuf::from(bind::arg_string(scope, &args, 0)));
    with(scope, |_| acde_hostwin::answer_folder(path));
}

fn read_clipboard(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(text) = with(scope, |_| acde_hostwin::clipboard_text()) else { return };
    let text = bind::string(scope, &text);
    rv.set(text.into());
}

fn write_clipboard(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let text = bind::arg_string(scope, &args, 0);
    with(scope, |_| acde_hostwin::set_clipboard_text(text));
}

fn answer_open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let answer = args.get(0);
    let paths = if answer.is_null_or_undefined() {
        None
    } else {
        match bind::strings(scope, answer) {
            Some(paths) if !paths.is_empty() => Some(paths.into_iter().map(std::path::PathBuf::from).collect()),
            _ => return bind::throw_type_error(scope, "answerOpen: the answer is a non-empty list of paths, or null"),
        }
    };
    with(scope, |_| acde_hostwin::answer_open(paths));
}

fn answer_save(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let answer = args.get(0);
    let path = (!answer.is_null_or_undefined()).then(|| std::path::PathBuf::from(bind::arg_string(scope, &args, 0)));
    with(scope, |_| acde_hostwin::answer_save(path));
}

fn chooser_open(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let chooser = v8::Object::new(scope);
    crate::methods!(scope, chooser,
        "openFile" => open_file,
        "saveFile" => save_file,
    );
    let Some(resolver) = v8::PromiseResolver::new(scope) else { return };
    resolver.resolve(scope, chooser.into());
    rv.set(resolver.get_promise(scope).into());
}

fn chooser_options<'s>(scope: &mut v8::PinScope, value: v8::Local<'s, v8::Value>, method: &str) -> Option<v8::Local<'s, v8::Object>> {
    let options = v8::Local::<v8::Object>::try_from(value).ok();
    if options.is_none() {
        bind::throw_type_error(scope, &format!("{method}: the options are an object"));
    }
    options
}

fn flag(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str) -> bool {
    bind::get(scope, obj, name).is_some_and(|v| v.is_true())
}

fn file_filters(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) -> Vec<FileFilter> {
    let Some(list) = bind::get(scope, obj, "filters").and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) else {
        return Vec::new();
    };
    (0..list.length())
        .filter_map(|i| {
            let filter = list.get_index(scope, i).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok())?;
            let mut strings = |name: &str| bind::get(scope, filter, name).and_then(|v| bind::strings(scope, v)).unwrap_or_default();
            let globs = strings("globs");
            let mimes = strings("mimes");
            Some(FileFilter { name: bind::get_string(scope, filter, "name").unwrap_or_default(), globs, mimes })
        })
        .collect()
}

fn open_file(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(options) = chooser_options(scope, args.get(0), "openFile") else { return };
    let request = OpenRequest {
        title: bind::get_string(scope, options, "title").unwrap_or_default(),
        multiple: flag(scope, options, "multiple"),
        directory: flag(scope, options, "directory"),
        filters: file_filters(scope, options),
    };
    crate::offload::run(scope, &mut rv, "acde-chooser", move || crate::chooser::open(request), settle_open);
}

fn save_file(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(options) = chooser_options(scope, args.get(0), "saveFile") else { return };
    let request = SaveRequest {
        title: bind::get_string(scope, options, "title").unwrap_or_default(),
        name: bind::get_string(scope, options, "name").unwrap_or_default(),
        filters: file_filters(scope, options),
    };
    crate::offload::run(scope, &mut rv, "acde-chooser", move || crate::chooser::save(request), settle_save);
}

fn chooser_failed(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, error: &str) {
    let error = crate::offload::failure(scope, error, None, "chooser");
    resolver.reject(scope, error);
}

fn settle_open(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, picked: Result<Option<Vec<String>>, String>) {
    match picked {
        Ok(Some(paths)) => {
            let paths: Vec<v8::Local<v8::Value>> = paths.iter().map(|path| bind::string(scope, path).into()).collect();
            let list = v8::Array::new_with_elements(scope, &paths);
            resolver.resolve(scope, list.into());
        }
        Ok(None) => {
            let null = v8::null(scope).into();
            resolver.resolve(scope, null);
        }
        Err(e) => chooser_failed(scope, resolver, &e),
    }
}

fn settle_save(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, picked: Result<Option<String>, String>) {
    match picked {
        Ok(picked) => {
            let value = match picked {
                Some(path) => bind::string(scope, &path).into(),
                None => v8::null(scope).into(),
            };
            resolver.resolve(scope, value);
        }
        Err(e) => chooser_failed(scope, resolver, &e),
    }
}

fn quit(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with(scope, Shell::quit);
}
