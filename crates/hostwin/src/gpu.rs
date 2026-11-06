use std::sync::Arc;

use acde_gpu::wgpu;

pub(crate) struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub shared: Arc<acde_gpu::Gpu>,
}

impl Gpu {
    pub fn open() -> Result<Self, String> {
        let (instance, adapter, shared) = acde_gpu::Gpu::open("acde host")?;
        log::info!("网页图层用 {} ({:?}, {:?})", shared.info.name, shared.info.device_type, shared.info.backend);
        Ok(Self { instance, adapter, shared })
    }
}
