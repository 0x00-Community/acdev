use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LINGER: Duration = Duration::from_secs(1);

type Beat = Box<dyn Fn() -> bool + Send + Sync>;

struct Target {
    wanted: AtomicBool,
    send: Beat,
}

pub(crate) struct Follower {
    target: Arc<Target>,
    clock: &'static Clock,
}

impl Follower {
    pub fn want(&self, on: bool) {
        if self.target.wanted.swap(on, Ordering::AcqRel) != on && on {
            self.clock.wake();
        }
    }
}

impl Drop for Follower {
    fn drop(&mut self) {
        lock(&self.clock.targets).retain(|t| !Arc::ptr_eq(t, &self.target));
    }
}

struct Clock {
    targets: Mutex<Vec<Arc<Target>>>,
    asked: Mutex<bool>,
    changed: Condvar,
}

impl Clock {
    fn wake(&self) {
        *lock(&self.asked) = true;
        self.changed.notify_all();
    }

    fn wanted(&self) -> bool {
        lock(&self.targets).iter().any(|t| t.wanted.load(Ordering::Acquire))
    }

    fn beat(&self) {
        let targets: Vec<Arc<Target>> = lock(&self.targets).iter().filter(|t| t.wanted.load(Ordering::Acquire)).cloned().collect();
        for target in targets {
            if !(target.send)() {
                target.wanted.store(false, Ordering::Release);
            }
        }
    }

    fn run(&self, link: &dyn Fn(bool)) {
        loop {
            let mut asked = lock(&self.asked);
            while !*asked && !self.wanted() {
                asked = self.changed.wait(asked).unwrap_or_else(|e| e.into_inner());
            }
            *asked = false;
            drop(asked);
            link(true);
            let mut idle_since: Option<Instant> = None;
            loop {
                let asked = lock(&self.asked);
                let (mut asked, _) = self.changed.wait_timeout(asked, LINGER / 4).unwrap_or_else(|e| e.into_inner());
                *asked = false;
                drop(asked);
                if self.wanted() {
                    idle_since = None;
                    continue;
                }
                let since = *idle_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= LINGER {
                    break;
                }
            }
            link(false);
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

static CLOCK: OnceLock<Option<&'static Clock>> = OnceLock::new();

fn clock() -> Option<&'static Clock> {
    *CLOCK.get_or_init(|| {
        let clock: &'static Clock = Box::leak(Box::new(Clock { targets: Mutex::new(Vec::new()), asked: Mutex::new(false), changed: Condvar::new() }));
        let link = platform::Link::open(clock)?;
        let started = std::thread::Builder::new().name("acde-vsync".into()).spawn(move || clock.run(&|on| link.run(on)));
        match started {
            Ok(_) => {
                log::info!("host window: frames follow the display's vsync");
                Some(clock)
            }
            Err(e) => {
                log::warn!("host window: vsync thread: {e}");
                None
            }
        }
    })
}

pub(crate) fn available() -> bool {
    clock().is_some()
}

pub(crate) fn follow(send: impl Fn() -> bool + Send + Sync + 'static) -> Option<Follower> {
    let clock = clock()?;
    let target = Arc::new(Target { wanted: AtomicBool::new(false), send: Box::new(send) });
    lock(&clock.targets).push(target.clone());
    Some(Follower { target, clock })
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod platform {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2_core_video::{CVDisplayLink, CVOptionFlags, CVReturn, CVTimeStamp, kCVReturnSuccess};

    use super::Clock;

    pub(super) struct Link(NonNull<CVDisplayLink>);

    unsafe impl Send for Link {}
    unsafe impl Sync for Link {}

    unsafe extern "C-unwind" fn output(
        _: NonNull<CVDisplayLink>,
        _: NonNull<CVTimeStamp>,
        _: NonNull<CVTimeStamp>,
        _: CVOptionFlags,
        _: NonNull<CVOptionFlags>,
        clock: *mut c_void,
    ) -> CVReturn {
        let clock = unsafe { &*(clock as *const Clock) };
        clock.beat();
        kCVReturnSuccess
    }

    impl Link {
        pub(super) fn open(clock: &'static Clock) -> Option<Self> {
            if std::env::var_os("ACDE_NO_VSYNC").is_some() {
                return None;
            }
            let mut raw: *mut CVDisplayLink = std::ptr::null_mut();
            let made = unsafe { CVDisplayLink::create_with_active_cg_displays(NonNull::from(&mut raw)) };
            let Some(link) = NonNull::new(raw).filter(|_| made == kCVReturnSuccess) else {
                log::warn!("host window: no display link ({made}), frames follow a timer");
                return None;
            };
            let set = unsafe { link.as_ref().set_output_callback(Some(output), clock as *const Clock as *mut c_void) };
            if set != kCVReturnSuccess {
                log::warn!("host window: display link callback ({set}), frames follow a timer");
                return None;
            }
            Some(Self(link))
        }

        pub(super) fn run(&self, on: bool) {
            log::debug!("host window: display link {}", if on { "on" } else { "off" });
            let link = unsafe { self.0.as_ref() };
            let result = if on { link.start() } else { link.stop() };
            if result != kCVReturnSuccess {
                log::warn!("host window: display link {} ({result})", if on { "start" } else { "stop" });
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Clock;

    pub(super) struct Link;

    impl Link {
        pub(super) fn open(_: &'static Clock) -> Option<Self> {
            None
        }

        pub(super) fn run(&self, _: bool) {}
    }
}
