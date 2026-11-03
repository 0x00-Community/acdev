use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use anyrender::recording::RenderCommand;
use anyrender::{Paint, PaintScene, Scene};
use anyrender_vello::{VelloScenePainter, wgpu};
use kurbo::Affine;

const WAIT: Duration = Duration::from_secs(10);
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const MAX_RADIUS: f64 = 256.0;

pub struct Shared {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    submit: Mutex<()>,
}

impl Shared {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Arc<Self> {
        Arc::new(Self { device, queue, submit: Mutex::new(()) })
    }

    pub fn submit_lock(&self) -> MutexGuard<'_, ()> {
        self.submit.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn open() -> Option<Arc<Self>> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::PRIMARY, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::PRIMARY))
            .into_iter()
            .filter(|a| a.get_info().device_type != wgpu::DeviceType::Cpu)
            .min_by_key(|a| match a.get_info().device_type {
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => 0,
                _ => 1,
            });
        let Some(adapter) = adapter else {
            log::warn!("render: 没有 GPU");
            return None;
        };
        let desc = wgpu::DeviceDescriptor { label: Some("acde render"), required_limits: adapter.limits(), ..Default::default() };
        match pollster::block_on(adapter.request_device(&desc)) {
            Ok((device, queue)) => Some(Self::new(device, queue)),
            Err(e) => {
                log::warn!("render: 打开 GPU {}: {e}", adapter.get_info().name);
                None
            }
        }
    }
}

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
        *state = State::Ready(Shared::open());
    }
    let (state, _) = READY.wait_timeout_while(state, WAIT, |s| matches!(s, State::Expected)).unwrap_or_else(|e| e.into_inner());
    match &*state {
        State::Ready(shared) => shared.clone(),
        _ => None,
    }
}

pub struct CanvasImage {
    pub texture: wgpu::Texture,
    id: u64,
    generation: AtomicU64,
    copied: AtomicU64,
}

static IMAGES: Mutex<Option<HashMap<u64, Weak<CanvasImage>>>> = Mutex::new(None);
static IMAGE_COUNT: AtomicUsize = AtomicUsize::new(0);

impl AsRef<[u8]> for CanvasImage {
    fn as_ref(&self) -> &[u8] {
        &[]
    }
}

impl CanvasImage {
    pub fn new(texture: wgpu::Texture) -> Arc<Self> {
        let id = peniko::Blob::<u8>::new(Arc::new(Vec::<u8>::new())).id();
        let image = Arc::new(Self { texture, id, generation: AtomicU64::new(0), copied: AtomicU64::new(0) });
        IMAGES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_default().insert(id, Arc::downgrade(&image));
        IMAGE_COUNT.fetch_add(1, Ordering::Relaxed);
        image
    }

    pub fn image(self: &Arc<Self>) -> peniko::ImageData {
        peniko::ImageData {
            data: peniko::Blob::from_raw_parts(self.clone(), self.id),
            format: peniko::ImageFormat::Rgba8,
            alpha_type: peniko::ImageAlphaType::Alpha,
            width: self.texture.width(),
            height: self.texture.height(),
        }
    }

    pub fn brush(self: &Arc<Self>) -> peniko::ImageBrush {
        peniko::ImageBrush { image: self.image(), sampler: peniko::ImageSampler::default() }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn painted(&self) {
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn copied(&self) -> bool {
        self.copied.load(Ordering::Acquire) >= self.generation()
    }

    fn mark_copied(&self, generation: u64) {
        self.copied.fetch_max(generation, Ordering::Release);
    }

    pub fn find(id: u64) -> Option<Arc<Self>> {
        if IMAGE_COUNT.load(Ordering::Relaxed) == 0 {
            return None;
        }
        IMAGES.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(&id)?.upgrade()
    }

    pub fn any() -> bool {
        IMAGE_COUNT.load(Ordering::Relaxed) > 0
    }
}

impl Drop for CanvasImage {
    fn drop(&mut self) {
        if let Some(images) = IMAGES.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            images.remove(&self.id);
        }
        IMAGE_COUNT.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct Overrides {
    seen: HashMap<u64, (u64, u32, u32)>,
    copying: Vec<(Arc<CanvasImage>, u64)>,
}

impl Overrides {
    pub fn apply(&mut self, vello: &mut vello::Renderer, scene: &Scene) {
        if !CanvasImage::any() {
            return;
        }
        for command in &scene.commands {
            let brush = match command {
                RenderCommand::Fill(c) => &c.brush,
                RenderCommand::Stroke(c) => &c.brush,
                RenderCommand::GlyphRun(c) => &c.brush,
                _ => continue,
            };
            let Paint::Image(brush) = brush else { continue };
            let id = brush.image.data.id();
            let Some(canvas) = CanvasImage::find(id) else { continue };
            let generation = canvas.generation();
            match self.seen.get_mut(&id) {
                Some((seen, ..)) if *seen == generation => {}
                Some((seen, ..)) => {
                    *seen = generation;
                    vello.mark_override_image_dirty(&brush.image);
                    self.copying.push((canvas, generation));
                }
                None => {
                    let texture = wgpu::TexelCopyTextureInfoBase { texture: canvas.texture.clone(), mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
                    vello.override_image(&brush.image, Some(texture));
                    self.seen.insert(id, (generation, brush.image.width, brush.image.height));
                    self.copying.push((canvas, generation));
                }
            }
        }
    }

    pub fn submitted(&mut self) {
        for (canvas, generation) in self.copying.drain(..) {
            canvas.mark_copied(generation);
        }
    }

    pub fn forget(&mut self, vello: &mut vello::Renderer) {
        if self.seen.is_empty() {
            return;
        }
        let gone: Vec<_> = self.seen.iter().filter(|(id, _)| CanvasImage::find(**id).is_none()).map(|(id, (_, w, h))| (*id, *w, *h)).collect();
        for (id, width, height) in gone {
            self.seen.remove(&id);
            let image = peniko::ImageData {
                data: peniko::Blob::from_raw_parts(Arc::new(Vec::<u8>::new()), id),
                format: peniko::ImageFormat::Rgba8,
                alpha_type: peniko::ImageAlphaType::Alpha,
                width,
                height,
            };
            vello.override_image(&image, None);
        }
    }
}

pub fn keep_atlas(scene: &mut vello::Scene) {
    let clear = peniko::Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops([peniko::Color::TRANSPARENT, peniko::Color::TRANSPARENT]);
    scene.fill(peniko::Fill::NonZero, Affine::IDENTITY, &clear, None, &kurbo::Rect::new(0.0, 0.0, 1.0, 1.0));
}

struct Blur {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

struct Offscreen {
    shared: Arc<Shared>,
    vello: vello::Renderer,
    scene: vello::Scene,
    overrides: Overrides,
    blur: Option<Blur>,
}

static OFFSCREEN: Mutex<Option<Offscreen>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Offscreen) -> Option<T>) -> Option<T> {
    let mut slot = OFFSCREEN.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        let shared = shared()?;
        let options = vello::RendererOptions { use_cpu: false, antialiasing_support: vello::AaSupport::area_only(), num_init_threads: None, pipeline_cache: None };
        match vello::Renderer::new(&shared.device, options) {
            Ok(vello) => *slot = Some(Offscreen { shared, vello, scene: vello::Scene::new(), overrides: Overrides::default(), blur: None }),
            Err(e) => {
                log::warn!("render: vello: {e}");
                return None;
            }
        }
    }
    f(slot.as_mut()?)
}

pub fn draw(scene: Scene, (width, height): (u32, u32), place: Affine) -> Option<Arc<CanvasImage>> {
    with(|o| o.draw(scene, (width, height), place))
}

pub fn read(image: &CanvasImage, rect: [u32; 4]) -> Option<Vec<u8>> {
    with(|o| o.read(&image.texture, rect))
}

pub fn write(image: &CanvasImage, data: &[u8], (width, height): (u32, u32), from: [u32; 2], to: [u32; 4]) {
    let Some(shared) = shared() else { return };
    let [x, y, w, h] = to;
    if w == 0 || h == 0 || data.len() < (width * height * 4) as usize {
        return;
    }
    shared.queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &image.texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
        data,
        wgpu::TexelCopyBufferLayout { offset: u64::from((from[1] * width + from[0]) * 4), bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

pub fn shadow(scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Option<Arc<CanvasImage>> {
    with(|o| {
        let shape = o.draw(scene, size, place)?;
        o.blurred(&shape.texture, sigma, color)
    })
}

pub fn rasterize(scene: Scene, (width, height): (u32, u32), place: Affine) -> Vec<u8> {
    let mut rgba = draw(scene, (width, height), place).and_then(|image| read(&image, [0, 0, width, height])).unwrap_or_else(|| vec![0; (width * height * 4) as usize]);
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * a + 127) / 255) as u8;
        }
    }
    rgba
}

impl Offscreen {
    fn texture(&self, (width, height): (u32, u32), label: &str) -> wgpu::Texture {
        self.shared.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }

    fn draw(&mut self, scene: Scene, (width, height): (u32, u32), place: Affine) -> Option<Arc<CanvasImage>> {
        if width == 0 || height == 0 {
            return None;
        }
        let texture = self.texture((width, height), "acde canvas");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.overrides.forget(&mut self.vello);
        self.scene.reset();
        self.overrides.apply(&mut self.vello, &scene);
        VelloScenePainter::new(&mut self.scene).append_scene(scene, place);
        keep_atlas(&mut self.scene);
        let params = vello::RenderParams { base_color: peniko::Color::TRANSPARENT, width, height, antialiasing_method: vello::AaConfig::Area };
        let rendered = {
            let _lock = self.shared.submit_lock();
            self.vello.render_to_texture(&self.shared.device, &self.shared.queue, &self.scene, &view, &params)
        };
        self.scene.reset();
        if let Err(e) = rendered {
            log::warn!("render: vello 渲染: {e}");
            return None;
        }
        self.overrides.submitted();
        Some(CanvasImage::new(texture))
    }

    fn read(&self, texture: &wgpu::Texture, [x, y, w, h]: [u32; 4]) -> Option<Vec<u8>> {
        let (device, queue) = (&self.shared.device, &self.shared.queue);
        if w == 0 || h == 0 || x + w > texture.width() || y + h > texture.height() {
            return None;
        }
        let stride = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("acde canvas read"),
            size: u64::from(stride) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde canvas read") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(h) } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let index = {
            let _lock = self.shared.submit_lock();
            queue.submit([encoder.finish()])
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, move |r| _ = tx.send(r));
        if let Err(e) = device.poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(WAIT) }) {
            log::warn!("render: 等读回: {e}");
        }
        if let Err(e) = rx.recv_timeout(WAIT).map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())) {
            log::warn!("render: 读回: {e}");
            return None;
        }
        let mapped = match slice.get_mapped_range() {
            Ok(mapped) => mapped,
            Err(e) => {
                log::warn!("render: 读回: {e}");
                return None;
            }
        };
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for row in mapped.chunks_exact(stride as usize) {
            out.extend_from_slice(&row[..(w * 4) as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Some(out)
    }

    fn blur_pipeline(&mut self) -> &Blur {
        let device = &self.shared.device;
        self.blur.get_or_insert_with(|| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("acde canvas blur"), source: wgpu::ShaderSource::Wgsl(include_str!("blur.wgsl").into()) });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("acde canvas blur"),
                layout: None,
                module: &module,
                entry_point: Some("blur"),
                compilation_options: Default::default(),
                cache: None,
            });
            let layout = pipeline.get_bind_group_layout(0);
            Blur { pipeline, layout }
        })
    }

    fn blurred(&mut self, src: &wgpu::Texture, sigma: f64, color: [f32; 4]) -> Option<Arc<CanvasImage>> {
        let size = (src.width(), src.height());
        let tmp = self.texture(size, "acde canvas blur");
        let out = self.texture(size, "acde canvas shadow");
        let radius = (3.0 * sigma).ceil().clamp(0.0, MAX_RADIUS) as i32;
        let sigma = sigma.max(0.01) as f32;
        let passes = [(src, &tmp, [1i32, 0], [0.0, 0.0, 0.0, 1.0]), (&tmp, &out, [0, 1], color)];
        let blur = self.blur_pipeline();
        let (pipeline, layout) = (blur.pipeline.clone(), blur.layout.clone());
        let device = &self.shared.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde canvas blur") });
        let mut keep = Vec::new();
        for (from, to, dir, color) in passes {
            let mut bytes = Vec::with_capacity(32);
            for v in color {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            bytes.extend_from_slice(&sigma.to_le_bytes());
            bytes.extend_from_slice(&radius.to_le_bytes());
            for v in dir {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let params = device.create_buffer(&wgpu::BufferDescriptor { label: Some("acde canvas blur"), size: 32, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            self.shared.queue.write_buffer(&params, 0, &bytes);
            let input = from.create_view(&wgpu::TextureViewDescriptor::default());
            let output = to.create_view(&wgpu::TextureViewDescriptor::default());
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("acde canvas blur"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&input) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&output) },
                    wgpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("acde canvas blur"), timestamp_writes: None });
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(size.0.div_ceil(8), size.1.div_ceil(8), 1);
            }
            keep.push(params);
        }
        {
            let _lock = self.shared.submit_lock();
            self.shared.queue.submit([encoder.finish()]);
        }
        drop(keep);
        Some(CanvasImage::new(out))
    }
}
