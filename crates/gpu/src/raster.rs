use std::collections::{HashMap, VecDeque};
use std::os::fd::OwnedFd;
use std::time::{Duration, Instant};

use crate::{PaintScene, Scene};
use kurbo::Affine;
use peniko::Color;

use crate::{Backdrop, Composer, Device, Dmabuf, Effect, Images, Shadow, VelloScene};

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

    pub fn overlaps(self, o: Self) -> bool {
        self.intersection(o).is_some()
    }

    pub fn xywh(self) -> [u32; 4] {
        [self.x, self.y, self.w, self.h].map(|v| v.max(0) as u32)
    }
}

pub trait Content {
    fn scene_for(&self, region: Px) -> Scene;
}

pub struct Part<C> {
    pub content: C,
    pub backdrop: Option<Backdrop>,
    pub shadows: Vec<Shadow>,
    pub effect: Effect,
    pub bounds: Option<Px>,
}

pub struct Pass<C> {
    pub plane: usize,
    pub size: (u32, u32),
    pub parts: Vec<Part<C>>,
    pub next: usize,
    pub targets: Option<Vec<Px>>,
}

pub struct Submitted {
    pub fence: Option<OwnedFd>,
    pub waited: Duration,
    pub recorded: Duration,
}

pub struct Raster {
    pub device: Device,
    vello: vello::Renderer,
    scene: vello::Scene,
    composer: Composer,
    canvases: HashMap<usize, Vec<Option<(wgpu::Texture, wgpu::TextureView)>>>,
    submits: VecDeque<(wgpu::SubmissionIndex, Option<OwnedFd>)>,
    poll: bool,
}

impl Raster {
    pub fn new(device: Device, poll: bool) -> Result<Self, String> {
        let options = vello::RendererOptions { use_cpu: false, antialiasing_support: vello::AaSupport::area_only(), num_init_threads: None, pipeline_cache: None };
        let vello = vello::Renderer::new(&device.device, options).map_err(|e| format!("vello: {e}"))?;
        let composer = Composer::new(&device.device, &device.queue);
        let mut raster = Self { device, vello, scene: vello::Scene::new(), composer, canvases: HashMap::new(), submits: VecDeque::new(), poll };
        raster.warm_up();
        Ok(raster)
    }

    fn warm_up(&mut self) {
        let texture = self.device.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("acde warm-up"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let params = vello::RenderParams { base_color: Color::TRANSPARENT, width: 64, height: 64, antialiasing_method: vello::AaConfig::Area };
        let _ = self.vello.render_to_texture(&self.device.device, &self.device.queue, &vello::Scene::new(), &view, &params);
        let _ = self.device.device.poll(wgpu::PollType::wait_indefinitely());
    }

    pub fn canvases(&mut self, plane: usize, dmabufs: &[Dmabuf<'_>], size: (u32, u32)) -> Vec<Result<(), String>> {
        let mut results = Vec::new();
        let canvases = dmabufs
            .iter()
            .map(|d| {
                let imported = self.device.import(*d, size).map(|t| {
                    let view = t.create_view(&wgpu::TextureViewDescriptor::default());
                    (t, view)
                });
                results.push(imported.as_ref().map(|_| ()).map_err(Clone::clone));
                imported.ok()
            })
            .collect();
        self.canvases.insert(plane, canvases);
        results
    }

    pub fn release(&mut self, plane: usize) {
        self.canvases.remove(&plane);
    }

    pub fn idle(&mut self) {
        self.composer.trim();
    }

    pub fn draw<C: Content>(&mut self, passes: Vec<Pass<C>>, images: &mut impl Images, lock: &std::sync::Mutex<()>) -> Result<Submitted, String> {
        let started = Instant::now();
        let oldest = if self.submits.len() > 1 { self.submits.pop_front() } else { None };
        let poll = match oldest {
            Some((_, Some(fence))) => {
                let mut fds = [rustix::event::PollFd::new(&fence, rustix::event::PollFlags::IN)];
                let _ = rustix::event::poll(&mut fds, Some(&rustix::event::Timespec { tv_sec: 1, tv_nsec: 0 }));
                wgpu::PollType::Poll
            }
            Some((index, None)) => wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(Duration::from_secs(1)) },
            None => wgpu::PollType::Poll,
        };
        let _ = self.device.device.poll(poll);
        let waited = started.elapsed();
        let mut encoder = self.device.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde page") });
        for pass in passes {
            self.draw_pass(&mut encoder, pass, images)?;
        }
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let fence = if self.poll { None } else { self.device.arm() };
        let index = self.submit(&mut encoder);
        drop(guard);
        images.submitted();
        let recorded = started.elapsed() - waited;
        self.composer.end_frame();
        images.forget(&mut self.vello);
        let fence = match fence.and_then(|f| self.device.sync_file(f)) {
            Some(fd) => {
                self.submits.push_back((index, fd.try_clone().ok()));
                Some(fd)
            }
            None => {
                self.submits.push_back((index, None));
                self.device.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("waiting for the GPU: {e}"))?;
                None
            }
        };
        Ok(Submitted { fence, waited, recorded })
    }

    fn submit(&mut self, encoder: &mut wgpu::CommandEncoder) -> wgpu::SubmissionIndex {
        self.composer.flush();
        let done = std::mem::replace(encoder, self.device.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde page") }));
        self.device.queue.submit([done.finish()])
    }

    fn pieces<C>(part: &Part<C>, targets: &[Px], full: Px) -> Vec<(Px, Px)> {
        let shadows = part.shadows.iter().map(|s| (s.dx.abs().max(s.dy.abs()) + 4.0 * s.blur).ceil() as i32).max().unwrap_or(0);
        let margin = shadows.max((3.0 * part.effect.blur).ceil() as i32);
        targets
            .iter()
            .filter_map(|t| {
                let clip = part.bounds.map_or(Some(*t), |b| b.intersection(*t))?;
                let drawn = part.bounds.map_or(Some(*t), |b| b.intersection(t.grown(margin)))?.intersection(full)?;
                Some((drawn, clip))
            })
            .collect()
    }

    fn draw_pass<C: Content>(&mut self, encoder: &mut wgpu::CommandEncoder, Pass { plane, size, parts, next, targets }: Pass<C>, images: &mut impl Images) -> Result<(), String> {
        let full = Px::sized(size);
        let (_, canvas) = self.canvases.get(&plane).and_then(|c| c.get(next)?.clone()).ok_or("the canvas is not imported yet")?;
        let layer = self.composer.layer_view(size);
        match &targets {
            Some(regions) => self.composer.clear_rects(encoder, &canvas, regions.iter().map(|r| r.xywh())),
            None => Composer::clear(encoder, &canvas),
        }
        let targets = targets.unwrap_or_else(|| vec![full]);
        for part in parts {
            if let Some(backdrop) = part.backdrop.as_ref().filter(|b| targets.iter().any(|t| Px::covering(b.rect).overlaps(*t))) {
                self.composer.backdrop(encoder, &canvas, backdrop);
            }
            for (drawn, clip) in Self::pieces(&part, &targets, full) {
                let [ox, oy, width, height] = drawn.xywh();
                let scene = part.content.scene_for(drawn);
                if scene.commands.is_empty() {
                    continue;
                }
                self.submit(encoder);
                self.render(scene, Affine::translate((-f64::from(ox), -f64::from(oy))), (width, height), &layer, images)?;
                for shadow in &part.shadows {
                    self.composer.shadow(encoder, &canvas, shadow, drawn.xywh(), clip.xywh());
                }
                match part.effect.is_none() {
                    true => self.composer.place(encoder, &canvas, [ox, oy], clip.xywh()),
                    false => self.composer.filtered(encoder, &canvas, &part.effect, drawn.xywh(), clip.xywh()),
                }
            }
        }
        Ok(())
    }

    fn render(&mut self, scene: Scene, place: Affine, (width, height): (u32, u32), target: &wgpu::TextureView, images: &mut impl Images) -> Result<(), String> {
        self.scene.reset();
        images.apply(&mut self.vello, &scene);
        VelloScene::from(&mut self.scene).append_scene(scene, place);
        VelloScene::keep_atlas(&mut self.scene);
        let params = vello::RenderParams { base_color: Color::TRANSPARENT, width, height, antialiasing_method: vello::AaConfig::Area };
        self.vello.render_to_texture(&self.device.device, &self.device.queue, &self.scene, target, &params).map_err(|e| format!("vello: {e}"))
    }

    pub fn icon(&mut self, dmabuf: Dmabuf<'_>, (width, height): (u32, u32), scene: Scene, images: &mut impl Images) -> Result<(), String> {
        let texture = self.device.import(dmabuf, (width, height))?;
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let layer = self.composer.layer_view((width, height));
        self.render(scene, Affine::IDENTITY, (width, height), &layer, images)?;
        let mut encoder = self.device.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde icon") });
        Composer::clear(&mut encoder, &view);
        self.composer.place(&mut encoder, &view, [0, 0], [0, 0, width, height]);
        let index = self.submit(&mut encoder);
        images.submitted();
        self.composer.end_frame();
        self.device
            .device
            .poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(Duration::from_secs(2)) })
            .map(|_| ())
            .map_err(|e| format!("waiting for the GPU: {e}"))
    }
}
