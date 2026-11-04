use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use acde_runtime::{Deliver, UnixClient, UnixEvent as Event};

use crate::bind;
use crate::rt::{self, Msg};

struct Open {
    connection: u32,
    on_event: v8::Global<v8::Function>,
    websocket: bool,
}

#[derive(Default)]
struct State {
    sockets: PathBuf,
    client: Option<UnixClient>,
    open: HashMap<u32, Open>,
    next: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn install<'s>(scope: &mut v8::PinScope<'s, '_>, natives: v8::Local<'s, v8::Object>, init: v8::Local<'s, v8::Value>) {
    let Ok(init) = v8::Local::<v8::Object>::try_from(init) else { return };
    let Some(sockets) = bind::get(scope, init, "sockets").filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope)) else { return };
    if !Path::new(&sockets).is_absolute() {
        return;
    }
    STATE.with(|s| s.borrow_mut().sockets = PathBuf::from(sockets));
    let backend = v8::Object::new(scope);
    crate::methods!(scope, backend,
        "request" => request,
        "abort" => abort,
        "websocket" => websocket,
        "send" => send,
        "close" => close,
    );
    bind::set(scope, natives, "backend", backend.into());
}

pub fn clear() {
    let state = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    drop(state);
}

fn socket(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> Option<String> {
    let port = bind::arg_f64(scope, args, i);
    if !(0.0..=65535.0).contains(&port) || port.fract() != 0.0 {
        bind::throw_range_error(scope, "acde.backend: a port is 0 to 65535");
        return None;
    }
    let sockets = STATE.with(|s| s.borrow().sockets.clone());
    Some(sockets.join(format!("{port}.sock")).to_string_lossy().into_owned())
}

fn headers(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<Vec<String>>> {
    let list = v8::Local::<v8::Array>::try_from(value).ok()?;
    (0..list.length()).map(|i| list.get_index(scope, i).and_then(|pair| bind::strings(scope, pair))).collect()
}

fn open(
    scope: &mut v8::PinScope,
    on_event: v8::Local<v8::Value>,
    websocket: bool,
    rv: &mut v8::ReturnValue,
    start: impl FnOnce(&UnixClient, Deliver) -> Result<u32, String>,
) {
    let Ok(on_event) = v8::Local::<v8::Function>::try_from(on_event) else {
        return bind::throw_type_error(scope, "acde.backend: onEvent is not a function");
    };
    let id = STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.next = s.next.wrapping_add(1).max(1);
        s.next
    });
    let tx = rt::current().sender();
    let deliver: Deliver = Arc::new(move |event, taken| {
        tx.send(Msg::Task(Box::new(move |scope| {
            dispatch(scope, id, event);
            _ = taken.send(());
        })))
        .is_ok()
    });
    let started = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let client = s.client.get_or_insert_with(UnixClient::new);
        start(client, deliver)
    });
    match started {
        Ok(connection) => {
            let on_event = v8::Global::new(scope, on_event);
            STATE.with(|s| s.borrow_mut().open.insert(id, Open { connection, on_event, websocket }));
            rv.set_uint32(id);
        }
        Err(message) => bind::throw_type_error(scope, &format!("acde.backend: {message}")),
    }
}

fn request(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(socket) = socket(scope, &args, 0) else { return };
    let method = bind::arg_string(scope, &args, 1);
    let path = bind::arg_string(scope, &args, 2);
    let Some(headers) = headers(scope, args.get(3)) else {
        return bind::throw_type_error(scope, "acde.backend: headers are [name, value] pairs");
    };
    let body = args.get(4);
    let body = if body.is_null_or_undefined() {
        None
    } else {
        match bind::bytes(body) {
            Some(bytes) => Some(bytes),
            None => return bind::throw_type_error(scope, "acde.backend: the body is a Uint8Array or null"),
        }
    };
    open(scope, args.get(5), false, &mut rv, |client, deliver| client.request(socket, method, path, headers, body, deliver));
}

fn websocket(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(socket) = socket(scope, &args, 0) else { return };
    let path = bind::arg_string(scope, &args, 1);
    let Some(headers) = headers(scope, args.get(2)) else {
        return bind::throw_type_error(scope, "acde.backend: headers are [name, value] pairs");
    };
    let Some(protocols) = bind::strings(scope, args.get(3)) else {
        return bind::throw_type_error(scope, "acde.backend: protocols are strings");
    };
    open(scope, args.get(4), true, &mut rv, |client, deliver| client.websocket(socket, path, headers, protocols, deliver));
}

fn connection(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, websocket: bool) -> Option<u32> {
    let id = bind::arg_f64(scope, args, 0) as u32;
    STATE.with(|s| s.borrow().open.get(&id).filter(|o| !websocket || o.websocket).map(|o| o.connection))
}

fn abort(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_f64(scope, &args, 0) as u32;
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if let (Some(open), Some(client)) = (s.open.remove(&id), s.client.as_ref()) {
            client.abort(open.connection);
        }
    });
}

fn send(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(connection) = connection(scope, &args, true) else { return };
    let data = match bind::bytes(args.get(1)) {
        Some(bytes) => Err(bytes),
        None => Ok(bind::arg_string(scope, &args, 1)),
    };
    STATE.with(|s| {
        let s = s.borrow();
        let Some(client) = s.client.as_ref() else { return };
        match data {
            Ok(text) => client.send_text(connection, text),
            Err(bytes) => client.send_binary(connection, bytes),
        }
    });
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Some(connection) = connection(scope, &args, true) else { return };
    let code = args.get(1);
    let code = if code.is_null_or_undefined() { None } else { Some(bind::arg_f64(scope, &args, 1)) };
    let code = match code {
        None => None,
        Some(code) if (0.0..=u32::MAX as f64).contains(&code) && code.fract() == 0.0 => Some(code as u32),
        Some(code) => return bind::throw_range_error(scope, &format!("close code {code} may not be sent")),
    };
    let reason = args.get(2);
    let reason = if reason.is_null_or_undefined() { None } else { Some(bind::arg_string(scope, &args, 2)) };
    let closed = STATE.with(|s| s.borrow().client.as_ref().map(|client| client.close(connection, code, reason)));
    if let Some(Err(message)) = closed {
        bind::throw_range_error(scope, &format!("acde.backend: {message}"));
    }
}

fn dispatch(scope: &mut v8::PinScope, id: u32, event: Event) {
    let (ends_request, ends_websocket) = (matches!(event, Event::End | Event::Error(_)), matches!(event, Event::Close { .. }));
    let callback = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let open = s.open.get(&id)?;
        let callback = open.on_event.clone();
        let last = if open.websocket { ends_websocket } else { ends_request };
        if last {
            s.open.remove(&id);
        }
        Some(callback)
    });
    let Some(callback) = callback else { return };
    let kind = match &event {
        Event::Head { .. } => "head",
        Event::Chunk(_) => "chunk",
        Event::End => "end",
        Event::Open { .. } => "open",
        Event::Text(_) | Event::Binary(_) => "message",
        Event::Close { .. } => "close",
        Event::Error(_) => "error",
    };
    let mut fields: Vec<(&str, v8::Local<v8::Value>)> = vec![("type", bind::string(scope, kind).into())];
    match event {
        Event::Head { status, status_text, headers } => {
            let pairs: Vec<v8::Local<v8::Value>> = headers
                .iter()
                .map(|(name, value)| {
                    let pair = [bind::string(scope, name).into(), bind::string(scope, value).into()];
                    v8::Array::new_with_elements(scope, &pair).into()
                })
                .collect();
            fields.push(("status", v8::Integer::new(scope, status.into()).into()));
            fields.push(("statusText", bind::string(scope, &status_text).into()));
            fields.push(("headers", v8::Array::new_with_elements(scope, &pairs).into()));
        }
        Event::Chunk(data) | Event::Binary(data) => fields.push(("data", bind::uint8_array(scope, data).into())),
        Event::Text(text) => fields.push(("text", bind::string(scope, &text).into())),
        Event::Open { protocol, extensions } => {
            fields.push(("protocol", bind::string(scope, &protocol).into()));
            fields.push(("extensions", bind::string(scope, &extensions).into()));
        }
        Event::Close { code, reason, clean } => {
            fields.push(("code", v8::Integer::new(scope, code.into()).into()));
            fields.push(("reason", bind::string(scope, &reason).into()));
            fields.push(("wasClean", v8::Boolean::new(scope, clean).into()));
        }
        Event::Error(message) => fields.push(("message", bind::string(scope, &message).into())),
        Event::End => {}
    }
    let obj = bind::object(scope, &fields);
    bind::call(scope, callback, &[obj.into()]);
}
