use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, BigInt, Function};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use crate::compositor::{Animate, BTN_LEFT, CanvasInfo, Command, Compositor, Event, Grant, Handle, Inbox, Injected, SURFACE_IDS, Stats, WindowInfo};

#[napi]
pub struct Shell {
    handle: Handle,
    events: Arc<Inbox>,
    next_surface: std::sync::atomic::AtomicU32,
}

#[napi(object)]
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
pub struct InjectEvent {
    #[napi(js_name = "type")]
    pub kind: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub button: Option<u32>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub source: Option<String>,
    pub code: Option<u32>,
}

impl TryFrom<InjectEvent> for Injected {
    type Error = Error;

    fn try_from(e: InjectEvent) -> Result<Self> {
        let need = |v: Option<f64>, name: &str| v.ok_or_else(|| napi_error(format!("inject {}: 缺 {name}", e.kind)));
        let code = || e.code.ok_or_else(|| napi_error(format!("inject {}: 缺 code", e.kind)));
        Ok(match e.kind.as_str() {
            "move" => Self::Move((need(e.x, "x")?, need(e.y, "y")?).into()),
            "motion" => Self::Motion((need(e.dx, "dx")?, need(e.dy, "dy")?).into()),
            "down" | "up" => Self::Button { button: e.button.unwrap_or(BTN_LEFT), pressed: e.kind == "down" },
            "wheel" => {
                use smithay::backend::input::AxisSource;
                let source = match e.source.as_deref() {
                    None | Some("wheel") => AxisSource::Wheel,
                    Some("finger") => AxisSource::Finger,
                    Some("continuous") => AxisSource::Continuous,
                    Some(other) => return Err(napi_error(format!("inject wheel: 不认识的 source {other}"))),
                };
                Self::Wheel { delta: (e.dx.unwrap_or(0.0), e.dy.unwrap_or(0.0)).into(), source }
            }
            "keydown" | "keyup" => Self::Key { code: code()?, pressed: e.kind == "keydown" },
            other => return Err(napi_error(format!("inject: 不认识的 type {other}"))),
        })
    }
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
        Ok(Animate { opacity: o.opacity, scale: o.scale, dx: o.dx, dy: o.dy, duration_ms: o.duration.unwrap_or(200.0), delay_ms: o.delay.unwrap_or(0.0), easing })
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
        let (handle, events) = Compositor::spawn().map_err(napi_error)?;
        Ok(Self { handle, events, next_surface: SURFACE_IDS.into() })
    }

    #[napi]
    pub fn grant(&self, options: Option<GrantOptions>) -> Result<SurfaceGrant> {
        use std::hash::{BuildHasher, Hasher};
        let options = options.unwrap_or(GrantOptions { desktop: None, window: None, mode: None, rect: None, size: None });
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
        self.handle.send(Command::Grant(token, Grant { id, desktop, mode, rect, size }));
        Ok(SurfaceGrant { window: id, token: BigInt::from(token) })
    }

    #[napi]
    pub fn release(&self, window: u32) {
        self.handle.send(Command::Release(window));
    }

    #[napi(getter)]
    pub fn socket_name(&self) -> String {
        self.handle.socket_name().to_string_lossy().into_owned()
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
        self.handle.launch(&argv, cwd.as_deref(), env.iter().flatten()).map_err(napi_error)
    }

    #[napi]
    pub fn stats(&self, reset: Option<bool>) -> Stats {
        let (reply, rx) = std::sync::mpsc::channel();
        self.handle.send(Command::Stats(reset.unwrap_or(false), reply));
        rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default()
    }

    #[napi(ts_return_type = "Promise<{ width: number, height: number }>")]
    pub fn screenshot(&self, path: String) -> AsyncTask<Screenshot> {
        let (reply, rx) = std::sync::mpsc::channel();
        self.handle.send(Command::Screenshot(path.into(), reply));
        AsyncTask::new(Screenshot { rx })
    }

    #[napi]
    pub fn focus(&self, window: u32) {
        self.handle.send(Command::Focus(window));
    }

    #[napi]
    pub fn hide(&self, window: u32, hidden: bool) {
        self.handle.send(Command::Hide { window, hidden });
    }

    #[napi]
    pub fn close(&self, window: u32) {
        self.handle.send(Command::Close(window));
    }

    #[napi]
    pub fn place(&self, window: u32, x: i32, y: i32, width: i32, height: i32) {
        self.handle.send(Command::Place { window, x, y, width, height });
    }

    #[napi]
    pub fn raise(&self, window: u32, above: Option<u32>) {
        self.handle.send(Command::Raise { window, above });
    }

    #[napi]
    pub fn set_mode(&self, window: u32, mode: String) -> Result<()> {
        self.handle.send(Command::SetMode { window, mode: mode.parse().map_err(napi_error)? });
        Ok(())
    }

    #[napi]
    pub fn windows(&self) -> Vec<WindowInfo> {
        self.list().0
    }

    #[napi]
    pub fn canvases(&self) -> Vec<CanvasInfo> {
        self.list().1
    }

    fn list(&self) -> (Vec<WindowInfo>, Vec<CanvasInfo>) {
        let (reply, rx) = std::sync::mpsc::channel();
        self.handle.send(Command::List(reply));
        rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default()
    }

    #[napi]
    pub fn inject(&self, event: InjectEvent) -> Result<()> {
        self.handle.send(Command::Inject(event.try_into()?));
        Ok(())
    }

    #[napi]
    pub fn animate(&self, window: u32, options: AnimateOptions) -> Result<()> {
        self.handle.send(Command::Animate(window, options.try_into()?));
        Ok(())
    }

    #[napi]
    pub fn shortcut(&self, combo: String, scope: String, owner: u32) -> Result<()> {
        let scope = scope.parse().map_err(napi_error)?;
        let (reply, rx) = std::sync::mpsc::channel();
        self.handle.send(Command::Shortcut { combo, scope, owner, reply });
        rx.recv_timeout(Duration::from_millis(500)).map_err(napi_error)?.map_err(napi_error)
    }

    #[napi]
    pub fn unshortcut(&self, combo: String, scope: String, owner: u32) -> Result<()> {
        let scope = scope.parse().map_err(napi_error)?;
        self.handle.send(Command::Unshortcut { combo, scope, owner });
        Ok(())
    }

    #[napi]
    pub fn quit(&mut self) {
        self.handle.quit();
    }
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
