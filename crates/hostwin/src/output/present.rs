use std::collections::{HashMap, HashSet};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use acde_gpu::{Backdrop, Composer, Effect, FilterEffect, Overrides, Px, Scene, Shadow, Vello, vello, wgpu};
use acde_model::{Inbox, Pacer};
use acde_render::{Bar, Decoration, Layer, Plane, RenderHandle};
use vello::kurbo::{Affine, Rect};
use vello::peniko::Color;

use crate::app::server;
use crate::output::compose::{Page, drain};
use crate::output::gpu::Gpu;
use crate::output::surface::{Msg, Shot};

const DEFAULT_HZ: f64 = 60.0;
const REFRESH_SLACK: f64 = 0.9;

pub(crate) fn pace(refresh: Option<f64>) -> Duration {
    Duration::from_secs_f64(REFRESH_SLACK / refresh.filter(|hz| *hz > 1.0).unwrap_or(DEFAULT_HZ))
}

struct Scratch {
    size: (u32, u32),
    view: wgpu::TextureView,
    drawn: bool,
}

type Part = (Option<Backdrop>, Vec<Shadow>, Effect, Px);

pub(crate) struct Presenter {
    gpu: Arc<Gpu>,
    vello: Vello,
    composer: Composer,
    overrides: Overrides,
    render: RenderHandle,
    inbox: Arc<Inbox>,
    id: u32,
    size: (u32, u32),
    scale: f64,
    panels: HashMap<u32, u32>,
    targets: HashMap<u32, Arc<Page>>,
    unpublished: HashSet<u32>,
    captures: Vec<(mpsc::SyncSender<Result<Shot, String>>, Instant)>,
    scratch: HashMap<u32, Scratch>,
    pacer: Pacer,
    dirty: bool,
    bar: Bar,
    decoration: Option<Decoration>,
}

impl Presenter {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: u32,
        gpu: Arc<Gpu>,
        size: (u32, u32),
        scale: f64,
        refresh: Option<f64>,
        bar: Bar,
        render: RenderHandle,
        inbox: Arc<Inbox>,
    ) -> Result<Self, String> {
        let vello = Vello::new(&gpu.shared.device, &gpu.shared.queue)?;
        let composer = Composer::new(&gpu.shared.device, &gpu.shared.queue);
        let overrides = Overrides::from(gpu.shared.images.clone());
        Ok(Self {
            gpu,
            vello,
            composer,
            overrides,
            render,
            inbox,
            id,
            size,
            scale,
            panels: HashMap::new(),
            targets: HashMap::new(),
            unpublished: HashSet::new(),
            captures: Vec::new(),
            scratch: HashMap::new(),
            pacer: Pacer::new(Some(pace(refresh))),
            dirty: true,
            decoration: (bar.height > 0.0).then(Decoration::new),
            bar,
        })
    }

    pub fn run(&mut self, rx: &mpsc::Receiver<Msg>) {
        self.pacer.tell_size(&self.inbox, self.size, self.scale);
        while let Some(msgs) = drain(rx, self.wait()) {
            let mut stop = false;
            for msg in msgs {
                stop |= self.handle(msg);
            }
            if stop {
                break;
            }
            if self.pacer.wait() == Some(Duration::ZERO)
                && let Some(now) = self.pacer.tick(&self.inbox)
            {
                self.render.tick(now);
            }
            if self.dirty {
                self.paint();
            }
            self.answer_captures();
        }
        for (reply, _) in self.captures.drain(..) {
            let _ = reply.send(Err("the window is gone".to_owned()));
        }
        if let Some(compositor) = server().and_then(|s| s.compositor()) {
            for id in self.targets.keys() {
                compositor.remove(*id);
            }
        }
    }

    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Wake => self.dirty = true,
            Msg::Frame => self.pacer.want_frame = true,
            Msg::Resized(width, height, scale) => {
                self.size = (width.max(1), height.max(1));
                self.scale = scale;
                self.pacer.tell_size(&self.inbox, self.size, self.scale);
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Scroll(x, y, dx, dy) => {
                let s = self.scale;
                self.render.scroll_at((x * s) as f32, (y * s) as f32, dx * s, dy * s);
            }
            Msg::Panel(dom, window) => {
                match window {
                    Some(window) => _ = self.panels.insert(dom, window),
                    None => {
                        if let Some(window) = self.panels.remove(&dom) {
                            self.targets.remove(&window);
                            self.scratch.remove(&window);
                            self.unpublished.remove(&window);
                            if let Some(compositor) = server().and_then(|s| s.compositor()) {
                                compositor.remove(window);
                            }
                        }
                    }
                }
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Title(title) => {
                self.bar.title = title;
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Fullscreen(fullscreen) => {
                self.bar.fullscreen = fullscreen;
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Theme(theme) => {
                self.bar.theme = theme;
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Active(active) => {
                self.bar.active = active;
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Refresh(hz) => {
                let pace = pace(hz);
                log::debug!(target: "perf::raster", "window {} pace ms={:.3}", self.id, pace.as_secs_f64() * 1000.0);
                self.pacer.set_refresh(Some(pace));
            }
            Msg::Capture(reply) => self.captures.push((reply, Instant::now() + crate::shell::CAPTURE_WAIT)),
            Msg::Stop => return true,
        }
        false
    }

    fn paint(&mut self) {
        self.dirty = false;
        let Some(frame) = self.render.frame() else { return };
        if frame.commit == 0 {
            return;
        }
        self.pacer.animating = frame.animating;
        let started = Instant::now();
        let (decoration, size) = self.framed(Vec::new());
        let top = size.1 - self.size.1;
        let plane = Self::in_layers(frame.plane, frame.size);
        let mut result = self.layered(self.id, size, &plane, top, decoration, Color::WHITE);
        for panel in frame.panels {
            let Some(&window) = self.panels.get(&panel.id) else { continue };
            let size = (panel.size.0.max(1), panel.size.1.max(1));
            let plane = Self::in_layers(panel.plane, panel.size);
            result = result.and_then(|drawn| Ok(self.layered(window, size, &plane, 0, Vec::new(), Color::TRANSPARENT)? || drawn));
            Self::backdrop(window, &plane);
            Self::drawn(window, size);
        }
        let drawn = result.unwrap_or_else(|e| {
            log::warn!("web window: {e}");
            true
        });
        if let Some(compositor) = server().and_then(|s| s.compositor()).filter(|_| drawn) {
            compositor.dirty();
        }
        log::debug!(target: "perf::raster", "surface ms={:.3}", acde_log::since_ms(started));
    }

    fn in_layers(mut plane: Plane, (width, height): (u32, u32)) -> Plane {
        if plane.layers.is_empty() {
            let drawing = std::mem::take(&mut plane.drawing);
            let bounds = Some(Rect::new(0.0, 0.0, f64::from(width), f64::from(height)));
            plane.layers.push(Layer { drawing, bounds, backdrop: None, filter: None });
        }
        plane
    }

    fn drawn(window: u32, size: (u32, u32)) {
        let Some(server) = server() else { return };
        let mut state = server.state();
        let scale = state.screen[2];
        if let Some(entry) = state.entries.get_mut(&window) {
            entry.drawn = size;
            crate::shell::State::place_when_drawn(entry, scale);
        }
    }

    fn backdrop(window: u32, plane: &Plane) {
        let backdrop = plane
            .layers
            .iter()
            .filter_map(|l| l.backdrop.as_ref())
            .map(|b| {
                let r = b.bounds.intersect(b.clip);
                (
                    [r.x0.floor(), r.y0.floor(), r.width().ceil().max(0.0), r.height().ceil().max(0.0)],
                    [b.radius(), b.blur(), f64::from(b.saturate()), f64::from(b.brightness())],
                )
            })
            .filter(|([.., w, h], _)| *w > 0.0 && *h > 0.0)
            .max_by(|([.., aw, ah], _), ([.., bw, bh], _)| (aw * ah).total_cmp(&(bw * bh)));
        let Some(server) = server() else { return };
        if let Some(entry) = server.state().entries.get_mut(&window) {
            entry.backdrop = backdrop;
        }
    }

    fn framed(&mut self, page: Vec<(Scene, Affine)>) -> (Vec<(Scene, Affine)>, (u32, u32)) {
        let Some(decoration) = self.decoration.as_mut() else { return (page, self.size) };
        let bar = Bar { width: f64::from(self.size.0) / self.scale, scale: self.scale, ..self.bar.clone() };
        let (_, top) = bar.pixels();
        let down = Affine::translate((0.0, f64::from(top)));
        let mut scenes: Vec<(Scene, Affine)> = page.into_iter().map(|(scene, place)| (scene, down * place)).collect();
        scenes.push((decoration.scene(&bar), Affine::IDENTITY));
        (scenes, (self.size.0, self.size.1 + top))
    }

    fn wait(&self) -> Option<Duration> {
        let capture = self.captures.iter().map(|(_, deadline)| deadline.saturating_duration_since(Instant::now())).min();
        match (self.pacer.wait(), capture) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn answer_captures(&mut self) {
        if self.captures.is_empty() {
            return;
        }
        let drawn = self.targets.contains_key(&self.id);
        let now = Instant::now();
        let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut self.captures).into_iter().partition(|(_, deadline)| drawn || *deadline <= now);
        self.captures = waiting;
        for (reply, _) in due {
            let _ = reply.send(self.capture());
        }
    }

    fn capture(&self) -> Result<Shot, String> {
        let page = self.targets.get(&self.id).ok_or("the window has not drawn a frame yet")?;
        let (width, height) = page.size;
        let rgba = self.gpu.shared.read(&page.texture, [0, 0, width, height])?;
        let png = acde_render::encode_png(width, height, &rgba).ok_or("png encoding failed")?;
        Ok(Shot { width, height, png })
    }

    fn target(&mut self, window: u32, size: (u32, u32)) -> wgpu::TextureView {
        if let Some(page) = self.targets.get(&window).filter(|p| p.size == size) {
            return page.view.clone();
        }
        let usage = wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST;
        let texture = acde_gpu::texture(&self.gpu.shared.device, size, usage, "acde host page");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let page = Arc::new(Page { size, view: view.clone(), texture, straight: true.into() });
        self.targets.insert(window, page);
        self.unpublished.insert(window);
        view
    }

    fn publish(&mut self, window: u32) {
        if !self.unpublished.remove(&window) {
            return;
        }
        if let (Some(compositor), Some(page)) = (server().and_then(|s| s.compositor()), self.targets.get(&window)) {
            compositor.page(window, page.clone());
        }
    }

    fn straight(&self, window: u32, straight: bool) {
        if let Some(page) = self.targets.get(&window) {
            page.straight.store(straight, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn layered(&mut self, window: u32, size: (u32, u32), plane: &Plane, top: u32, over: Vec<(Scene, Affine)>, base: Color) -> Result<bool, String> {
        self.target(window, size);
        let page = self.targets[&window].clone();
        let fresh = self.scratch.get(&window).is_none_or(|s| s.size != size || !s.drawn);
        let view = self.scratch(window, size);
        let shared = self.gpu.shared.clone();
        let full = Px::sized(size);
        let dy = f64::from(top);
        let parts: Vec<_> = plane.layers.iter().map(|layer| (layer, Self::part(layer, dy as f32))).collect();
        let region = if fresh { None } else { Self::region(plane, &parts, top, full) };
        let target = region.unwrap_or(full);
        if target.area() == 0 {
            return Ok(false);
        }
        if let Some(scratch) = self.scratch.get_mut(&window) {
            scratch.drawn = false;
        }
        let mut encoder = shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde host layers") });
        let (started, mut redrawn) = (Instant::now(), 0);
        let room = self.composer.layer_view(size).texture().size();
        let [r, g, b, a] = base.components;
        self.composer.fill_rects(&mut encoder, &view, [r * a, g * a, b * a, a], [target.xywh()]);
        let jobs: Vec<Option<(Px, Px)>> = parts
            .iter()
            .map(|(_, (_, shadows, effect, bounds))| {
                let clip = bounds.intersection(target)?;
                Some((clip, bounds.intersection(target.grown(acde_gpu::reach(shadows, effect)))?.intersection(full)?))
            })
            .collect();
        let mut scenes: Vec<Option<Scene>> = parts
            .iter()
            .zip(&jobs)
            .map(|((layer, _), job)| {
                let [ox, oy, w, h] = job.as_ref()?.1.xywh();
                let (x, y) = (f64::from(ox), f64::from(oy));
                Some(layer.drawing.scene_for(Rect::new(x, y - dy, x + f64::from(w), y + f64::from(h) - dy))).filter(|scene| !scene.commands.is_empty())
            })
            .collect();
        let slots =
            Self::pack(scenes.iter().zip(&jobs).map(|(scene, job)| scene.as_ref().and(job.as_ref()).map(|(_, drawn)| drawn.xywh())), (room.width, room.height));
        let mut atlas = None;
        for (i, (_, (backdrop, shadows, effect, _))) in parts.iter().enumerate() {
            if let Some(backdrop) = backdrop.as_ref().filter(|b| Px::covering(b.rect).overlaps(target)) {
                self.composer.backdrop(&mut encoder, &view, backdrop);
            }
            let (Some((clip, drawn)), Some((batch, at))) = (jobs[i], slots[i]) else { continue };
            if atlas != Some(batch) {
                atlas = Some(batch);
                self.flush(&mut encoder);
                let canvas = self.composer.layer_view(size);
                let mut extent = (1, 1);
                let mut items = Vec::new();
                for (j, slot) in slots.iter().enumerate() {
                    let (Some((b, [sx, sy])), Some((_, drawn)), Some(scene)) = (slot, jobs[j], scenes[j].take()) else { continue };
                    if *b != batch {
                        scenes[j] = Some(scene);
                        continue;
                    }
                    let [ox, oy, w, h] = drawn.xywh();
                    extent = (extent.0.max(sx + w), extent.1.max(sy + h));
                    let (sx, sy) = (f64::from(*sx), f64::from(*sy));
                    let place = Affine::translate((sx - f64::from(ox), sy + dy - f64::from(oy)));
                    items.push((scene, place, Some(Rect::new(sx, sy, sx + f64::from(w), sy + f64::from(h)))));
                    redrawn += 1;
                }
                self.vello.render_clipped(items, &mut self.overrides, &canvas, extent, Color::TRANSPARENT, Some(&shared))?;
            }
            let [ox, oy, ..] = drawn.xywh();
            for shadow in shadows {
                self.composer.shadow(&mut encoder, &view, shadow, drawn.xywh(), at, clip.xywh());
            }
            match effect.is_none() {
                true => self.composer.place(&mut encoder, &view, [ox, oy], at, clip.xywh()),
                false => self.composer.filtered(&mut encoder, &view, effect, drawn.xywh(), at, clip.xywh()),
            }
        }
        if !over.is_empty() && target.y < top as i32 {
            self.flush(&mut encoder);
            let canvas = self.composer.layer_view(size);
            self.vello.render(over, &mut self.overrides, &canvas, size, Color::TRANSPARENT, Some(&shared))?;
            self.composer.place(&mut encoder, &view, [0, 0], [0, 0], target.xywh());
        }
        let [x, y, w, h] = target.xywh();
        let at = wgpu::Origin3d { x, y, z: 0 };
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: view.texture(), mip_level: 0, origin: at, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &page.texture, mip_level: 0, origin: at, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.flush(&mut encoder);
        self.straight(window, false);
        self.composer.end_frame();
        self.publish(window);
        if let Some(scratch) = self.scratch.get_mut(&window) {
            scratch.drawn = true;
        }
        let ms = acde_log::since_ms(started);
        log::debug!(target: "perf::layers", "window={window} region={:?} layers={redrawn}/{} ms={ms:.3}", target.xywh(), parts.len());
        Ok(true)
    }

    fn region(plane: &Plane, parts: &[(&Layer, Part)], top: u32, full: Px) -> Option<Px> {
        let dy = top as f32;
        let damaged = |r: &acde_render::Rect| Px::covering([r.x as f32 - 1.0, r.y as f32 - 1.0 + dy, r.width as f32 + 2.0, r.height as f32 + 2.0]);
        let rects: Vec<Px> = match plane.damage_rects.iter().filter(|r| r.width > 0.0 && r.height > 0.0).map(damaged).collect::<Vec<_>>() {
            rects if rects.is_empty() && plane.damage.width > 0.0 && plane.damage.height > 0.0 => vec![damaged(&plane.damage)],
            rects => rects,
        };
        let Some(mut region) = rects.into_iter().reduce(Px::union).and_then(|r| r.intersection(full)) else { return Some(Px::default()) };
        let reads: Vec<Px> = parts.iter().filter_map(|(_, (b, ..))| b.as_ref().and_then(|b| Px::covering(b.rect).intersection(full))).collect();
        let mut grew = true;
        while grew {
            grew = false;
            for read in &reads {
                if region.overlaps(*read) && !region.contains(*read) {
                    region = region.union(*read);
                    grew = true;
                }
            }
        }
        (region.area() * 2 < full.area()).then_some(region)
    }

    fn pack(rects: impl Iterator<Item = Option<[u32; 4]>>, (width, height): (u32, u32)) -> Vec<Option<(usize, [u32; 2])>> {
        let (mut batch, mut x, mut y, mut row) = (0, 0, 0, 0);
        rects
            .map(|rect| {
                let [_, _, w, h] = rect?;
                if x + w > width {
                    (x, y, row) = (0, y + row, 0);
                }
                if y + h > height {
                    (batch, x, y, row) = (batch + 1, 0, 0, 0);
                }
                let at = [x, y];
                (x, row) = (x + w, row.max(h));
                Some((batch, at))
            })
            .collect()
    }

    fn scratch(&mut self, window: u32, size: (u32, u32)) -> wgpu::TextureView {
        if self.scratch.get(&window).is_none_or(|s| s.size != size) {
            let usage = wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST;
            let texture = acde_gpu::texture(&self.gpu.shared.device, size, usage, "acde host layers");
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.scratch.insert(window, Scratch { size, view, drawn: false });
        }
        self.scratch[&window].view.clone()
    }

    fn flush(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let shared = &self.gpu.shared;
        self.composer.flush();
        let done = std::mem::replace(encoder, shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde host layers") }));
        shared.submit([done.finish()]);
    }

    fn part(layer: &Layer, dy: f32) -> Part {
        let backdrop = layer.backdrop.as_ref().map(|b| {
            let r = b.bounds.intersect(b.clip);
            Backdrop {
                rect: [r.x0 as f32, r.y0 as f32 + dy, r.width().max(0.0) as f32, r.height().max(0.0) as f32],
                radius: b.radius() as f32,
                effect: b.effect(),
            }
        });
        let mut shadows = Vec::new();
        let mut effect = Effect::default();
        for (e, scale) in layer.filter.iter().flat_map(|f| f.filter.effects().iter().map(|e| (e, f.scale as f32))) {
            match e {
                FilterEffect::DropShadow(d) => {
                    shadows.push(Shadow { dx: d.dx * scale, dy: d.dy * scale, blur: d.std_deviation * scale, color: d.color.components })
                }
                FilterEffect::GaussianBlur(g) => effect.blur(g.std_deviation * scale),
                FilterEffect::ColorMatrix(m) => effect.matrix(m.0),
            }
        }
        let cover = |r: &Rect| Px::covering([r.x0 as f32 - 1.0, r.y0 as f32 - 1.0 + dy, r.width() as f32 + 2.0, r.height() as f32 + 2.0]);
        let bounds = match (&layer.filter, &layer.bounds) {
            (Some(f), _) => cover(&f.bounds),
            (None, Some(b)) => cover(b),
            (None, None) => Px::default(),
        };
        (backdrop, shadows, effect, bounds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pace_follows_the_monitor_rate() {
        assert_eq!(pace(Some(144.0)), Duration::from_secs_f64(0.9 / 144.0));
        assert_eq!(pace(Some(60.0)), Duration::from_secs_f64(0.9 / 60.0));
        assert_eq!(pace(None), pace(Some(60.0)));
        assert_eq!(pace(Some(1.0)), pace(Some(60.0)), "1 Hz means the driver's default mode");
    }
}
