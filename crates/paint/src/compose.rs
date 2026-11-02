use std::collections::HashMap;

use acde_render::anyrender_vello::wgpu;

#[derive(Clone, Copy, Debug)]
pub struct Backdrop {
    pub rect: [f32; 4],
    pub radius: f32,
    pub blur: f32,
    pub saturate: f32,
    pub brightness: f32,
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
    const IDENTITY: [f32; 20] = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];

    pub fn is_none(&self) -> bool {
        self.blur <= 0.0 && self.matrix.is_none()
    }

    pub fn blur(&mut self, sigma: f32) {
        self.blur = self.blur.hypot(sigma);
    }

    pub fn matrix(&mut self, m: [f32; 20]) {
        let a = self.matrix.unwrap_or(Self::IDENTITY);
        self.matrix = Some(std::array::from_fn(|k| {
            let (i, j) = (k / 5, k % 5);
            (0..4).map(|t| m[i * 5 + t] * a[t * 5 + j]).sum::<f32>() + if j == 4 { m[i * 5 + 4] } else { 0.0 }
        }));
    }

    fn columns(&self) -> ([f32; 16], [f32; 4]) {
        let m = self.matrix.unwrap_or(Self::IDENTITY);
        (std::array::from_fn(|k| m[(k % 4) * 5 + k / 4]), [m[4], m[9], m[14], m[19]])
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Params {
    texel: [f32; 2],
    offset: f32,
    saturate: f32,
    rect: [f32; 4],
    radius: f32,
    brightness: f32,
    shift: [f32; 2],
    color: [f32; 4],
    matrix: [f32; 16],
    bias: [f32; 4],
}

impl Params {
    const SIZE: u64 = 144;

    fn bytes(&self) -> [u8; 144] {
        let head = [self.texel[0], self.texel[1], self.offset, self.saturate, self.rect[0], self.rect[1], self.rect[2], self.rect[3], self.radius, self.brightness, self.shift[0], self.shift[1]];
        let f = head.iter().chain(&self.color).chain(&self.matrix).chain(&self.bias);
        let mut out = [0u8; 144];
        for (chunk, v) in out.as_chunks_mut::<4>().0.iter_mut().zip(f) {
            *chunk = v.to_le_bytes();
        }
        out
    }
}

const KEEP_FRAMES: u64 = 8;
const CACHE_BYTES: u64 = 96 << 20;
const MAX_BINDS: usize = 256;
const STAGING_BYTES: u64 = 32 << 20;

#[derive(Clone, Copy)]
enum Pipe {
    Down,
    Up,
    Backdrop,
    Shadow,
    Place,
    PlacePremultiplied,
    Flatten,
    FlattenPremultiplied,
    Filter,
    Clear,
    CopyOver,
}

struct Draw<'a> {
    pipe: Pipe,
    src: &'a wgpu::TextureView,
    params: Params,
    scissor: Option<[u32; 4]>,
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

#[derive(Default)]
struct Staging {
    buffer: Option<wgpu::Buffer>,
    used: u64,
    peak: u64,
    idle: u32,
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
    staging: Staging,
    frame: u64,
}

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

impl Composer {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("acde web compose"), source: wgpu::ShaderSource::Wgsl(include_str!("web.wgsl").into()) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("acde web compose"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(Params::SIZE) },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("acde web compose"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let over = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
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
            pipeline("fs_place_premultiplied", Some(over)),
            pipeline("fs_place", None),
            pipeline("fs_place_premultiplied", None),
            pipeline("fs_filter", Some(over)),
            pipeline("fs_clear", None),
            pipeline("fs_copy", Some(over)),
        ];
        let stride = Params::SIZE.next_multiple_of(u64::from(device.limits().min_uniform_buffer_offset_alignment));
        Self {
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("acde web compose"),
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
            staging: Staging::default(),
            frame: 0,
        }
    }

    fn uniform_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor { label: Some("acde web params"), size, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })
    }

    pub fn layer_view(&mut self, size: (u32, u32)) -> wgpu::TextureView {
        if self.layer.as_ref().is_none_or(|(s, _, _)| *s != size) {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("acde web layer"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.layer = Some((size, texture, view));
        }
        self.layer.as_ref().map(|(_, _, v)| v.clone()).expect("刚建好")
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
                label: Some("acde web compose"),
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
        self.staging.used = 0;
    }

    pub fn end_frame(&mut self) {
        let frame = self.frame;
        self.binds.retain(|_, (_, used)| *used + KEEP_FRAMES > frame);
        self.textures.retain(|_, c| c.used + KEEP_FRAMES > frame);
        let s = &mut self.staging;
        let size = s.buffer.as_ref().map_or(0, wgpu::Buffer::size);
        s.idle = if s.peak * 2 < size { s.idle + 1 } else { 0 };
        if s.idle > KEEP_FRAMES as u32 * 8 {
            s.buffer = None;
            s.idle = 0;
        }
        s.peak = 0;
        self.frame += 1;
    }

    pub fn trim(&mut self) {
        self.binds.clear();
        self.textures.clear();
        self.staging = Staging::default();
        self.layer = None;
        let _ = self.device.poll(wgpu::PollType::Poll);
    }

    fn pass(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, clear: bool, draws: &[Draw]) {
        if draws.is_empty() && !clear {
            return;
        }
        let prepared: Vec<(wgpu::BindGroup, u32, Pipe, Option<[u32; 4]>)> = draws
            .iter()
            .map(|d| {
                let offset = self.push(&d.params);
                (self.bind(d.src), offset, d.pipe, d.scissor)
            })
            .collect();
        let load = if clear { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) } else { wgpu::LoadOp::Load };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("acde web compose"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        let size = target.texture().size();
        for (bind, offset, pipe, scissor) in &prepared {
            pass.set_pipeline(&self.pipelines[*pipe as usize]);
            pass.set_bind_group(0, bind, &[*offset]);
            let [x, y, w, h] = scissor.unwrap_or([0, 0, size.width, size.height]);
            pass.set_scissor_rect(x, y, w, h);
            pass.draw(0..3, 0..1);
        }
    }

    pub fn clear(encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView) {
        let _ = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("acde web clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: canvas,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }

    fn region(rect: [f32; 4], size: wgpu::Extent3d) -> Option<[u32; 4]> {
        let x0 = rect[0].max(0.0).floor() as u32;
        let y0 = rect[1].max(0.0).floor() as u32;
        let x1 = ((rect[0] + rect[2]).max(0.0).ceil() as u32).min(size.width);
        let y1 = ((rect[1] + rect[3]).max(0.0).ceil() as u32).min(size.height);
        (x1 > x0 + 1 && y1 > y0 + 1).then_some([x0, y0, x1 - x0, y1 - y0])
    }

    fn textures(&mut self, w: u32, h: u32, levels: u32) -> Vec<wgpu::TextureView> {
        let frame = self.frame;
        if !self.textures.contains_key(&(w, h, levels)) {
            let chain: Vec<(wgpu::Texture, wgpu::TextureView)> = (0..=levels)
                .map(|i| {
                    let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("acde web blur"),
                        size: wgpu::Extent3d { width: (w >> i).max(1), height: (h >> i).max(1), depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: FORMAT,
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
                        view_formats: &[],
                    });
                    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                    (texture, view)
                })
                .collect();
            let bytes = chain.iter().map(|(t, _)| u64::from(t.width()) * u64::from(t.height()) * 4).sum();
            self.evict(bytes);
            self.textures.insert((w, h, levels), Cached { levels: chain, bytes, used: frame });
        }
        let cached = self.textures.get_mut(&(w, h, levels)).expect("刚建好");
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

    fn blur(&mut self, encoder: &mut wgpu::CommandEncoder, src: &wgpu::Texture, over: Option<&wgpu::TextureView>, [x0, y0, w, h]: [u32; 4], sigma: f32) -> wgpu::TextureView {
        let levels = ((sigma.max(1.0) / 2.0).log2().ceil() as u32).clamp(1, 5);
        let views = self.textures(w, h, levels);
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: src, mip_level: 0, origin: wgpu::Origin3d { x: x0, y: y0, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: views[0].texture(), mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        if let Some(over) = over {
            self.pass(encoder, &views[0], false, &[Draw { pipe: Pipe::CopyOver, src: over, params: Params { rect: [x0 as f32, y0 as f32, 0.0, 0.0], ..Default::default() }, scissor: None }]);
        }
        let texel = |v: &wgpu::TextureView| [1.0 / v.texture().width() as f32, 1.0 / v.texture().height() as f32];
        for i in 0..levels as usize {
            let params = Params { texel: texel(&views[i]), offset: 1.0, ..Default::default() };
            self.pass(encoder, &views[i + 1], true, &[Draw { pipe: Pipe::Down, src: &views[i], params, scissor: None }]);
        }
        for i in (0..levels as usize).rev() {
            let params = Params { texel: texel(&views[i + 1]), offset: 1.0, ..Default::default() };
            self.pass(encoder, &views[i], true, &[Draw { pipe: Pipe::Up, src: &views[i + 1], params, scissor: None }]);
        }
        views.into_iter().next().expect("至少一层")
    }

    pub fn place(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, origin: [u32; 2], clip: [u32; 4], premultiplied: bool) {
        let Some((_, _, layer)) = self.layer.clone() else { return };
        let pipe = if premultiplied { Pipe::PlacePremultiplied } else { Pipe::Place };
        let params = Params { rect: [origin[0] as f32, origin[1] as f32, 0.0, 0.0], ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe, src: &layer, params, scissor: Some(clip) }]);
    }

    pub fn filtered(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, e: &Effect, [x, y, w, h]: [u32; 4], clip: [u32; 4], premultiplied: bool) {
        let Some((_, _, layer)) = self.layer.clone() else { return };
        if w < 2 || h < 2 {
            return;
        }
        let flat = self.textures(w, h, 0).swap_remove(0);
        let pipe = if premultiplied { Pipe::FlattenPremultiplied } else { Pipe::Flatten };
        self.pass(encoder, &flat, true, &[Draw { pipe, src: &layer, params: Params::default(), scissor: None }]);
        let src = if e.blur > 0.0 { self.blur(encoder, flat.texture(), None, [0, 0, w, h], e.blur) } else { flat };
        let (matrix, bias) = e.columns();
        let params = Params { rect: [x as f32, y as f32, w as f32, h as f32], matrix, bias, ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe: Pipe::Filter, src: &src, params, scissor: Some(clip) }]);
    }

    pub fn staging_room(&mut self, [w, h]: [u32; 2]) -> bool {
        let bytes = Self::staged_bytes(w, h);
        let s = &mut self.staging;
        let size = s.buffer.as_ref().map_or(0, wgpu::Buffer::size);
        if s.used + bytes <= size {
            return true;
        }
        let cap = STAGING_BYTES.max(bytes);
        if size >= cap && s.used > 0 {
            return false;
        }
        let size = (size * 2).clamp(bytes, cap);
        s.buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("acde web staging"), size, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }));
        s.used = 0;
        true
    }

    fn staged_bytes(w: u32, h: u32) -> u64 {
        u64::from((4 * w).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)) * u64::from(h)
    }

    pub fn upload_layer(&mut self, encoder: &mut wgpu::CommandEncoder, rgba: &[u8], width: u32, [x, y, w, h]: [u32; 4]) {
        let Some((_, texture, _)) = &self.layer else { return };
        let Some(buffer) = &self.staging.buffer else { return };
        let (row, stride) = (4 * w as usize, (4 * w).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT));
        let bytes = Self::staged_bytes(w, h);
        let Some(size) = wgpu::BufferSize::new(bytes) else { return };
        let source = 4 * width as usize;
        if x + w > width || rgba.len() < source * (y + h) as usize {
            return;
        }
        let offset = self.staging.used;
        let Some(mut view) = self.queue.write_buffer_with(buffer, offset, size) else { return };
        for (i, line) in rgba.chunks_exact(source).skip(y as usize).take(h as usize).enumerate() {
            let at = i * stride as usize;
            view.slice(at..at + row).copy_from_slice(&line[4 * x as usize..4 * x as usize + row]);
        }
        drop(view);
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo { buffer, layout: wgpu::TexelCopyBufferLayout { offset, bytes_per_row: Some(stride), rows_per_image: Some(h) } },
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.staging.used += bytes;
        self.staging.peak = self.staging.peak.max(self.staging.used);
    }

    pub fn clear_rects(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, rects: impl IntoIterator<Item = [u32; 4]>) {
        let Some((_, _, layer)) = self.layer.clone() else { return };
        let draws: Vec<Draw> = rects.into_iter().map(|r| Draw { pipe: Pipe::Clear, src: &layer, params: Params::default(), scissor: Some(r) }).collect();
        self.pass(encoder, canvas, false, &draws);
    }

    pub fn backdrop(&mut self, encoder: &mut wgpu::CommandEncoder, under: Option<&wgpu::TextureView>, canvas: &wgpu::TextureView, b: &Backdrop) {
        let Some(region) = Self::region(b.rect, canvas.texture().size()) else { return };
        let blurred = match under {
            Some(under) => self.blur(encoder, under.texture(), Some(canvas), region, b.blur),
            None => self.blur(encoder, canvas.texture(), None, region, b.blur),
        };
        let params = Params { rect: b.rect, radius: b.radius, saturate: b.saturate, brightness: b.brightness, ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe: Pipe::Backdrop, src: &blurred, params, scissor: Some(region) }]);
    }

    pub fn shadow(&mut self, encoder: &mut wgpu::CommandEncoder, canvas: &wgpu::TextureView, s: &Shadow, [x, y, w, h]: [u32; 4], clip: [u32; 4]) {
        let Some((_, layer, _)) = self.layer.clone() else { return };
        if w < 2 || h < 2 {
            return;
        }
        let rect = [x as f32, y as f32, w as f32, h as f32];
        let Some(shifted) = Self::region([rect[0] + s.dx, rect[1] + s.dy, rect[2], rect[3]], layer.size()) else { return };
        let (x0, y0) = (shifted[0].max(clip[0]), shifted[1].max(clip[1]));
        let (x1, y1) = ((shifted[0] + shifted[2]).min(clip[0] + clip[2]), (shifted[1] + shifted[3]).min(clip[1] + clip[3]));
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let blurred = self.blur(encoder, &layer, None, [0, 0, w, h], s.blur);
        let params = Params { rect, shift: [s.dx, s.dy], color: s.color, ..Default::default() };
        self.pass(encoder, canvas, false, &[Draw { pipe: Pipe::Shadow, src: &blurred, params, scissor: Some([x0, y0, x1 - x0, y1 - y0]) }]);
    }
}
