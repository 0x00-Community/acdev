use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::decode::MediaStream;
use super::graph::{AudioData, Bus, Graph, Kind, ParamOp, QUANTUM, Shared, Wave};

pub const RATE: f64 = 48000.0;

pub fn now_ns() -> u64 {
    acde_log::start().elapsed().as_nanos() as u64 + 1
}

pub struct Clock {
    pub frames: AtomicU64,
    pub since: AtomicU64,
}

impl Clock {
    pub fn new() -> Clock {
        Clock { frames: AtomicU64::new(0), since: AtomicU64::new(now_ns()) }
    }

    pub fn seconds(&self) -> f64 {
        let frames = self.frames.load(Ordering::Acquire) as f64;
        let since = self.since.load(Ordering::Acquire);
        let extra = if since == 0 { 0.0 } else { now_ns().saturating_sub(since) as f64 * RATE / 1e9 };
        (frames + extra) / RATE
    }
}

pub enum Cmd {
    CreateContext { ctx: u32, dest: u32, clock: Arc<Clock> },
    Running { ctx: u32, running: bool },
    CloseContext { ctx: u32 },
    CreateNode { ctx: u32, node: u32, kind: Kind, shared: Arc<Shared> },
    Connect { from: u32, to: u32, param: i32 },
    Disconnect { from: u32, to: i64, param: i32 },
    Param { node: u32, param: usize, op: ParamOp },
    Wave { node: u32, wave: Wave },
    Buffer { node: u32, data: Option<Arc<AudioData>> },
    Loop { node: u32, looping: bool, start: f64, end: f64 },
    Start { node: u32, when: f64, offset: f64, duration: Option<f64> },
    Stop { node: u32, when: f64 },
    Release { node: u32 },
    AddMedia { media: u32, stream: Box<MediaStream>, time: Arc<AtomicU64> },
    Media { media: u32, op: MediaOp },
    CloseMedia { media: u32 },
}

#[derive(Clone, Copy, Debug)]
pub enum MediaOp {
    Play,
    Pause,
    Seek(f64),
    Volume(f32),
    Loop(bool),
    Rate(f64),
}

#[derive(Debug, PartialEq)]
pub enum Note {
    Ended(u32),
    MediaEnded(u32),
}

struct Context {
    graph: Graph,
    clock: Arc<Clock>,
    running: bool,
}

struct Media {
    stream: Box<MediaStream>,
    playing: bool,
    gain: f32,
    looping: bool,
    rate: f64,
    time: Arc<AtomicU64>,
}

pub struct Mixer {
    contexts: HashMap<u32, Context>,
    owner: HashMap<u32, u32>,
    media: HashMap<u32, Media>,
    notes: Vec<Note>,
    bus: Bus,
    pos: usize,
    ended: Vec<u32>,
}

impl Default for Mixer {
    fn default() -> Self {
        Mixer {
            contexts: HashMap::new(),
            owner: HashMap::new(),
            media: HashMap::new(),
            notes: Vec::new(),
            bus: [[0.0; QUANTUM]; 2],
            pos: QUANTUM,
            ended: Vec::new(),
        }
    }
}

impl Mixer {
    fn graph_of(&mut self, node: u32) -> Option<&mut Graph> {
        let ctx = self.owner.get(&node)?;
        self.contexts.get_mut(ctx).map(|c| &mut c.graph)
    }

    pub fn apply(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::CreateContext { ctx, dest, clock } => {
                let graph = Graph::new(RATE, dest);
                self.contexts.insert(ctx, Context { graph, clock, running: true });
                self.owner.insert(dest, ctx);
            }
            Cmd::Running { ctx, running } => {
                if let Some(c) = self.contexts.get_mut(&ctx) {
                    c.running = running;
                }
            }
            Cmd::CloseContext { ctx } => {
                self.contexts.remove(&ctx);
                self.owner.retain(|_, c| *c != ctx);
            }
            Cmd::CreateNode { ctx, node, kind, shared } => {
                if let Some(c) = self.contexts.get_mut(&ctx) {
                    c.graph.add(node, kind, shared);
                    self.owner.insert(node, ctx);
                }
            }
            Cmd::Connect { from, to, param } => {
                if let (Some(a), Some(b)) = (self.owner.get(&from), self.owner.get(&to))
                    && a == b
                    && let Some(c) = self.contexts.get_mut(a)
                {
                    c.graph.connect(from, to, usize::try_from(param).ok());
                }
            }
            Cmd::Disconnect { from, to, param } => {
                if let Some(graph) = self.graph_of(from) {
                    graph.disconnect(from, u32::try_from(to).ok(), usize::try_from(param).ok());
                }
            }
            Cmd::Param { node, param, op } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.param(node, param, op);
                }
            }
            Cmd::Wave { node, wave } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.set_wave(node, wave);
                }
            }
            Cmd::Buffer { node, data } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.set_buffer(node, data);
                }
            }
            Cmd::Loop { node, looping, start, end } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.set_loop(node, looping, start, end);
                }
            }
            Cmd::Start { node, when, offset, duration } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.start(node, when, offset, duration);
                }
            }
            Cmd::Stop { node, when } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.stop(node, when);
                }
            }
            Cmd::Release { node } => {
                if let Some(graph) = self.graph_of(node) {
                    graph.release(node);
                }
            }
            Cmd::AddMedia { media, stream, time } => {
                self.media.insert(media, Media { stream, playing: false, gain: 1.0, looping: false, rate: 1.0, time });
            }
            Cmd::Media { media, op } => {
                let Some(m) = self.media.get_mut(&media) else { return };
                match op {
                    MediaOp::Play => m.playing = true,
                    MediaOp::Pause => m.playing = false,
                    MediaOp::Seek(seconds) => {
                        m.stream.seek(seconds);
                        m.time.store(m.stream.time().to_bits(), Ordering::Release);
                    }
                    MediaOp::Volume(gain) => m.gain = gain,
                    MediaOp::Loop(looping) => m.looping = looping,
                    MediaOp::Rate(rate) => m.rate = rate,
                }
            }
            Cmd::CloseMedia { media } => {
                self.media.remove(&media);
            }
        }
    }

    pub fn active(&self) -> bool {
        self.media.values().any(|m| m.playing) || self.contexts.values().any(|c| c.running && c.graph.active())
    }

    fn quantum(&mut self) {
        self.bus = [[0.0; QUANTUM]; 2];
        for c in self.contexts.values_mut() {
            if !c.running {
                continue;
            }
            c.graph.render(&mut self.bus, &mut self.ended);
            c.clock.frames.store(c.graph.frame, Ordering::Release);
            for id in c.graph.gone.drain(..) {
                self.owner.remove(&id);
            }
        }
        for id in self.ended.drain(..) {
            self.notes.push(Note::Ended(id));
        }
        for (&id, m) in self.media.iter_mut() {
            if !m.playing {
                continue;
            }
            if m.stream.render(&mut self.bus, RATE, m.rate, m.gain, m.looping) {
                m.playing = false;
                self.notes.push(Note::MediaEnded(id));
            }
            m.time.store(m.stream.time().to_bits(), Ordering::Release);
        }
        for c in &mut self.bus {
            for v in c.iter_mut() {
                *v = v.clamp(-1.0, 1.0);
            }
        }
        self.pos = 0;
    }

    pub fn render(&mut self, out: &mut [f32]) {
        for frame in out.as_chunks_mut::<2>().0 {
            if self.pos == QUANTUM {
                self.quantum();
            }
            frame[0] = self.bus[0][self.pos];
            frame[1] = self.bus[1][self.pos];
            self.pos += 1;
        }
    }

    pub fn take_notes(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.notes)
    }

    pub fn catch_up(&mut self) {
        let now = now_ns();
        for c in self.contexts.values_mut() {
            let since = c.clock.since.load(Ordering::Acquire);
            if since == 0 || !c.running {
                continue;
            }
            let quanta = (now.saturating_sub(since) as f64 * RATE / 1e9) as u64 / QUANTUM as u64;
            if quanta == 0 {
                continue;
            }
            let frames = quanta * QUANTUM as u64;
            c.graph.skip(frames);
            c.clock.frames.store(c.graph.frame, Ordering::Release);
            c.clock.since.store(since + (frames as f64 * 1e9 / RATE) as u64, Ordering::Release);
        }
    }

    pub fn set_rendering(&mut self, rendering: bool) {
        let since = if rendering { 0 } else { now_ns() };
        for c in self.contexts.values() {
            c.clock.since.store(since, Ordering::Release);
        }
    }

    pub fn restart_clock(&mut self, ctx: u32, rendering: bool) {
        if let Some(c) = self.contexts.get(&ctx) {
            c.clock.since.store(if rendering { 0 } else { now_ns() }, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode::tests::wav;

    fn mixer_with_beep() -> (Mixer, Arc<Clock>) {
        let mut m = Mixer::default();
        let clock = Arc::new(Clock::new());
        m.apply(Cmd::CreateContext { ctx: 1, dest: 2, clock: clock.clone() });
        m.apply(Cmd::CreateNode { ctx: 1, node: 3, kind: Kind::Oscillator, shared: Arc::default() });
        m.apply(Cmd::CreateNode { ctx: 1, node: 4, kind: Kind::Gain, shared: Arc::default() });
        m.apply(Cmd::Connect { from: 3, to: 4, param: -1 });
        m.apply(Cmd::Connect { from: 4, to: 2, param: -1 });
        m.apply(Cmd::Param { node: 4, param: 0, op: ParamOp::Value(0.25) });
        m.apply(Cmd::Start { node: 3, when: 0.0, offset: 0.0, duration: None });
        m.apply(Cmd::Stop { node: 3, when: 0.1 });
        (m, clock)
    }

    #[test]
    fn mixes_a_context_and_reports_its_end() {
        let (mut m, clock) = mixer_with_beep();
        m.set_rendering(true);
        assert!(m.active());
        let mut out = vec![0.0; 2 * 4800];
        m.render(&mut out);
        let peak = out.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        assert!((peak - 0.25).abs() < 0.01, "{peak}");
        assert_eq!(out[0], out[1]);
        assert_eq!(m.take_notes(), vec![Note::Ended(3)]);
        assert!(!m.active());
        let mut more = vec![0.0; 2 * 256];
        m.render(&mut more);
        assert!(more.iter().all(|v| *v == 0.0));
        assert!((clock.seconds() - 5120.0 / RATE).abs() < 1e-9, "{}", clock.seconds());
    }

    #[test]
    fn without_output_the_clock_follows_wall_time() {
        let (mut m, clock) = mixer_with_beep();
        m.set_rendering(false);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let t = clock.seconds();
        assert!((0.03..0.2).contains(&t), "{t}");
        m.catch_up();
        let after = clock.seconds();
        assert!((after - t).abs() < 0.01, "{t} {after}");
        assert_eq!(clock.frames.load(Ordering::Relaxed) % QUANTUM as u64, 0);
        assert!(clock.frames.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn plays_media_with_volume_and_ends() {
        let mut m = Mixer::default();
        let stream = MediaStream::open(wav(48000, 1, 1000.0, 0.05).into()).unwrap();
        let time = Arc::new(AtomicU64::new(0));
        m.apply(Cmd::AddMedia { media: 9, stream: Box::new(stream), time: time.clone() });
        m.apply(Cmd::Media { media: 9, op: MediaOp::Volume(0.5) });
        assert!(!m.active());
        m.apply(Cmd::Media { media: 9, op: MediaOp::Play });
        assert!(m.active());
        let mut out = vec![0.0; 2 * 4800];
        m.render(&mut out);
        let peak = out.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        assert!((peak - 0.25).abs() < 0.01, "{peak}");
        assert_eq!(m.take_notes(), vec![Note::MediaEnded(9)]);
        assert!(!m.active());
        assert!((f64::from_bits(time.load(Ordering::Relaxed)) - 0.05).abs() < 0.005);
    }
}
