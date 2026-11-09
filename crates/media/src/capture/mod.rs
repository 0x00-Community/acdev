#[cfg(target_os = "macos")]
mod apple;
pub mod fake;
#[cfg(target_os = "linux")]
mod gst;

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::{CHANNELS, Frame, RATE, lock};

const RING: usize = RATE as usize * CHANNELS * 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Microphone,
    Camera,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub kind: Kind,
    pub label: String,
    pub group: String,
    pub facing: Option<&'static str>,
    pub modes: Vec<Mode>,
    pub channels: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    NotAllowed(String),
    NotFound(String),
    NotReadable(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (name, message) = match self {
            Error::NotAllowed(m) => ("NotAllowedError", m),
            Error::NotFound(m) => ("NotFoundError", m),
            Error::NotReadable(m) => ("NotReadableError", m),
        };
        write!(f, "{name}: {message}")
    }
}

pub(crate) trait Source: Send + Sync {
    fn stop(&self);
}

#[derive(Default)]
struct Ring {
    samples: Vec<f32>,
    written: u64,
}

type OnEnd = Box<dyn FnOnce(String) + Send>;

#[derive(Default)]
struct State {
    frame: Option<(u64, Arc<Frame>)>,
    ended: Option<String>,
    on_end: Vec<OnEnd>,
}

#[derive(Default)]
pub(crate) struct Feed {
    state: Mutex<State>,
    ring: Mutex<Ring>,
    arrived: Condvar,
}

impl Feed {
    pub(crate) fn frame(&self, frame: Frame) {
        let mut state = lock(&self.state);
        let seq = state.frame.as_ref().map_or(1, |(seq, _)| seq + 1);
        state.frame = Some((seq, Arc::new(frame)));
        self.arrived.notify_all();
    }

    pub(crate) fn audio(&self, samples: &[f32]) {
        let mut ring = lock(&self.ring);
        if ring.samples.len() < RING {
            ring.samples.resize(RING, 0.0);
        }
        let start = (ring.written % RING as u64) as usize;
        let samples = &samples[samples.len().saturating_sub(RING)..];
        let first = samples.len().min(RING - start);
        ring.samples[start..start + first].copy_from_slice(&samples[..first]);
        ring.samples[..samples.len() - first].copy_from_slice(&samples[first..]);
        ring.written += samples.len() as u64;
        drop(ring);
        self.arrived.notify_all();
    }

    pub(crate) fn end(&self, reason: String) {
        let mut state = lock(&self.state);
        if state.ended.is_some() {
            return;
        }
        log::info!("capture: ended: {reason}");
        state.ended = Some(reason.clone());
        let listeners = std::mem::take(&mut state.on_end);
        drop(state);
        self.arrived.notify_all();
        for listener in listeners {
            listener(reason.clone());
        }
    }

    fn written(&self) -> u64 {
        lock(&self.ring).written
    }
}

pub struct Capture {
    feed: Arc<Feed>,
    source: Box<dyn Source>,
    device: Device,
    mode: Option<Mode>,
}

impl Capture {
    pub fn open(device: &Device, mode: Option<Mode>) -> Result<Capture, Error> {
        let feed = Arc::new(Feed::default());
        let source = match backend() {
            Backend::Fake => fake::open(device, mode, feed.clone())?,
            #[cfg(target_os = "linux")]
            Backend::System => gst::open(device, mode, feed.clone())?,
            #[cfg(target_os = "macos")]
            Backend::System => apple::open(device, mode, feed.clone())?,
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            Backend::System => return Err(Error::NotFound("no capture devices on this platform".into())),
        };
        Ok(Capture { feed, source, device: device.clone(), mode })
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    pub fn mode(&self) -> Option<Mode> {
        self.mode
    }

    pub fn frame(&self) -> Option<(u64, Arc<Frame>)> {
        lock(&self.feed.state).frame.clone()
    }

    pub fn first_frame(&self, timeout: Duration) -> Option<Arc<Frame>> {
        let deadline = Instant::now() + timeout;
        let mut state = lock(&self.feed.state);
        loop {
            if let Some((_, frame)) = &state.frame {
                return Some(frame.clone());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if state.ended.is_some() || left.is_zero() {
                return None;
            }
            state = self.feed.arrived.wait_timeout(state, left).map_or_else(|e| e.into_inner().0, |(s, _)| s);
        }
    }

    pub fn tap(&self) -> Tap {
        Tap { feed: self.feed.clone(), read: self.feed.written() }
    }

    pub fn ended(&self) -> Option<String> {
        lock(&self.feed.state).ended.clone()
    }

    pub fn on_end(&self, listener: impl FnOnce(String) + Send + 'static) {
        let mut state = lock(&self.feed.state);
        match state.ended.clone() {
            Some(reason) => {
                drop(state);
                listener(reason);
            }
            None => state.on_end.push(Box::new(listener)),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.source.stop();
    }
}

pub struct Tap {
    feed: Arc<Feed>,
    read: u64,
}

impl Tap {
    pub fn available(&self) -> usize {
        let written = self.feed.written();
        (written.saturating_sub(self.read)).min(RING as u64) as usize
    }

    pub fn take(&mut self, out: &mut [f32]) -> usize {
        let ring = lock(&self.feed.ring);
        if ring.written.saturating_sub(self.read) > RING as u64 {
            self.read = ring.written - RING as u64;
        }
        let n = (out.len().min((ring.written - self.read) as usize)) / CHANNELS * CHANNELS;
        for (i, slot) in out[..n].iter_mut().enumerate() {
            *slot = ring.samples[((self.read + i as u64) % RING as u64) as usize];
        }
        self.read += n as u64;
        n
    }

    pub fn keep_latest(&mut self, samples: usize) {
        let written = self.feed.written();
        self.read = self.read.max(written.saturating_sub(samples as u64));
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Backend {
    Fake,
    System,
}

static FAKE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn use_fake_devices() {
    _ = FAKE.set(true);
}

fn backend() -> Backend {
    match FAKE.get_or_init(|| std::env::var("ACDE_CAPTURE").is_ok_and(|v| v == "fake")) {
        true => Backend::Fake,
        false => Backend::System,
    }
}

pub fn devices() -> Vec<Device> {
    match backend() {
        Backend::Fake => fake::devices(),
        #[cfg(target_os = "linux")]
        Backend::System => gst::devices(),
        #[cfg(target_os = "macos")]
        Backend::System => apple::devices(),
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        Backend::System => Vec::new(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    Prompt,
}

pub fn permission(kind: Kind) -> Permission {
    match backend() {
        Backend::Fake => Permission::Granted,
        #[cfg(target_os = "macos")]
        Backend::System => apple::permission(kind),
        #[cfg(not(target_os = "macos"))]
        Backend::System => {
            let _ = kind;
            Permission::Granted
        }
    }
}

pub fn authorize(kind: Kind) -> Result<(), Error> {
    match backend() {
        Backend::Fake => Ok(()),
        #[cfg(target_os = "macos")]
        Backend::System => apple::authorize(kind),
        #[cfg(not(target_os = "macos"))]
        Backend::System => {
            let _ = kind;
            Ok(())
        }
    }
}

pub(crate) fn stable_id(kind: Kind, native: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in [kind as u8].iter().chain(native.as_bytes()) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}
