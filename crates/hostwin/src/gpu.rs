use std::sync::Arc;

use acde_render::acgpu::fallback::wgpu;
use acde_render::gpu::Shared;

const BLIT: &str = r"
@group(0) @binding(0) var page: texture_2d<f32>;

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_blit(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    let size = textureDimensions(page);
    let p = min(vec2<u32>(at.xy), size - vec2<u32>(1u, 1u));
    let c = textureLoad(page, p, 0);
    return vec4<f32>(c.rgb, 1.0);
}
";

pub(crate) struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub shared: Arc<Shared>,
    pub layout: wgpu::BindGroupLayout,
    module: wgpu::ShaderModule,
    pipeline_layout: wgpu::PipelineLayout,
    pipelines: std::sync::Mutex<Vec<(wgpu::TextureFormat, wgpu::RenderPipeline)>>,
}

impl Gpu {
    pub fn open() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::PRIMARY))
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
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("acde host blit"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("acde host blit"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("acde host blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT.into()),
        });
        Ok(Self {
            instance,
            adapter,
            shared: Shared::new(device, queue),
            layout,
            module,
            pipeline_layout,
            pipelines: std::sync::Mutex::new(Vec::new()),
        })
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.shared.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.shared.queue
    }

    pub fn blit(&self, format: wgpu::TextureFormat) -> wgpu::RenderPipeline {
        let mut pipelines = self.pipelines.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, p)) = pipelines.iter().find(|(f, _)| *f == format) {
            return p.clone();
        }
        let pipeline = self
            .device()
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("acde host blit"),
                layout: Some(&self.pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &self.module,
                    entry_point: Some("vs_full"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &self.module,
                    entry_point: Some("fs_blit"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        pipelines.push((format, pipeline.clone()));
        pipeline
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
