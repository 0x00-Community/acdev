use std::collections::HashMap;
use std::sync::Arc;

use crate::{Gpu, Paint, PaintScene as _, RenderCommand, Scene, Vello};
use crate::{GpuImage, ImageSet, image_data};
use kurbo::Affine;
use wgpu::util::DeviceExt;

const MAX_RADIUS: f64 = 256.0;
const USAGE: wgpu::TextureUsages =
    wgpu::TextureUsages::STORAGE_BINDING.union(wgpu::TextureUsages::TEXTURE_BINDING).union(wgpu::TextureUsages::COPY_SRC).union(wgpu::TextureUsages::COPY_DST);

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

impl Overrides {
    pub fn apply(&mut self, vello: &mut vello::Renderer, scene: &Scene) {
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

    pub fn submitted(&mut self) {
        for (image, generation) in self.copying.drain(..) {
            image.mark_copied(generation);
        }
    }

    pub fn forget(&mut self, vello: &mut vello::Renderer) {
        let set = &self.set;
        let gone: Vec<_> = self.seen.iter().filter(|(id, _)| set.find(**id).is_none()).map(|(id, (_, w, h))| (*id, *w, *h)).collect();
        for (id, width, height) in gone {
            self.seen.remove(&id);
            vello.override_image(&image_data(peniko::Blob::from_raw_parts(Arc::new(Vec::<u8>::new()), id), width, height), None);
        }
    }
}

struct Blur {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

pub struct Offscreen {
    pub gpu: Arc<Gpu>,
    vello: Vello,
    overrides: Overrides,
    blur: Option<Blur>,
    filters: HashMap<&'static str, Blur>,
}

impl Offscreen {
    pub fn new(gpu: Arc<Gpu>) -> Result<Self, String> {
        let vello = Vello::new(&gpu.device, &gpu.queue)?;
        let overrides = gpu.images.clone().into();
        Ok(Self { gpu, vello, overrides, blur: None, filters: HashMap::new() })
    }

    pub fn draw(&mut self, scene: Scene, size: (u32, u32), place: Affine) -> Result<Arc<GpuImage>, String> {
        if size.0 == 0 || size.1 == 0 {
            return Err("an empty image".into());
        }
        let texture = crate::texture(&self.gpu.device, size, USAGE, "acde offscreen");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.vello.render([(scene, place)], &mut self.overrides, &view, size, peniko::Color::TRANSPARENT, Some(&self.gpu))?;
        Ok(GpuImage::new(texture, &self.gpu.images))
    }

    pub fn shadow(&mut self, scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Result<Arc<GpuImage>, String> {
        let shape = self.draw(scene, size, place)?;
        Ok(self.blurred(&shape.texture, sigma, color))
    }

    pub fn filtered(&mut self, scene: Scene, size: (u32, u32), place: Affine, filter: &crate::Filter) -> Result<Arc<GpuImage>, String> {
        let mut image = self.draw(scene, size, place)?;
        for effect in filter.effects() {
            image = match *effect {
                crate::FilterEffect::GaussianBlur(b) => self.blur_rgba(&image.texture, f64::from(b.std_deviation)),
                crate::FilterEffect::ColorMatrix(m) => self.color_matrix(&image.texture, &m.0),
                crate::FilterEffect::DropShadow(d) => {
                    let c = d.color.components;
                    let shadow = self.blurred(&image.texture, f64::from(d.std_deviation), c);
                    let mut both = Scene::new();
                    both.draw_image(shadow.brush().as_ref(), Affine::translate((f64::from(d.dx), f64::from(d.dy))));
                    both.draw_image(image.brush().as_ref(), Affine::IDENTITY);
                    self.draw(both, size, Affine::IDENTITY)?
                }
            };
        }
        Ok(image)
    }

    fn filter_pipeline(&mut self, source: &'static str, entry: &'static str) -> (wgpu::ComputePipeline, wgpu::BindGroupLayout) {
        let device = &self.gpu.device;
        let made = self.filters.entry(entry).or_insert_with(|| {
            let module = device
                .create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("acde canvas filter"), source: wgpu::ShaderSource::Wgsl(source.into()) });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("acde canvas filter"),
                layout: None,
                module: &module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            });
            let layout = pipeline.get_bind_group_layout(0);
            Blur { pipeline, layout }
        });
        (made.pipeline.clone(), made.layout.clone())
    }

    fn compute(&mut self, source: &'static str, entry: &'static str, passes: &[(&wgpu::Texture, &wgpu::Texture, Vec<u8>)]) {
        let (pipeline, layout) = self.filter_pipeline(source, entry);
        let device = &self.gpu.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde canvas filter") });
        for (from, to, bytes) in passes {
            let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("acde canvas filter"),
                contents: bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let input = from.create_view(&wgpu::TextureViewDescriptor::default());
            let output = to.create_view(&wgpu::TextureViewDescriptor::default());
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("acde canvas filter"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&input) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&output) },
                    wgpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("acde canvas filter"), timestamp_writes: None });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(from.width().div_ceil(8), from.height().div_ceil(8), 1);
        }
        self.gpu.submit([encoder.finish()]);
    }

    fn blur_rgba(&mut self, src: &wgpu::Texture, sigma: f64) -> Arc<GpuImage> {
        let size = (src.width(), src.height());
        let tmp = crate::texture(&self.gpu.device, size, USAGE, "acde canvas blur");
        let out = crate::texture(&self.gpu.device, size, USAGE, "acde canvas blur");
        let radius = (3.0 * sigma).ceil().clamp(0.0, MAX_RADIUS) as i32;
        let params = |dir: [i32; 2]| {
            let mut bytes = Vec::with_capacity(32);
            for v in [0.0f32, 0.0, 0.0, 0.0, sigma.max(0.01) as f32] {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            for v in [radius].into_iter().chain(dir) {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            bytes
        };
        self.compute(include_str!("blur.wgsl"), "blur_rgba", &[(src, &tmp, params([1, 0])), (&tmp, &out, params([0, 1]))]);
        GpuImage::new(out, &self.gpu.images)
    }

    fn color_matrix(&mut self, src: &wgpu::Texture, m: &[f32; 20]) -> Arc<GpuImage> {
        let out = crate::texture(&self.gpu.device, (src.width(), src.height()), USAGE, "acde canvas color matrix");
        let mut bytes = Vec::with_capacity(80);
        for row in 0..4 {
            for v in &m[row * 5..row * 5 + 4] {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        for row in 0..4 {
            bytes.extend_from_slice(&m[row * 5 + 4].to_le_bytes());
        }
        self.compute(include_str!("matrix.wgsl"), "color_matrix", &[(src, &out, bytes)]);
        GpuImage::new(out, &self.gpu.images)
    }

    pub fn rasterize(&mut self, scene: Scene, (width, height): (u32, u32)) -> Vec<u8> {
        let drawn = self.draw(scene, (width, height), Affine::IDENTITY).and_then(|image| self.gpu.read(&image.texture, [0, 0, width, height]));
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
        let device = &self.gpu.device;
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
        let tmp = crate::texture(&self.gpu.device, size, USAGE, "acde shadow blur");
        let out = crate::texture(&self.gpu.device, size, USAGE, "acde shadow");
        let radius = (3.0 * sigma).ceil().clamp(0.0, MAX_RADIUS) as i32;
        let sigma = sigma.max(0.01) as f32;
        let passes = [(src, &tmp, [1i32, 0], [0.0, 0.0, 0.0, 1.0]), (&tmp, &out, [0, 1], color)];
        let blur = self.blur_pipeline();
        let (pipeline, layout) = (blur.pipeline.clone(), blur.layout.clone());
        let device = &self.gpu.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde shadow blur") });
        for (from, to, dir, color) in passes {
            let mut bytes = Vec::with_capacity(32);
            for v in color.into_iter().chain([sigma]) {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            for v in [radius].into_iter().chain(dir) {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("acde shadow blur"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
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
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("acde shadow blur"), timestamp_writes: None });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(size.0.div_ceil(8), size.1.div_ceil(8), 1);
        }
        self.gpu.submit([encoder.finish()]);
        GpuImage::new(out, &self.gpu.images)
    }
}

impl acde_gpu::Offscreen for Offscreen {
    fn draw(&mut self, scene: Scene, size: (u32, u32), place: Affine) -> Result<Arc<GpuImage>, String> {
        Offscreen::draw(self, scene, size, place)
    }

    fn shadow(&mut self, scene: Scene, size: (u32, u32), place: Affine, sigma: f64, color: [f32; 4]) -> Result<Arc<GpuImage>, String> {
        Offscreen::shadow(self, scene, size, place, sigma, color)
    }

    fn filtered(&mut self, scene: Scene, size: (u32, u32), place: Affine, filter: &crate::Filter) -> Result<Arc<GpuImage>, String> {
        Offscreen::filtered(self, scene, size, place, filter)
    }

    fn rasterize(&mut self, scene: Scene, size: (u32, u32)) -> Vec<u8> {
        Offscreen::rasterize(self, scene, size)
    }
}
