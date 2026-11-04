use std::cell::RefCell;
use std::sync::Arc;

use acde_hostwin::{Grant, Mode, Shell};

use crate::bind;
use crate::rt::{self, Msg};

thread_local! {
    static SHELL: RefCell<Option<Shell>> = const { RefCell::new(None) };
    static CALLBACK: RefCell<Option<v8::Global<v8::Function>>> = const { RefCell::new(None) };
}

pub fn exports<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    native: Option<v8::Local<'s, v8::Value>>,
) -> v8::Local<'s, v8::Value> {
    let obj = native
        .and_then(|n| v8::Local::<v8::Object>::try_from(n).ok())
        .unwrap_or_else(|| v8::Object::new(scope));
    let shell = v8::Object::new(scope);
    crate::methods!(scope, shell,
        "broker" => broker,
    );
    bind::set(scope, obj, "Shell", shell.into());
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
        "close" => close,
        "launch" => launch,
        "screenshot" => screenshot,
        "stats" => stats,
        "windows" => windows,
        "canvases" => canvases,
        "animate" => animate,
        "shortcut" => shortcut,
        "unshortcut" => unshortcut,
        "inject" => inject,
        "setMode" => set_mode,
        "raise" => raise,
        "quit" => quit,
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
    (0..array.length())
        .map(|i| {
            array
                .get_index(scope, i)
                .and_then(|v| v.number_value(scope))
        })
        .collect()
}

fn grant(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let mut wanted = Grant::default();
    if let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        wanted.desktop =
            bind::get(scope, options, "desktop").is_some_and(|v| v.boolean_value(scope));
        wanted.hidden = bind::get(scope, options, "hidden").is_some_and(|v| v.boolean_value(scope));
        wanted.window = bind::get(scope, options, "window")
            .and_then(|v| v.number_value(scope))
            .filter(|n| n.is_finite())
            .map(|n| n as u32);
        wanted.mode = bind::get(scope, options, "mode")
            .filter(|v| v.is_string())
            .and_then(|v| Mode::parse(&v.to_rust_string_lossy(scope)));
        let rect = bind::get(scope, options, "rect");
        wanted.rect = numbers(scope, rect).and_then(|r| <[f64; 4]>::try_from(r).ok());
        let size = bind::get(scope, options, "size");
        wanted.size = numbers(scope, size).and_then(|s| <[f64; 2]>::try_from(s).ok());
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

fn release(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    with(scope, |shell| shell.release(window));
}

fn focus(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    with(scope, |shell| shell.focus(window));
}

fn raise(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    with(scope, |shell| shell.focus(window));
}

fn hide(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    let hidden = bind::arg_bool(scope, &args, 1);
    with(scope, |shell| shell.hide(window, hidden));
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    with(scope, |shell| shell.close(window));
}

fn set_mode(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    let Some(mode) = Mode::parse(&bind::arg_string(scope, &args, 1)) else {
        return bind::throw_type_error(scope, "setMode: no such mode");
    };
    with(scope, |shell| shell.set_mode(window, mode));
}

fn launch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let argv = bind::strings(scope, args.get(0)).unwrap_or_default();
    let options = v8::Local::<v8::Object>::try_from(args.get(1)).ok();
    let cwd = options
        .and_then(|o| bind::get(scope, o, "cwd"))
        .filter(|v| v.is_string())
        .map(|v| v.to_rust_string_lossy(scope));
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

fn screenshot(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    let promise = resolver.get_promise(scope);
    let message = bind::string(scope, "screenshot: not in host windows");
    let error = v8::Exception::error(scope, message);
    resolver.reject(scope, error);
    rv.set(promise.into());
}

fn stats(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(stats) = with(scope, Shell::stats) else {
        return;
    };
    let fields: Vec<(&str, v8::Local<v8::Value>)> = stats
        .into_iter()
        .map(|(k, v)| (k, v8::Number::new(scope, v).into()))
        .collect();
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
        let [x, y, width, height] = [
            num(scope, w.rect[0]),
            num(scope, w.rect[1]),
            num(scope, w.rect[2]),
            num(scope, w.rect[3]),
        ];
        let z = num(scope, w.z as f64);
        let focus = v8::Boolean::new(scope, w.focus);
        let hidden = v8::Boolean::new(scope, w.hidden);
        let pid = num(scope, pid);
        let fields = [
            ("id", id),
            ("window", window),
            ("canvas", canvas),
            ("mode", mode.into()),
            ("x", x),
            ("y", y),
            ("width", width),
            ("height", height),
            ("z", z),
            ("focus", focus.into()),
            ("hidden", hidden.into()),
            ("pid", pid),
        ];
        let obj = bind::object(scope, &fields);
        array.set_index(scope, i as u32, obj.into());
    }
    rv.set(array.into());
}

fn num<'s>(scope: &mut v8::PinScope<'s, '_>, value: f64) -> v8::Local<'s, v8::Value> {
    v8::Number::new(scope, value).into()
}

fn canvases(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some([w, h, scale]) = with(scope, Shell::screen) else {
        return;
    };
    let id = v8::Number::new(scope, 0.0);
    let zero = v8::Number::new(scope, 0.0);
    let width = v8::Number::new(scope, w);
    let height = v8::Number::new(scope, h);
    let scale = v8::Number::new(scope, scale);
    let canvas = bind::object(
        scope,
        &[
            ("id", id.into()),
            ("x", zero.into()),
            ("y", zero.into()),
            ("width", width.into()),
            ("height", height.into()),
            ("scale", scale.into()),
        ],
    );
    let array = v8::Array::new_with_elements(scope, &[canvas.into()]);
    rv.set(array.into());
}

fn animate(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let window = bind::arg_f64(scope, &args, 0) as u32;
    with(scope, |shell| shell.animate(window));
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

fn inject(_: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {}

fn quit(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with(scope, Shell::quit);
}
