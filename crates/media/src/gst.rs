use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use gio::prelude::*;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use gstreamer_video::prelude::VideoFrameExt;

use crate::{Backend, CHANNELS, Frame, Info, Pcm, Pull, RATE};

const WAIT: gst::ClockTime = gst::ClockTime::from_mseconds(100);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn init() -> Result<(), String> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED.get_or_init(|| gst::init().map_err(|e| format!("GStreamer cannot start: {e}"))).clone()
}

fn element(kind: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(kind).build().map_err(|_| format!("the GStreamer element {kind} is missing (install gst-plugins-base / gst-plugins-good)"))
}

pub(crate) struct Gst {
    pipeline: gst::Pipeline,
    video: Option<gst_app::AppSink>,
    audio: Option<gst_app::AppSink>,
    start: Mutex<f64>,
}

impl Drop for Gst {
    fn drop(&mut self) {
        _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn source(bytes: Arc<[u8]>) -> Result<gst::Element, String> {
    let stream = gio::MemoryInputStream::from_bytes(&gio::glib::Bytes::from_owned(Shared(bytes)));
    let src = element("giostreamsrc")?;
    src.set_property("stream", stream.upcast::<gio::InputStream>());
    Ok(src)
}

struct Shared(Arc<[u8]>);

impl AsRef<[u8]> for Shared {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

fn branch(pipeline: &gst::Pipeline, kinds: &[&str], caps: gst::Caps) -> Result<(gst::Element, gst_app::AppSink), String> {
    let elements = kinds.iter().map(|k| element(k)).collect::<Result<Vec<_>, _>>()?;
    for e in &elements {
        if e.factory().is_some_and(|f| f.name() == "videoflip") {
            e.set_property_from_str("video-direction", "auto");
        }
    }
    let sink = gst_app::AppSink::builder().caps(&caps).sync(false).max_buffers(2).drop(false).build();
    let mut all: Vec<&gst::Element> = elements.iter().collect();
    all.push(sink.upcast_ref());
    pipeline.add_many(all.iter().copied()).map_err(|e| e.to_string())?;
    gst::Element::link_many(all.iter().copied()).map_err(|e| e.to_string())?;
    for e in &all {
        e.sync_state_with_parent().map_err(|e| e.to_string())?;
    }
    Ok((elements[0].clone(), sink))
}

fn bus_error(pipeline: &gst::Pipeline) -> Option<String> {
    let bus = pipeline.bus()?;
    while let Some(message) = bus.pop_filtered(&[gst::MessageType::Error]) {
        if let gst::MessageView::Error(e) = message.view() {
            return Some(format!("{} ({})", e.error(), e.debug().map(|d| d.to_string()).unwrap_or_default()));
        }
    }
    None
}

pub(crate) fn open(bytes: Arc<[u8]>) -> Result<(Box<dyn Backend>, Info), String> {
    init()?;
    let pipeline = gst::Pipeline::new();
    let src = source(bytes)?;
    let decode = element("decodebin3")?;
    pipeline.add_many([&src, &decode]).map_err(|e| e.to_string())?;
    src.link(&decode).map_err(|e| e.to_string())?;
    let sinks: Arc<Mutex<(Option<gst_app::AppSink>, Option<gst_app::AppSink>)>> = Arc::default();
    let added = sinks.clone();
    let weak = pipeline.downgrade();
    decode.connect_pad_added(move |_, pad| {
        let Some(pipeline) = weak.upgrade() else { return };
        let caps = pad.current_caps().or_else(|| Some(pad.query_caps(None)));
        let name = caps.as_ref().and_then(|c| c.structure(0)).map(|s| s.name().to_string()).unwrap_or_default();
        let mut sinks = lock(&added);
        let made = if name.starts_with("video/") && sinks.0.is_none() {
            let caps = gst_video::VideoCapsBuilder::new().format(gst_video::VideoFormat::Rgba).build();
            branch(&pipeline, &["videoconvert", "videoflip", "videoconvert"], caps).map(|(first, sink)| {
                sinks.0 = Some(sink);
                first
            })
        } else if name.starts_with("audio/") && sinks.1.is_none() {
            let caps = gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", RATE as i32)
                .field("channels", CHANNELS as i32)
                .build();
            branch(&pipeline, &["audioconvert", "audioresample", "audioconvert"], caps).map(|(first, sink)| {
                sinks.1 = Some(sink);
                first
            })
        } else {
            return;
        };
        match made {
            Ok(first) => {
                if let Some(sink_pad) = first.static_pad("sink")
                    && let Err(e) = pad.link(&sink_pad)
                {
                    log::warn!("media: a {name} track cannot be decoded: {e:?}");
                }
            }
            Err(e) => log::warn!("media: a {name} track cannot be decoded: {e}"),
        }
    });
    pipeline.set_state(gst::State::Paused).map_err(|_| bus_error(&pipeline).unwrap_or_else(|| "GStreamer cannot read the file".into()))?;
    let bus = pipeline.bus().ok_or("no GStreamer bus")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut prerolled: Option<std::time::Instant> = None;
    let mut wanted: Option<(bool, bool)> = None;
    loop {
        if let Some(at) = prerolled {
            match wanted {
                Some((want_video, want_audio)) => {
                    let have = lock(&sinks);
                    if have.0.is_some() >= want_video && have.1.is_some() >= want_audio {
                        break;
                    }
                }
                None if at.elapsed() > Duration::from_secs(1) => break,
                None => {}
            }
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            if prerolled.is_some() {
                break;
            }
            _ = pipeline.set_state(gst::State::Null);
            return Err("GStreamer did not finish reading the file".into());
        }
        let kinds = [gst::MessageType::AsyncDone, gst::MessageType::Error, gst::MessageType::StreamsSelected];
        let Some(message) = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(left.as_millis().min(100) as u64), &kinds) else { continue };
        match message.view() {
            gst::MessageView::AsyncDone(_) => prerolled = prerolled.or_else(|| Some(std::time::Instant::now())),
            gst::MessageView::StreamsSelected(selected) => {
                let streams: Vec<gst::Stream> = selected.streams().collect();
                let has = |kind: gst::StreamType| streams.iter().any(|s| s.stream_type().contains(kind));
                wanted = Some((has(gst::StreamType::VIDEO), has(gst::StreamType::AUDIO)));
            }
            gst::MessageView::Error(e) => {
                _ = pipeline.set_state(gst::State::Null);
                return Err(format!("GStreamer cannot play the file: {}", e.error()));
            }
            _ => {}
        }
    }
    _ = pipeline.state(gst::ClockTime::from_seconds(5));
    let (video, audio) = lock(&sinks).clone();
    if video.is_none() && audio.is_none() {
        _ = pipeline.set_state(gst::State::Null);
        return Err("the file has neither video nor audio GStreamer can decode".into());
    }
    let (width, height) = video
        .as_ref()
        .and_then(|sink| sink.static_pad("sink")?.current_caps())
        .and_then(|caps| gst_video::VideoInfo::from_caps(&caps).ok())
        .map_or((0, 0), |info| (info.width(), info.height()));
    let duration = pipeline.query_duration::<gst::ClockTime>().map_or(f64::NAN, |d| d.seconds_f64());
    pipeline.set_state(gst::State::Playing).map_err(|_| bus_error(&pipeline).unwrap_or_else(|| "GStreamer cannot start decoding".into()))?;
    let info = Info { duration, width, height, audio: audio.is_some(), video: video.is_some() };
    Ok((Box::new(Gst { pipeline, video, audio, start: Mutex::new(0.0) }), info))
}

impl Gst {
    fn pull(&self, sink: &gst_app::AppSink) -> Pull<gst::Sample> {
        if let Some(e) = bus_error(&self.pipeline) {
            return Pull::Failed(e);
        }
        match sink.try_pull_sample(WAIT) {
            Some(sample) => Pull::Item(sample),
            None if sink.is_eos() => Pull::End,
            None => Pull::Wait,
        }
    }

    fn time(sample: &gst::Sample) -> Option<f64> {
        let pts = sample.buffer()?.pts()?;
        let segment = sample.segment()?.downcast_ref::<gst::ClockTime>()?;
        Some(segment.to_stream_time(pts).unwrap_or(pts).seconds_f64())
    }
}

impl Backend for Gst {
    fn restart(&self, from: f64) -> Result<(), String> {
        *lock(&self.start) = from;
        let at = gst::ClockTime::from_nseconds((from.max(0.0) * 1e9) as u64);
        self.pipeline.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, at).map_err(|e| format!("GStreamer cannot seek: {e}"))
    }

    fn next_video(&self) -> Pull<Frame> {
        let Some(sink) = &self.video else { return Pull::End };
        loop {
            let sample = match self.pull(sink) {
                Pull::Item(s) => s,
                Pull::Wait => return Pull::Wait,
                Pull::End => return Pull::End,
                Pull::Failed(e) => return Pull::Failed(e),
            };
            let Some(time) = Self::time(&sample) else { continue };
            if time + 0.001 < *lock(&self.start) {
                continue;
            }
            let (Some(buffer), Some(caps)) = (sample.buffer(), sample.caps()) else { continue };
            let Ok(info) = gst_video::VideoInfo::from_caps(caps) else { continue };
            let Ok(frame) = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info) else { continue };
            let (w, h) = (info.width() as usize, info.height() as usize);
            let stride = frame.info().stride()[0] as usize;
            let Ok(plane) = frame.plane_data(0) else { continue };
            let mut rgba = Vec::with_capacity(w * h * 4);
            for y in 0..h {
                rgba.extend_from_slice(&plane[y * stride..y * stride + w * 4]);
            }
            return Pull::Item(Frame { time, width: w as u32, height: h as u32, rgba });
        }
    }

    fn next_audio(&self) -> Pull<Pcm> {
        let Some(sink) = &self.audio else { return Pull::End };
        loop {
            let sample = match self.pull(sink) {
                Pull::Item(s) => s,
                Pull::Wait => return Pull::Wait,
                Pull::End => return Pull::End,
                Pull::Failed(e) => return Pull::Failed(e),
            };
            let Some(time) = Self::time(&sample) else { continue };
            let Some(buffer) = sample.buffer() else { continue };
            let Ok(map) = buffer.map_readable() else { continue };
            let mut samples: Vec<f32> = map.as_slice().as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
            let start = *lock(&self.start);
            let mut time = time;
            if time < start {
                let skip = (((start - time) * f64::from(RATE)).round() as usize * CHANNELS).min(samples.len());
                samples.drain(..skip);
                time = start;
            }
            if samples.is_empty() {
                continue;
            }
            return Pull::Item(Pcm { time, samples });
        }
    }

    fn stop(&self) {
        _ = self.pipeline.set_state(gst::State::Null);
    }
}
