use std::sync::{Arc, Mutex};

use acde_gpu::{Gpu, GpuImage, Offscreen, Scene};
use kurbo::Affine;

static OFFSCREEN: Mutex<Option<Offscreen>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Offscreen) -> Result<T, String>) -> Option<T> {
    let mut slot = OFFSCREEN.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(Offscreen::new(Gpu::shared()?).inspect_err(|e| log::warn!("render: {e}")).ok()?);
    }
    f(slot.as_mut()?).inspect_err(|e| log::warn!("render: {e}")).ok()
}

pub fn warm() {
    let started = std::time::Instant::now();
    if with(|_| Ok(())).is_some() {
        log::info!("offscreen vello warm-up {:.1}ms", started.elapsed().as_secs_f64() * 1000.0);
    }
}

pub fn draw(scene: Scene, size: (u32, u32), place: Affine) -> Option<Arc<GpuImage>> {
    with(|o| o.draw(scene, size, place))
}

pub fn read(image: &GpuImage, rect: [u32; 4]) -> Option<Vec<u8>> {
    with(|o| o.gpu.read(&image.texture, rect))
}

pub fn write(image: &GpuImage, data: &[u8], size: (u32, u32), from: [u32; 2], to: [u32; 4]) {
    if let Some(gpu) = Gpu::shared() {
        gpu.write(image, data, size, from, to);
    }
}

pub fn shadow(scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Option<Arc<GpuImage>> {
    with(|o| o.shadow(scene, size, place, sigma, color))
}

pub fn rasterize(scene: Scene, size: (u32, u32)) -> Vec<u8> {
    with(|o| Ok(o.rasterize(scene, size))).unwrap_or_else(|| vec![0; (size.0 * size.1 * 4) as usize])
}
