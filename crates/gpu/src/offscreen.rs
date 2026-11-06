use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use crate::{Paint, PaintScene, RenderCommand, Scene};
use kurbo::Affine;

use crate::{Images, VelloScene};

const WAIT: Duration = Duration::from_secs(10);
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const MAX_RADIUS: f64 = 256.0;

pub struct Shared {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub images: Arc<ImageSet>,
    submit: Mutex<()>,
}

impl Shared {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Arc<Self> {
        Arc::new(Self { device, queue, images: Arc::default(), submit: Mutex::new(()) })
    }

    pub fn open() -> Result<Arc<Self>, String> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor { backends: crate::BACKEND, ..wgpu::InstanceDescriptor::new_without_display_handle_from_env() });
        let adapter = pollster::block_on(instance.enumerate_adapters(crate::BACKEND))
            .into_iter()
            .filter(|a| a.get_info().device_type != wgpu::DeviceType::Cpu)
            .min_by_key(|a| match a.get_info().device_type {
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => 0,
                _ => 1,
            })
            .ok_or("no GPU")?;
        let desc = wgpu::DeviceDescriptor { label: Some("acde offscreen"), required_limits: adapter.limits(), ..Default::default() };
        let (device, queue) = pollster::block_on(adapter.request_device(&desc)).map_err(|e| format!("opening {}: {e}", adapter.get_info().name))?;
        Ok(Self::new(device, queue))
    }

    pub fn submit_lock(&self) -> MutexGuard<'_, ()> {
        self.submit.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn submit_mutex(&self) -> &Mutex<()> {
        &self.submit
    }

    fn texture(&self, (width, height): (u32, u32), label: &str) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
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

    pub fn write(&self, image: &GpuImage, data: &[u8], (width, height): (u32, u32), from: [u32; 2], [x, y, w, h]: [u32; 4]) {
        if w == 0 || h == 0 || data.len() < (width * height * 4) as usize {
            return;
        }
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &image.texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: u64::from((from[1] * width + from[0]) * 4), bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
    }

    pub fn read(&self, texture: &wgpu::Texture, [x, y, w, h]: [u32; 4]) -> Result<Vec<u8>, String> {
        if w == 0 || h == 0 || x + w > texture.width() || y + h > texture.height() {
            return Err(format!("{w}x{h} at ({x}, {y}) is outside the {}x{} texture", texture.width(), texture.height()));
        }
        let stride = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("acde read back"),
            size: u64::from(stride) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde read back") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(h) },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let index = {
            let _lock = self.submit_lock();
            self.queue.submit([encoder.finish()])
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, move |r| _ = tx.send(r));
        self.device.poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(WAIT) }).map_err(|e| format!("waiting for the read back: {e}"))?;
        rx.recv_timeout(WAIT).map_err(|e| e.to_string())?.map_err(|e| format!("read back: {e}"))?;
        let mapped = slice.get_mapped_range().map_err(|e| format!("read back: {e}"))?;
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for row in mapped.chunks_exact(stride as usize) {
            out.extend_from_slice(&row[..(w * 4) as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(out)
    }
}

#[derive(Default)]
pub struct ImageSet(Mutex<HashMap<u64, Weak<GpuImage>>>);

impl ImageSet {
    fn find(&self, id: u64) -> Option<Arc<GpuImage>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).get(&id)?.upgrade()
    }

    fn is_empty(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

pub struct GpuImage {
    pub texture: wgpu::Texture,
    id: u64,
    set: Weak<ImageSet>,
    generation: AtomicU64,
    copied: AtomicU64,
}

impl AsRef<[u8]> for GpuImage {
    fn as_ref(&self) -> &[u8] {
        &[]
    }
}

impl GpuImage {
    pub fn new(texture: wgpu::Texture, set: &Arc<ImageSet>) -> Arc<Self> {
        let id = peniko::Blob::<u8>::new(Arc::new(Vec::<u8>::new())).id();
        let image = Arc::new(Self { texture, id, set: Arc::downgrade(set), generation: AtomicU64::new(0), copied: AtomicU64::new(0) });
        set.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Arc::downgrade(&image));
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
}

impl Drop for GpuImage {
    fn drop(&mut self) {
        if let Some(set) = self.set.upgrade() {
            set.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
        }
    }
}

pub struct Overrides {
    set: Arc<ImageSet>,
    seen: HashMap<u64, (u64, u32, u32)>,
    copying: Vec<(Arc<GpuImage>, u64)>,
}

impl From<Arc<ImageSet>> for Overrides {
    fn from(set: Arc<ImageSet>) -> Self {
        Self { set, seen: HashMap::new(), copying: Vec::new() }
    }
}

impl Images for Overrides {
    fn apply(&mut self, vello: &mut vello::Renderer, scene: &Scene) {
        if self.set.is_empty() {
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
            let Some(image) = self.set.find(id) else { continue };
            let generation = image.generation();
            match self.seen.get_mut(&id) {
                Some((seen, ..)) if *seen == generation => {}
                Some((seen, ..)) => {
                    *seen = generation;
                    vello.mark_override_image_dirty(&brush.image);
                    self.copying.push((image, generation));
                }
                None => {
                    let texture = wgpu::TexelCopyTextureInfoBase {
                        texture: image.texture.clone(),
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    };
                    vello.override_image(&brush.image, Some(texture));
                    self.seen.insert(id, (generation, brush.image.width, brush.image.height));
                    self.copying.push((image, generation));
                }
            }
        }
    }

    fn submitted(&mut self) {
        for (image, generation) in self.copying.drain(..) {
            image.mark_copied(generation);
        }
    }

    fn forget(&mut self, vello: &mut vello::Renderer) {
        let set = &self.set;
        let gone: Vec<_> = self.seen.iter().filter(|(id, _)| set.find(**id).is_none()).map(|(id, (_, w, h))| (*id, *w, *h)).collect();
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

struct Blur {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

pub struct Offscreen {
    pub shared: Arc<Shared>,
    vello: vello::Renderer,
    scene: vello::Scene,
    overrides: Overrides,
    blur: Option<Blur>,
}

impl Offscreen {
    pub fn new(shared: Arc<Shared>) -> Result<Self, String> {
        let options =
            vello::RendererOptions { use_cpu: false, antialiasing_support: vello::AaSupport::area_only(), num_init_threads: None, pipeline_cache: None };
        let vello = vello::Renderer::new(&shared.device, options).map_err(|e| format!("vello: {e}"))?;
        let overrides = shared.images.clone().into();
        Ok(Self { shared, vello, scene: vello::Scene::new(), overrides, blur: None })
    }

    pub fn draw(&mut self, scene: Scene, (width, height): (u32, u32), place: Affine) -> Result<Arc<GpuImage>, String> {
        if width == 0 || height == 0 {
            return Err("an empty image".into());
        }
        let texture = self.shared.texture((width, height), "acde offscreen");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.overrides.forget(&mut self.vello);
        self.scene.reset();
        self.overrides.apply(&mut self.vello, &scene);
        VelloScene::from(&mut self.scene).append_scene(scene, place);
        VelloScene::keep_atlas(&mut self.scene);
        let params = vello::RenderParams { base_color: peniko::Color::TRANSPARENT, width, height, antialiasing_method: vello::AaConfig::Area };
        let rendered = {
            let _lock = self.shared.submit_lock();
            self.vello.render_to_texture(&self.shared.device, &self.shared.queue, &self.scene, &view, &params)
        };
        self.scene.reset();
        rendered.map_err(|e| format!("vello: {e}"))?;
        self.overrides.submitted();
        Ok(GpuImage::new(texture, &self.shared.images))
    }

    pub fn shadow(&mut self, scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Result<Arc<GpuImage>, String> {
        let shape = self.draw(scene, size, place)?;
        Ok(self.blurred(&shape.texture, sigma, color))
    }

    pub fn rasterize(&mut self, scene: Scene, (width, height): (u32, u32), place: Affine) -> Vec<u8> {
        let drawn = self.draw(scene, (width, height), place).and_then(|image| self.shared.read(&image.texture, [0, 0, width, height]));
        let mut rgba = drawn.unwrap_or_else(|_| vec![0; (width * height * 4) as usize]);
        for px in rgba.as_chunks_mut::<4>().0 {
            let a = u32::from(px[3]);
            for c in &mut px[..3] {
                *c = ((u32::from(*c) * a + 127) / 255) as u8;
            }
        }
        rgba
    }

    fn blur_pipeline(&mut self) -> &Blur {
        let device = &self.shared.device;
        self.blur.get_or_insert_with(|| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("acde shadow blur"),
                source: wgpu::ShaderSource::Wgsl(include_str!("blur.wgsl").into()),
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("acde shadow blur"),
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

    fn blurred(&mut self, src: &wgpu::Texture, sigma: f64, color: [f32; 4]) -> Arc<GpuImage> {
        let size = (src.width(), src.height());
        let tmp = self.shared.texture(size, "acde shadow blur");
        let out = self.shared.texture(size, "acde shadow");
        let radius = (3.0 * sigma).ceil().clamp(0.0, MAX_RADIUS) as i32;
        let sigma = sigma.max(0.01) as f32;
        let passes = [(src, &tmp, [1i32, 0], [0.0, 0.0, 0.0, 1.0]), (&tmp, &out, [0, 1], color)];
        let blur = self.blur_pipeline();
        let (pipeline, layout) = (blur.pipeline.clone(), blur.layout.clone());
        let device = &self.shared.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde shadow blur") });
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
            let params = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("acde shadow blur"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.shared.queue.write_buffer(&params, 0, &bytes);
            let input = from.create_view(&wgpu::TextureViewDescriptor::default());
            let output = to.create_view(&wgpu::TextureViewDescriptor::default());
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("acde shadow blur"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&input) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&output) },
                    wgpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("acde shadow blur"), timestamp_writes: None });
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
        GpuImage::new(out, &self.shared.images)
    }
}
