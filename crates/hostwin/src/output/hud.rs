use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use acde::render::Hud;

const WINDOW: Duration = Duration::from_secs(1);

static SHOWN: OnceLock<AtomicBool> = OnceLock::new();
static LOGS: Mutex<Option<HashMap<u32, FrameLog>>> = Mutex::new(None);

#[derive(Default)]
struct FrameLog {
    stamps: VecDeque<Instant>,
    intervals: VecDeque<f64>,
    raster: VecDeque<f64>,
}

pub(crate) struct Stats {
    pub fps: f64,
    pub mean_ms: f64,
    pub worst_ms: f64,
    pub raster_ms: f64,
    pub intervals: Vec<f64>,
}

fn flag() -> &'static AtomicBool {
    SHOWN.get_or_init(|| AtomicBool::new(std::env::var("ACDE_HUD").is_ok_and(|v| !v.is_empty() && v != "0")))
}

fn logs() -> MutexGuard<'static, Option<HashMap<u32, FrameLog>>> {
    LOGS.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn shown() -> bool {
    flag().load(Ordering::Relaxed)
}

pub(crate) fn toggle() -> bool {
    let on = !flag().fetch_xor(true, Ordering::Relaxed);
    if !on {
        *logs() = None;
    }
    log::info!("host window: frame meter {}", if on { "on" } else { "off" });
    on
}

pub(crate) fn frame(window: u32, raster_ms: f64) {
    if !shown() {
        return;
    }
    let now = Instant::now();
    let mut logs = logs();
    let log = logs.get_or_insert_with(HashMap::new).entry(window).or_default();
    if let Some(&last) = log.stamps.back() {
        log.intervals.push_back(now.duration_since(last).as_secs_f64() * 1000.0);
        if log.intervals.len() > Hud::BARS {
            log.intervals.pop_front();
        }
    }
    log.stamps.push_back(now);
    log.raster.push_back(raster_ms);
    while log.stamps.front().is_some_and(|&at| now.duration_since(at) > WINDOW) {
        log.stamps.pop_front();
        log.raster.pop_front();
    }
}

pub(crate) fn forget(window: u32) {
    if let Some(logs) = logs().as_mut() {
        logs.remove(&window);
    }
}

pub(crate) fn stats(window: u32) -> Option<Stats> {
    let now = Instant::now();
    let logs = logs();
    let log = logs.as_ref()?.get(&window)?;
    let fresh = log.stamps.iter().rev().take_while(|&&at| now.duration_since(at) <= WINDOW).count();
    if fresh < 2 {
        return None;
    }
    let gaps = fresh - 1;
    let span = log.stamps[log.stamps.len() - 1].duration_since(log.stamps[log.stamps.len() - fresh]).as_secs_f64() * 1000.0;
    Some(Stats {
        fps: fresh as f64 / WINDOW.as_secs_f64(),
        mean_ms: span / gaps as f64,
        worst_ms: log.intervals.iter().rev().take(gaps).copied().fold(0.0, f64::max),
        raster_ms: log.raster.iter().rev().take(fresh).sum::<f64>() / fresh as f64,
        intervals: log.intervals.iter().copied().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_with_frames_in_the_last_second_has_stats_and_one_without_is_idle() {
        flag().store(true, Ordering::Relaxed);
        assert!(stats(7).is_none());
        for _ in 0..5 {
            frame(7, 2.0);
            std::thread::sleep(Duration::from_millis(10));
        }
        let s = stats(7).expect("five frames just now");
        assert_eq!(s.intervals.len(), 4);
        assert_eq!(s.fps, 5.0);
        assert!(s.mean_ms >= 9.0 && s.worst_ms >= s.mean_ms, "{} {}", s.mean_ms, s.worst_ms);
        assert_eq!(s.raster_ms, 2.0);
        forget(7);
        assert!(stats(7).is_none());
    }
}
