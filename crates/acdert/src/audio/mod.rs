mod decode;
mod graph;
mod mixer;
mod output;
#[cfg(not(target_os = "linux"))]
mod output_cpal;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::bind;
use crate::rt::{self, Msg};
use graph::{AudioData, Kind, ParamOp, Shared, Wave};
use mixer::{Clock, Cmd, MediaOp, Note, RATE};
use output::Ctl;

#[derive(Default)]
struct State {
    web: u64,
    callback: Option<v8::Global<v8::Function>>,
    clocks: HashMap<u32, Arc<Clock>>,
    nodes: HashMap<u32, Arc<Shared>>,
    buffers: HashMap<u32, Arc<AudioData>>,
    media: HashMap<u32, Arc<AtomicU64>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn web() -> Option<u64> {
    let web = with_state(|s| s.web);
    if web != 0 {
        return Some(web);
    }
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let web = NEXT.fetch_add(1, Ordering::Relaxed);
    let name = rt::web_name();
    if !output::send(Ctl::Open { web, name, notify: rt::current().sender() }) {
        return None;
    }
    with_state(|s| s.web = web);
    Some(web)
}

fn send(cmd: Cmd) {
    let web = with_state(|s| s.web);
    if web != 0 {
        output::send(Ctl::Cmd(web, cmd));
    }
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>) {
    let audio = v8::Object::new(scope);
    let rate = v8::Number::new(scope, RATE);
    bind::set(scope, audio, "sampleRate", rate.into());
    crate::methods!(scope, audio,
        "onEvent" => on_event,
        "createContext" => create_context,
        "setRunning" => set_running,
        "closeContext" => close_context,
        "time" => time,
        "createNode" => create_node,
        "connect" => connect,
        "disconnect" => disconnect,
        "automate" => automate,
        "automateCurve" => automate_curve,
        "paramValue" => param_value,
        "setWave" => set_wave,
        "setLoop" => set_loop,
        "setBuffer" => set_buffer,
        "start" => start,
        "stop" => stop,
        "release" => release,
        "decode" => decode,
        "createBuffer" => create_buffer,
        "channelData" => channel_data,
        "releaseBuffer" => release_buffer,
        "openMedia" => open_media,
        "media" => media,
        "mediaTime" => media_time,
        "closeMedia" => close_media,
    );
    bind::set(scope, natives, "audio", audio.into());
}

pub fn clear() {
    let state = with_state(std::mem::take);
    if state.web != 0 {
        output::send(Ctl::Close(state.web));
    }
    drop(state);
}

fn deliver(scope: &mut v8::PinScope, notes: Vec<Note>) {
    let Some(callback) = with_state(|s| s.callback.clone()) else { return };
    let callback = v8::Local::new(scope, callback);
    for note in notes {
        let (kind, id) = match note {
            Note::Ended(id) => (0, id),
            Note::MediaEnded(id) => (1, id),
        };
        let kind = v8::Integer::new(scope, kind).into();
        let id = v8::Integer::new_from_unsigned(scope, id).into();
        bind::call(scope, callback, &[kind, id]);
    }
}

fn int(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> i32 {
    let n = bind::arg_f64(scope, args, i);
    if n.is_finite() { n as i32 } else { -1 }
}

fn floats(value: v8::Local<v8::Value>) -> Option<Vec<f32>> {
    bind::with_bytes(value, |bytes| bytes.as_chunks::<4>().0.iter().map(|b| f32::from_ne_bytes(*b)).collect())
}

fn on_event(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "audio.onEvent: not a function");
    };
    let callback = v8::Global::new(scope, callback);
    with_state(|s| s.callback = Some(callback));
}

fn create_context(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (ctx, dest) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    if web().is_none() {
        return bind::throw_error(scope, "NotSupportedError: no audio output");
    }
    let clock = Arc::new(Clock::new());
    with_state(|s| s.clocks.insert(ctx, clock.clone()));
    send(Cmd::CreateContext { ctx, dest, clock });
}

fn set_running(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let ctx = bind::arg_u32(scope, &args, 0);
    let running = bind::arg_bool(scope, &args, 1);
    send(Cmd::Running { ctx, running });
}

fn close_context(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let ctx = bind::arg_u32(scope, &args, 0);
    with_state(|s| s.clocks.remove(&ctx));
    send(Cmd::CloseContext { ctx });
}

fn time(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ctx = bind::arg_u32(scope, &args, 0);
    let seconds = with_state(|s| s.clocks.get(&ctx).map_or(0.0, |c| c.seconds()));
    rv.set_double(seconds);
}

fn create_node(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (ctx, node) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let Some(kind) = Kind::from_code(bind::arg_u32(scope, &args, 2)) else {
        return bind::throw_type_error(scope, "audio.createNode: unknown kind");
    };
    let shared = Arc::new(Shared::default());
    with_state(|s| s.nodes.insert(node, shared.clone()));
    send(Cmd::CreateNode { ctx, node, kind, shared });
}

fn connect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (from, to, param) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1), int(scope, &args, 2));
    send(Cmd::Connect { from, to, param });
}

fn disconnect(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let from = bind::arg_u32(scope, &args, 0);
    let to = int(scope, &args, 1) as i64;
    let param = int(scope, &args, 2);
    send(Cmd::Disconnect { from, to, param });
}

fn automate(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (node, param, code) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1) as usize, bind::arg_u32(scope, &args, 2));
    let value = bind::arg_f64(scope, &args, 3) as f32;
    let at = bind::arg_f64(scope, &args, 4);
    let extra = bind::arg_f64(scope, &args, 5);
    let op = match code {
        0 => ParamOp::Value(value),
        1 => ParamOp::SetAt(value, at),
        2 => ParamOp::Linear(value, at),
        3 => ParamOp::Exponential(value, at),
        4 => ParamOp::Target(value, at, extra),
        5 => ParamOp::Cancel(at),
        6 => ParamOp::CancelAndHold(at),
        _ => return bind::throw_type_error(scope, "audio.automate: unknown op"),
    };
    send(Cmd::Param { node, param, op });
}

fn automate_curve(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (node, param) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1) as usize);
    let Some(values) = floats(args.get(2)) else {
        return bind::throw_type_error(scope, "audio.automateCurve: values must be a Float32Array");
    };
    let (at, duration) = (bind::arg_f64(scope, &args, 3), bind::arg_f64(scope, &args, 4));
    send(Cmd::Param { node, param, op: ParamOp::Curve(values.into(), at, duration) });
}

fn param_value(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (node, param) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1) as usize);
    let value = with_state(|s| s.nodes.get(&node).map_or(0.0, |n| n.param(param)));
    rv.set_double(f64::from(value));
}

fn set_wave(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (node, wave) = (bind::arg_u32(scope, &args, 0), Wave::from_code(bind::arg_u32(scope, &args, 1)));
    send(Cmd::Wave { node, wave });
}

fn set_loop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let node = bind::arg_u32(scope, &args, 0);
    let looping = bind::arg_bool(scope, &args, 1);
    let (start, end) = (bind::arg_f64(scope, &args, 2), bind::arg_f64(scope, &args, 3));
    send(Cmd::Loop { node, looping, start: if start.is_finite() { start } else { 0.0 }, end: if end.is_finite() { end } else { 0.0 } });
}

fn set_buffer(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (node, buffer) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let data = with_state(|s| s.buffers.get(&buffer).cloned());
    send(Cmd::Buffer { node, data });
}

fn start(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let node = bind::arg_u32(scope, &args, 0);
    let (when, offset, duration) = (bind::arg_f64(scope, &args, 1), bind::arg_f64(scope, &args, 2), bind::arg_f64(scope, &args, 3));
    let offset = if offset.is_finite() { offset } else { 0.0 };
    send(Cmd::Start { node, when, offset, duration: (duration >= 0.0).then_some(duration) });
}

fn stop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let node = bind::arg_u32(scope, &args, 0);
    let when = bind::arg_f64(scope, &args, 1);
    send(Cmd::Stop { node, when });
}

fn release(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let node = bind::arg_u32(scope, &args, 0);
    with_state(|s| s.nodes.remove(&node));
    send(Cmd::Release { node });
}

type Fields = [(&'static str, f64); 3];

fn settle(scope: &mut v8::PinScope, token: u32, result: Result<Fields, String>) {
    let Some(resolver) = bind::resolver(scope, token) else { return };
    match result {
        Ok(fields) => {
            let fields: [(&str, v8::Local<v8::Value>); 3] = fields.map(|(name, value)| (name, v8::Number::new(scope, value).into()));
            let obj = bind::object(scope, &fields);
            resolver.resolve(scope, obj.into());
        }
        Err(message) => {
            let message = bind::string(scope, &message);
            let error = v8::Exception::error(scope, message);
            resolver.reject(scope, error);
        }
    }
}

fn off_thread<T: Send + 'static>(name: &str, work: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(&mut v8::PinScope, T) + Send + 'static) -> Result<(), String> {
    let tx = rt::current().sender();
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let result = work();
            _ = tx.send(Msg::Task(Box::new(move |scope| done(scope, result))));
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn decode(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let buffer = bind::arg_u32(scope, &args, 0);
    let Some(bytes) = bind::bytes(args.get(1)) else {
        return bind::throw_type_error(scope, "audio.decode: not bytes");
    };
    let Some((token, promise)) = bind::promise(scope) else { return };
    let bytes: Arc<[u8]> = bytes.into();
    let started = off_thread(
        "acde-decode",
        move || decode::decode_all(bytes, RATE),
        move |scope, result| {
            let result = result.map(|data| {
                let fields: Fields = [("length", data.len() as f64), ("sampleRate", data.rate), ("numberOfChannels", data.channels.len() as f64)];
                with_state(|s| s.buffers.insert(buffer, Arc::new(data)));
                fields
            });
            settle(scope, token, result);
        },
    );
    if let Err(e) = started {
        bind::forget_promise(token);
        return bind::throw_error(scope, &format!("audio.decode: {e}"));
    }
    rv.set(promise.into());
}

fn create_buffer(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let buffer = bind::arg_u32(scope, &args, 0);
    let rate = bind::arg_f64(scope, &args, 1);
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(2)) else {
        return bind::throw_type_error(scope, "audio.createBuffer: channels must be an array");
    };
    let mut channels = Vec::new();
    for i in 0..list.length() {
        let Some(channel) = list.get_index(scope, i).and_then(floats) else {
            return bind::throw_type_error(scope, "audio.createBuffer: a channel is not a Float32Array");
        };
        channels.push(channel);
    }
    if !(rate.is_finite() && rate > 0.0) {
        return bind::throw_type_error(scope, "audio.createBuffer: bad sample rate");
    }
    with_state(|s| s.buffers.insert(buffer, Arc::new(AudioData { rate, channels })));
}

fn channel_data(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let buffer = bind::arg_u32(scope, &args, 0);
    let data = with_state(|s| s.buffers.get(&buffer).cloned());
    let channels = data.as_ref().map_or(&[][..], |d| &d.channels[..]);
    let list = v8::Array::new(scope, channels.len() as i32);
    for (i, channel) in channels.iter().enumerate() {
        let array = bind::float32_array(scope, channel);
        list.set_index(scope, i as u32, array.into());
    }
    rv.set(list.into());
}

fn release_buffer(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let buffer = bind::arg_u32(scope, &args, 0);
    with_state(|s| s.buffers.remove(&buffer));
}

fn open_media(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let media = bind::arg_u32(scope, &args, 0);
    let Some(bytes) = bind::bytes(args.get(1)) else {
        return bind::throw_type_error(scope, "audio.openMedia: not bytes");
    };
    let Some(web) = web() else {
        return bind::throw_error(scope, "NotSupportedError: no audio output");
    };
    let Some((token, promise)) = bind::promise(scope) else { return };
    let time = Arc::new(AtomicU64::new(0f64.to_bits()));
    with_state(|s| s.media.insert(media, time.clone()));
    let bytes: Arc<[u8]> = bytes.into();
    let started = off_thread(
        "acde-decode",
        move || {
            let stream = decode::MediaStream::open(bytes)?;
            let fields: Fields = [("duration", stream.duration), ("sampleRate", stream.rate), ("numberOfChannels", stream.channels as f64)];
            output::send(Ctl::Cmd(web, Cmd::AddMedia { media, stream: Box::new(stream), time }));
            Ok(fields)
        },
        move |scope, result: Result<Fields, String>| settle(scope, token, result),
    );
    if let Err(e) = started {
        bind::forget_promise(token);
        return bind::throw_error(scope, &format!("audio.openMedia: {e}"));
    }
    rv.set(promise.into());
}

fn media(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (media, code) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let value = bind::arg_f64(scope, &args, 2);
    let value = if value.is_finite() { value } else { 0.0 };
    let op = match code {
        0 => MediaOp::Play,
        1 => MediaOp::Pause,
        2 => MediaOp::Seek(value),
        3 => MediaOp::Volume(value as f32),
        4 => MediaOp::Loop(value != 0.0),
        5 => MediaOp::Rate(value),
        _ => return bind::throw_type_error(scope, "audio.media: unknown op"),
    };
    if let MediaOp::Seek(seconds) = op {
        with_state(|s| {
            if let Some(t) = s.media.get(&media) {
                t.store(seconds.to_bits(), Ordering::Release);
            }
        });
    }
    send(Cmd::Media { media, op });
}

fn media_time(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let media = bind::arg_u32(scope, &args, 0);
    let seconds = with_state(|s| s.media.get(&media).map_or(0.0, |t| f64::from_bits(t.load(Ordering::Acquire))));
    rv.set_double(seconds);
}

fn close_media(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let media = bind::arg_u32(scope, &args, 0);
    with_state(|s| s.media.remove(&media));
    send(Cmd::CloseMedia { media });
}
