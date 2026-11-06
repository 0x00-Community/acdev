use std::sync::Arc;

use acde_gpu::wgpu;
use acde_render::gpu::Shared;

pub(crate) struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub shared: Arc<Shared>,
}

impl Gpu {
    pub fn open() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: acde_gpu::BACKEND,
            ..wgpu::InstanceDescriptor::new_without_display_handle_from_env()
        });
        let adapter = pollster::block_on(instance.enumerate_adapters(acde_gpu::BACKEND))
            .into_iter()
            .filter(|a| a.get_info().device_type != wgpu::DeviceType::Cpu)
            .min_by_key(|a| match a.get_info().device_type {
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => 0,
                _ => 1,
            })
            .ok_or("没有 GPU")?;
        let info = adapter.get_info();
        let desc = wgpu::DeviceDescriptor {
            label: Some("acde host"),
            required_limits: adapter.limits(),
            ..Default::default()
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&desc))
            .map_err(|e| format!("打开 {}: {e}", info.name))?;
        log::info!(
            "网页图层用 {} ({:?}, {:?})",
            info.name,
            info.device_type,
            info.backend
        );
        Ok(Self {
            instance,
            adapter,
            shared: Shared::new(device, queue),
        })
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.shared.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.shared.queue
    }

    pub fn page_texture(&self, (width, height): (u32, u32)) -> wgpu::Texture {
        self.device().create_texture(&wgpu::TextureDescriptor {
            label: Some("acde host page"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }
}
