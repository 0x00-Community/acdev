use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::surface::{DragImage, Event, Surface};

use crate::bind;
use crate::rt::{self, Msg};

#[derive(Default)]
struct State {
    surface: Option<Surface>,
    waiting: Option<v8::Global<v8::PromiseResolver>>,
    armed: Arc<AtomicBool>,
    #[cfg(target_os = "linux")]
    imes: HashMap<u32, (acde_runtime::Ime, v8::Global<v8::Function>)>,
    #[cfg(target_os = "linux")]
    next: u32,
}

#[cfg(target_os = "linux")]
impl State {
    fn id(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1);
        self.next
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>) {
    crate::methods!(scope, natives,
        "claimSurface" => claim_surface,
    );
    #[cfg(target_os = "linux")]
    crate::methods!(scope, natives,
        "Ime" => ime_new,
    );
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn claim_surface(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Ok(token) = v8::Local::<v8::BigInt>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "claimSurface: the token is a bigint");
    };
    let (token, lossless) = token.u64_value();
    if !lossless {
        return bind::throw_type_error(scope, "claimSurface: not a token");
    }
    let Some(render) = crate::dom::render_handle() else {
        return bind::throw_error(scope, "claimSurface: this web has no document yet");
    };
    let frame = v8::Local::<v8::Object>::try_from(args.get(1))
        .ok()
        .and_then(|options| bind::get(scope, options, "frame"))
        .and_then(|value| value.number_value(scope))
        .filter(|height| height.is_finite() && *height >= 1.0)
        .map_or(0, |height| height.round().min(f64::from(u16::MAX)) as u32);
    let surface = match Surface::claim(token, render, frame) {
        Ok(surface) => surface,
        Err(e) => return bind::throw_error(scope, &e),
    };
    let tx = rt::current().sender();
    let armed = STATE.with(|s| s.borrow().armed.clone());
    surface.set_waker(Some(Arc::new(move || {
        if armed.swap(false, Ordering::SeqCst) {
            _ = tx.send(Msg::Task(Box::new(wake)));
        }
    })));
    let window = surface.window();
    let hosted = surface.hosted();
    let (offset_x, offset_y) = surface.content_offset();
    STATE.with(|s| s.borrow_mut().surface = Some(surface));
    let obj = v8::Object::new(scope);
    let window = v8::Integer::new_from_unsigned(scope, window);
    bind::set(scope, obj, "window", window.into());
    let hosted = v8::Boolean::new(scope, hosted);
    bind::set(scope, obj, "hosted", hosted.into());
    let offset = [offset_x, offset_y].map(|v| v8::Number::new(scope, v).into());
    let offset = v8::Array::new_with_elements(scope, &offset);
    bind::set(scope, obj, "contentOffset", offset.into());
    crate::methods!(scope, obj,
        "pump" => pump,
        "wait" => wait,
        "requestFrame" => request_frame,
        "requestMode" => request_mode,
        "setGrabHint" => set_grab_hint,
        "setBackdrop" => set_backdrop,
        "requestActivate" => request_activate,
        "requestGrab" => request_grab,
        "releaseGrab" => release_grab,
        "openPanel" => open_panel,
        "placePanel" => place_panel,
        "closePanel" => close_panel,
        "setClipboard" => set_clipboard,
        "readClipboard" => read_clipboard,
        "startDrag" => start_drag,
        "setTitle" => set_title,
        "setImeArea" => set_ime_area,
    );
    rv.set(obj.into());
}

fn with_surface<R>(scope: &mut v8::PinScope, f: impl FnOnce(&Surface) -> R) -> Option<R> {
    let result = STATE.with(|s| s.borrow().surface.as_ref().map(f));
    if result.is_none() {
        bind::throw_error(scope, "surface: released");
    }
    result
}

fn pump(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(events) = with_surface(scope, Surface::pump) else { return };
    traced(&events);
    let list = v8::Array::new(scope, events.len() as i32);
    for (i, event) in events.into_iter().enumerate() {
        let event = event_object(scope, event);
        list.set_index(scope, i as u32, event.into());
    }
    rv.set(list.into());
}

fn traced(events: &[Event]) {
    if !log::log_enabled!(target: "perf::latency", log::Level::Debug) {
        return;
    }
    let pumped = acde_log::now_ms();
    let trace = events
        .iter()
        .filter_map(|e| {
            let kind = match e.kind.as_str() {
                "pointerdown" => "pointerdown",
                "pointerup" => "pointerup",
                "keydown" => "keydown",
                "wheel" => "wheel",
                _ => return None,
            };
            Some(acde_log::Trace { pumped, ..acde_log::Trace::input(kind, e.stamp?) })
        })
        .fold(None, |a, b| acde_log::Trace::earliest(a, Some(b)));
    if let Some(trace) = trace {
        crate::dom::with_dom(|dom| dom.input(trace));
    }
}

pub(crate) fn event_object<'s>(scope: &mut v8::PinScope<'s, '_>, event: Event) -> v8::Local<'s, v8::Object> {
    let mut fields: Vec<(&str, v8::Local<v8::Value>)> = vec![("type", bind::string(scope, &event.kind).into())];
    let numbers = [
        ("window", event.window.map(f64::from)),
        ("x", event.x),
        ("y", event.y),
        ("button", event.button.map(f64::from)),
        ("deltaX", event.delta_x),
        ("deltaY", event.delta_y),
        ("code", event.code.map(f64::from)),
        ("width", event.width),
        ("height", event.height),
        ("time", event.time),
        ("scale", event.scale),
        ("parent", event.parent.map(f64::from)),
    ];
    for (name, value) in numbers {
        if let Some(value) = value {
            fields.push((name, v8::Number::new(scope, value).into()));
        }
    }
    for (name, value) in [("key", &event.key), ("title", &event.title), ("appId", &event.app_id)] {
        if let Some(value) = value {
            fields.push((name, bind::string(scope, value).into()));
        }
    }
    if let Some(mime) = &event.mime {
        let kinds: Vec<v8::Local<v8::Value>> = mime.iter().map(|kind| bind::string(scope, kind).into()).collect();
        fields.push(("mime", v8::Array::new_with_elements(scope, &kinds).into()));
    }
    if let Some(data) = &event.data {
        let texts: Vec<(&str, v8::Local<v8::Value>)> = data.iter().map(|(kind, text)| (kind.as_str(), bind::string(scope, text).into())).collect();
        fields.push(("data", bind::object(scope, &texts).into()));
    }
    bind::object(scope, &fields)
}

fn wait(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else { return };
    let promise = resolver.get_promise(scope);
    let global = v8::Global::new(scope, resolver);
    let (ready, replaced) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.armed.store(true, Ordering::SeqCst);
        let ready = s.surface.as_ref().is_none_or(Surface::has_events);
        if ready {
            s.armed.store(false, Ordering::SeqCst);
            return (true, None);
        }
        (false, s.waiting.replace(global))
    });
    let undefined = v8::undefined(scope);
    if let Some(replaced) = replaced {
        v8::Local::new(scope, replaced).resolve(scope, undefined.into());
    }
    if ready {
        resolver.resolve(scope, undefined.into());
    }
    rv.set(promise.into());
}

fn wake(scope: &mut v8::PinScope) {
    if let Some(waiting) = STATE.with(|s| s.borrow_mut().waiting.take()) {
        let undefined = v8::undefined(scope);
        v8::Local::new(scope, waiting).resolve(scope, undefined.into());
    }
}

fn request_frame(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_surface(scope, Surface::request_frame);
}

fn request_mode(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mode = match bind::arg_string(scope, &args, 0).as_str() {
        "fullscreen" => 0,
        "free" => 1,
        "fixed" => 2,
        "pinned" => 3,
        other => return bind::throw_type_error(scope, &format!("requestMode: no mode {other}")),
    };
    with_surface(scope, |surface| surface.request_mode(mode));
}

fn rect(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> [i32; 4] {
    [0, 1, 2, 3].map(|i| bind::arg_f64(scope, args, i).round() as i32)
}

fn set_grab_hint(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let rect = rect(scope, &args);
    let edges = bind::arg_f64(scope, &args, 4) as u32;
    with_surface(scope, |surface| surface.set_grab_hint(rect, edges));
}

fn set_backdrop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let rect = rect(scope, &args);
    let effect = [4, 5, 6, 7].map(|i| bind::arg_f64(scope, &args, i));
    with_surface(scope, |surface| surface.set_backdrop(rect, effect));
}

fn open_panel(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_f64(scope, &args, 0) as u32;
    let Ok(token) = v8::Local::<v8::BigInt>::try_from(args.get(1)) else {
        return bind::throw_type_error(scope, "openPanel: the token is a bigint");
    };
    let (token, _) = token.u64_value();
    let rect = [2, 3, 4, 5].map(|i| bind::arg_f64(scope, &args, i).round() as i32);
    with_surface(scope, |surface| surface.open_panel(id, token, rect));
}

fn place_panel(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_f64(scope, &args, 0) as u32;
    let rect = [1, 2, 3, 4].map(|i| bind::arg_f64(scope, &args, i).round() as i32);
    let input = [5, 6, 7, 8].map(|i| bind::arg_f64(scope, &args, i).round() as i32);
    with_surface(scope, |surface| surface.place_panel(id, rect, input));
}

fn close_panel(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_f64(scope, &args, 0) as u32;
    with_surface(scope, |surface| surface.close_panel(id));
}

fn request_activate(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    with_surface(scope, Surface::request_activate);
}

fn grab_kind(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments) -> Option<u32> {
    match bind::arg_string(scope, args, 0).as_str() {
        "pointer" => Some(1),
        "keyboard" => Some(2),
        other => {
            bind::throw_type_error(scope, &format!("grab: no kind {other}"));
            None
        }
    }
}

fn request_grab(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(kind) = grab_kind(scope, &args) else { return };
    with_surface(scope, |surface| surface.request_grab(kind, true));
}

fn release_grab(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(kind) = grab_kind(scope, &args) else { return };
    with_surface(scope, |surface| surface.request_grab(kind, false));
}

fn set_title(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let title = bind::arg_string(scope, &args, 0);
    with_surface(scope, |surface| surface.set_title(&title));
}

fn set_ime_area(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let rect = [0, 1, 2, 3].map(|i| bind::arg_f64(scope, &args, i));
    with_surface(scope, |surface| surface.set_ime_area(rect));
}

fn set_clipboard(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let text = bind::arg_string(scope, &args, 0);
    with_surface(scope, |surface| surface.set_clipboard(text));
}

fn read_clipboard(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some((token, promise)) = bind::promise(scope) else { return };
    let tx = rt::current().sender();
    let reply = move |text: String| _ = tx.send(Msg::Task(Box::new(move |scope| clipboard_read(scope, token, &text))));
    if with_surface(scope, |surface| surface.read_clipboard(Box::new(reply))).is_none() {
        return bind::forget_promise(token);
    }
    rt::current().delay(Duration::from_secs(2), move |scope| clipboard_read(scope, token, ""));
    rv.set(promise.into());
}

fn clipboard_read(scope: &mut v8::PinScope, token: u32, text: &str) {
    if let Some(resolver) = bind::resolver(scope, token) {
        let text = bind::string(scope, text);
        resolver.resolve(scope, text.into());
    }
}

fn start_drag<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, _: v8::ReturnValue) {
    let data: HashMap<String, String> = bind::own_string_pairs(scope, args.get(0)).into_iter().collect();
    let icon = v8::Local::<v8::Object>::try_from(args.get(1)).ok().and_then(|icon| {
        let mut number = |name: &str| bind::get(scope, icon, name).and_then(|v| v.number_value(scope)).filter(|n| n.is_finite());
        let (width, height) = (number("width")? as u32, number("height")? as u32);
        let hotspot = (number("hotX").unwrap_or(0.0) as i32, number("hotY").unwrap_or(0.0) as i32);
        let picture = number("picture").and_then(|id| crate::dom::take_picture(id as u32));
        let scene = match picture {
            Some(scene) => scene,
            None => acde_render::Capture::bitmap(width, height, bind::get(scope, icon, "rgba").and_then(bind::bytes).filter(|b| b.len() == (width * height * 4) as usize)?),
        };
        Some(DragImage { width, height, scene, hotspot })
    });
    with_surface(scope, |surface| surface.start_drag(data, icon));
}

#[cfg(target_os = "linux")]
fn ime_new(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "Ime: the callback is not a function");
    };
    let id = STATE.with(|s| s.borrow_mut().id());
    let tx = rt::current().sender();
    let opened = acde_runtime::Ime::open(move |event| {
        let json = event.to_string();
        _ = tx.send(Msg::Task(Box::new(move |scope| ime_event(scope, id, &json))));
    });
    let ime = match opened {
        Ok(ime) => ime,
        Err(e) => return bind::throw_error(scope, &e),
    };
    let backend = ime.backend();
    let callback = v8::Global::new(scope, callback);
    STATE.with(|s| s.borrow_mut().imes.insert(id, (ime, callback)));
    let obj = v8::Object::new(scope);
    let backend = bind::string(scope, &backend);
    bind::set(scope, obj, "backend", backend.into());
    let data: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, id).into();
    ime_methods(scope, obj, data);
    rv.set(obj.into());
}

#[cfg(target_os = "linux")]
fn ime_event(scope: &mut v8::PinScope, id: u32, json: &str) {
    let Some(callback) = STATE.with(|s| s.borrow().imes.get(&id).map(|(_, f)| f.clone())) else { return };
    let json = bind::string(scope, json);
    let Some(event) = v8::json::parse(scope, json) else { return };
    bind::call(scope, callback, &[event]);
}

#[cfg(target_os = "linux")]
type ImeResult = Result<Option<bool>, String>;

#[cfg(target_os = "linux")]
macro_rules! done {
    ($result:expr) => {
        $result.map(|()| None)
    };
}

#[cfg(target_os = "linux")]
fn ime_methods(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, data: v8::Local<v8::Value>) {
    crate::methods!(scope, obj, data = data;
        "focusIn" => ime_focus_in,
        "focusOut" => ime_focus_out,
        "reset" => ime_reset,
        "setCursorRect" => ime_set_cursor_rect,
        "setSurroundingText" => ime_set_surrounding_text,
        "setCapability" => ime_set_capability,
        "processKey" => ime_process_key,
        "selectCandidate" => ime_select_candidate,
        "prevPage" => ime_prev_page,
        "nextPage" => ime_next_page,
        "close" => ime_close,
    );
}

#[cfg(target_os = "linux")]
fn ime_focus_in(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |_, _, ime| done!(ime.focus_in()));
}

#[cfg(target_os = "linux")]
fn ime_focus_out(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |_, _, ime| done!(ime.focus_out()));
}

#[cfg(target_os = "linux")]
fn ime_reset(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |_, _, ime| done!(ime.reset()));
}

#[cfg(target_os = "linux")]
fn ime_set_cursor_rect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |s, a, ime| {
        let (x, y) = (bind::arg_f64(s, a, 0) as i32, bind::arg_f64(s, a, 1) as i32);
        let (w, h) = (bind::arg_f64(s, a, 2) as i32, bind::arg_f64(s, a, 3) as i32);
        done!(ime.set_cursor_rect(x, y, w, h))
    });
}

#[cfg(target_os = "linux")]
fn ime_set_surrounding_text(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |s, a, ime| {
        let text = bind::arg_string(s, a, 0);
        let (cursor, anchor) = (bind::arg_f64(s, a, 1) as u32, bind::arg_f64(s, a, 2) as u32);
        done!(ime.set_surrounding_text(text, cursor, anchor))
    });
}

#[cfg(target_os = "linux")]
fn ime_set_capability(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |s, a, ime| {
        let obj = v8::Local::<v8::Object>::try_from(a.get(0)).ok();
        let mut flag = |name: &str| obj.and_then(|o| bind::get(s, o, name)).filter(|v| !v.is_undefined()).map(|v| v.boolean_value(s));
        let capability = acde_runtime::ImeCapability {
            preedit: flag("preedit"),
            surrounding_text: flag("surroundingText"),
            password: flag("password"),
            client_panel: flag("clientPanel"),
        };
        done!(ime.set_capability(capability))
    });
}

#[cfg(target_os = "linux")]
fn ime_process_key(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |s, a, ime| {
        let (keysym, keycode, state) = (bind::arg_f64(s, a, 0) as u32, bind::arg_f64(s, a, 1) as u32, bind::arg_f64(s, a, 2) as u32);
        let release = bind::arg_bool(s, a, 3);
        ime.process_key(keysym, keycode, state, release).map(Some)
    });
}

#[cfg(target_os = "linux")]
fn ime_select_candidate(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |s, a, ime| done!(ime.select_candidate(bind::arg_f64(s, a, 0) as i32)));
}

#[cfg(target_os = "linux")]
fn ime_prev_page(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |_, _, ime| done!(ime.prev_page()));
}

#[cfg(target_os = "linux")]
fn ime_next_page(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, rv: v8::ReturnValue) {
    ime_call(scope, &args, rv, |_, _, ime| done!(ime.next_page()));
}

#[cfg(target_os = "linux")]
fn ime_call(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
    f: impl FnOnce(&mut v8::PinScope, &v8::FunctionCallbackArguments, &acde_runtime::Ime) -> ImeResult,
) {
    let id = args.data().uint32_value(scope).unwrap_or(0);
    let result = STATE.with(|s| s.borrow().imes.get(&id).map(|(ime, _)| f(scope, args, ime)));
    match result {
        None => bind::throw_error(scope, "Ime: closed"),
        Some(Err(e)) => bind::throw_error(scope, &e),
        Some(Ok(Some(value))) => rv.set_bool(value),
        Some(Ok(None)) => {}
    }
}

#[cfg(target_os = "linux")]
fn ime_close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = args.data().uint32_value(scope).unwrap_or(0);
    let Some((ime, callback)) = STATE.with(|s| s.borrow_mut().imes.remove(&id)) else { return };
    let closed: ImeResult = done!(ime.close());
    drop((ime, callback));
    if let Err(e) = closed {
        bind::throw_error(scope, &e);
    }
}
