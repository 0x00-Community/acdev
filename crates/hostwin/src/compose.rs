use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use acde_gpu::wgpu;

use crate::app::server;
use crate::gpu::Gpu;

const SHADER: &str = r"
struct Place {
    screen: vec2<f32>,
    origin: vec2<f32>,
    size: vec2<f32>,
    pad: vec2<f32>,
}

@group(0) @binding(0) var page: texture_2d<f32>;
@group(0) @binding(1) var<uniform> place: Place;

@vertex
fn vs_quad(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let corner = vec2<f32>(f32(i & 1u), f32((i >> 1u) & 1u));
    let p = place.origin + corner * place.size;
    return vec4<f32>(p.x / place.screen.x * 2.0 - 1.0, 1.0 - p.y / place.screen.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_quad(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(page));
    let p = clamp(vec2<i32>(floor(at.xy - place.origin)), vec2<i32>(0, 0), size - vec2<i32>(1, 1));
    return textureLoad(page, p, 0);
}
";

const DUMP_DELAY: Duration = Duration::from_millis(300);
const BACKGROUND: wgpu::Color = wgpu::Color { r: 0.12, g: 0.12, b: 0.13, a: 1.0 };

pub(crate) struct Page {
    pub size: (u32, u32),
    pub view: wgpu::TextureView,
    pub texture: wgpu::Texture,
}

pub(crate) struct Layer {
    pub id: u32,
    pub rect: [f64; 4],
}

enum Msg {
    Page(u32, Arc<Page>),
    Remove(u32),
    Dirty,
    Resized(u32, u32),
    Stop,
}

#[derive(Clone)]
pub(crate) struct Compositor(mpsc::Sender<Msg>);

impl Compositor {
    pub fn page(&self, id: u32, page: Arc<Page>) {
        let _ = self.0.send(Msg::Page(id, page));
    }

    pub fn remove(&self, id: u32) {
        let _ = self.0.send(Msg::Remove(id));
    }

    pub fn dirty(&self) {
        let _ = self.0.send(Msg::Dirty);
    }

    pub fn resized(&self, size: (u32, u32)) {
        let _ = self.0.send(Msg::Resized(size.0, size.1));
    }

    pub fn stop(&self) {
        let _ = self.0.send(Msg::Stop);
    }
}

struct Bound {
    page: Arc<Page>,
    place: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

pub(crate) fn drain<T>(rx: &mpsc::Receiver<T>, wait: Option<Duration>) -> Option<Vec<T>> {
    let first = match wait {
        Some(wait) => match rx.recv_timeout(wait) {
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            got => got.ok(),
        },
        None => Some(rx.recv().ok()?),
    };
    Some(first.into_iter().chain(std::iter::from_fn(|| rx.try_recv().ok())).collect())
}

struct Thread {
    gpu: Arc<Gpu>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    dump: Option<(PathBuf, wgpu::RenderPipeline)>,
    dump_at: Option<Instant>,
    pages: HashMap<u32, Bound>,
}

pub(crate) fn start(gpu: Arc<Gpu>, surface: wgpu::Surface<'static>, size: (u32, u32)) -> Result<(Compositor, JoinHandle<()>), String> {
    let caps = surface.get_capabilities(&gpu.adapter);
    let format = [wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba8Unorm]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .or_else(|| caps.formats.iter().copied().find(|f| !f.is_srgb()))
        .or_else(|| caps.formats.first().copied())
        .ok_or("宿主窗口的 surface 没有可用的格式")?;
    let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
        wgpu::CompositeAlphaMode::Opaque
    } else {
        caps.alpha_modes.first().copied().unwrap_or(wgpu::CompositeAlphaMode::Auto)
    };
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        color_space: wgpu::SurfaceColorSpace::Auto,
        width: size.0.max(1),
        height: size.1.max(1),
        desired_maximum_frame_latency: 2,
        present_mode: wgpu::PresentMode::AutoVsync,
        alpha_mode,
        view_formats: vec![],
    };
    {
        let _lock = gpu.shared.submit_lock();
        surface.configure(&gpu.shared.device, &config);
    }
    let device = &gpu.shared.device;
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("acde compose"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: wgpu::BufferSize::new(32) },
                count: None,
            },
        ],
    });
    let pipeline_layout =
        device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("acde compose"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("acde compose"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
    let pipeline = make_pipeline(device, &pipeline_layout, &module, format);
    let dump =
        std::env::var_os("ACDE_HOST_DUMP").map(|dir| (PathBuf::from(dir), make_pipeline(device, &pipeline_layout, &module, wgpu::TextureFormat::Rgba8Unorm)));
    let (tx, rx) = mpsc::channel();
    let mut thread = Thread { gpu, surface, config, pipeline, layout, dump, dump_at: None, pages: HashMap::new() };
    let handle = std::thread::Builder::new().name("acde-compose".into()).spawn(move || thread.run(&rx)).map_err(|e| format!("合成线程: {e}"))?;
    Ok((Compositor(tx), handle))
}

fn make_pipeline(device: &wgpu::Device, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, format: wgpu::TextureFormat) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("acde compose"),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some("vs_quad"), compilation_options: Default::default(), buffers: &[] },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some("fs_quad"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
        }),
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

impl Thread {
    fn run(&mut self, rx: &mpsc::Receiver<Msg>) {
        while let Some(msgs) = drain(rx, self.dump_at.map(|at| at.saturating_duration_since(Instant::now()))) {
            if msgs.is_empty() {
                self.dump_at = None;
                self.dump();
                continue;
            }
            for msg in msgs {
                match msg {
                    Msg::Page(id, page) => _ = self.pages.insert(id, self.bind(page)),
                    Msg::Remove(id) => _ = self.pages.remove(&id),
                    Msg::Dirty => {}
                    Msg::Resized(w, h) => {
                        if (w, h) != (self.config.width, self.config.height) {
                            self.config.width = w.max(1);
                            self.config.height = h.max(1);
                            self.configure();
                        }
                    }
                    Msg::Stop => return,
                }
            }
            self.draw();
        }
    }

    fn bind(&self, page: Arc<Page>) -> Bound {
        let device = &self.gpu.shared.device;
        let place = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("acde compose place"),
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("acde compose page"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&page.view) },
                wgpu::BindGroupEntry { binding: 1, resource: place.as_entire_binding() },
            ],
        });
        Bound { page, place, bind }
    }

    fn prepare(&self) -> Option<Vec<u32>> {
        let server = server()?;
        let (layers, scale) = {
            let state = server.state();
            (state.layers(), state.screen[2])
        };
        let shown: Vec<&Layer> = layers.iter().filter(|l| self.pages.contains_key(&l.id)).collect();
        let screen = [self.config.width as f32, self.config.height as f32];
        for layer in &shown {
            let bound = &self.pages[&layer.id];
            let origin = [(layer.rect[0] * scale).round() as f32, (layer.rect[1] * scale).round() as f32];
            let values = [screen[0], screen[1], origin[0], origin[1], bound.page.size.0 as f32, bound.page.size.1 as f32, 0.0, 0.0];
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_ne_bytes()).collect();
            self.gpu.shared.queue.write_buffer(&bound.place, 0, &bytes);
        }
        Some(shown.iter().map(|l| l.id).collect())
    }

    fn pass(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, ids: &[u32]) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("acde compose"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(BACKGROUND), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipeline);
        for id in ids {
            pass.set_bind_group(0, &self.pages[id].bind, &[]);
            pass.draw(0..4, 0..1);
        }
    }

    fn configure(&self) {
        let _lock = self.gpu.shared.submit_lock();
        self.surface.configure(&self.gpu.shared.device, &self.config);
    }

    fn draw(&mut self) {
        let Some(ids) = self.prepare() else { return };
        let gpu = self.gpu.clone();
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.configure();
                return;
            }
            _ => return,
        };
        let target = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu.shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde compose") });
        self.pass(&mut encoder, &target, &self.pipeline, &ids);
        gpu.shared.submit([encoder.finish()]);
        gpu.shared.queue.present(texture);
        if let Some(server) = server() {
            server.state().frames += 1;
        }
        if self.dump.is_some() && self.dump_at.is_none() {
            self.dump_at = Some(Instant::now() + DUMP_DELAY);
        }
    }

    fn dump(&mut self) {
        let Some(ids) = self.prepare() else { return };
        let Some((dir, pipeline)) = &self.dump else { return };
        let gpu = self.gpu.clone();
        let (w, h) = (self.config.width, self.config.height);
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
        let texture = acde_gpu::texture(&gpu.shared.device, (w, h), usage, "acde compose dump");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu.shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde compose dump") });
        self.pass(&mut encoder, &view, pipeline, &ids);
        gpu.shared.submit([encoder.finish()]);
        let written =
            gpu.shared.read(&texture, [0, 0, w, h]).and_then(|rgba| acde_render::encode_png(w, h, &rgba).ok_or_else(|| "png".to_owned())).and_then(|png| {
                let _ = std::fs::create_dir_all(dir);
                std::fs::write(dir.join("screen.png"), png).map_err(|e| e.to_string())
            });
        match written {
            Ok(()) => log::info!("ACDE_HOST_DUMP: screen.png {w}x{h}, {} layers", ids.len()),
            Err(e) => log::warn!("ACDE_HOST_DUMP: {e}"),
        }
    }
}
