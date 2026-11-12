mod compose;
mod offscreen;
#[cfg(target_os = "linux")]
mod raster;
mod vello_scene;

use std::sync::Arc;

#[allow(unused_imports)]
pub(crate) use acde_gpu::*;
pub use compose::{Composer, Op};
pub use offscreen::{Offscreen, Overrides};
#[cfg(target_os = "linux")]
pub use raster::Raster;
pub use vello_scene::Vello;
pub use {acde_gpu, vello};

pub struct VelloCompositor;

impl acde_gpu::Compositor for VelloCompositor {
    fn offscreen(&self, gpu: Arc<acde_gpu::Gpu>) -> Result<Box<dyn acde_gpu::Offscreen>, String> {
        Offscreen::new(gpu).map(|o| Box::new(o) as Box<dyn acde_gpu::Offscreen>)
    }
}
