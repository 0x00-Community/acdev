#![allow(clippy::needless_range_loop)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

pub const QUANTUM: usize = 128;

pub type Bus = [[f32; QUANTUM]; 2];

pub struct AudioData {
    pub rate: f64,
    pub channels: Vec<Vec<f32>>,
}

impl AudioData {
    pub fn len(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }
}

#[derive(Default)]
pub struct Shared {
    params: [AtomicU32; 2],
}

impl Shared {
    pub fn param(&self, i: usize) -> f32 {
        self.params.get(i).map_or(0.0, |p| f32::from_bits(p.load(Ordering::Relaxed)))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Destination,
    Gain,
    Oscillator,
    BufferSource,
    StereoPanner,
    ConstantSource,
    Through,
}

impl Kind {
    pub fn from_code(code: u32) -> Option<Kind> {
        Some(match code {
            1 => Kind::Gain,
            2 => Kind::Oscillator,
            3 => Kind::BufferSource,
            4 => Kind::StereoPanner,
            5 => Kind::ConstantSource,
            6 => Kind::Through,
            _ => return None,
        })
    }

    fn is_source(self) -> bool {
        matches!(self, Kind::Oscillator | Kind::BufferSource | Kind::ConstantSource)
    }

    fn params(self, rate: f64) -> [(f32, f32, f32); 2] {
        let nyquist = (rate / 2.0) as f32;
        let detune = 1200.0 * f32::MAX.log2();
        let none = (0.0, f32::MIN, f32::MAX);
        match self {
            Kind::Gain => [(1.0, f32::MIN, f32::MAX), none],
            Kind::Oscillator => [(440.0, -nyquist, nyquist), (0.0, -detune, detune)],
            Kind::BufferSource => [(1.0, f32::MIN, f32::MAX), (0.0, f32::MIN, f32::MAX)],
            Kind::StereoPanner => [(0.0, -1.0, 1.0), none],
            Kind::ConstantSource => [(1.0, f32::MIN, f32::MAX), none],
            Kind::Destination | Kind::Through => [none, none],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wave {
    Sine,
    Square,
    Sawtooth,
    Triangle,
}

impl Wave {
    pub fn from_code(code: u32) -> Wave {
        match code {
            1 => Wave::Square,
            2 => Wave::Sawtooth,
            3 => Wave::Triangle,
            _ => Wave::Sine,
        }
    }
}

#[derive(Clone, Debug)]
pub enum ParamOp {
    Value(f32),
    SetAt(f32, f64),
    Linear(f32, f64),
    Exponential(f32, f64),
    Target(f32, f64, f64),
    Curve(Arc<[f32]>, f64, f64),
    Cancel(f64),
    CancelAndHold(f64),
}

#[derive(Clone, Debug)]
enum EventKind {
    Set,
    Linear,
    Exponential,
    Target(f64),
    Curve(Arc<[f32]>, f64),
}

#[derive(Clone, Debug)]
struct Event {
    time: f64,
    value: f32,
    kind: EventKind,
}

impl Event {
    fn end(&self) -> f64 {
        match &self.kind {
            EventKind::Curve(_, duration) => self.time + duration,
            _ => self.time,
        }
    }
}

#[derive(Clone, Debug)]
enum Curve {
    Const(f32),
    Linear { t0: f64, v0: f32, t1: f64, v1: f32 },
    Exponential { t0: f64, v0: f32, t1: f64, v1: f32 },
    Target { t0: f64, v0: f32, target: f32, tc: f64 },
    Values { t0: f64, duration: f64, values: Arc<[f32]> },
}

impl Curve {
    fn at(&self, t: f64) -> f32 {
        match self {
            Curve::Const(v) => *v,
            Curve::Linear { t0, v0, t1, v1 } => {
                if t1 <= t0 {
                    return *v1;
                }
                let k = ((t - t0) / (t1 - t0)).clamp(0.0, 1.0);
                (*v0 as f64 + (*v1 as f64 - *v0 as f64) * k) as f32
            }
            Curve::Exponential { t0, v0, t1, v1 } => {
                if t1 <= t0 {
                    return *v1;
                }
                if *v0 == 0.0 || (*v0 > 0.0) != (*v1 > 0.0) {
                    return *v0;
                }
                let k = ((t - t0) / (t1 - t0)).clamp(0.0, 1.0);
                (*v0 as f64 * (*v1 as f64 / *v0 as f64).powf(k)) as f32
            }
            Curve::Target { t0, v0, target, tc } => {
                if *tc <= 0.0 {
                    return *target;
                }
                (*target as f64 + (*v0 as f64 - *target as f64) * (-(t - t0).max(0.0) / tc).exp()) as f32
            }
            Curve::Values { t0, duration, values } => {
                let n = values.len();
                if n == 0 {
                    return 0.0;
                }
                if n == 1 || *duration <= 0.0 {
                    return values[n - 1];
                }
                let x = ((t - t0) / duration * (n - 1) as f64).max(0.0);
                let k = x.floor() as usize;
                if k >= n - 1 {
                    return values[n - 1];
                }
                let f = (x - k as f64) as f32;
                values[k] + (values[k + 1] - values[k]) * f
            }
        }
    }
}

#[derive(Clone, Debug)]
struct Seg {
    end: f64,
    curve: Curve,
}

pub struct Param {
    base: f32,
    min: f32,
    max: f32,
    events: Vec<Event>,
    segs: Vec<Seg>,
}

impl Param {
    pub fn new(value: f32, min: f32, max: f32) -> Param {
        Param { base: value, min, max, events: Vec::new(), segs: vec![Seg { end: f64::INFINITY, curve: Curve::Const(value) }] }
    }

    fn rebuild(&mut self) {
        self.segs.clear();
        let mut hold = Curve::Const(self.base);
        let mut prev: Option<(f64, f32)> = None;
        for e in &self.events {
            match &e.kind {
                EventKind::Linear | EventKind::Exponential => {
                    match prev {
                        Some((t0, v0)) => {
                            let curve = if matches!(e.kind, EventKind::Linear) {
                                Curve::Linear { t0, v0, t1: e.time, v1: e.value }
                            } else {
                                Curve::Exponential { t0, v0, t1: e.time, v1: e.value }
                            };
                            self.segs.push(Seg { end: e.time, curve });
                        }
                        None => self.segs.push(Seg { end: e.time, curve: hold.clone() }),
                    }
                    hold = Curve::Const(e.value);
                    prev = Some((e.time, e.value));
                }
                EventKind::Set => {
                    self.segs.push(Seg { end: e.time, curve: hold.clone() });
                    hold = Curve::Const(e.value);
                    prev = Some((e.time, e.value));
                }
                EventKind::Target(tc) => {
                    let v0 = hold.at(e.time);
                    self.segs.push(Seg { end: e.time, curve: hold.clone() });
                    hold = Curve::Target { t0: e.time, v0, target: e.value, tc: *tc };
                    prev = Some((e.time, v0));
                }
                EventKind::Curve(values, duration) => {
                    self.segs.push(Seg { end: e.time, curve: hold.clone() });
                    self.segs.push(Seg { end: e.time + duration, curve: Curve::Values { t0: e.time, duration: *duration, values: values.clone() } });
                    let last = values.last().copied().unwrap_or(0.0);
                    hold = Curve::Const(last);
                    prev = Some((e.time + duration, last));
                }
            }
        }
        self.segs.push(Seg { end: f64::INFINITY, curve: hold });
    }

    pub fn at(&self, t: f64) -> f32 {
        let i = self.segs.partition_point(|s| s.end <= t);
        self.segs.get(i).map_or(self.base, |s| s.curve.at(t))
    }

    fn insert(&mut self, event: Event) {
        let i = self.events.partition_point(|e| e.time <= event.time);
        self.events.insert(i, event);
    }

    pub fn apply(&mut self, op: ParamOp, now: f64) {
        match op {
            ParamOp::Value(v) => {
                if self.events.is_empty() {
                    self.base = v;
                } else {
                    self.insert(Event { time: now, value: v, kind: EventKind::Set });
                }
            }
            ParamOp::SetAt(v, t) => self.insert(Event { time: t, value: v, kind: EventKind::Set }),
            ParamOp::Linear(v, t) | ParamOp::Exponential(v, t) => {
                if !self.events.iter().any(|e| e.time < t) {
                    let current = self.at(now);
                    self.insert(Event { time: now.min(t), value: current, kind: EventKind::Set });
                }
                let kind = if matches!(op, ParamOp::Linear(..)) { EventKind::Linear } else { EventKind::Exponential };
                self.insert(Event { time: t, value: v, kind });
            }
            ParamOp::Target(v, t, tc) => self.insert(Event { time: t, value: v, kind: EventKind::Target(tc) }),
            ParamOp::Curve(values, t, duration) => {
                let value = values.first().copied().unwrap_or(0.0);
                self.insert(Event { time: t, value, kind: EventKind::Curve(values, duration) });
            }
            ParamOp::Cancel(t) => self.events.retain(|e| e.time < t),
            ParamOp::CancelAndHold(t) => {
                let held = self.at(t);
                let cut = self.events.iter().find(|e| e.time >= t).map(|e| e.kind.clone());
                self.events.retain(|e| e.time < t);
                if let Some(EventKind::Curve(values, duration)) = self.events.last().map(|e| e.kind.clone())
                    && let Some(last) = self.events.last_mut()
                    && last.time + duration > t
                {
                    let played = ((t - last.time) / duration).clamp(0.0, 1.0);
                    let n = ((values.len() as f64 - 1.0) * played).floor() as usize + 1;
                    let mut kept: Vec<f32> = values[..n.min(values.len())].to_vec();
                    kept.push(held);
                    last.kind = EventKind::Curve(kept.into(), t - last.time);
                } else {
                    let kind = match cut {
                        Some(EventKind::Linear) => EventKind::Linear,
                        Some(EventKind::Exponential) => EventKind::Exponential,
                        _ => EventKind::Set,
                    };
                    self.insert(Event { time: t, value: held, kind });
                }
            }
        }
        self.rebuild();
    }

    fn prune(&mut self, now: f64) {
        let mut changed = false;
        while self.events.len() >= 2 && self.events[1].end() <= now {
            self.base = self.at(self.events[1].time);
            self.events.remove(0);
            changed = true;
        }
        if let [only] = self.events.as_slice()
            && only.end() <= now
        {
            let settled = match only.kind {
                EventKind::Target(_) => {
                    let v = self.at(now);
                    ((v - only.value).abs() <= 1e-6 * only.value.abs().max(1.0)).then_some(only.value)
                }
                _ => Some(self.at(now)),
            };
            if let Some(v) = settled {
                self.base = v;
                self.events.clear();
                changed = true;
            }
        }
        if changed {
            self.rebuild();
        }
    }

    fn fill(&mut self, out: &mut [f32; QUANTUM], frame: u64, rate: f64) -> bool {
        let t0 = frame as f64 / rate;
        self.prune(t0);
        if self.events.is_empty() {
            out.fill(self.base);
            return true;
        }
        let mut i = self.segs.partition_point(|s| s.end <= t0);
        for (k, value) in out.iter_mut().enumerate() {
            let t = (frame + k as u64) as f64 / rate;
            while i + 1 < self.segs.len() && self.segs[i].end <= t {
                i += 1;
            }
            *value = self.segs[i].curve.at(t);
        }
        false
    }
}

struct Source {
    start: Option<u64>,
    stop: Option<u64>,
    ended: bool,
}

struct Buffer {
    data: Option<Arc<AudioData>>,
    pos: Option<f64>,
    offset: f64,
    duration: Option<f64>,
    played: f64,
    looping: bool,
    loop_start: f64,
    loop_end: f64,
}

struct Node {
    kind: Kind,
    inputs: Vec<u32>,
    param_inputs: [Vec<u32>; 2],
    params: [Param; 2],
    out: Bus,
    mono: bool,
    silent: bool,
    shared: Arc<Shared>,
    released: bool,
    src: Source,
    wave: Wave,
    phase: f64,
    buf: Buffer,
}

impl Node {
    fn new(kind: Kind, rate: f64, shared: Arc<Shared>) -> Node {
        let [(d0, lo0, hi0), (d1, lo1, hi1)] = kind.params(rate);
        for (i, d) in [d0, d1].into_iter().enumerate() {
            shared.params[i].store(d.to_bits(), Ordering::Relaxed);
        }
        Node {
            kind,
            inputs: Vec::new(),
            param_inputs: [Vec::new(), Vec::new()],
            params: [Param::new(d0, lo0, hi0), Param::new(d1, lo1, hi1)],
            out: [[0.0; QUANTUM]; 2],
            mono: true,
            silent: true,
            shared,
            released: false,
            src: Source { start: None, stop: None, ended: false },
            wave: Wave::Sine,
            phase: 0.0,
            buf: Buffer { data: None, pos: None, offset: 0.0, duration: None, played: 0.0, looping: false, loop_start: 0.0, loop_end: 0.0 },
        }
    }

    fn param_count(&self) -> usize {
        match self.kind {
            Kind::Oscillator | Kind::BufferSource => 2,
            Kind::Gain | Kind::StereoPanner | Kind::ConstantSource => 1,
            Kind::Destination | Kind::Through => 0,
        }
    }

    fn playing_range(&self, frame: u64) -> Option<(usize, usize)> {
        let start = self.src.start?;
        if self.src.ended {
            return None;
        }
        let end = frame + QUANTUM as u64;
        let stop = self.src.stop.unwrap_or(u64::MAX);
        if start >= end || stop <= frame || stop <= start {
            return None;
        }
        Some((start.saturating_sub(frame) as usize, (stop.min(end) - frame) as usize))
    }
}

pub struct Graph {
    pub rate: f64,
    pub frame: u64,
    dest: u32,
    nodes: HashMap<u32, Node>,
    order: Vec<u32>,
    order_dirty: bool,
    input: Bus,
    values: [[f32; QUANTUM]; 2],
    pub gone: Vec<u32>,
}

fn up_mix(acc: &mut Bus, acc_mono: &mut bool, empty: &mut bool, out: &Bus, mono: bool) {
    if *empty {
        acc[0] = out[0];
        acc[1] = if mono { out[0] } else { out[1] };
        *acc_mono = mono;
        *empty = false;
        return;
    }
    for i in 0..QUANTUM {
        acc[0][i] += out[0][i];
        acc[1][i] += if mono { out[0][i] } else { out[1][i] };
    }
    *acc_mono &= mono;
}

impl Graph {
    pub fn new(rate: f64, dest: u32) -> Graph {
        let mut nodes = HashMap::new();
        nodes.insert(dest, Node::new(Kind::Destination, rate, Arc::default()));
        Graph { rate, frame: 0, dest, nodes, order: Vec::new(), order_dirty: true, input: [[0.0; QUANTUM]; 2], values: [[0.0; QUANTUM]; 2], gone: Vec::new() }
    }

    pub fn now(&self) -> f64 {
        self.frame as f64 / self.rate
    }

    #[cfg(test)]
    pub fn has(&self, node: u32) -> bool {
        self.nodes.contains_key(&node)
    }

    pub fn add(&mut self, id: u32, kind: Kind, shared: Arc<Shared>) {
        self.nodes.insert(id, Node::new(kind, self.rate, shared));
        self.order_dirty = true;
    }

    pub fn connect(&mut self, from: u32, to: u32, param: Option<usize>) {
        if !self.nodes.contains_key(&from) || from == self.dest {
            return;
        }
        let Some(node) = self.nodes.get_mut(&to) else { return };
        let list = match param {
            None => &mut node.inputs,
            Some(i) if i < 2 => &mut node.param_inputs[i],
            Some(_) => return,
        };
        if !list.contains(&from) {
            list.push(from);
            self.order_dirty = true;
        }
    }

    pub fn disconnect(&mut self, from: u32, to: Option<u32>, param: Option<usize>) {
        for (id, node) in self.nodes.iter_mut() {
            if to.is_some_and(|to| to != *id) {
                continue;
            }
            match (to, param) {
                (Some(_), Some(i)) if i < 2 => node.param_inputs[i].retain(|&n| n != from),
                (Some(_), Some(_)) => {}
                (Some(_), None) => node.inputs.retain(|&n| n != from),
                (None, _) => {
                    node.inputs.retain(|&n| n != from);
                    for list in &mut node.param_inputs {
                        list.retain(|&n| n != from);
                    }
                }
            }
        }
        self.order_dirty = true;
    }

    pub fn param(&mut self, node: u32, i: usize, op: ParamOp) {
        let now = self.now();
        if let Some(node) = self.nodes.get_mut(&node)
            && i < node.param_count()
        {
            node.params[i].apply(op, now);
        }
    }

    pub fn set_wave(&mut self, node: u32, wave: Wave) {
        if let Some(node) = self.nodes.get_mut(&node) {
            node.wave = wave;
        }
    }

    pub fn set_buffer(&mut self, node: u32, data: Option<Arc<AudioData>>) {
        if let Some(node) = self.nodes.get_mut(&node) {
            node.buf.data = data;
        }
    }

    pub fn set_loop(&mut self, node: u32, looping: bool, start: f64, end: f64) {
        if let Some(node) = self.nodes.get_mut(&node) {
            node.buf.looping = looping;
            node.buf.loop_start = start;
            node.buf.loop_end = end;
        }
    }

    fn frame_at(&self, when: f64) -> u64 {
        if !when.is_finite() || when <= 0.0 {
            return self.frame;
        }
        let x = when * self.rate;
        let frame = if (x - x.round()).abs() < 1e-6 { x.round() } else { x.ceil() };
        (frame as u64).max(self.frame)
    }

    pub fn start(&mut self, node: u32, when: f64, offset: f64, duration: Option<f64>) {
        let frame = self.frame_at(when);
        if let Some(node) = self.nodes.get_mut(&node)
            && node.kind.is_source()
            && node.src.start.is_none()
        {
            node.src.start = Some(frame);
            node.buf.offset = offset.max(0.0);
            node.buf.duration = duration.filter(|d| d.is_finite() && *d >= 0.0);
        }
    }

    pub fn stop(&mut self, node: u32, when: f64) {
        let frame = self.frame_at(when);
        if let Some(node) = self.nodes.get_mut(&node)
            && node.kind.is_source()
        {
            node.src.stop = Some(frame);
        }
    }

    pub fn release(&mut self, node: u32) {
        if let Some(node) = self.nodes.get_mut(&node) {
            node.released = true;
        }
    }

    pub fn active(&self) -> bool {
        self.nodes.values().any(|n| n.kind.is_source() && n.src.start.is_some() && !n.src.ended)
    }

    #[cfg(test)]
    pub fn param_value(&self, node: u32, i: usize) -> Option<f32> {
        self.nodes.get(&node).map(|n| n.shared.param(i))
    }

    fn sort(&mut self) {
        let mut ids: Vec<u32> = self.nodes.keys().copied().collect();
        ids.sort_unstable();
        let mut state: HashMap<u32, u8> = HashMap::with_capacity(ids.len());
        let mut order = Vec::with_capacity(ids.len());
        for root in ids {
            if state.contains_key(&root) {
                continue;
            }
            let mut stack: Vec<(u32, usize)> = vec![(root, 0)];
            state.insert(root, 1);
            while let Some(&mut (id, ref mut next)) = stack.last_mut() {
                let node = &self.nodes[&id];
                let feeds = node.inputs.iter().chain(node.param_inputs.iter().flatten());
                if let Some(&input) = feeds.clone().nth(*next) {
                    *next += 1;
                    if self.nodes.contains_key(&input) && !state.contains_key(&input) {
                        state.insert(input, 1);
                        stack.push((input, 0));
                    }
                } else {
                    stack.pop();
                    state.insert(id, 2);
                    order.push(id);
                }
            }
        }
        self.order = order;
        self.order_dirty = false;
    }

    pub fn render(&mut self, out: &mut Bus, ended: &mut Vec<u32>) {
        if self.order_dirty {
            self.sort();
        }
        let frame = self.frame;
        for k in 0..self.order.len() {
            let id = self.order[k];
            let Some(mut node) = self.nodes.remove(&id) else { continue };
            self.process(&mut node, frame);
            self.nodes.insert(id, node);
        }
        if let Some(dest) = self.nodes.get(&self.dest)
            && !dest.silent
        {
            let right = if dest.mono { 0 } else { 1 };
            for i in 0..QUANTUM {
                out[0][i] += dest.out[0][i];
                out[1][i] += dest.out[right][i];
            }
        }
        self.frame += QUANTUM as u64;
        self.collect(ended);
    }

    pub fn skip(&mut self, frames: u64) {
        self.frame += frames;
    }

    fn collect(&mut self, ended: &mut Vec<u32>) {
        let mut gone = Vec::new();
        for (&id, node) in &self.nodes {
            if id == self.dest {
                continue;
            }
            let fed = !node.inputs.is_empty() || node.param_inputs.iter().any(|l| !l.is_empty());
            let done = if node.kind.is_source() {
                node.src.ended || (node.released && node.src.start.is_none())
            } else {
                node.released && !fed
            };
            if done {
                gone.push(id);
                if node.kind.is_source() && node.src.ended {
                    ended.push(id);
                }
            }
        }
        if gone.is_empty() {
            return;
        }
        for id in &gone {
            self.nodes.remove(id);
        }
        self.gone.extend_from_slice(&gone);
        for node in self.nodes.values_mut() {
            node.inputs.retain(|n| !gone.contains(n));
            for list in &mut node.param_inputs {
                list.retain(|n| !gone.contains(n));
            }
        }
        self.order_dirty = true;
    }

    fn process(&mut self, node: &mut Node, frame: u64) {
        let mut empty = true;
        let mut mono = true;
        for input in &node.inputs {
            if let Some(from) = self.nodes.get(input)
                && !from.silent
            {
                up_mix(&mut self.input, &mut mono, &mut empty, &from.out, from.mono);
            }
        }
        let count = node.param_count();
        for p in 0..count {
            let values = &mut self.values[p];
            node.params[p].fill(values, frame, self.rate);
            for input in &node.param_inputs[p] {
                if let Some(from) = self.nodes.get(input)
                    && !from.silent
                {
                    let right = if from.mono { 0 } else { 1 };
                    for (i, v) in values.iter_mut().enumerate() {
                        *v += (from.out[0][i] + from.out[right][i]) * 0.5;
                    }
                }
            }
            let (lo, hi) = (node.params[p].min, node.params[p].max);
            for v in values.iter_mut() {
                *v = v.clamp(lo, hi);
            }
            node.shared.params[p].store(values[QUANTUM - 1].to_bits(), Ordering::Relaxed);
        }
        let rate = self.rate;
        let input = &self.input;
        let values = &self.values;
        match node.kind {
            Kind::Destination | Kind::Through => {
                node.silent = empty;
                if !empty {
                    node.out = *input;
                    node.mono = mono;
                }
            }
            Kind::Gain => {
                node.silent = empty;
                if !empty {
                    node.mono = mono;
                    for c in 0..if mono { 1 } else { 2 } {
                        for i in 0..QUANTUM {
                            node.out[c][i] = input[c][i] * values[0][i];
                        }
                    }
                }
            }
            Kind::StereoPanner => {
                node.silent = empty;
                if !empty {
                    node.mono = false;
                    let half_pi = std::f32::consts::FRAC_PI_2;
                    for i in 0..QUANTUM {
                        let pan = values[0][i];
                        if mono {
                            let x = (pan + 1.0) * 0.5;
                            node.out[0][i] = input[0][i] * (x * half_pi).cos();
                            node.out[1][i] = input[0][i] * (x * half_pi).sin();
                        } else if pan <= 0.0 {
                            let x = pan + 1.0;
                            node.out[0][i] = input[0][i] + input[1][i] * (x * half_pi).cos();
                            node.out[1][i] = input[1][i] * (x * half_pi).sin();
                        } else {
                            let x = pan;
                            node.out[0][i] = input[0][i] * (x * half_pi).cos();
                            node.out[1][i] = input[1][i] + input[0][i] * (x * half_pi).sin();
                        }
                    }
                }
            }
            Kind::Oscillator => {
                let range = node.playing_range(frame);
                node.silent = range.is_none();
                node.mono = true;
                if let Some((from, to)) = range {
                    node.out[0][..from].fill(0.0);
                    node.out[0][to..].fill(0.0);
                    for i in from..to {
                        let detune = values[1][i];
                        let f = if detune == 0.0 { values[0][i] as f64 } else { values[0][i] as f64 * (detune as f64 / 1200.0).exp2() };
                        let dt = f / rate;
                        node.out[0][i] = oscillator(node.wave, node.phase, dt.abs()) as f32;
                        node.phase += dt;
                        node.phase -= node.phase.floor();
                    }
                }
            }
            Kind::ConstantSource => {
                let range = node.playing_range(frame);
                node.silent = range.is_none();
                node.mono = true;
                if let Some((from, to)) = range {
                    node.out[0][..from].fill(0.0);
                    node.out[0][to..].fill(0.0);
                    node.out[0][from..to].copy_from_slice(&values[0][from..to]);
                }
            }
            Kind::BufferSource => {
                let range = node.playing_range(frame);
                node.silent = range.is_none();
                if let Some((from, to)) = range
                    && play_buffer(node, from, to, rate, values)
                {
                    node.src.ended = true;
                }
            }
        }
        if node.kind.is_source()
            && let (Some(_), Some(stop)) = (node.src.start, node.src.stop)
            && stop <= frame + QUANTUM as u64
        {
            node.src.ended = true;
        }
    }
}

fn oscillator(wave: Wave, phase: f64, dt: f64) -> f64 {
    match wave {
        Wave::Sine => (std::f64::consts::TAU * phase).sin(),
        Wave::Square => {
            let naive = if phase < 0.5 { 1.0 } else { -1.0 };
            naive + poly_blep(phase, dt) - poly_blep((phase + 0.5).fract(), dt)
        }
        Wave::Sawtooth => {
            let p = (phase + 0.5).fract();
            2.0 * p - 1.0 - poly_blep(p, dt)
        }
        Wave::Triangle => 1.0 - 4.0 * ((phase + 0.25).fract() - 0.5).abs(),
    }
}

fn poly_blep(t: f64, dt: f64) -> f64 {
    if dt <= 0.0 {
        0.0
    } else if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

pub fn hermite(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + y1
}

fn play_buffer(node: &mut Node, from: usize, to: usize, rate: f64, values: &[[f32; QUANTUM]; 2]) -> bool {
    let Some(data) = node.buf.data.clone() else {
        node.out[0].fill(0.0);
        node.mono = true;
        return false;
    };
    let len = data.len();
    let channels = data.channels.len().min(2);
    node.mono = channels < 2;
    for c in &mut node.out {
        c[..from].fill(0.0);
        c[to..].fill(0.0);
    }
    if len == 0 || channels == 0 {
        return true;
    }
    let ratio = data.rate / rate;
    let (loop_start, loop_end) = {
        let (s, e) = (node.buf.loop_start * data.rate, node.buf.loop_end * data.rate);
        let e = if e > 0.0 && e > s { e.min(len as f64) } else { len as f64 };
        let s = if s > 0.0 && s < e { s } else { 0.0 };
        (s, e)
    };
    let mut pos = node.buf.pos.unwrap_or_else(|| (node.buf.offset * data.rate).min(len as f64));
    let limit = node.buf.duration.map(|d| d * data.rate);
    let sample = |c: usize, i: isize, looping: bool| -> f32 {
        let ch = &data.channels[c];
        let i = if looping && loop_end > loop_start {
            let (s, e) = (loop_start as isize, (loop_end.ceil() as isize).max(loop_start as isize + 1));
            if i >= e { s + (i - s) % (e - s) } else { i }
        } else {
            i
        };
        if i < 0 || i as usize >= len { 0.0 } else { ch[i as usize] }
    };
    for i in from..to {
        if !node.buf.looping && (pos >= len as f64 || pos < 0.0) {
            return true;
        }
        if limit.is_some_and(|l| node.buf.played >= l) {
            return true;
        }
        let base = pos.floor();
        let t = (pos - base) as f32;
        let k = base as isize;
        let looping = node.buf.looping;
        for c in 0..channels {
            node.out[c][i] = hermite(sample(c, k - 1, looping), sample(c, k, looping), sample(c, k + 1, looping), sample(c, k + 2, looping), t);
        }
        let detune = values[1][i];
        let speed = values[0][i] as f64 * if detune == 0.0 { 1.0 } else { (detune as f64 / 1200.0).exp2() };
        let step = speed * ratio;
        pos += step;
        node.buf.played += step.abs();
        if node.buf.looping && loop_end > loop_start {
            let span = loop_end - loop_start;
            if pos >= loop_end {
                pos = loop_start + (pos - loop_end) % span;
            } else if pos < loop_start && step < 0.0 {
                pos = loop_end - (loop_start - pos) % span;
            }
        }
    }
    node.buf.pos = Some(pos);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48000.0;

    fn render(graph: &mut Graph, quanta: usize) -> Vec<f32> {
        let mut left = Vec::new();
        let mut ended = Vec::new();
        for _ in 0..quanta {
            let mut out = [[0.0; QUANTUM]; 2];
            graph.render(&mut out, &mut ended);
            left.extend_from_slice(&out[0]);
        }
        left
    }

    fn frequency(samples: &[f32], rate: f64) -> f64 {
        let ups: Vec<usize> = samples.windows(2).enumerate().filter(|(_, w)| w[0] < 0.0 && w[1] >= 0.0).map(|(i, _)| i).collect();
        let (Some(first), Some(last)) = (ups.first(), ups.last()) else { return 0.0 };
        (ups.len() - 1) as f64 * rate / (last - first) as f64
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    #[test]
    fn oscillator_through_gain_has_its_frequency_and_level() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::Oscillator, Arc::default());
        g.add(3, Kind::Gain, Arc::default());
        g.connect(2, 3, None);
        g.connect(3, 1, None);
        g.param(3, 0, ParamOp::Value(0.5));
        g.param(2, 0, ParamOp::Value(1000.0));
        g.start(2, 0.0, 0.0, None);
        let out = render(&mut g, 375);
        let f = frequency(&out, RATE);
        assert!((f - 1000.0).abs() <= 2.0, "{f}");
        let p = peak(&out);
        assert!((p - 0.5).abs() < 0.01, "{p}");
    }

    #[test]
    fn waveforms_start_as_web_audio_does() {
        assert!(oscillator(Wave::Sine, 0.0, 0.0).abs() < 1e-9);
        assert!((oscillator(Wave::Sine, 0.25, 0.0) - 1.0).abs() < 1e-9);
        assert_eq!(oscillator(Wave::Square, 0.25, 0.0), 1.0);
        assert_eq!(oscillator(Wave::Square, 0.75, 0.0), -1.0);
        assert!(oscillator(Wave::Sawtooth, 0.0, 0.0).abs() < 1e-9);
        assert!((oscillator(Wave::Sawtooth, 0.25, 0.0) - 0.5).abs() < 1e-9);
        assert!(oscillator(Wave::Triangle, 0.0, 0.0).abs() < 1e-9);
        assert!((oscillator(Wave::Triangle, 0.25, 0.0) - 1.0).abs() < 1e-9);
        assert!((oscillator(Wave::Triangle, 0.75, 0.0) + 1.0).abs() < 1e-9);
    }

    #[test]
    fn square_and_sawtooth_keep_their_frequency() {
        for wave in [Wave::Square, Wave::Sawtooth, Wave::Triangle] {
            let mut g = Graph::new(RATE, 1);
            g.add(2, Kind::Oscillator, Arc::default());
            g.set_wave(2, wave);
            g.param(2, 0, ParamOp::Value(441.0));
            g.connect(2, 1, None);
            g.start(2, 0.0, 0.0, None);
            let out = render(&mut g, 375);
            let f = frequency(&out, RATE);
            assert!((f - 441.0).abs() <= 2.0, "{wave:?} {f}");
        }
    }

    #[test]
    fn start_and_stop_are_sample_accurate() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::ConstantSource, Arc::default());
        g.connect(2, 1, None);
        g.start(2, 100.0 / RATE, 0.0, None);
        g.stop(2, 300.0 / RATE);
        let mut ended = Vec::new();
        let mut all = Vec::new();
        for _ in 0..4 {
            let mut out = [[0.0; QUANTUM]; 2];
            g.render(&mut out, &mut ended);
            all.extend_from_slice(&out[0]);
        }
        assert_eq!(all[99], 0.0);
        assert_eq!(all[100], 1.0);
        assert_eq!(all[299], 1.0);
        assert_eq!(all[300], 0.0);
        assert_eq!(ended, vec![2]);
        assert!(!g.has(2), "an ended source goes");
    }

    #[test]
    fn linear_ramp() {
        let mut p = Param::new(0.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::SetAt(0.0, 0.0), 0.0);
        p.apply(ParamOp::Linear(1.0, 1.0), 0.0);
        assert!((p.at(0.25) - 0.25).abs() < 1e-6);
        assert!((p.at(0.5) - 0.5).abs() < 1e-6);
        assert_eq!(p.at(2.0), 1.0);
    }

    #[test]
    fn exponential_ramp() {
        let mut p = Param::new(1.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::SetAt(1.0, 0.0), 0.0);
        p.apply(ParamOp::Exponential(0.01, 2.0), 0.0);
        assert!((p.at(1.0) - 0.1).abs() < 1e-5, "{}", p.at(1.0));
        assert!((p.at(2.0) - 0.01).abs() < 1e-7);
        assert!((p.at(5.0) - 0.01).abs() < 1e-7);
    }

    #[test]
    fn exponential_ramp_from_zero_holds() {
        let mut p = Param::new(0.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::SetAt(0.0, 0.0), 0.0);
        p.apply(ParamOp::Exponential(1.0, 1.0), 0.0);
        assert_eq!(p.at(0.5), 0.0);
        assert_eq!(p.at(1.0), 1.0);
    }

    #[test]
    fn ramp_without_an_event_before_starts_now() {
        let mut p = Param::new(2.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::Linear(4.0, 3.0), 1.0);
        assert_eq!(p.at(0.5), 2.0);
        assert!((p.at(2.0) - 3.0).abs() < 1e-6);
    }

    #[test]
    fn set_target_approaches() {
        let mut p = Param::new(1.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::Target(0.0, 1.0, 0.5), 0.0);
        assert_eq!(p.at(0.5), 1.0);
        let one_tc = p.at(1.5);
        assert!((one_tc - (-1.0f32).exp()).abs() < 1e-5, "{one_tc}");
    }

    #[test]
    fn value_curve_interpolates() {
        let mut p = Param::new(0.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::Curve(vec![0.0, 1.0, 0.0].into(), 1.0, 2.0), 0.0);
        assert_eq!(p.at(0.5), 0.0);
        assert!((p.at(1.5) - 0.5).abs() < 1e-6);
        assert!((p.at(2.0) - 1.0).abs() < 1e-6);
        assert_eq!(p.at(3.5), 0.0);
    }

    #[test]
    fn cancel_and_hold_keeps_the_ramp_value() {
        let mut p = Param::new(0.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::SetAt(0.0, 0.0), 0.0);
        p.apply(ParamOp::Linear(1.0, 2.0), 0.0);
        p.apply(ParamOp::CancelAndHold(1.0), 0.0);
        assert!((p.at(0.5) - 0.25).abs() < 1e-6);
        assert!((p.at(1.0) - 0.5).abs() < 1e-6);
        assert!((p.at(3.0) - 0.5).abs() < 1e-6);
        p.apply(ParamOp::Cancel(0.0), 0.0);
        assert_eq!(p.at(3.0), 0.0);
    }

    #[test]
    fn pruning_keeps_the_values() {
        let mut p = Param::new(1.0, f32::MIN, f32::MAX);
        p.apply(ParamOp::SetAt(1.0, 0.0), 0.0);
        p.apply(ParamOp::Linear(0.0, 1.0), 0.0);
        p.apply(ParamOp::Target(1.0, 2.0, 0.1), 0.0);
        let mut out = [0.0; QUANTUM];
        let before = p.at(2.05);
        p.fill(&mut out, (1.5 * RATE) as u64, RATE);
        assert!((p.at(2.05) - before).abs() < 1e-6);
        p.fill(&mut out, (2.01 * RATE) as u64, RATE);
        assert!((p.at(2.05) - before).abs() < 1e-6);
        p.fill(&mut out, (20.0 * RATE) as u64, RATE);
        assert!(p.events.is_empty());
        assert_eq!(out[0], 1.0);
    }

    #[test]
    fn gain_envelope_shapes_the_output() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::Oscillator, Arc::default());
        g.add(3, Kind::Gain, Arc::default());
        g.param(2, 0, ParamOp::Value(880.0));
        g.param(3, 0, ParamOp::SetAt(0.0, 0.0));
        g.param(3, 0, ParamOp::Linear(1.0, 0.01));
        g.param(3, 0, ParamOp::Exponential(0.001, 0.2));
        g.connect(2, 3, None);
        g.connect(3, 1, None);
        g.start(2, 0.0, 0.0, None);
        g.stop(2, 0.25);
        let out = render(&mut g, 120);
        let window = |t: f64| peak(&out[(t * RATE) as usize..((t + 0.005) * RATE) as usize]);
        assert!(window(0.0) < 0.6, "attack {}", window(0.0));
        assert!(window(0.009) > 0.9, "peak {}", window(0.009));
        let mid = window(0.105);
        assert!((mid - 0.0316).abs() < 0.01, "decay {mid}");
        assert_eq!(peak(&out[(0.25 * RATE) as usize + 1..]), 0.0);
        let f = frequency(&out[..(0.2 * RATE) as usize], RATE);
        assert!((f - 880.0).abs() < 10.0, "{f}");
        assert!(!g.has(2));
    }

    #[test]
    fn buffer_source_plays_resamples_and_loops() {
        let rate = 24000.0;
        let samples: Vec<f32> = (0..2400).map(|i| (std::f64::consts::TAU * 100.0 * i as f64 / rate).sin() as f32).collect();
        let data = Arc::new(AudioData { rate, channels: vec![samples] });
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::BufferSource, Arc::default());
        g.set_buffer(2, Some(data.clone()));
        g.connect(2, 1, None);
        g.start(2, 0.0, 0.0, None);
        let mut ended = Vec::new();
        let mut all = Vec::new();
        for _ in 0..60 {
            let mut out = [[0.0; QUANTUM]; 2];
            g.render(&mut out, &mut ended);
            all.extend_from_slice(&out[0]);
        }
        assert_eq!(ended, vec![2]);
        let played = all.iter().rposition(|v| v.abs() > 1e-3).unwrap();
        assert!((played as f64 - 4800.0).abs() < 130.0, "{played}");
        let f = frequency(&all[..4700], RATE);
        assert!((f - 100.0).abs() < 1.0, "{f}");

        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::BufferSource, Arc::default());
        g.set_buffer(2, Some(data));
        g.set_loop(2, true, 0.0, 0.0);
        g.param(2, 0, ParamOp::Value(2.0));
        g.connect(2, 1, None);
        g.start(2, 0.0, 0.0, None);
        let out = render(&mut g, 375);
        let f = frequency(&out, RATE);
        assert!((f - 200.0).abs() < 3.0, "{f}");
        assert!(g.has(2));
    }

    #[test]
    fn stereo_panner_pans_mono_with_equal_power() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::ConstantSource, Arc::default());
        g.add(3, Kind::StereoPanner, Arc::default());
        g.connect(2, 3, None);
        g.connect(3, 1, None);
        g.param(3, 0, ParamOp::Value(1.0));
        g.start(2, 0.0, 0.0, None);
        let mut out = [[0.0; QUANTUM]; 2];
        g.render(&mut out, &mut Vec::new());
        assert!(out[0][5].abs() < 1e-6);
        assert!((out[1][5] - 1.0).abs() < 1e-6);
        g.param(3, 0, ParamOp::Value(0.0));
        let mut out = [[0.0; QUANTUM]; 2];
        g.render(&mut out, &mut Vec::new());
        assert!((out[0][5] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    }

    #[test]
    fn a_node_into_a_param_modulates_it() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::ConstantSource, Arc::default());
        g.add(3, Kind::ConstantSource, Arc::default());
        g.add(4, Kind::Gain, Arc::default());
        g.param(3, 0, ParamOp::Value(0.25));
        g.param(4, 0, ParamOp::Value(0.5));
        g.connect(2, 4, None);
        g.connect(3, 4, Some(0));
        g.connect(4, 1, None);
        g.start(2, 0.0, 0.0, None);
        g.start(3, 0.0, 0.0, None);
        let mut out = [[0.0; QUANTUM]; 2];
        g.render(&mut out, &mut Vec::new());
        assert!((out[0][0] - 0.75).abs() < 1e-6);
        assert!((g.param_value(4, 0).unwrap() - 0.75).abs() < 1e-6);
    }

    #[test]
    fn released_nodes_go_once_nothing_feeds_them() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::Oscillator, Arc::default());
        g.add(3, Kind::Gain, Arc::default());
        g.connect(2, 3, None);
        g.connect(3, 1, None);
        g.start(2, 0.0, 0.0, None);
        g.stop(2, 0.01);
        g.release(3);
        render(&mut g, 2);
        assert!(g.has(3), "still fed");
        render(&mut g, 4);
        assert!(!g.has(2) && !g.has(3));
        assert!(!g.active());
    }

    #[test]
    fn a_cycle_does_not_hang() {
        let mut g = Graph::new(RATE, 1);
        g.add(2, Kind::Gain, Arc::default());
        g.add(3, Kind::Gain, Arc::default());
        g.add(4, Kind::ConstantSource, Arc::default());
        g.connect(4, 2, None);
        g.connect(2, 3, None);
        g.connect(3, 2, None);
        g.connect(3, 1, None);
        g.param(3, 0, ParamOp::Value(0.5));
        g.start(4, 0.0, 0.0, None);
        render(&mut g, 10);
    }
}
