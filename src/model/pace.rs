use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crate::model::{Event, Inbox};

static WEB_FPS: LazyLock<Option<Duration>> =
    LazyLock::new(|| std::env::var("ACDE_WEB_FPS").ok().and_then(|v| v.parse::<f64>().ok()).filter(|f| *f > 0.0).map(|fps| Duration::from_secs_f64(1.0 / fps)));

#[derive(Default)]
pub struct Pacer {
    pub want_frame: bool,
    pub animating: bool,
    interval: Option<Duration>,
    last_tick: Option<Instant>,
    told: Option<(u32, u32, u64)>,
}

impl Pacer {
    pub fn new(refresh: Option<Duration>) -> Self {
        Self { interval: WEB_FPS.or(refresh), ..Self::default() }
    }

    pub fn set_refresh(&mut self, refresh: Option<Duration>) {
        self.interval = WEB_FPS.or(refresh);
    }

    pub fn wait(&self) -> Option<Duration> {
        (self.want_frame || self.animating).then(|| self.interval.map_or(Duration::ZERO, |i| i.saturating_sub(self.last_tick.map_or(i, |t| t.elapsed()))))
    }

    pub fn tick(&mut self, inbox: &Inbox) -> Option<f64> {
        let now = crate::log::now_ms();
        self.last_tick = Some(Instant::now());
        if std::mem::take(&mut self.want_frame) {
            inbox.push(Event { kind: "frame".into(), time: Some(now), ..Default::default() });
        }
        self.animating.then_some(now)
    }

    pub fn tell_size(&mut self, inbox: &Inbox, (w, h): (u32, u32), scale: f64) {
        let told = (w, h, scale.to_bits());
        if self.told.replace(told) != Some(told) {
            inbox.push(Event { kind: "resize".into(), width: Some(w.into()), height: Some(h.into()), scale: Some(scale), ..Default::default() });
        }
    }
}
