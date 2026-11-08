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
    let c = textureLoad(page, p, 0);
    return select(c, vec4<f32>(c.rgb * c.a, c.a), place.pad.x > 0.5);
}
";

const DUMP_DELAY: Duration = Duration::from_millis(300);
const SCREENSHOT_WAIT: Duration = Duration::from_secs(10);
const OFFSCREEN: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const BACKGROUND: wgpu::Color = wgpu::Color { r: 0.12, g: 0.12, b: 0.13, a: 1.0 };

pub(crate) struct Page {
    pub size: (u32, u32),
    pub view: wgpu::TextureView,
    pub texture: wgpu::Texture,
    pub straight: std::sync::atomic::AtomicBool,
}

pub(crate) struct Layer {
    pub id: u32,
    pub rect: [f64; 4],
    pub backdrop: Option<([f64; 4], [f64; 4])>,
}

struct Canvas {
    size: (u32, u32),
    texture: wgpu::Texture,
    _place: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

type ShotReply = mpsc::SyncSender<Result<(u32, u32), String>>;

enum Msg {
    Page(u32, Arc<Page>),
    Remove(u32),
    Dirty,
    Resized(u32, u32),
    Screenshot(PathBuf, ShotReply),
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

    pub fn screenshot(&self, path: PathBuf) -> Result<(u32, u32), String> {
        let (reply, got) = mpsc::sync_channel(1);
        self.0.send(Msg::Screenshot(path, reply)).map_err(|_| "the compositor has stopped".to_owned())?;
        got.recv_timeout(SCREENSHOT_WAIT).map_err(|_| "the compositor did not answer".to_owned())?
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

struct Output {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
}

struct Thread {
    gpu: Arc<Gpu>,
    output: Option<Output>,
    size: (u32, u32),
    offscreen: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    dump: Option<PathBuf>,
    dump_at: Option<Instant>,
    pages: HashMap<u32, Bound>,
    composer: acde_gpu::Composer,
    canvas: Option<Canvas>,
}

fn configuration(gpu: &Gpu, surface: &wgpu::Surface<'static>, size: (u32, u32)) -> Result<wgpu::SurfaceConfiguration, String> {
    let caps = surface.get_capabilities(&gpu.adapter);
    let format = [wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba8Unorm]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .or_else(|| caps.formats.iter().copied().find(|f| !f.is_srgb()))
        .or_else(|| caps.formats.first().copied())
        .ok_or("host window surface has no usable format")?;
    let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
        wgpu::CompositeAlphaMode::Opaque
    } else {
        caps.alpha_modes.first().copied().unwrap_or(wgpu::CompositeAlphaMode::Auto)
    };
    Ok(wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        color_space: wgpu::SurfaceColorSpace::Auto,
        width: size.0.max(1),
        height: size.1.max(1),
        desired_maximum_frame_latency: 2,
        present_mode: wgpu::PresentMode::AutoVsync,
        alpha_mode,
        view_formats: vec![],
    })
}

pub(crate) fn start(gpu: Arc<Gpu>, surface: Option<wgpu::Surface<'static>>, size: (u32, u32)) -> Result<(Compositor, JoinHandle<()>), String> {
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
    let output = match surface {
        Some(surface) => {
            let config = configuration(&gpu, &surface, size)?;
            {
                let _lock = gpu.shared.submit_lock();
                surface.configure(device, &config);
            }
            let pipeline = make_pipeline(device, &pipeline_layout, &module, config.format);
            Some(Output { surface, config, pipeline })
        }
        None => None,
    };
    let offscreen = make_pipeline(device, &pipeline_layout, &module, OFFSCREEN);
    let dump = std::env::var_os("ACDE_HOST_DUMP").map(PathBuf::from);
    let (tx, rx) = mpsc::channel();
    let size = (size.0.max(1), size.1.max(1));
    let composer = acde_gpu::Composer::new(device, &gpu.shared.queue);
    let mut thread = Thread { gpu, output, size, offscreen, layout, dump, dump_at: None, pages: HashMap::new(), composer, canvas: None };
    let handle = std::thread::Builder::new().name("acde-compose".into()).spawn(move || thread.run(&rx)).map_err(|e| format!("compose thread: {e}"))?;
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
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
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
                        if (w.max(1), h.max(1)) != self.size {
                            self.size = (w.max(1), h.max(1));
                            self.configure();
                        }
                    }
                    Msg::Screenshot(path, reply) => _ = reply.send(self.screenshot(&path)),
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

    fn prepare(&self) -> Option<Vec<(u32, Option<acde_gpu::Backdrop>)>> {
        let server = server()?;
        let (layers, scale) = {
            let state = server.state();
            (state.layers(), state.screen[2])
        };
        let shown: Vec<&Layer> = layers.iter().filter(|l| self.pages.contains_key(&l.id)).collect();
        let screen = [self.size.0 as f32, self.size.1 as f32];
        for layer in &shown {
            let bound = &self.pages[&layer.id];
            let origin = [(layer.rect[0] * scale).round() as f32, (layer.rect[1] * scale).round() as f32];
            let straight = f32::from(u8::from(bound.page.straight.load(std::sync::atomic::Ordering::Relaxed)));
            let values = [screen[0], screen[1], origin[0], origin[1], bound.page.size.0 as f32, bound.page.size.1 as f32, straight, 0.0];
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_ne_bytes()).collect();
            self.gpu.shared.queue.write_buffer(&bound.place, 0, &bytes);
        }
        let backdrop = |layer: &Layer| {
            let ([x, y, w, h], [radius, blur, saturate, brightness]) = layer.backdrop?;
            let origin = [(layer.rect[0] * scale).round(), (layer.rect[1] * scale).round()];
            let rect = [(origin[0] + x) as f32, (origin[1] + y) as f32, w as f32, h as f32];
            (blur > 0.0 || saturate != 1.0 || brightness != 1.0).then_some(acde_gpu::Backdrop {
                rect,
                radius: radius as f32,
                blur: blur as f32,
                saturate: saturate as f32,
                brightness: brightness as f32,
            })
        };
        Some(shown.iter().map(|l| (l.id, backdrop(l))).collect())
    }

    fn pass<'a>(
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        pipeline: &wgpu::RenderPipeline,
        clear: bool,
        binds: impl IntoIterator<Item = &'a wgpu::BindGroup>,
    ) {
        let load = if clear { wgpu::LoadOp::Clear(BACKGROUND) } else { wgpu::LoadOp::Load };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("acde compose"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipeline);
        for bind in binds {
            pass.set_bind_group(0, bind, &[]);
            pass.draw(0..4, 0..1);
        }
    }

    fn canvas(&mut self) -> wgpu::TextureView {
        let size = self.size;
        if self.canvas.as_ref().is_none_or(|c| c.size != size) {
            let device = &self.gpu.shared.device;
            let usage =
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST;
            let texture = acde_gpu::texture(device, size, usage, "acde compose canvas");
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let place = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("acde compose canvas place"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let screen = [size.0 as f32, size.1 as f32];
            let values = [screen[0], screen[1], 0.0, 0.0, screen[0], screen[1], 0.0, 0.0];
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_ne_bytes()).collect();
            self.gpu.shared.queue.write_buffer(&place, 0, &bytes);
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("acde compose canvas"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                    wgpu::BindGroupEntry { binding: 1, resource: place.as_entire_binding() },
                ],
            });
            self.canvas = Some(Canvas { size, texture, _place: place, bind });
        }
        let canvas = self.canvas.as_ref().expect("made just above");
        canvas.texture.create_view(&wgpu::TextureViewDescriptor::default())
    }

    fn compose(&mut self, encoder: &mut wgpu::CommandEncoder, layers: &[(u32, Option<acde_gpu::Backdrop>)]) -> wgpu::TextureView {
        let canvas = self.canvas();
        let mut from = 0;
        let mut clear = true;
        for (at, (_, backdrop)) in layers.iter().enumerate() {
            let Some(backdrop) = backdrop else { continue };
            Self::pass(encoder, &canvas, &self.offscreen, clear, layers[from..at].iter().map(|(id, _)| &self.pages[id].bind));
            clear = false;
            from = at;
            self.composer.backdrop(encoder, &canvas, backdrop);
        }
        Self::pass(encoder, &canvas, &self.offscreen, clear, layers[from..].iter().map(|(id, _)| &self.pages[id].bind));
        self.composer.flush();
        canvas
    }

    fn configure(&mut self) {
        let size = self.size;
        let Some(output) = self.output.as_mut() else { return };
        output.config.width = size.0;
        output.config.height = size.1;
        let _lock = self.gpu.shared.submit_lock();
        output.surface.configure(&self.gpu.shared.device, &output.config);
    }

    fn draw(&mut self) {
        let Some(ids) = self.prepare() else { return };
        if self.dump.is_some() && self.dump_at.is_none() {
            self.dump_at = Some(Instant::now() + DUMP_DELAY);
        }
        let Some(output) = &self.output else { return };
        let gpu = self.gpu.clone();
        let texture = match output.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.configure();
                return;
            }
            _ => return,
        };
        let target = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu.shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde compose") });
        self.compose(&mut encoder, &ids);
        let (Some(output), Some(canvas)) = (&self.output, &self.canvas) else { return };
        Self::pass(&mut encoder, &target, &output.pipeline, true, [&canvas.bind]);
        gpu.shared.submit([encoder.finish()]);
        self.composer.end_frame();
        gpu.shared.queue.present(texture);
        if let Some(server) = server() {
            server.state().frames += 1;
        }
    }

    fn png(&mut self) -> Result<(u32, u32, Vec<u8>, usize), String> {
        let ids = self.prepare().ok_or("hostwin is not running")?;
        let gpu = self.gpu.clone();
        let (w, h) = self.size;
        let mut encoder = gpu.shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde compose offscreen") });
        self.compose(&mut encoder, &ids);
        gpu.shared.submit([encoder.finish()]);
        self.composer.end_frame();
        let texture = &self.canvas.as_ref().ok_or("no canvas")?.texture;
        let rgba = gpu.shared.read(texture, [0, 0, w, h])?;
        let png = acde_render::encode_png(w, h, &rgba).ok_or("png encoding failed")?;
        Ok((w, h, png, ids.len()))
    }

    fn screenshot(&mut self, path: &std::path::Path) -> Result<(u32, u32), String> {
        let (w, h, png, _) = self.png()?;
        std::fs::write(path, png).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok((w, h))
    }

    fn dump(&mut self) {
        let Some(dir) = self.dump.clone() else { return };
        let _ = std::fs::create_dir_all(&dir);
        match self.png().and_then(|(w, h, png, layers)| std::fs::write(dir.join("screen.png"), png).map(|()| (w, h, layers)).map_err(|e| e.to_string())) {
            Ok((w, h, layers)) => log::info!("ACDE_HOST_DUMP: screen.png {w}x{h}, {layers} layers"),
            Err(e) => log::warn!("ACDE_HOST_DUMP: {e}"),
        }
    }
}
