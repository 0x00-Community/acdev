//! The web process's raster thread installs its device ([`install`]); without one (tests), the first use opens one.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use acde_gpu::Scene;
use acde_gpu::Offscreen;
use kurbo::Affine;

pub use acde_gpu::{GpuImage as CanvasImage, Overrides, Shared};

const WAIT: Duration = Duration::from_secs(10);

enum State {
    Unset,
    Expected,
    Ready(Option<Arc<Shared>>),
}

static STATE: Mutex<State> = Mutex::new(State::Unset);
static READY: Condvar = Condvar::new();

pub fn expect() {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(*state, State::Unset) {
        *state = State::Expected;
    }
}

pub fn install(shared: Option<Arc<Shared>>) {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = State::Ready(shared);
    READY.notify_all();
}

pub fn shared() -> Option<Arc<Shared>> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(*state, State::Unset) {
        *state = State::Ready(Shared::open().inspect_err(|e| log::warn!("render: GPU: {e}")).ok());
    }
    let (state, _) = READY.wait_timeout_while(state, WAIT, |s| matches!(s, State::Expected)).unwrap_or_else(|e| e.into_inner());
    match &*state {
        State::Ready(shared) => shared.clone(),
        _ => None,
    }
}

static OFFSCREEN: Mutex<Option<Offscreen>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Offscreen) -> Result<T, String>) -> Option<T> {
    let mut slot = OFFSCREEN.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(Offscreen::new(shared()?).inspect_err(|e| log::warn!("render: {e}")).ok()?);
    }
    f(slot.as_mut()?).inspect_err(|e| log::warn!("render: {e}")).ok()
}

pub fn draw(scene: Scene, size: (u32, u32), place: Affine) -> Option<Arc<CanvasImage>> {
    with(|o| o.draw(scene, size, place))
}

pub fn read(image: &CanvasImage, rect: [u32; 4]) -> Option<Vec<u8>> {
    with(|o| o.shared.read(&image.texture, rect))
}

pub fn write(image: &CanvasImage, data: &[u8], size: (u32, u32), from: [u32; 2], to: [u32; 4]) {
    if let Some(shared) = shared() {
        shared.write(image, data, size, from, to);
    }
}

pub fn shadow(scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Option<Arc<CanvasImage>> {
    with(|o| o.shadow(scene, size, place, sigma, color))
}

pub fn rasterize(scene: Scene, size: (u32, u32), place: Affine) -> Vec<u8> {
    with(|o| Ok(o.rasterize(scene, size, place))).unwrap_or_else(|| vec![0; (size.0 * size.1 * 4) as usize])
}
