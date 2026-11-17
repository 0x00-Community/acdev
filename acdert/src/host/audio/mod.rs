mod decode;
mod graph;
mod live;
mod mixer;
mod output;
#[cfg(not(target_os = "linux"))]
mod output_cpal;
mod spatial;
pub mod video;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::host::bind::{self, arg_bool, arg_f64, arg_u32};
use crate::host::{offload, rt};
use graph::{AudioData, Kind, NodeOp, ParamOp, Shared, Wave};
use mixer::{Clock, Cmd, MediaOp, Note, RATE};
use output::Ctl;
use video::{Picture, VideoSound};

enum Feed {
    File { player: Arc<crate::media::Player>, epoch: u64 },
    Live { capture: Arc<crate::media::capture::Capture>, seq: u64, black: bool },
}

struct Video {
    feed: Feed,
    picture: Picture,
}

#[derive(Default)]
struct State {
    web: u64,
    callback: Option<v8::Global<v8::Function>>,
    clocks: HashMap<u32, Arc<Clock>>,
    nodes: HashMap<u32, Arc<Shared>>,
    buffers: HashMap<u32, Arc<AudioData>>,
    media: HashMap<u32, Arc<AtomicU64>>,
    videos: HashMap<u32, Video>,
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
    let types = v8::Array::new(scope, crate::media::TYPES.len() as i32);
    for (i, kind) in crate::media::TYPES.iter().enumerate() {
        let kind = bind::string(scope, kind);
        types.set_index(scope, i as u32, kind.into());
    }
    bind::set(scope, audio, "videoTypes", types.into());
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
        "setPanner" => set_panner,
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
        "openVideo" => open_video,
        "present" => present,
        "videoSize" => video_size,
        "clearVideo" => clear_video,
        "openStream" => open_stream,
        "streamEnabled" => stream_enabled,
        "streamNode" => stream_node,
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

fn finite(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> f64 {
    let n = bind::arg_f64(scope, args, i);
    if n.is_finite() { n } else { 0.0 }
}

macro_rules! senders {
    ($($name:ident($s:ident, $a:ident) => $cmd:expr;)*) => {$(
        fn $name($s: &mut v8::PinScope, $a: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
            send($cmd);
        }
    )*};
}

senders! {
    set_running(s, a) => Cmd::Running { ctx: arg_u32(s, &a, 0), running: arg_bool(s, &a, 1) };
    close_context(s, a) => {
        let ctx = arg_u32(s, &a, 0);
        with_state(|state| state.clocks.remove(&ctx));
        Cmd::CloseContext { ctx }
    };
    connect(s, a) => Cmd::Connect { from: arg_u32(s, &a, 0), to: arg_u32(s, &a, 1), param: int(s, &a, 2) };
    disconnect(s, a) => Cmd::Disconnect { from: arg_u32(s, &a, 0), to: int(s, &a, 1) as i64, param: int(s, &a, 2) };
    set_wave(s, a) => Cmd::Node { node: arg_u32(s, &a, 0), op: NodeOp::Wave(Wave::from_code(arg_u32(s, &a, 1))) };
    set_loop(s, a) => Cmd::Node { node: arg_u32(s, &a, 0), op: NodeOp::Loop { looping: arg_bool(s, &a, 1), start: finite(s, &a, 2), end: finite(s, &a, 3) } };
    set_panner(s, a) => Cmd::Node {
        node: arg_u32(s, &a, 0),
        op: NodeOp::Panner(spatial::PannerConfig {
            hrtf: arg_bool(s, &a, 1),
            distance: spatial::DistanceModel::from_code(arg_u32(s, &a, 2)),
            ref_distance: finite(s, &a, 3),
            max_distance: finite(s, &a, 4),
            rolloff: finite(s, &a, 5),
            cone_inner: finite(s, &a, 6),
            cone_outer: finite(s, &a, 7),
            cone_outer_gain: finite(s, &a, 8),
        }),
    };
    set_buffer(s, a) => {
        let (node, buffer) = (arg_u32(s, &a, 0), arg_u32(s, &a, 1));
        Cmd::Node { node, op: NodeOp::Buffer(with_state(|state| state.buffers.get(&buffer).cloned())) }
    };
    start(s, a) => {
        let (node, when, offset, duration) = (arg_u32(s, &a, 0), arg_f64(s, &a, 1), finite(s, &a, 2), arg_f64(s, &a, 3));
        Cmd::Node { node, op: NodeOp::Start { when, offset, duration: (duration >= 0.0).then_some(duration) } }
    };
    stop(s, a) => Cmd::Node { node: arg_u32(s, &a, 0), op: NodeOp::Stop(arg_f64(s, &a, 1)) };
    release(s, a) => {
        let node = arg_u32(s, &a, 0);
        with_state(|state| state.nodes.remove(&node));
        Cmd::Node { node, op: NodeOp::Release }
    };
    close_media(s, a) => {
        let media = arg_u32(s, &a, 0);
        with_state(|state| {
            state.media.remove(&media);
            state.videos.remove(&media);
        });
        Cmd::CloseMedia { media }
    };
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
    let shared = Arc::new(Shared::new(kind));
    with_state(|s| s.nodes.insert(node, shared.clone()));
    send(Cmd::CreateNode { ctx, node, kind, shared });
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
    send(Cmd::Node { node, op: NodeOp::Param(param, op) });
}

fn automate_curve(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (node, param) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1) as usize);
    let Some(values) = floats(args.get(2)) else {
        return bind::throw_type_error(scope, "audio.automateCurve: values must be a Float32Array");
    };
    let (at, duration) = (bind::arg_f64(scope, &args, 3), bind::arg_f64(scope, &args, 4));
    send(Cmd::Node { node, op: NodeOp::Param(param, ParamOp::Curve(values.into(), at, duration)) });
}

fn param_value(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (node, param) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1) as usize);
    let value = with_state(|s| s.nodes.get(&node).map_or(0.0, |n| n.param(param)));
    rv.set_double(f64::from(value));
}

type Fields = [(&'static str, f64); 3];

fn settle(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, result: Result<Fields, String>) {
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

fn decode(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let buffer = bind::arg_u32(scope, &args, 0);
    let Some(bytes) = bind::bytes(args.get(1)) else {
        return bind::throw_type_error(scope, "audio.decode: not bytes");
    };
    let bytes: Arc<[u8]> = bytes.into();
    offload::run(
        scope,
        &mut rv,
        "acde-decode",
        move || (buffer, decode::decode_all(bytes, RATE)),
        |scope, resolver, (buffer, result)| {
            let result = result.map(|data| {
                let fields: Fields = [("length", data.len() as f64), ("sampleRate", data.rate), ("numberOfChannels", data.channels.len() as f64)];
                with_state(|s| s.buffers.insert(buffer, Arc::new(data)));
                fields
            });
            settle(scope, resolver, result);
        },
    );
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
    let time = Arc::new(AtomicU64::new(0f64.to_bits()));
    with_state(|s| s.media.insert(media, time.clone()));
    let bytes: Arc<[u8]> = bytes.into();
    let open = move || -> (u32, Result<Fields, String>) {
        let opened = decode::MediaStream::open(bytes).map(|stream| {
            let fields: Fields = [("duration", stream.duration), ("sampleRate", stream.rate), ("numberOfChannels", stream.channels as f64)];
            output::send(Ctl::Cmd(web, Cmd::AddMedia { media, stream: Box::new(stream), time }));
            fields
        });
        (media, opened)
    };
    offload::run(scope, &mut rv, "acde-decode", open, |scope, resolver, (media, result)| {
        if result.is_ok() && !with_state(|s| s.media.contains_key(&media)) {
            send(Cmd::CloseMedia { media });
        }
        settle(scope, resolver, result);
    });
}

fn media(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (media, code) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let value = finite(scope, &args, 2);
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

struct Open {
    media: u32,
    node: u32,
    player: Arc<crate::media::Player>,
    gpu: Option<Arc<crate::gpu::Gpu>>,
    first: Option<crate::media::Frame>,
    epoch: u64,
}

fn open_video(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (media, node) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let Some(bytes) = bind::bytes(args.get(2)) else {
        return bind::throw_type_error(scope, "audio.openVideo: not bytes");
    };
    let Some(web) = web() else {
        return bind::throw_error(scope, "NotSupportedError: no audio output");
    };
    let time = Arc::new(AtomicU64::new(0f64.to_bits()));
    with_state(|s| s.media.insert(media, time.clone()));
    let bytes: Arc<[u8]> = bytes.into();
    let open = move || -> Result<Open, String> {
        let player = Arc::new(crate::media::Player::open(bytes)?);
        let video = player.info().video;
        let epoch = player.epoch();
        let first = if video { player.first_frame(Duration::from_secs(10)) } else { None };
        if let Some(e) = player.error() {
            return Err(e);
        }
        let gpu = if video { crate::gpu::Gpu::shared() } else { None };
        output::send(Ctl::Cmd(web, Cmd::AddMedia { media, stream: Box::new(VideoSound::new(player.clone())), time }));
        Ok(Open { media, node, player, gpu, first, epoch })
    };
    offload::run(scope, &mut rv, "acde-video", open, opened);
}

fn opened(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, result: Result<Open, String>) {
    let result = result.map(|open| {
        let info = open.player.info().clone();
        let mut picture = Picture::new(open.node, open.gpu);
        let live = with_state(|s| s.media.contains_key(&open.media));
        if !live {
            send(Cmd::CloseMedia { media: open.media });
        } else if let Some(frame) = open.first {
            picture.show(&frame);
        }
        let (width, height) = if info.video { picture.size.unwrap_or((info.width, info.height)) } else { (0, 0) };
        if live {
            with_state(|s| s.videos.insert(open.media, Video { feed: Feed::File { player: open.player, epoch: open.epoch }, picture }));
        }
        [("duration", info.duration), ("width", f64::from(width)), ("height", f64::from(height)), ("audio", f64::from(u8::from(info.audio)))]
    });
    match result {
        Ok(fields) => {
            let fields: Vec<(&str, v8::Local<v8::Value>)> = fields.iter().map(|&(name, value)| (name, v8::Number::new(scope, value).into())).collect();
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

fn present(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let media = bind::arg_u32(scope, &args, 0);
    let shown = with_state(|s| {
        let time = s.media.get(&media).map(|t| f64::from_bits(t.load(Ordering::Acquire)))?;
        let video = s.videos.get_mut(&media)?;
        match &mut video.feed {
            Feed::File { player, epoch } => {
                let now = player.epoch();
                let frame = if now != *epoch {
                    let frame = player.first_frame(Duration::ZERO);
                    if frame.is_some() {
                        *epoch = now;
                    }
                    frame
                } else {
                    player.frame_at(time)
                };
                Some(video.picture.show(&frame?))
            }
            Feed::Live { black: true, .. } => None,
            Feed::Live { capture, seq, .. } => {
                let (latest, frame) = capture.frame()?;
                if latest == *seq {
                    return None;
                }
                *seq = latest;
                Some(video.picture.show(&frame))
            }
        }
    });
    rv.set_int32(match shown {
        Some(true) => 2,
        Some(false) => 1,
        None => 0,
    });
}

fn video_size(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let media = bind::arg_u32(scope, &args, 0);
    let (width, height) = with_state(|s| s.videos.get(&media).and_then(|v| v.picture.size)).unwrap_or((0, 0));
    let list = v8::Array::new(scope, 2);
    let (width, height) = (v8::Integer::new_from_unsigned(scope, width), v8::Integer::new_from_unsigned(scope, height));
    list.set_index(scope, 0, width.into());
    list.set_index(scope, 1, height.into());
    rv.set(list.into());
}

fn clear_video(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let node = bind::arg_u32(scope, &args, 0);
    Picture::new(node, None).clear();
}

fn open_stream(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let (media, node) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let (video, audio) = (crate::host::capture::source(bind::arg_u32(scope, &args, 2)), crate::host::capture::source(bind::arg_u32(scope, &args, 3)));
    let Some(web) = web() else {
        return bind::throw_error(scope, "NotSupportedError: no audio output");
    };
    let time = Arc::new(AtomicU64::new(0f64.to_bits()));
    with_state(|s| s.media.insert(media, time.clone()));
    let has_audio = audio.is_some();
    output::send(Ctl::Cmd(web, Cmd::AddMedia { media, stream: Box::new(live::LiveSound::new(audio)), time }));
    let (mut width, mut height) = (0, 0);
    if let Some(capture) = video {
        let mut picture = Picture::new(node, crate::gpu::Gpu::shared());
        let mut seq = 0;
        if let Some((latest, frame)) = capture.frame() {
            picture.show(&frame);
            seq = latest;
        }
        (width, height) = picture.size.unwrap_or((0, 0));
        with_state(|s| s.videos.insert(media, Video { feed: Feed::Live { capture, seq, black: false }, picture }));
    }
    let fields: [(&str, f64); 4] =
        [("duration", f64::INFINITY), ("width", f64::from(width)), ("height", f64::from(height)), ("audio", f64::from(u8::from(has_audio)))];
    let fields: Vec<(&str, v8::Local<v8::Value>)> = fields.iter().map(|&(name, value)| (name, v8::Number::new(scope, value).into())).collect();
    let obj = bind::object(scope, &fields);
    rv.set(obj.into());
}

fn stream_enabled(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (media, enabled) = (bind::arg_u32(scope, &args, 0), bind::arg_bool(scope, &args, 1));
    with_state(|s| {
        let Some(video) = s.videos.get_mut(&media) else { return };
        let Feed::Live { black, seq, .. } = &mut video.feed else { return };
        *black = !enabled;
        *seq = 0;
        if !enabled {
            video.picture.black();
        }
    });
}

fn stream_node(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let (node, source) = (bind::arg_u32(scope, &args, 0), bind::arg_u32(scope, &args, 1));
    let tap = crate::host::capture::source(source).map(|capture| Box::new(live::LiveTap::new(capture)));
    send(Cmd::Node { node, op: NodeOp::Stream(tap) });
}
