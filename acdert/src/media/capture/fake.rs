use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::{Device, Error, Feed, Kind, Mode, Source, stable_id};
use crate::media::{CHANNELS, Frame, RATE, lock};

pub const BACKGROUND: [u8; 3] = [0x20, 0x80, 0xe0];
pub const TONE: f64 = 440.0;
pub const LEVEL: f32 = 0.25;

pub fn devices() -> Vec<Device> {
    let modes = [(320, 240), (640, 480), (1280, 720)].map(|(width, height)| Mode { width, height, frame_rate: 30.0 }).to_vec();
    vec![
        Device {
            id: stable_id(Kind::Microphone, "fake-microphone"),
            kind: Kind::Microphone,
            label: "Fake microphone".into(),
            group: stable_id(Kind::Microphone, "fake"),
            facing: None,
            modes: Vec::new(),
            channels: 1,
        },
        Device {
            id: stable_id(Kind::Camera, "fake-camera"),
            kind: Kind::Camera,
            label: "Fake camera".into(),
            group: stable_id(Kind::Microphone, "fake"),
            facing: Some("user"),
            modes,
            channels: 0,
        },
    ]
}

static LIVE: Mutex<Vec<(String, Weak<Feed>)>> = Mutex::new(Vec::new());

pub fn unplug(id: &str) {
    let feeds: Vec<Arc<Feed>> = lock(&LIVE).iter().filter(|(d, _)| d == id).filter_map(|(_, f)| f.upgrade()).collect();
    for feed in feeds {
        feed.end("the device was unplugged".into());
    }
}

struct Fake {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Source for Fake {
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = lock(&self.thread).take() {
            _ = thread.join();
        }
    }
}

pub(crate) fn open(device: &Device, mode: Option<Mode>, feed: Arc<Feed>) -> Result<Box<dyn Source>, Error> {
    if !devices().iter().any(|d| d.id == device.id) {
        return Err(Error::NotFound(format!("no device {}", device.label)));
    }
    {
        let mut live = lock(&LIVE);
        live.retain(|(_, f)| f.strong_count() > 0);
        live.push((device.id.clone(), Arc::downgrade(&feed)));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let running = stop.clone();
    let kind = device.kind;
    let mode = mode.or_else(|| device.modes.first().copied());
    let thread = std::thread::Builder::new()
        .name("acde-fake-capture".into())
        .spawn(move || match (kind, mode) {
            (Kind::Camera, Some(mode)) => camera(&feed, mode, &running),
            (Kind::Microphone, _) => microphone(&feed, &running),
            (Kind::Camera, None) => feed.end("a camera needs a mode".into()),
        })
        .map_err(|e| Error::NotReadable(e.to_string()))?;
    Ok(Box::new(Fake { stop, thread: Mutex::new(Some(thread)) }))
}

fn camera(feed: &Feed, mode: Mode, stop: &AtomicBool) {
    let start = Instant::now();
    let period = Duration::from_secs_f64(1.0 / mode.frame_rate.max(1.0));
    let (width, height) = (mode.width, mode.height);
    let bar = (width / 8).max(1);
    for index in 0u64.. {
        if stop.load(Ordering::Acquire) {
            return;
        }
        let time = index as f64 * period.as_secs_f64();
        let left = ((time.fract() * f64::from(width)) as u32).min(width - 1);
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..height {
            for x in 0..width {
                let lit = x >= left && x < left + bar;
                let [r, g, b] = if lit { [0xff; 3] } else { BACKGROUND };
                rgba.extend_from_slice(&[r, g, b, 0xff]);
            }
        }
        feed.frame(Frame { time, width, height, rgba });
        let next = start + period * (index + 1) as u32;
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
    }
}

fn microphone(feed: &Feed, stop: &AtomicBool) {
    let start = Instant::now();
    let chunk = RATE as usize / 100;
    let mut phase = 0.0f64;
    let mut buffer = vec![0f32; chunk * CHANNELS];
    for index in 0u32.. {
        if stop.load(Ordering::Acquire) {
            return;
        }
        for frame in buffer.as_chunks_mut::<CHANNELS>().0 {
            let value = LEVEL * (std::f64::consts::TAU * phase).sin() as f32;
            frame.fill(value);
            phase = (phase + TONE / f64::from(RATE)).fract();
        }
        feed.audio(&buffer);
        let next = start + Duration::from_millis(10) * (index + 1);
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
    }
}
