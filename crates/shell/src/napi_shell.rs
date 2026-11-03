use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, BigInt, Function};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use crate::compositor::{Animate, BTN_LEFT, CanvasInfo, Compositor, Event, Grant, Handle, Inbox, Injected, SURFACE_IDS, Stats, WindowInfo};
use crate::link::Link;

#[napi]
pub struct Shell {
    handle: Handle,
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
        let (handle, stream) = Compositor::spawn().map_err(napi_error)?;
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
        self.link.grant(token, Grant { id, desktop, mode, rect, size });
        Ok(SurfaceGrant { window: id, token: BigInt::from(token) })
    }

    #[napi]
    pub fn release(&self, window: u32) {
        self.link.release(window);
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
        self.link.launch(&argv, cwd.as_deref(), env.iter().flatten()).map_err(napi_error)
    }

    #[napi]
    pub fn stats(&self, reset: Option<bool>) -> Stats {
        self.link.stats(reset.unwrap_or(false))
    }

    #[napi(ts_return_type = "Promise<{ width: number, height: number }>")]
    pub fn screenshot(&self, path: String) -> AsyncTask<Screenshot> {
        AsyncTask::new(Screenshot { rx: self.link.screenshot(path) })
    }

    #[napi]
    pub fn focus(&self, window: u32) {
        self.link.focus(window);
    }

    #[napi]
    pub fn hide(&self, window: u32, hidden: bool) {
        self.link.hide(window, hidden);
    }

    #[napi]
    pub fn close(&self, window: u32) {
        self.link.close(window);
    }

    #[napi]
    pub fn place(&self, window: u32, x: i32, y: i32, width: i32, height: i32) {
        self.link.place(window, [x, y, width, height]);
    }

    #[napi]
    pub fn raise(&self, window: u32, above: Option<u32>) {
        self.link.raise(window, above);
    }

    #[napi]
    pub fn set_mode(&self, window: u32, mode: String) -> Result<()> {
        self.link.set_mode(window, mode.parse().map_err(napi_error)?);
        Ok(())
    }

    #[napi]
    pub fn windows(&self) -> Vec<WindowRow> {
        self.link.list().0.into_iter().map(WindowRow::from).collect()
    }

    #[napi]
    pub fn canvases(&self) -> Vec<CanvasInfo> {
        self.link.list().1
    }

    #[napi]
    pub fn inject(&self, event: InjectEvent) -> Result<()> {
        self.link.inject(event.try_into()?);
        Ok(())
    }

    #[napi]
    pub fn animate(&self, window: u32, options: AnimateOptions) -> Result<()> {
        self.link.animate(window, options.try_into()?);
        Ok(())
    }

    #[napi]
    pub fn shortcut(&self, combo: String, scope: String, owner: u32) -> Result<()> {
        let scope = scope.parse().map_err(napi_error)?;
        self.link.shortcut(combo, scope, owner).map_err(napi_error)
    }

    #[napi]
    pub fn unshortcut(&self, combo: String, scope: String, owner: u32) -> Result<()> {
        let scope = scope.parse().map_err(napi_error)?;
        self.link.unshortcut(combo, scope, owner);
        Ok(())
    }

    #[napi]
    pub fn quit(&mut self) {
        self.link.quit();
        self.handle.quit();
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

impl From<WindowInfo> for WindowRow {
    fn from(w: WindowInfo) -> Self {
        Self { id: w.id, window: w.window, canvas: w.canvas, mode: w.mode.as_str().into(), x: w.x, y: w.y, width: w.width, height: w.height, z: w.z, focus: w.focus, hidden: w.hidden, pid: w.pid }
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
