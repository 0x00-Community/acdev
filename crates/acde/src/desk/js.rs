//! The desk as JS sees it. In a desktop or window isolate: `natives.desk` (the window table, the compositor, apps;
//! what is allowed is checked in `Desk` against the caller) and `natives.services` (calls to the desktop package's
//! services in the Broker, step 6). In the Broker: `sys.desk(look)`, what is left for it to run.

use std::cell::RefCell;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::mpsc::Sender;

use acde_model::{Easing, Mode, Scope};
use acde_shell::compositor::{Animate, BTN_LEFT, Injected, WheelKind};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{App, Ask, Desk, Done, Failure, LookChange};
use crate::bind;
use crate::isolate::Place;
use crate::offload;

struct Caller {
    desk: Arc<Desk>,
    window: u32,
}

#[derive(Default)]
struct Handlers {
    message: Option<v8::Global<v8::Function>>,
    ask: Option<v8::Global<v8::Function>>,
    service: Option<v8::Global<v8::Function>>,
    notice: Option<v8::Global<v8::Function>>,
    replies: HashMap<u32, Sender<Value>>,
    next: u32,
}

thread_local! {
    static CALLER: RefCell<Option<Caller>> = const { RefCell::new(None) };
    static BROKER: RefCell<Option<Arc<Desk>>> = const { RefCell::new(None) };
    static HANDLERS: RefCell<Handlers> = RefCell::default();
}

pub fn clear() {
    CALLER.with(|c| c.borrow_mut().take());
    HANDLERS.with(|h| std::mem::take(&mut *h.borrow_mut()));
}

fn caller() -> Option<(Arc<Desk>, u32)> {
    CALLER.with(|c| c.borrow().as_ref().map(|c| (c.desk.clone(), c.window)))
}

fn broker() -> Option<Arc<Desk>> {
    BROKER.with(|b| b.borrow().clone())
}

// ---- values ----

fn json_of(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Value {
    if value.is_undefined() {
        return Value::Null;
    }
    v8::json::stringify(scope, value).and_then(|s| serde_json::from_str(&s.to_rust_string_lossy(scope)).ok()).unwrap_or(Value::Null)
}

fn arg<T: for<'de> Deserialize<'de>>(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> Option<T> {
    serde_json::from_value(json_of(scope, args.get(i))).ok()
}

fn throw(scope: &mut v8::PinScope, failure: Failure) {
    let error = offload::failure(scope, &failure.message, failure.status, failure.code);
    scope.throw_exception(error);
}

fn give(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, done: Done<Value>) {
    match done {
        Ok(value) => rv.set(offload::json(scope, &value)),
        Err(failure) => throw(scope, failure),
    }
}

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, done: Done<Value>) {
    match done {
        Ok(value) => {
            let value = offload::json(scope, &value);
            resolver.resolve(scope, value);
        }
        Err(failure) => {
            let error = offload::failure(scope, &failure.message, failure.status, failure.code);
            resolver.reject(scope, error);
        }
    }
}

/// Runs blocking desk work off the caller's loop; the promise settles back on it.
fn later(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, work: impl FnOnce() -> Done<Value> + Send + 'static) {
    offload::run(scope, rv, "acde-desk-call", work, settle);
}

fn resolved(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, done: Done<Value>) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else { return };
    let promise = resolver.get_promise(scope);
    settle(scope, resolver, done);
    rv.set(promise.into());
}

fn window_arg(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> u32 {
    bind::arg_u32(scope, args, i)
}

fn rect_arg(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> [i32; 4] {
    let v: Vec<f64> = arg(scope, args, i).unwrap_or_default();
    std::array::from_fn(|n| v.get(n).copied().unwrap_or(0.0).round() as i32)
}

fn handler(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<v8::Global<v8::Function>> {
    let function = v8::Local::<v8::Function>::try_from(args.get(0)).ok();
    if function.is_none() {
        bind::throw_type_error(scope, "desk: not a function");
    }
    function.map(|f| v8::Global::new(scope, f))
}

macro_rules! with_caller {
    ($scope:ident, |$desk:ident, $me:ident| $body:expr) => {{
        let Some(($desk, $me)) = caller() else { return bind::throw_error($scope, "desk: not in a desktop or window isolate") };
        $body
    }};
}

// ---- the isolate's side ----

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, desk: Arc<Desk>, window: u32, place: Place) {
    CALLER.with(|c| *c.borrow_mut() = Some(Caller { desk, window }));
    let object = v8::Object::new(scope);
    let place = bind::string(scope, place.name()).into();
    bind::set(scope, object, "place", place);
    let window = v8::Integer::new_from_unsigned(scope, window).into();
    bind::set(scope, object, "window", window);
    crate::methods!(scope, object,
        "onMessage" => on_message,
        "onAsk" => on_ask,
        "launch" => start_program,
        "close" => close,
        "kill" => kill,
        "focus" => focus,
        "hide" => hide,
        "show" => show,
        "setMode" => set_mode,
        "placeWindow" => place_window,
        "geometry" => geometry,
        "invokeMenu" => invoke_menu,
        "stats" => stats,
        "screenshot" => screenshot,
        "animate" => animate,
        "shortcut" => shortcut,
        "unshortcut" => unshortcut,
        "panelOpen" => panel_open,
        "panelPlace" => panel_place,
        "panelClose" => panel_close,
        "setTitle" => set_title,
        "setMenus" => set_menus,
        "closeSelf" => close_self,
        "minimize" => minimize,
        "requestAttention" => request_attention,
        "ready" => ready,
        "reload" => reload,
        "openUrl" => open_url,
        "shown" => shown,
        "download" => download,
        "notify" => notify,
        "apps" => apps,
        "openApp" => open_app,
        "sessionOwn" => session_own,
        "endSession" => end_session,
        "setLanguage" => set_language,
        "desktops" => desktops,
        "chooseDesktop" => choose_desktop,
        "openPath" => open_path,
        "handlers" => handlers,
        "setDefault" => set_default,
        "inspectSnapshot" => inspect_snapshot,
        "inspectRun" => inspect_run,
        "inspectOpen" => inspect_open,
    );
    bind::set(scope, natives, "desk", object.into());
    let services = v8::Object::new(scope);
    crate::methods!(scope, services,
        "post" => service_post,
        "onMessage" => on_service,
    );
    bind::set(scope, natives, "services", services.into());
}

/// A message for this isolate (`events`, `screen`, `languages`, `colorscheme`, `visible`) to its `onMessage`.
pub fn message(scope: &mut v8::PinScope, message: Value) {
    let Some(function) = HANDLERS.with(|h| h.borrow().message.clone()) else { return };
    let value = offload::json(scope, &message);
    bind::call(scope, &function, &[value]);
}

/// The desk asks this isolate's JS (`onAsk(kind, payload)`); the answer (or the promise's) goes to `reply`.
pub fn ask(scope: &mut v8::PinScope, ask: Ask, payload: Value, reply: Sender<Value>) {
    let Some(function) = HANDLERS.with(|h| h.borrow().ask.clone()) else { return };
    let kind = bind::string(scope, ask.name()).into();
    let payload = offload::json(scope, &payload);
    let Some(answer) = bind::call(scope, &function, &[kind, payload]) else { return };
    let Ok(promise) = v8::Local::<v8::Promise>::try_from(answer) else {
        _ = reply.send(json_of(scope, answer));
        return;
    };
    let token = HANDLERS.with(|h| {
        let mut h = h.borrow_mut();
        h.next = h.next.wrapping_add(1);
        let token = h.next;
        h.replies.insert(token, reply);
        token
    });
    let data = v8::Integer::new_from_unsigned(scope, token).into();
    let (Some(ok), Some(failed)) = (v8::Function::builder(answered).data(data).build(scope), v8::Function::builder(unanswered).data(data).build(scope)) else { return };
    promise.then2(scope, ok, failed);
}

fn answered(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let token = args.data().uint32_value(scope).unwrap_or(0);
    let value = json_of(scope, args.get(0));
    if let Some(reply) = HANDLERS.with(|h| h.borrow_mut().replies.remove(&token)) {
        _ = reply.send(value);
    }
}

fn unanswered(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let token = args.data().uint32_value(scope).unwrap_or(0);
    HANDLERS.with(|h| h.borrow_mut().replies.remove(&token));
}

fn on_message(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let f = handler(scope, &args);
    HANDLERS.with(|h| h.borrow_mut().message = f);
}

fn on_ask(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let f = handler(scope, &args);
    HANDLERS.with(|h| h.borrow_mut().ask = f);
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct LaunchOptions {
    pub(super) cwd: Option<String>,
    pub(super) env: HashMap<String, String>,
    pub(super) slot: bool,
}

fn start_program(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let argv: Vec<String> = arg(scope, &args, 0).unwrap_or_default();
        let options: LaunchOptions = arg(scope, &args, 1).unwrap_or_default();
        let env: Vec<(String, String)> = options.env.into_iter().collect();
        let done = desk.start_program(me, &argv, options.cwd.as_deref(), &env, options.slot).map(Value::from);
        give(scope, &mut rv, done)
    })
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let window = window_arg(scope, &args, 0);
        later(scope, &mut rv, move || desk.close(me, window).map(Value::from))
    })
}

fn kill(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let window = window_arg(scope, &args, 0);
        later(scope, &mut rv, move || desk.kill(me, window).map(Value::from))
    })
}

/// A desktop-only call that only asks the compositor: a resolved promise, or a rejected one when refused.
fn desktop_call(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, what: &str, f: impl FnOnce(&Desk) -> Done<Value>) {
    let Some((desk, me)) = caller() else { return bind::throw_error(scope, "desk: not in a desktop or window isolate") };
    let done = desk.desktop_only(me, what).and_then(|()| f(&desk));
    resolved(scope, rv, done);
}

fn focus(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = window_arg(scope, &args, 0);
    desktop_call(scope, &mut rv, &format!("window {window}"), |desk| {
        desk.link().focus(window);
        Ok(Value::Null)
    });
}

fn hide(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = window_arg(scope, &args, 0);
    desktop_call(scope, &mut rv, &format!("window {window}"), |desk| {
        desk.hide(window, true);
        Ok(Value::Null)
    });
}

fn show(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = window_arg(scope, &args, 0);
    desktop_call(scope, &mut rv, &format!("window {window}"), |desk| {
        desk.hide(window, false);
        Ok(Value::Null)
    });
}

fn set_mode(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = window_arg(scope, &args, 0);
    let mode = Mode::from_str(&bind::arg_string(scope, &args, 1));
    desktop_call(scope, &mut rv, &format!("window {window}"), |desk| {
        let mode = mode.map_err(|e| Failure::new(400, "bad_mode", e))?;
        desk.link().set_mode(window, mode);
        Ok(Value::Null)
    });
}

fn place_window(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = window_arg(scope, &args, 0);
    let rect = rect_arg(scope, &args, 1);
    desktop_call(scope, &mut rv, &format!("window {window}"), |desk| {
        desk.link().place(window, rect);
        Ok(Value::Null)
    });
}

fn geometry(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    desktop_call(scope, &mut rv, "window geometry", |desk| {
        let (windows, canvases) = desk.link().list();
        let windows: Vec<Value> = windows
            .iter()
            .map(|w| json!({ "window": w.window.unwrap_or(w.id), "mode": w.mode.as_str(), "rect": [w.x, w.y, w.width, w.height], "z": w.z, "focus": w.focus, "hidden": w.hidden }))
            .collect();
        let canvases: Vec<Value> = canvases.iter().map(|c| json!({ "id": c.id, "rect": [c.x, c.y, c.width, c.height], "scale": c.scale })).collect();
        Ok(json!({ "windows": windows, "canvases": canvases }))
    });
}

fn invoke_menu(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let window = window_arg(scope, &args, 0);
        let (menu, item) = (json_of(scope, args.get(1)), json_of(scope, args.get(2)));
        later(scope, &mut rv, move || {
            let answer = desk.invoke_menu(me, window, menu, item)?;
            Ok(answer.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(Value::Null))
        })
    })
}

fn stats(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    desktop_call(scope, &mut rv, "compositor stats", |desk| Ok(stats_json(&desk.link().stats(false))));
}

fn stats_json(s: &acde_shell::compositor::Stats) -> Value {
    json!({ "frames": s.frames, "composeP50": s.compose_p50, "composeP95": s.compose_p95, "composeMax": s.compose_max, "plans": s.plans, "direct": s.direct })
}

fn screenshot(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let path: Option<String> = arg(scope, &args, 0);
        later(scope, &mut rv, move || {
            desk.desktop_only(me, "screenshots")?;
            desk.screenshot(path)
        })
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct AnimateOptions {
    opacity: Option<f64>,
    scale: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
    duration: Option<f64>,
    delay: Option<f64>,
    easing: Option<String>,
}

impl TryFrom<AnimateOptions> for Animate {
    type Error = String;

    fn try_from(o: AnimateOptions) -> Result<Self, String> {
        let easing = o.easing.as_deref().map(Easing::from_str).transpose()?;
        Ok(Animate { opacity: o.opacity, scale: o.scale, dx: o.dx, dy: o.dy, duration_ms: o.duration.unwrap_or(200.0), delay_ms: o.delay.unwrap_or(0.0), easing })
    }
}

fn animate(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let window = window_arg(scope, &args, 0);
    let options: AnimateOptions = arg(scope, &args, 1).unwrap_or_default();
    desktop_call(scope, &mut rv, &format!("animating window {window}"), |desk| {
        desk.link().animate(window, Animate::try_from(options)?);
        Ok(Value::Null)
    });
}

fn shortcut_call(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, rv: &mut v8::ReturnValue, on: bool) {
    with_caller!(scope, |desk, me| {
        let combo = bind::arg_string(scope, args, 0);
        let scope_arg: Option<String> = arg(scope, args, 1);
        let done = scope_arg.as_deref().map(Scope::from_str).transpose().map_err(Failure::from).and_then(|s| desk.shortcut(me, combo, s, on)).map(|()| Value::Null);
        resolved(scope, rv, done)
    })
}

fn shortcut(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    shortcut_call(scope, &args, &mut rv, true);
}

fn unshortcut(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    shortcut_call(scope, &args, &mut rv, false);
}

fn panel_open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let rect = rect_arg(scope, &args, 0);
        match desk.panel_open(me, rect) {
            Ok((window, token)) => {
                let window = v8::Integer::new_from_unsigned(scope, window).into();
                let token = v8::BigInt::new_from_u64(scope, token).into();
                rv.set(bind::object(scope, &[("window", window), ("token", token)]).into());
            }
            Err(failure) => throw(scope, failure),
        }
    })
}

fn panel_place(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let (window, rect) = (window_arg(scope, &args, 0), rect_arg(scope, &args, 1));
        give(scope, &mut rv, desk.panel_place(me, window, rect).map(|()| Value::Null))
    })
}

fn panel_close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let window = window_arg(scope, &args, 0);
        give(scope, &mut rv, desk.panel_close(me, window).map(|()| Value::Null))
    })
}

fn set_title(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let title = bind::arg_string(scope, &args, 0);
        give(scope, &mut rv, desk.set_title(me, title).map(|()| Value::Null))
    })
}

fn set_menus(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let menus = json_of(scope, args.get(0));
        give(scope, &mut rv, desk.set_menus(me, menus).map(|()| Value::Null))
    })
}

fn close_self(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| later(scope, &mut rv, move || Ok(desk.close_window(me, true).into())))
}

fn tell(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, kind: &'static str) {
    with_caller!(scope, |desk, me| resolved(scope, rv, desk.tell(me, kind).map(|()| Value::Null)))
}

fn minimize(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    tell(scope, &mut rv, "windowminimize");
}

fn request_attention(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    tell(scope, &mut rv, "windowattention");
}

fn ready(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    tell(scope, &mut rv, "windowready");
}

fn reload(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let url: Option<String> = arg(scope, &args, 0);
        give(scope, &mut rv, desk.reload(me, url).map(Value::from))
    })
}

fn open_url(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let url = bind::arg_string(scope, &args, 0);
        give(scope, &mut rv, desk.open_url(me, &url).map(Value::from))
    })
}

fn shown(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_caller!(scope, |desk, me| desk.shown(me))
}

fn download(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let (name, kind) = (bind::arg_string(scope, &args, 0), bind::arg_string(scope, &args, 1));
        let Some(bytes) = bind::bytes(args.get(2)) else { return bind::throw_type_error(scope, "download: the data is bytes") };
        later(scope, &mut rv, move || desk.download(me, &name, &kind, &bytes).map(Value::from))
    })
}

fn notify(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let notification = json_of(scope, args.get(0));
        desk.notify(me, &notification)
    })
}

fn apps(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, _me| resolved(scope, &mut rv, Ok(desk.app_list())))
}

/// `apps.launch` / `apps.open` / `acde.open`: the desktop may open any app, a window those its manifest's `open` names.
fn open_app(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let app = bind::arg_string(scope, &args, 0);
        let request = Some(json_of(scope, args.get(1))).filter(|r| !r.is_null());
        let (desktop, who, caps) = desk.rights(me);
        let done = if desktop || caps.opens(&app) { desk.launch(&app, request, Mode::Free).map(|window| json!({ "window": window })) } else { Err(Failure::refused(&who, &format!("open {app}"))) };
        resolved(scope, &mut rv, done)
    })
}

fn session_own(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, _me| rv.set_bool(desk.session_own()))
}

fn end_session(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let kind = bind::arg_string(scope, &args, 0);
        let end = match super::End::try_from(kind.as_str()) {
            Ok(end) => end,
            Err(failure) => return resolved(scope, &mut rv, Err(failure)),
        };
        later(scope, &mut rv, move || desk.end_session(me, end).map(|()| Value::Null))
    })
}

fn set_language(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let tag = bind::arg_string(scope, &args, 0);
        resolved(scope, &mut rv, desk.set_language(me, &tag).map(|()| Value::Null))
    })
}

fn desktops(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| resolved(scope, &mut rv, desk.desktops(me)))
}

fn choose_desktop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let (id, remember) = (bind::arg_string(scope, &args, 0), bind::arg_bool(scope, &args, 1));
        resolved(scope, &mut rv, desk.choose_desktop(me, &id, remember).map(|()| Value::Null))
    })
}

fn open_path(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let target = bind::arg_string(scope, &args, 0);
        let options: super::OpenOptions = arg(scope, &args, 1).unwrap_or_default();
        later(scope, &mut rv, move || desk.open_path(Some(me), &target, options))
    })
}

fn handlers(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let target = bind::arg_string(scope, &args, 0);
        later(scope, &mut rv, move || desk.handlers(Some(me), &target))
    })
}

fn set_default(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let (mime, app) = (bind::arg_string(scope, &args, 0), bind::arg_string(scope, &args, 1));
        resolved(scope, &mut rv, desk.set_default(Some(me), &mime, &app).map(Value::from))
    })
}

/// `acde:inspect` (only the desktop's): blocking, off the caller's loop.
fn inspect_call(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, work: impl FnOnce(&Arc<Desk>) -> Done<Value> + Send + 'static) {
    with_caller!(scope, |desk, me| later(scope, rv, move || {
        desk.desktop_only(me, "acde.inspect")?;
        work(&desk)
    }))
}

fn inspect_snapshot(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let options: super::SnapshotOptions = arg(scope, &args, 0).unwrap_or_default();
    inspect_call(scope, &mut rv, move |desk| desk.inspect_snapshot(options));
}

fn inspect_run(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let steps = arg::<Vec<super::Step>>(scope, &args, 0);
    match steps {
        Some(steps) => inspect_call(scope, &mut rv, move |desk| desk.inspect_run(steps)),
        None => resolved(scope, &mut rv, Err(Failure::new(400, "bad_steps", "inspect: steps are [{ref, action, text?}]; action is click, double, right, hover, scroll, type, settext, focus, key, restore, minimize or close"))),
    }
}

fn inspect_open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    inspect_call(scope, &mut rv, move |desk| desk.inspect_open(&name));
}

fn service_post(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_caller!(scope, |desk, me| {
        let Some(bytes) = crate::host::serialize_value(scope, args.get(0)) else { return };
        desk.service_to_broker(me, bytes)
    })
}

fn on_service(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let f = handler(scope, &args);
    HANDLERS.with(|h| h.borrow_mut().service = f);
}

/// A service message for this isolate (the Broker's answer, or a callback it calls) to its `services.onMessage`.
pub fn service_in(scope: &mut v8::PinScope, bytes: &[u8]) {
    let Some(function) = HANDLERS.with(|h| h.borrow().service.clone()) else { return };
    if let Some(message) = crate::host::deserialize_bytes(scope, bytes) {
        bind::call(scope, &function, &[message]);
    }
}

// ---- the Broker's side ----

/// `sys.desk(look)`: opens the desk (once) and gives the Broker its object.
pub fn broker_object(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let look: LookChange = arg(scope, &args, 0).unwrap_or_default();
    let desk = match broker() {
        Some(desk) => desk,
        None => {
            let mut initial = super::Look::default();
            initial.apply(look);
            match Desk::open(crate::rt::current().sender(), initial) {
                Ok(desk) => {
                    BROKER.with(|b| *b.borrow_mut() = Some(desk.clone()));
                    // The desk's notices come in as tasks: the Broker's loop stays up until `quit`.
                    crate::rt::current().keep_alive(true);
                    desk
                }
                Err(e) => return bind::throw_error(scope, &format!("desk: {e}")),
            }
        }
    };
    let object = v8::Object::new(scope);
    let socket = bind::string(scope, desk.socket()).into();
    bind::set(scope, object, "socketName", socket);
    crate::methods!(scope, object,
        "onNotice" => b_on_notice,
        "onService" => b_on_service,
        "servicePost" => b_service_post,
        "caller" => b_caller,
        "look" => b_look,
        "setApps" => b_set_apps,
        "openDesktop" => b_open_desktop,
        "launch" => b_launch,
        "raise" => b_raise,
        "running" => b_running,
        "records" => b_records,
        "isPanel" => b_is_panel,
        "closeWindow" => b_close_window,
        "hide" => b_hide,
        "focus" => b_focus,
        "close" => b_close,
        "windows" => b_windows,
        "stats" => b_stats,
        "inject" => b_inject,
        "startProgram" => b_start_program,
        "children" => b_children,
        "ask" => b_ask,
        "named" => b_named,
        "isolates" => b_isolates,
        "openOffice" => b_open_office,
        "closeOffice" => b_close_office,
        "closeAll" => b_close_all,
        "closeDesktop" => b_close_desktop,
        "toDesktop" => b_to_desktop,
        "openPath" => b_open_path,
        "inspectSnapshot" => b_inspect_snapshot,
        "inspectRun" => b_inspect_run,
        "inspectOpen" => b_inspect_open,
        "warmAccessibility" => b_warm_accessibility,
        "quit" => b_quit,
    );
    rv.set(object.into());
}

/// A notice for the Broker (`exit`, `milestone`, `desktopexit`, `desktopshown`, `appstart`, `appstop`).
pub fn broker_notice(scope: &mut v8::PinScope, notice: Value) {
    let Some(function) = HANDLERS.with(|h| h.borrow().notice.clone()) else { return };
    let value = offload::json(scope, &notice);
    bind::call(scope, &function, &[value]);
}

/// A service message from the isolate of `window` to the Broker's `onService(window, message)`.
pub fn broker_service(scope: &mut v8::PinScope, window: u32, bytes: &[u8]) {
    let Some(function) = HANDLERS.with(|h| h.borrow().service.clone()) else { return };
    let Some(message) = crate::host::deserialize_bytes(scope, bytes) else { return };
    let window = v8::Integer::new_from_unsigned(scope, window).into();
    bind::call(scope, &function, &[window, message]);
}

macro_rules! with_broker {
    ($scope:ident, |$desk:ident| $body:expr) => {{
        let Some($desk) = broker() else { return bind::throw_error($scope, "desk: not open") };
        $body
    }};
}

fn b_on_notice(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let f = handler(scope, &args);
    HANDLERS.with(|h| h.borrow_mut().notice = f);
}

fn b_on_service(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let f = handler(scope, &args);
    HANDLERS.with(|h| h.borrow_mut().service = f);
}

fn b_service_post(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let window = window_arg(scope, &args, 0);
        let Some(bytes) = crate::host::serialize_value(scope, args.get(1)) else { return };
        desk.service_to_isolate(window, bytes)
    })
}

fn b_caller(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let window = window_arg(scope, &args, 0);
        rv.set(offload::json(scope, &desk.caller_info(window)))
    })
}

fn b_look(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let change: LookChange = match serde_json::from_value(json_of(scope, args.get(0))) {
            Ok(change) => change,
            Err(e) => return bind::throw_type_error(scope, &format!("desk.look: {e}")),
        };
        desk.change_look(change)
    })
}

#[derive(Deserialize)]
struct Listed {
    app: Value,
    available: bool,
}

fn b_set_apps(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let listed: Vec<Listed> = arg(scope, &args, 0).unwrap_or_default();
        let apps = listed.into_iter().filter_map(|l| App::parse(l.app).inspect_err(|e| log::warn!("desk: app manifest: {e}")).ok().map(|a| (a, l.available))).collect();
        desk.set_apps(apps)
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DesktopOptions {
    html: Option<String>,
    standalone: Option<String>,
    storage: Option<String>,
    heap_mb: f64,
}

fn b_open_desktop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let o: DesktopOptions = arg(scope, &args, 0).unwrap_or_default();
        if let Err(e) = desk.open_desktop(o.html, o.standalone, o.storage.map(Into::into), o.heap_mb) {
            bind::throw_error(scope, &format!("desktop: {e}"));
        }
    })
}

fn b_launch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let app = bind::arg_string(scope, &args, 0);
        let request = Some(json_of(scope, args.get(1))).filter(|r| !r.is_null());
        let mode: Option<String> = arg(scope, &args, 2);
        let done = mode.as_deref().map(Mode::from_str).transpose().map_err(Failure::from).and_then(|m| desk.launch(&app, request, m.unwrap_or(Mode::Free))).map(Value::from);
        give(scope, &mut rv, done)
    })
}

fn b_raise(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| desk.raise(window_arg(scope, &args, 0)))
}

fn b_running(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let app = bind::arg_string(scope, &args, 0);
        rv.set_bool(desk.running_app(&app))
    })
}

fn b_records(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| rv.set(offload::json(scope, &desk.records())))
}

fn b_is_panel(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| rv.set_bool(desk.is_panel(window_arg(scope, &args, 0))))
}

fn b_close_window(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let (window, force) = (window_arg(scope, &args, 0), bind::arg_bool(scope, &args, 1));
        later(scope, &mut rv, move || Ok(desk.close_window(window, force).into()))
    })
}

fn b_hide(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| desk.hide(window_arg(scope, &args, 0), bind::arg_bool(scope, &args, 1)))
}

fn b_focus(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| desk.link().focus(window_arg(scope, &args, 0)))
}

fn b_close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| desk.link().close(window_arg(scope, &args, 0)))
}

fn b_windows(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let rows: Vec<Value> = desk.link().list().0.into_iter().map(|w| {
            json!({ "id": w.id, "window": w.window, "canvas": w.canvas, "mode": w.mode.as_str(), "x": w.x, "y": w.y, "width": w.width, "height": w.height, "z": w.z, "focus": w.focus, "hidden": w.hidden, "pid": w.pid })
        }).collect();
        rv.set(offload::json(scope, &Value::Array(rows)))
    })
}

fn b_stats(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let reset = bind::arg_bool(scope, &args, 0);
        rv.set(offload::json(scope, &stats_json(&desk.link().stats(reset))))
    })
}

/// An input event for `Shell.inject`-style injection, as inspect sends it.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Inject {
    Move { x: f64, y: f64 },
    Motion { dx: f64, dy: f64 },
    Down { button: Option<u32> },
    Up { button: Option<u32> },
    Wheel { dx: f64, dy: f64, source: Option<WheelKind> },
    Keydown { code: u32 },
    Keyup { code: u32 },
}

impl From<Inject> for Injected {
    fn from(e: Inject) -> Self {
        match e {
            Inject::Move { x, y } => Injected::moved(x, y),
            Inject::Motion { dx, dy } => Injected::motion(dx, dy),
            Inject::Down { button } => Injected::Button { button: button.unwrap_or(BTN_LEFT), pressed: true },
            Inject::Up { button } => Injected::Button { button: button.unwrap_or(BTN_LEFT), pressed: false },
            Inject::Wheel { dx, dy, source } => Injected::wheel(dx, dy, source.unwrap_or(WheelKind::Wheel)),
            Inject::Keydown { code } => Injected::Key { code, pressed: true },
            Inject::Keyup { code } => Injected::Key { code, pressed: false },
        }
    }
}

fn b_inject(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        match serde_json::from_value::<Inject>(json_of(scope, args.get(0))) {
            Ok(event) => desk.link().inject(event.into()),
            Err(e) => bind::throw_type_error(scope, &format!("inject: {e}")),
        }
    })
}

fn b_start_program(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let argv: Vec<String> = arg(scope, &args, 0).unwrap_or_default();
        let options: LaunchOptions = arg(scope, &args, 1).unwrap_or_default();
        let env: Vec<(String, String)> = options.env.into_iter().collect();
        let done = desk.launch_session(&argv, options.cwd.as_deref(), &env).map(Value::from).map_err(Failure::from);
        give(scope, &mut rv, done)
    })
}

fn b_children(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| rv.set(offload::json(scope, &desk.children().into())))
}

/// `ask(window, 'inspect' | 'debug.eval' | 'debug.stats', payload)`: a promise of that isolate's answer.
fn b_ask(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let window = window_arg(scope, &args, 0);
        let kind = bind::arg_string(scope, &args, 1);
        let ask = match kind.as_str() {
            "inspect" => Ask::Inspect,
            "debug.eval" => Ask::DebugEval,
            "debug.stats" => Ask::DebugStats,
            _ => return bind::throw_type_error(scope, &format!("desk.ask: no {kind}")),
        };
        let payload = json_of(scope, args.get(2));
        let answer = desk.ask(window, ask, payload);
        later(scope, &mut rv, move || answer.recv_timeout(std::time::Duration::from_secs(10)).map_err(|_| Failure::from(format!("window {window} did not answer"))))
    })
}

fn b_named(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let name = bind::arg_string(scope, &args, 0);
        match desk.named(&name) {
            Some(window) => rv.set_uint32(window),
            None => rv.set_null(),
        }
    })
}

fn b_isolates(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let rows: Vec<Value> = desk.isolates().into_iter().map(|(window, name, cpu, external)| json!({ "window": window, "name": name, "cpuMs": cpu, "externalMb": external })).collect();
        rv.set(offload::json(scope, &Value::Array(rows)))
    })
}

fn b_open_office(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| match desk.open_office() {
        Ok(()) => rv.set_null(),
        Err(message) => rv.set(bind::string(scope, &message).into()),
    })
}

fn b_close_office(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| desk.close_office())
}

fn b_close_all(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| later(scope, &mut rv, move || {
        desk.close_all();
        Ok(Value::Null)
    }))
}

fn b_quit(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        desk.quit();
        crate::rt::current().keep_alive(false);
    })
}

fn b_to_desktop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let event = json_of(scope, args.get(0));
        desk.tell_desktop(event)
    })
}

fn b_close_desktop(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| later(scope, &mut rv, move || {
        desk.close_desktop();
        Ok(Value::Null)
    }))
}

/// The Broker's `openPath` (D-Bus `FileManager1`, `acde open`): no caller to check.
fn b_open_path(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let target = bind::arg_string(scope, &args, 0);
        let options: super::OpenOptions = arg(scope, &args, 1).unwrap_or_default();
        later(scope, &mut rv, move || desk.open_path(None, &target, options))
    })
}

/// The same inspector for the desktop package's services (`ServiceContext.inspect`), from the Broker.
fn b_inspect_snapshot(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let options: super::SnapshotOptions = arg(scope, &args, 0).unwrap_or_default();
        later(scope, &mut rv, move || desk.inspect_snapshot(options))
    })
}

fn b_inspect_run(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| match arg::<Vec<super::Step>>(scope, &args, 0) {
        Some(steps) => later(scope, &mut rv, move || desk.inspect_run(steps)),
        None => resolved(scope, &mut rv, Err(Failure::new(400, "bad_steps", "inspect: steps are [{ref, action, text?}]"))),
    })
}

fn b_inspect_open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    with_broker!(scope, |desk| {
        let name = bind::arg_string(scope, &args, 0);
        later(scope, &mut rv, move || desk.inspect_open(&name))
    })
}

fn b_warm_accessibility(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_broker!(scope, |desk| desk.warm_accessibility())
}
