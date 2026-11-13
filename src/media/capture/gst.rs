use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::{Device, Error, Feed, Kind, Mode, Source, stable_id};
use crate::media::gst::{element, init, rgba};
use crate::media::{CHANNELS, Frame, RATE};

const CLASSES: [(&str, Kind); 2] = [("Audio/Source", Kind::Microphone), ("Video/Source", Kind::Camera)];

fn monitor() -> Vec<(gst::Device, Kind)> {
    if let Err(e) = init() {
        log::warn!("capture: {e}");
        return Vec::new();
    }
    let monitor = gst::DeviceMonitor::new();
    for (class, _) in CLASSES {
        monitor.add_filter(Some(class), None);
    }
    if let Err(e) = monitor.start() {
        log::warn!("capture: no device monitor: {e}");
        return Vec::new();
    }
    let found = monitor
        .devices()
        .into_iter()
        .filter_map(|device| {
            let class = device.device_class();
            let kind = CLASSES.iter().find(|(c, _)| class.split('/').zip(c.split('/')).all(|(a, b)| a == b))?.1;
            let monitor_of_output = property(&device, "device.class").is_some_and(|c| c == "monitor");
            (!monitor_of_output).then_some((device, kind))
        })
        .collect();
    monitor.stop();
    found
}

fn property(device: &gst::Device, key: &str) -> Option<String> {
    device.properties()?.get::<String>(key).ok()
}

fn native_id(device: &gst::Device) -> String {
    ["node.name", "api.v4l2.path", "device.path", "object.path"]
        .iter()
        .find_map(|key| property(device, key))
        .unwrap_or_else(|| device.display_name().to_string())
}

fn group(device: &gst::Device) -> String {
    ["device.bus-path", "api.v4l2.cap.bus_info", "device.serial", "device.name"]
        .iter()
        .find_map(|key| property(device, key))
        .unwrap_or_else(|| native_id(device))
}

fn rate(value: &gst::glib::SendValue) -> Option<f64> {
    if let Ok(f) = value.get::<gst::Fraction>() {
        return (f.denom() != 0).then(|| f64::from(f.numer()) / f64::from(f.denom()));
    }
    if let Ok(range) = value.get::<gst::FractionRange>() {
        let max = range.max();
        return (max.denom() != 0).then(|| f64::from(max.numer()) / f64::from(max.denom()));
    }
    if let Ok(list) = value.get::<gst::List>() {
        return list
            .iter()
            .filter_map(|v| v.get::<gst::Fraction>().ok())
            .filter(|f| f.denom() != 0)
            .map(|f| f64::from(f.numer()) / f64::from(f.denom()))
            .reduce(f64::max);
    }
    None
}

fn modes(device: &gst::Device) -> Vec<Mode> {
    let mut modes: Vec<Mode> = Vec::new();
    let Some(caps) = device.caps() else { return modes };
    for structure in caps.iter() {
        if !matches!(structure.name().as_str(), "video/x-raw" | "image/jpeg") {
            continue;
        }
        let (Ok(width), Ok(height)) = (structure.get::<i32>("width"), structure.get::<i32>("height")) else { continue };
        let frame_rate = structure.value("framerate").ok().and_then(rate).unwrap_or(30.0);
        let (width, height) = (width.max(0) as u32, height.max(0) as u32);
        match modes.iter_mut().find(|m| (m.width, m.height) == (width, height)) {
            Some(mode) => mode.frame_rate = mode.frame_rate.max(frame_rate),
            None => modes.push(Mode { width, height, frame_rate }),
        }
    }
    modes.sort_by_key(|m| std::cmp::Reverse(m.width * m.height));
    modes
}

fn channels(device: &gst::Device) -> u32 {
    device.caps().and_then(|caps| caps.iter().find_map(|s| s.get::<i32>("channels").ok())).map_or(2, |c| c.clamp(1, 32) as u32)
}

fn describe(device: &gst::Device, kind: Kind) -> Device {
    Device {
        id: stable_id(kind, &native_id(device)),
        kind,
        label: device.display_name().to_string(),
        group: stable_id(Kind::Microphone, &group(device)),
        facing: None,
        modes: if kind == Kind::Camera { modes(device) } else { Vec::new() },
        channels: if kind == Kind::Microphone { channels(device) } else { 0 },
    }
}

pub fn devices() -> Vec<Device> {
    monitor().into_iter().map(|(device, kind)| describe(&device, kind)).collect()
}

struct Capture {
    pipeline: gst::Pipeline,
    stop: Arc<AtomicBool>,
    watch: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Source for Capture {
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        _ = self.pipeline.set_state(gst::State::Null);
        if let Some(watch) = crate::media::lock(&self.watch).take() {
            _ = watch.join();
        }
    }
}

fn readable(e: impl std::fmt::Display) -> Error {
    Error::NotReadable(e.to_string())
}

fn fraction(value: f64) -> gst::Fraction {
    gst::Fraction::approximate_f64(value).unwrap_or_else(|| gst::Fraction::new(30, 1))
}

fn mode_caps(mode: Mode) -> gst::Caps {
    let (w, h) = (mode.width as i32, mode.height as i32);
    let rates = gst::FractionRange::new(fraction((mode.frame_rate - 0.5).max(1.0)), fraction(mode.frame_rate + 0.5));
    let mut caps = gst::Caps::new_empty();
    {
        let caps = caps.get_mut().unwrap_or_else(|| unreachable!());
        for name in ["video/x-raw", "image/jpeg"] {
            caps.append_structure(gst::Structure::builder(name).field("width", w).field("height", h).field("framerate", rates).build());
        }
    }
    caps
}

pub(crate) fn open(wanted: &Device, mode: Option<Mode>, feed: Arc<Feed>) -> Result<Box<dyn Source>, Error> {
    init().map_err(readable)?;
    let device = monitor()
        .into_iter()
        .find(|(d, kind)| *kind == wanted.kind && stable_id(*kind, &native_id(d)) == wanted.id)
        .map(|(d, _)| d)
        .ok_or_else(|| Error::NotFound(format!("{} is gone", wanted.label)))?;
    let source = device.create_element(None).map_err(|e| readable(format!("{}: {e}", wanted.label)))?;
    let pipeline = gst::Pipeline::new();
    let started = Instant::now();
    let chain: Vec<gst::Element> = match wanted.kind {
        Kind::Camera => {
            let mode = mode.or_else(|| wanted.modes.first().copied()).ok_or_else(|| Error::NotReadable(format!("{} has no modes", wanted.label)))?;
            let filter = element("capsfilter").map_err(readable)?;
            let wanted_caps = mode_caps(mode);
            let caps = device.caps().map(|c| c.intersect(&wanted_caps)).filter(|c| !c.is_empty()).unwrap_or(wanted_caps);
            filter.set_property("caps", caps);
            let decode = element("decodebin").map_err(readable)?;
            let convert = element("videoconvert").map_err(readable)?;
            let sink = gst_app::AppSink::builder()
                .caps(&gst::Caps::builder("video/x-raw").field("format", "RGBA").build())
                .sync(false)
                .max_buffers(1)
                .drop(true)
                .callbacks(
                    gst_app::AppSinkCallbacks::builder()
                        .new_sample({
                            let feed = feed.clone();
                            move |sink| {
                                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                if let Some((width, height, rgba)) = rgba(&sample) {
                                    feed.frame(Frame { time: started.elapsed().as_secs_f64(), width, height, rgba });
                                }
                                Ok(gst::FlowSuccess::Ok)
                            }
                        })
                        .build(),
                )
                .build();
            pipeline.add_many([&source, &filter, &decode, &convert, sink.upcast_ref()]).map_err(readable)?;
            gst::Element::link_many([&source, &filter, &decode]).map_err(readable)?;
            gst::Element::link_many([&convert, sink.upcast_ref()]).map_err(readable)?;
            let convert_pad = convert.static_pad("sink");
            decode.connect_pad_added(move |_, pad| {
                if let Some(target) = &convert_pad
                    && !target.is_linked()
                {
                    _ = pad.link(target);
                }
            });
            vec![source, filter, decode, convert, sink.upcast()]
        }
        Kind::Microphone => {
            let convert = element("audioconvert").map_err(readable)?;
            let resample = element("audioresample").map_err(readable)?;
            let caps = gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("rate", RATE as i32)
                .field("channels", CHANNELS as i32)
                .field("layout", "interleaved")
                .build();
            let sink = gst_app::AppSink::builder()
                .caps(&caps)
                .sync(false)
                .callbacks(
                    gst_app::AppSinkCallbacks::builder()
                        .new_sample({
                            let feed = feed.clone();
                            move |sink| {
                                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                if let Some(buffer) = sample.buffer()
                                    && let Ok(map) = buffer.map_readable()
                                {
                                    let samples: Vec<f32> = map.as_slice().as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
                                    feed.audio(&samples);
                                }
                                Ok(gst::FlowSuccess::Ok)
                            }
                        })
                        .build(),
                )
                .build();
            pipeline.add_many([&source, &convert, &resample, sink.upcast_ref()]).map_err(readable)?;
            gst::Element::link_many([&source, &convert, &resample, sink.upcast_ref()]).map_err(readable)?;
            vec![source, convert, resample, sink.upcast()]
        }
    };
    drop(chain);
    let bus = pipeline.bus().ok_or_else(|| Error::NotReadable("the pipeline has no bus".into()))?;
    pipeline.set_state(gst::State::Playing).map_err(|_| match bus_error(&bus) {
        Some(e) if e.contains("busy") || e.contains("Busy") => Error::NotReadable(format!("{} is in use: {e}", wanted.label)),
        Some(e) => Error::NotReadable(e),
        None => Error::NotReadable(format!("{} does not start", wanted.label)),
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let watch = {
        let (stop, label) = (stop.clone(), wanted.label.clone());
        std::thread::Builder::new()
            .name("acde-capture-bus".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let Some(message) = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(200), &[gst::MessageType::Error, gst::MessageType::Eos]) else {
                        continue;
                    };
                    match message.view() {
                        gst::MessageView::Error(e) => feed.end(format!("{label}: {}", e.error())),
                        _ => feed.end(format!("{label} stopped")),
                    }
                    return;
                }
            })
            .map_err(readable)?
    };
    Ok(Box::new(Capture { pipeline, stop, watch: std::sync::Mutex::new(Some(watch)) }))
}

fn bus_error(bus: &gst::Bus) -> Option<String> {
    while let Some(message) = bus.pop_filtered(&[gst::MessageType::Error]) {
        if let gst::MessageView::Error(e) = message.view() {
            return Some(format!("{} ({})", e.error(), e.debug().map(|d| d.to_string()).unwrap_or_default()));
        }
    }
    None
}
