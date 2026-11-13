use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::time::Duration;

use crate::host::inspector;

thread_local! {
    static PROFILER: RefCell<Option<Profiler>> = const { RefCell::new(None) };
}

struct Profiler {
    dir: PathBuf,
    name: String,
    parts: Cell<u32>,
}

impl Profiler {
    fn cut(&self, restart: bool) {
        let profile = inspector::send("Profiler.stop", "{}");
        if restart {
            inspector::send("Profiler.start", "{}");
        }
        let Some(mut reply) = profile.and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok()) else { return };
        let body = reply["result"]["profile"].take().to_string();
        let part = self.parts.get() + 1;
        self.parts.set(part);
        let file = self.dir.join(format!("{}-{part}.cpuprofile", self.name));
        match std::fs::write(&file, body) {
            Ok(()) => log::info!("cpu profile {}", file.display()),
            Err(e) => log::warn!("cpu profile {}: {e}", file.display()),
        }
    }
}

fn period() -> Duration {
    let seconds = std::env::var("ACDE_PROFILE_SECONDS").ok().and_then(|s| s.parse().ok()).filter(|s: &u64| *s > 0);
    Duration::from_secs(seconds.unwrap_or(30))
}

pub fn start(name: &str) {
    let Some(dir) = std::env::var_os("ACDE_PROFILE_DIR").map(PathBuf::from) else { return };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return log::warn!("ACDE_PROFILE_DIR {}: {e}", dir.display());
    }
    let name = name.replace(['/', ' '], "_");
    inspector::send("Profiler.enable", "{}");
    inspector::send("Profiler.setSamplingInterval", r#"{"interval":250}"#);
    inspector::send("Profiler.start", "{}");
    PROFILER.with(|p| *p.borrow_mut() = Some(Profiler { dir, name, parts: Cell::new(0) }));
    schedule();
}

fn schedule() {
    crate::host::rt::current().delay(period(), |_| {
        let live = PROFILER.with(|p| p.borrow().as_ref().map(|p| p.cut(true)).is_some());
        if live {
            schedule();
        }
    });
}

pub fn stop() {
    if let Some(profiler) = PROFILER.with(|p| p.borrow_mut().take()) {
        profiler.cut(false);
    }
}
