use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, BigInt, Function};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use acde_model::{InjectEvent, Injected};

use crate::compositor::{Animate, Compositor, Event, Handle, Inbox, SURFACE_IDS, Stats};
use crate::link::Link;
use crate::link::protocol::acde_shell::Animated;

#[napi]
pub struct Shell {
    handle: Option<Handle>,
    link: Link,
    events: Arc<Inbox>,
    next_surface: std::sync::atomic::AtomicU32,
}

#[napi(object)]
#[derive(Default)]
pub struct GrantOptions {
    pub desktop: Option<bool>,
    pub window: Option<u32>,
    pub mode: Option<String>,
    pub rect: Option<Vec<i32>>,
    pub size: Option<Vec<i32>>,
}

#[napi(object)]
pub struct SurfaceGrant {
    pub window: u32,
    pub token: BigInt,
}

#[napi(object)]
pub struct AnimateOptions {
    pub opacity: Option<f64>,
    pub scale: Option<f64>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub duration: Option<f64>,
    pub delay: Option<f64>,
    pub easing: Option<String>,
}

impl TryFrom<AnimateOptions> for Animate {
    type Error = Error;

    fn try_from(o: AnimateOptions) -> Result<Self> {
        let easing = o.easing.as_deref().map(str::parse).transpose().map_err(napi_error)?;
        Ok(Animate {
            opacity: o.opacity,
            scale: o.scale,
            dx: o.dx,
            dy: o.dy,
            duration_ms: o.duration.unwrap_or(200.0),
            delay_ms: o.delay.unwrap_or(0.0),
            easing,
        })
    }
}

#[napi(object)]
pub struct LaunchOptions {
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

fn napi_error(e: impl ToString) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

#[napi]
impl Shell {
    #[napi(factory)]
    pub fn broker() -> Result<Self> {
        let (handle, stream) = match std::env::var(Self::SHELL_FD) {
            Ok(fd) => (None, Self::inherited(&fd).map_err(napi_error)?),
            Err(_) => {
                let (client, server) = std::os::unix::net::UnixStream::pair().map_err(napi_error)?;
                (Some(Compositor::spawn(server).map_err(napi_error)?), client)
            }
        };
        let events = Arc::new(Inbox::default());
        let link = Link::connect(stream, events.clone()).map_err(napi_error)?;
        Ok(Self { handle, link, events, next_surface: SURFACE_IDS.into() })
    }

    #[napi]
    pub fn grant(&self, options: Option<GrantOptions>) -> Result<SurfaceGrant> {
        use std::hash::{BuildHasher, Hasher};
        let options = options.unwrap_or_default();
        let mode = options.mode.as_deref().map_or(Ok(acde_model::Mode::Free), str::parse).map_err(napi_error)?;
        let desktop = options.desktop.unwrap_or(false);
        let id = match (desktop, options.window) {
            (true, _) => 0,
            (false, Some(id)) => id,
            (false, None) => self.next_surface.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        };
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(id);
        let token = hasher.finish();
        let rect = options.rect.as_deref().and_then(|r| <[i32; 4]>::try_from(r).ok()).filter(|r| r[2] > 0 && r[3] > 0);
        let size = options.size.as_deref().and_then(|s| <[i32; 2]>::try_from(s).ok()).filter(|s| s[0] > 0 && s[1] > 0);
        let [x, y, w, h] = rect.unwrap_or_default();
        let [sw, sh] = size.unwrap_or_default();
        self.link.send(|s| s.grant((token >> 32) as u32, token as u32, id, desktop.into(), mode as u32, x, y, w, h, sw, sh));
        Ok(SurfaceGrant { window: id, token: BigInt::from(token) })
    }

    #[napi]
    pub fn release(&self, window: u32) {
        self.link.send(|s| s.release(window));
    }

    #[napi(getter)]
    pub fn socket_name(&self) -> String {
        match &self.handle {
            Some(handle) => handle.socket_name().to_string_lossy().into_owned(),
            None => std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        }
    }

    #[napi]
    pub fn pump(&self) -> Vec<Event> {
        self.events.drain()
    }

    #[napi]
    pub fn on_events(&self, callback: Function<(), ()>) -> Result<()> {
        let wake = callback.build_threadsafe_function::<()>().callee_handled::<false>().weak::<true>().build()?;
        self.events.set_waker(Some(Arc::new(move || {
            wake.call((), ThreadsafeFunctionCallMode::NonBlocking);
        })));
        Ok(())
    }

    #[napi]
    pub fn launch(&self, argv: Vec<String>, options: Option<LaunchOptions>) -> Result<u32> {
        let (cwd, env) = options.map_or((None, None), |o| (o.cwd, o.env));
        let mut args = Vec::new();
        for a in &argv {
            args.extend_from_slice(a.as_bytes());
            args.push(0);
        }
        let mut vars = Vec::new();
        for (k, v) in env.iter().flatten() {
            vars.extend_from_slice(format!("{k}={v}").as_bytes());
            vars.push(0);
        }
        let cwd = cwd.unwrap_or_default();
        self.link.wait(|s, tx| _ = s.launch(args, cwd, vars, &self.link.qh, tx)).map(|(pid, _)| pid).map_err(napi_error)
    }

    #[napi]
    pub fn stats(&self, reset: Option<bool>) -> Stats {
        self.link.stats(reset.unwrap_or(false))
    }

    #[napi(ts_return_type = "Promise<{ width: number, height: number }>")]
    pub fn screenshot(&self, path: String) -> AsyncTask<Screenshot> {
        AsyncTask::new(Screenshot { rx: self.link.answer(|s, tx| _ = s.screenshot(path, &self.link.qh, tx)) })
    }

    #[napi]
    pub fn focus(&self, window: u32) {
        self.link.send(|s| s.focus(window));
    }

    #[napi]
    pub fn hide(&self, window: u32, hidden: bool) {
        self.link.send(|s| s.hide(window, hidden.into()));
    }

    #[napi]
    pub fn close(&self, window: u32) {
        self.link.send(|s| s.close(window));
    }

    #[napi]
    pub fn place(&self, window: u32, x: i32, y: i32, width: i32, height: i32) {
        self.link.send(|s| s.place(window, x, y, width, height));
    }

    #[napi]
    pub fn windows(&self) -> Vec<WindowRow> {
        self.link.list()
    }

    #[napi]
    pub fn inject(&self, event: InjectEvent) -> Result<()> {
        let event = Injected::try_from(event).map_err(napi_error)?;
        self.link.send(|s| match event {
            Injected::Move(x, y) => s.inject_move(x, y),
            Injected::Motion(dx, dy) => s.inject_motion(dx, dy),
            Injected::Button { button, pressed } => s.inject_button(button, pressed.into()),
            Injected::Wheel { dx, dy, source } => s.inject_wheel(dx, dy, source as u32),
            Injected::Key { code, pressed } => s.inject_key(code, pressed.into()),
        });
        Ok(())
    }

    #[napi]
    pub fn animate(&self, window: u32, options: AnimateOptions) -> Result<()> {
        let a = Animate::try_from(options)?;
        let mut given = Animated::empty();
        let mut take = |flag: Animated, v: Option<f64>| {
            given.set(flag, v.is_some());
            v.unwrap_or(0.0)
        };
        let (opacity, scale, dx, dy) = (take(Animated::Opacity, a.opacity), take(Animated::Scale, a.scale), take(Animated::Dx, a.dx), take(Animated::Dy, a.dy));
        given.set(Animated::Easing, a.easing.is_some());
        let easing = a.easing.unwrap_or(acde_model::Easing::Ease) as u32;
        self.link.send(|s| s.animate(window, given, opacity, scale, dx, dy, a.duration_ms as u32, a.delay_ms as u32, easing));
        Ok(())
    }

    #[napi]
    pub fn shortcut(&self, combo: String, scope: String, owner: u32) -> Result<()> {
        let scope: acde_model::Scope = scope.parse().map_err(napi_error)?;
        self.link.wait(|s, tx| _ = s.shortcut(combo, scope as u32, owner, &self.link.qh, tx)).map(drop).map_err(napi_error)
    }

    #[napi]
    pub fn unshortcut(&self, combo: String, scope: String, owner: u32) -> Result<()> {
        let scope: acde_model::Scope = scope.parse().map_err(napi_error)?;
        self.link.send(|s| s.unshortcut(combo, scope as u32, owner));
        Ok(())
    }

    #[napi]
    pub fn quit(&mut self) {
        self.link.quit();
        if let Some(handle) = self.handle.as_mut() {
            handle.quit();
        }
    }
}

impl Shell {
    const SHELL_FD: &str = "ACDE_SHELL_FD";

    fn inherited(fd: &str) -> std::result::Result<std::os::unix::net::UnixStream, String> {
        use rustix::io::{FdFlags, fcntl_getfd, fcntl_setfd};
        use std::os::fd::{BorrowedFd, FromRawFd, OwnedFd};
        let raw: i32 = fd.parse().map_err(|_| format!("{}={fd}: not an fd", Self::SHELL_FD))?;
        let borrowed = (raw > 2).then(|| unsafe { BorrowedFd::borrow_raw(raw) }).ok_or_else(|| format!("{}={fd}: not an fd", Self::SHELL_FD))?;
        let flags = fcntl_getfd(borrowed).map_err(|e| format!("{}={fd}: {e}", Self::SHELL_FD))?;
        if flags.contains(FdFlags::CLOEXEC) {
            return Err(format!("{}={fd}: already taken", Self::SHELL_FD));
        }
        if !rustix::fs::fstat(borrowed).is_ok_and(|s| rustix::fs::FileType::from_raw_mode(s.st_mode) == rustix::fs::FileType::Socket) {
            return Err(format!("{}={fd}: not a socket", Self::SHELL_FD));
        }
        fcntl_setfd(borrowed, FdFlags::CLOEXEC).map_err(|e| format!("{}={fd}: {e}", Self::SHELL_FD))?;
        Ok(unsafe { OwnedFd::from_raw_fd(raw) }.into())
    }
}

#[napi(object)]
pub struct WindowRow {
    pub id: u32,
    pub window: Option<u32>,
    pub canvas: u32,
    pub mode: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
    pub focus: bool,
    pub hidden: bool,
    pub pid: Option<u32>,
}

#[napi(object)]
pub struct ScreenshotSize {
    pub width: u32,
    pub height: u32,
}

pub struct Screenshot {
    rx: std::sync::mpsc::Receiver<std::result::Result<(u32, u32), String>>,
}

impl Task for Screenshot {
    type Output = (u32, u32);
    type JsValue = ScreenshotSize;

    fn compute(&mut self) -> Result<(u32, u32)> {
        self.rx.recv_timeout(Duration::from_secs(10)).map_err(napi_error)?.map_err(napi_error)
    }

    fn resolve(&mut self, _: Env, (width, height): (u32, u32)) -> Result<ScreenshotSize> {
        Ok(ScreenshotSize { width, height })
    }
}
