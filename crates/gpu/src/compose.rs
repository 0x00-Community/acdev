use std::collections::HashMap;

use acde_model::Blur;

use crate::ColorMatrix;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Px {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Px {
    pub fn sized((w, h): (u32, u32)) -> Self {
        Self { x: 0, y: 0, w: w as i32, h: h as i32 }
    }

    pub fn covering([x, y, w, h]: [f32; 4]) -> Self {
        let (x0, y0) = (x.floor() as i32, y.floor() as i32);
        Self { x: x0, y: y0, w: (x + w).ceil() as i32 - x0, h: (y + h).ceil() as i32 - y0 }
    }

    pub fn grown(self, m: i32) -> Self {
        Self { x: self.x - m, y: self.y - m, w: self.w + 2 * m, h: self.h + 2 * m }
    }

    pub fn intersection(self, o: Self) -> Option<Self> {
        let (x0, y0) = (self.x.max(o.x), self.y.max(o.y));
        let (x1, y1) = ((self.x + self.w).min(o.x + o.w), (self.y + self.h).min(o.y + o.h));
        (x1 > x0 && y1 > y0).then_some(Self { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }

    pub fn union(self, o: Self) -> Self {
        let (x0, y0) = (self.x.min(o.x), self.y.min(o.y));
        let (x1, y1) = ((self.x + self.w).max(o.x + o.w), (self.y + self.h).max(o.y + o.h));
        Self { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    pub fn contains(self, o: Self) -> bool {
        o.x >= self.x && o.y >= self.y && o.x + o.w <= self.x + self.w && o.y + o.h <= self.y + self.h
    }

    pub fn area(self) -> i64 {
        i64::from(self.w.max(0)) * i64::from(self.h.max(0))
    }

    pub fn overlaps(self, o: Self) -> bool {
        self.intersection(o).is_some()
    }

    pub fn xywh(self) -> [u32; 4] {
        [self.x, self.y, self.w, self.h].map(|v| v.max(0) as u32)
    }

    fn of([x, y, w, h]: [u32; 4]) -> Self {
        Self { x: x as i32, y: y as i32, w: w as i32, h: h as i32 }
    }
}

pub fn reach(shadows: &[Shadow], effect: &Effect) -> i32 {
    let shadows = shadows.iter().map(|s| (s.dx.abs().max(s.dy.abs()) + 4.0 * s.blur).ceil() as i32).max().unwrap_or(0);
    shadows.max((3.0 * effect.blur).ceil() as i32)
}

#[derive(Clone, Copy, Debug)]
pub struct Backdrop {
    pub rect: [f32; 4],
    pub radius: f32,
    pub effect: Effect,
}

#[derive(Clone, Copy, Debug)]
pub struct Shadow {
    pub dx: f32,
    pub dy: f32,
    pub blur: f32,
    pub color: [f32; 4],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Effect {
    pub blur: f32,
    pub matrix: Option<[f32; 20]>,
}

impl Effect {
    pub fn is_none(&self) -> bool {
        self.blur <= 0.0 && self.matrix.is_none()
    }

    pub fn blur(&mut self, sigma: f32) {
        self.blur = self.blur.hypot(sigma);
    }

    pub fn matrix(&mut self, m: [f32; 20]) {
        let a = self.matrix.unwrap_or(ColorMatrix::IDENTITY.0);
        self.matrix = Some(std::array::from_fn(|k| {
            let (i, j) = (k / 5, k % 5);
            (0..4).map(|t| m[i * 5 + t] * a[t * 5 + j]).sum::<f32>() + if j == 4 { m[i * 5 + 4] } else { 0.0 }
        }));
    }

    fn columns(&self) -> ([f32; 16], [f32; 4]) {
        let m = self.matrix.unwrap_or(ColorMatrix::IDENTITY.0);
        (std::array::from_fn(|k| m[(k % 4) * 5 + k / 4]), [m[4], m[9], m[14], m[19]])
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Params {
    texel: [f32; 2],
    offset: f32,
    spare0: f32,
    rect: [f32; 4],
    radius: f32,
    spare1: f32,
    shift: [f32; 2],
    color: [f32; 4],
    matrix: [f32; 16],
    bias: [f32; 4],
}

impl Params {
    const SIZE: u64 = 144;

    fn bytes(&self) -> [u8; Self::SIZE as usize] {
        let head = [
            self.texel[0],
            self.texel[1],
            self.offset,
            self.spare0,
            self.rect[0],
            self.rect[1],
            self.rect[2],
            self.rect[3],
            self.radius,
            self.spare1,
            self.shift[0],
            self.shift[1],
        ];
        let f = head.iter().chain(&self.color).chain(&self.matrix).chain(&self.bias);
        let mut out = [0u8; Self::SIZE as usize];
        for (chunk, v) in out.as_chunks_mut::<4>().0.iter_mut().zip(f) {
            *chunk = v.to_le_bytes();
        }
        out
    }
}

const KEEP_FRAMES: u64 = 8;
const CACHE_BYTES: u64 = 96 << 20;
const MAX_BINDS: usize = 256;

#[derive(Clone, Copy)]
enum Pipe {
    Down,
    Up,
    Backdrop,
    Shadow,
    Place,
    Flatten,
    Filter,
    Clear,
    Mix,
}

struct Draw<'a> {
    pipe: Pipe,
    src: &'a wgpu::TextureView,
    params: Params,
    scissor: Option<[u32; 4]>,
    mix: Option<f32>,
}

struct Cached {
    levels: Vec<(wgpu::Texture, wgpu::TextureView)>,
    bytes: u64,
    used: u64,
}

struct Uniforms {
    buffer: wgpu::Buffer,
    capacity: u64,
    stride: u64,
    pending: Vec<u8>,
}

pub struct Composer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pipelines: Vec<wgpu::RenderPipeline>,
    layer: Option<((u32, u32), wgpu::Texture, wgpu::TextureView)>,
    uniforms: Uniforms,
    binds: HashMap<wgpu::TextureView, (wgpu::BindGroup, u64)>,
    textures: HashMap<(u32, u32, u32), Cached>,
    frame: u64,
}

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

impl Composer {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("acde compose"),
            source: wgpu::ShaderSource::Wgsl(include_str!("compose.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("acde compose"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(Params::SIZE),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("acde compose"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let over = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let toward = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Constant,
            dst_factor: wgpu::BlendFactor::OneMinusConstant,
            operation: wgpu::BlendOperation::Add,
        };
        let mix = wgpu::BlendState { color: toward, alpha: toward };
        let pipeline = |entry: &str, blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let pipelines = vec![
            pipeline("fs_down", None),
            pipeline("fs_up", None),
            pipeline("fs_backdrop", Some(over)),
            pipeline("fs_shadow", Some(over)),
            pipeline("fs_place", Some(over)),
            pipeline("fs_place", None),
            pipeline("fs_filter", Some(over)),
            pipeline("fs_clear", None),
            pipeline("fs_up", Some(mix)),
        ];
        let stride = Params::SIZE.next_multiple_of(u64::from(device.limits().min_uniform_buffer_offset_alignment));
        Self {
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("acde compose"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            uniforms: Uniforms { buffer: Self::uniform_buffer(device, 64 * stride), capacity: 64, stride, pending: Vec::new() },
            device: device.clone(),
            queue: queue.clone(),
            pipelines,
            layout,
            layer: None,
            binds: HashMap::new(),
            textures: HashMap::new(),
            frame: 0,
        }
    }

    fn uniform_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("acde compose params"),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    pub fn layer_view(&mut self, size: (u32, u32)) -> wgpu::TextureView {
        if self.layer.as_ref().is_none_or(|(s, _, _)| *s != size) {
            let usage =
                wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST;
            let texture = crate::texture(&self.device, size, usage, "acde layer");
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.layer = Some((size, texture, view));
        }
        self.layer.as_ref().map(|(_, _, v)| v.clone()).expect("made just above")
    }

    fn push(&mut self, params: &Params) -> u32 {
        let u = &mut self.uniforms;
        let index = u.pending.len() as u64 / u.stride;
        if index == u.capacity {
            self.queue.write_buffer(&u.buffer, 0, &u.pending);
            u.pending.clear();
            u.capacity *= 2;
            u.buffer = Self::uniform_buffer(&self.device, u.capacity * u.stride);
            self.binds.clear();
            return self.push(params);
        }
        u.pending.extend_from_slice(&params.bytes());
        u.pending.resize(((index + 1) * u.stride) as usize, 0);
        (index * u.stride) as u32
    }

    fn bind(&mut self, src: &wgpu::TextureView) -> wgpu::BindGroup {
        if self.binds.len() >= MAX_BINDS && !self.binds.contains_key(src) {
            self.binds.clear();
        }
        let frame = self.frame;
        let (layout, sampler, buffer, device) = (&self.layout, &self.sampler, &self.uniforms.buffer, &self.device);
        let entry = self.binds.entry(src.clone()).or_insert_with(|| {
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("acde compose"),
                layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer, offset: 0, size: wgpu::BufferSize::new(Params::SIZE) }),
                    },
                ],
            });
            (group, frame)
        });
        entry.1 = frame;
        entry.0.clone()
    }

    pub fn flush(&mut self) {
        let u = &mut self.uniforms;
        if !u.pending.is_empty() {
            self.queue.write_buffer(&u.buffer, 0, &u.pending);
            u.pending.clear();
        }
    }

    pub fn end_frame(&mut self) {
        let frame = self.frame;
        self.binds.retain(|_, (_, used)| *used + KEEP_FRAMES > frame);
        self.textures.retain(|_, c| c.used + KEEP_FRAMES > frame);
        self.frame += 1;
    }

    pub fn trim(&mut self) {
        self.binds.clear();
        self.textures.clear();
        self.layer = None;
        let _ = self.device.poll(wgpu::PollType::Poll);
    }

    fn pass(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, clear: bool, draws: &[Draw]) {
        if draws.is_empty() && !clear {
            return;
        }
        let prepared: Vec<(wgpu::BindGroup, u32, &Draw)> = draws
            .iter()
            .map(|d| {
                let offset = self.push(&d.params);
                (self.bind(d.src), offset, d)
            })
            .collect();
        let load = if clear { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) } else { wgpu::LoadOp::Load };
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
        let size = target.texture().size();
        for (bind, offset, d) in &prepared {
            pass.set_pipeline(&self.pipelines[d.pipe as usize]);
            pass.set_bind_group(0, bind, &[*offset]);
            if let Some(mix) = d.mix {
                let m = f64::from(mix);
                pass.set_blend_constant(wgpu::Color { r: m, g: m, b: m, a: m });
            }
            let [x, y, w, h] = d.scissor.unwrap_or([0, 0, size.width, size.height]);
            pass.set_scissor_rect(x, y, w, h);
            pass.draw(0..3, 0..1);
        }
    }

    pub fn clear(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView) {
        self.pass(encoder, canvas, true, &[]);
    }

    fn region(rect: [f32; 4], size: wgpu::Extent3d) -> Option<[u32; 4]> {
        let x0 = rect[0].max(0.0).floor() as u32;
        let y0 = rect[1].max(0.0).floor() as u32;
        let x1 = ((rect[0] + rect[2]).max(0.0).ceil() as u32).min(size.width);
        let y1 = ((rect[1] + rect[3]).max(0.0).ceil() as u32).min(size.height);
        (x1 > x0 + 1 && y1 > y0 + 1).then(|| [x0, y0, x1 - x0, y1 - y0])
    }

    fn textures(&mut self, w: u32, h: u32, levels: u32) -> Vec<wgpu::TextureView> {
        let frame = self.frame;
        if !self.textures.contains_key(&(w, h, levels)) {
            let chain: Vec<(wgpu::Texture, wgpu::TextureView)> = (0..=levels)
                .map(|i| {
                    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC;
                    let texture = crate::texture(&self.device, ((w >> i).max(1), (h >> i).max(1)), usage, "acde blur");
                    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                    (texture, view)
                })
                .collect();
            let bytes = chain.iter().map(|(t, _)| u64::from(t.width()) * u64::from(t.height()) * 4).sum();
            self.evict(bytes);
            self.textures.insert((w, h, levels), Cached { levels: chain, bytes, used: frame });
        }
        let cached = self.textures.get_mut(&(w, h, levels)).expect("made just above");
        cached.used = frame;
        cached.levels.iter().map(|(_, v)| v.clone()).collect()
    }

    fn evict(&mut self, bytes: u64) {
        let mut total: u64 = self.textures.values().map(|c| c.bytes).sum();
        while total + bytes > CACHE_BYTES {
            let Some(key) = self.textures.iter().min_by_key(|(_, c)| c.used).map(|(k, _)| *k) else { break };
            if let Some(c) = self.textures.remove(&key) {
                total -= c.bytes;
                for (_, view) in &c.levels {
                    self.binds.remove(view);
                }
            }
        }
    }

    fn blur(&mut self, encoder: &mut wgpu::CommandEncoder, src: &wgpu::Texture, [x0, y0, w, h]: [u32; 4], sigma: f32) -> wgpu::TextureView {
        let blur = Blur::of(sigma);
        let levels = blur.map_or(0, |b| b.levels);
        let views = self.textures(w, h, levels);
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: src, mip_level: 0, origin: wgpu::Origin3d { x: x0, y: y0, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: views[0].texture(), mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let Some(blur) = blur else { return views.into_iter().next().expect("at least one level") };
        let texel = |v: &wgpu::TextureView| [1.0 / v.texture().width() as f32, 1.0 / v.texture().height() as f32];
        let offset = blur.offset;
        for i in 0..levels as usize {
            let params = Params { texel: texel(&views[i]), offset, ..Default::default() };
            self.pass(encoder, &views[i + 1], true, &[Draw { pipe: Pipe::Down, src: &views[i], params, scissor: None, mix: None }]);
        }
        for i in (0..levels as usize).rev() {
            let params = Params { texel: texel(&views[i + 1]), offset, ..Default::default() };
            let mix = (i == 0 && blur.mix < 1.0).then_some(blur.mix);
            let pipe = if mix.is_some() { Pipe::Mix } else { Pipe::Up };
            self.pass(encoder, &views[i], mix.is_none(), &[Draw { pipe, src: &views[i + 1], params, scissor: None, mix }]);
        }
        views.into_iter().next().expect("at least one level")
    }

    pub fn place(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, origin: [u32; 2], clip: [u32; 4]) {
        let Some((_, _, layer)) = self.layer.clone() else { return };
        let pipe = Pipe::Place;
        let params = Params { rect: [origin[0] as f32, origin[1] as f32, 0.0, 0.0], ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe, src: &layer, params, scissor: Some(clip), mix: None }]);
    }

    pub fn filtered(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, e: &Effect, [x, y, w, h]: [u32; 4], clip: [u32; 4]) {
        let Some((_, _, layer)) = self.layer.clone() else { return };
        if w < 2 || h < 2 {
            return;
        }
        let flat = self.textures(w, h, 0).swap_remove(0);
        self.pass(encoder, &flat, true, &[Draw { pipe: Pipe::Flatten, src: &layer, params: Params::default(), scissor: None, mix: None }]);
        let src = if e.blur > 0.0 { self.blur(encoder, flat.texture(), [0, 0, w, h], e.blur) } else { flat };
        let (matrix, bias) = e.columns();
        let params = Params { rect: [x as f32, y as f32, w as f32, h as f32], matrix, bias, ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe: Pipe::Filter, src: &src, params, scissor: Some(clip), mix: None }]);
    }

    pub fn clear_rects(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, rects: impl IntoIterator<Item = [u32; 4]>) {
        let Some((_, _, layer)) = self.layer.clone() else { return };
        let draws: Vec<Draw> =
            rects.into_iter().map(|r| Draw { pipe: Pipe::Clear, src: &layer, params: Params::default(), scissor: Some(r), mix: None }).collect();
        self.pass(encoder, canvas, false, &draws);
    }

    pub fn backdrop(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, b: &Backdrop) {
        let Some(region) = Self::region(b.rect, canvas.texture().size()) else { return };
        let blurred = self.blur(encoder, canvas.texture(), region, b.effect.blur);
        let (matrix, bias) = b.effect.columns();
        let params = Params { rect: b.rect, radius: b.radius, matrix, bias, ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe: Pipe::Backdrop, src: &blurred, params, scissor: Some(region), mix: None }]);
    }

    pub fn shadow(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, s: &Shadow, [x, y, w, h]: [u32; 4], clip: [u32; 4]) {
        let Some((_, layer, _)) = self.layer.clone() else { return };
        if w < 2 || h < 2 {
            return;
        }
        let rect = [x as f32, y as f32, w as f32, h as f32];
        let Some(shifted) = Self::region([rect[0] + s.dx, rect[1] + s.dy, rect[2], rect[3]], layer.size()) else { return };
        let Some(scissor) = Px::of(shifted).intersection(Px::of(clip)) else { return };
        let blurred = self.blur(encoder, &layer, [0, 0, w, h], s.blur);
        let params = Params { rect, shift: [s.dx, s.dy], color: s.color, ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe: Pipe::Shadow, src: &blurred, params, scissor: Some(scissor.xywh()), mix: None }]);
    }
}
