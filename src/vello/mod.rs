use std::sync::Arc;

use crate::gpu::acgpu::fallback;
use crate::gpu::{Filter, Gpu, GpuImage, Scene};
use kurbo::Affine;

#[cfg(target_os = "linux")]
pub use fallback::Raster;
pub use fallback::{Composer, Op, Overrides, Vello};
pub use {crate::gpu, vello};

pub struct Offscreen(fallback::Offscreen);

impl Offscreen {
    pub fn new(gpu: Arc<Gpu>) -> Result<Self, String> {
        fallback::Offscreen::new(gpu.shared.clone()).map(Self)
    }
}

impl std::ops::Deref for Offscreen {
    type Target = fallback::Offscreen;

    fn deref(&self) -> &fallback::Offscreen {
        &self.0
    }
}

impl std::ops::DerefMut for Offscreen {
    fn deref_mut(&mut self) -> &mut fallback::Offscreen {
        &mut self.0
    }
}

impl crate::gpu::Offscreen for Offscreen {
    fn draw(&mut self, scene: Scene, size: (u32, u32), place: Affine) -> Result<Arc<GpuImage>, String> {
        self.0.draw(scene, size, place)
    }

    fn shadow(&mut self, scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Result<Arc<GpuImage>, String> {
        self.0.shadow(scene, size, place, sigma, color)
    }

    fn filtered(&mut self, scene: Scene, size: (u32, u32), place: Affine, filter: &Filter) -> Result<Arc<GpuImage>, String> {
        self.0.filtered(scene, size, place, filter)
    }

    fn rasterize(&mut self, scene: Scene, size: (u32, u32)) -> Vec<u8> {
        self.0.rasterize(scene, size)
    }
}

pub struct VelloCompositor;

impl crate::gpu::Compositor for VelloCompositor {
    fn offscreen(&self, gpu: Arc<Gpu>) -> Result<Box<dyn crate::gpu::Offscreen>, String> {
        Offscreen::new(gpu).map(|o| Box::new(o) as Box<dyn crate::gpu::Offscreen>)
    }
}
