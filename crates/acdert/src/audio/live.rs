use std::sync::Arc;

use acde_media::capture::{Capture, Tap};
use acde_media::{CHANNELS, RATE};

use super::graph::{Bus, QUANTUM};
use super::mixer::MediaSource;

const KEEP: usize = RATE as usize / 50;
const TOO_LATE: usize = RATE as usize / 10;

pub struct LiveTap {
    _capture: Arc<Capture>,
    tap: Tap,
    chunk: Vec<f32>,
}

impl LiveTap {
    pub fn new(capture: Arc<Capture>) -> LiveTap {
        let tap = capture.tap();
        LiveTap { _capture: capture, tap, chunk: vec![0.0; QUANTUM * CHANNELS] }
    }

    pub fn read(&mut self, out: &mut Bus, gain: f32) {
        if self.tap.available() / CHANNELS > TOO_LATE {
            self.tap.keep_latest(KEEP * CHANNELS);
        }
        if self.tap.available() < QUANTUM * CHANNELS {
            return;
        }
        let n = self.tap.take(&mut self.chunk) / CHANNELS;
        let [left, right] = out;
        for (i, frame) in self.chunk[..n * CHANNELS].as_chunks::<CHANNELS>().0.iter().enumerate() {
            left[i] += gain * frame[0];
            right[i] += gain * frame[1];
        }
    }
}

pub struct LiveSound {
    tap: Option<LiveTap>,
    played: u64,
}

impl LiveSound {
    pub fn new(capture: Option<Arc<Capture>>) -> LiveSound {
        LiveSound { tap: capture.map(LiveTap::new), played: 0 }
    }
}

impl MediaSource for LiveSound {
    fn time(&self) -> f64 {
        self.played as f64 / f64::from(RATE)
    }

    fn seek(&mut self, _seconds: f64) {}

    fn render(&mut self, out: &mut Bus, _out_rate: f64, _speed: f64, gain: f32, _looping: bool) -> bool {
        self.played += QUANTUM as u64;
        if let Some(tap) = &mut self.tap {
            tap.read(out, gain);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::time::{Duration, Instant};

    use acde_media::capture::{self, fake};

    use super::*;
    use crate::audio::graph::{Graph, Kind, NodeOp};
    use crate::audio::mixer::{Cmd, MediaOp, Mixer};

    fn microphone() -> Arc<Capture> {
        capture::use_fake_devices();
        let device = capture::devices().into_iter().find(|d| d.kind == capture::Kind::Microphone).unwrap();
        Arc::new(Capture::open(&device, None).unwrap())
    }

    fn tone(samples: &[f32]) -> (f32, f64) {
        let peak = samples.iter().fold(0f32, |a, v| a.max(v.abs()));
        let crossings = samples.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        (peak, crossings as f64 / (samples.len() as f64 / f64::from(RATE)))
    }

    #[test]
    fn a_stream_in_a_media_element_plays_the_microphone_and_keeps_time() {
        let capture = microphone();
        let mut mixer = Mixer::default();
        let time = Arc::new(AtomicU64::new(0));
        mixer.apply(Cmd::AddMedia { media: 3, stream: Box::new(LiveSound::new(Some(capture))), time: time.clone() });
        mixer.apply(Cmd::Media { media: 3, op: MediaOp::Play });
        let mut left = Vec::new();
        let mut out = vec![0.0; 2 * QUANTUM];
        let deadline = Instant::now() + Duration::from_secs(3);
        while left.len() < RATE as usize / 4 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(3));
            mixer.render(&mut out);
            left.extend(out.as_chunks::<2>().0.iter().map(|f| f[0]).filter(|v| *v != 0.0));
        }
        let (peak, frequency) = tone(&left);
        assert!((peak - fake::LEVEL).abs() < 0.02, "peak {peak}");
        assert!((frequency - fake::TONE).abs() < 25.0, "frequency {frequency}");
        assert!(f64::from_bits(time.load(std::sync::atomic::Ordering::Acquire)) > 0.0);
    }

    #[test]
    fn a_stream_source_node_feeds_the_graph_until_it_is_detached() {
        let capture = microphone();
        let mut graph = Graph::new(f64::from(RATE), 1);
        graph.add(9, Kind::Stream, Arc::default());
        graph.connect(9, 1, None);
        graph.node(9, NodeOp::Stream(Some(Box::new(LiveTap::new(capture)))));
        assert!(graph.active());
        let mut left = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while left.len() < RATE as usize / 4 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(3));
            let mut out = [[0.0; QUANTUM]; 2];
            let mut ended = Vec::new();
            graph.render(&mut out, &mut ended);
            left.extend(out[0].iter().copied().filter(|v| *v != 0.0));
        }
        let (peak, frequency) = tone(&left);
        assert!((peak - fake::LEVEL).abs() < 0.02, "peak {peak}");
        assert!((frequency - fake::TONE).abs() < 25.0, "frequency {frequency}");
        graph.node(9, NodeOp::Stream(None));
        assert!(!graph.active());
    }
}
