use std::collections::HashMap;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use acde_gpu::{Backdrop, Composer, Effect, FilterEffect, Overrides, Px, Scene, Shadow, Vello, vello, wgpu};
use acde_model::{Inbox, Pacer};
use acde_render::{Bar, Decoration, Layer, Plane, RenderHandle};
use vello::kurbo::{Affine, Rect};
use vello::peniko::Color;

use crate::app::server;
use crate::compose::{Page, drain};
use crate::gpu::Gpu;
use crate::surface::{Msg, Shot};

const DEFAULT_HZ: f64 = 60.0;

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
    scratch: Option<((u32, u32), wgpu::Texture, wgpu::TextureView)>,
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
        let hz = refresh.filter(|hz| *hz > 1.0).unwrap_or(DEFAULT_HZ);
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
            scratch: None,
            pacer: Pacer::new(Some(Duration::from_secs_f64(0.9 / hz))),
            dirty: true,
            decoration: (bar.height > 0.0).then(Decoration::new),
            bar,
        })
    }

    pub fn run(&mut self, rx: &mpsc::Receiver<Msg>) {
        self.pacer.tell_size(&self.inbox, self.size, self.scale);
        while let Some(msgs) = drain(rx, self.pacer.wait()) {
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
            Msg::Panel(dom, window) => {
                match window {
                    Some(window) => _ = self.panels.insert(dom, window),
                    None => {
                        if let Some(window) = self.panels.remove(&dom) {
                            self.targets.remove(&window);
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
            Msg::Capture(reply) => {
                let _ = reply.send(self.capture());
            }
            Msg::Stop => return true,
        }
        false
    }

    fn scenes(plane: &Plane) -> Vec<(Scene, Affine)> {
        match plane.layers.is_empty() {
            true => vec![(plane.drawing.scene(), Affine::IDENTITY)],
            false => plane.layers.iter().map(|l| (l.drawing.scene(), Affine::IDENTITY)).collect(),
        }
    }

    fn paint(&mut self) {
        self.dirty = false;
        let Some(frame) = self.render.frame() else { return };
        if frame.commit == 0 {
            return;
        }
        self.pacer.animating = frame.animating;
        let started = Instant::now();
        let mut result = match frame.plane.layers.is_empty() {
            true => {
                let (main, size) = self.framed(Self::scenes(&frame.plane));
                self.draw(self.id, size, main, Color::WHITE)
            }
            false => {
                let (decoration, size) = self.framed(Vec::new());
                let top = size.1 - self.size.1;
                self.layered(self.id, size, &frame.plane.layers, top, decoration, Color::WHITE)
            }
        };
        for panel in &frame.panels {
            let Some(&window) = self.panels.get(&panel.id) else { continue };
            let size = (panel.size.0.max(1), panel.size.1.max(1));
            result = result.and(match panel.plane.layers.is_empty() {
                true => self.draw(window, size, Self::scenes(&panel.plane), Color::TRANSPARENT),
                false => self.layered(window, size, &panel.plane.layers, 0, Vec::new(), Color::TRANSPARENT),
            });
            Self::backdrop(window, &panel.plane);
            Self::drawn(window, size);
        }
        if let Err(e) = result {
            log::warn!("web window: {e}");
        }
        if let Some(compositor) = server().and_then(|s| s.compositor()) {
            compositor.dirty();
        }
        log::debug!(target: "perf::raster", "surface ms={:.3}", acde_log::since_ms(started));
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
        if let Some(compositor) = server().and_then(|s| s.compositor()) {
            compositor.page(window, page.clone());
        }
        self.targets.insert(window, page);
        view
    }

    fn draw(&mut self, window: u32, size: (u32, u32), scenes: Vec<(Scene, Affine)>, base: Color) -> Result<(), String> {
        let view = self.target(window, size);
        self.straight(window, true);
        self.vello.render(scenes, &mut self.overrides, &view, size, base, Some(&self.gpu.shared))
    }

    fn straight(&self, window: u32, straight: bool) {
        if let Some(page) = self.targets.get(&window) {
            page.straight.store(straight, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn layered(&mut self, window: u32, size: (u32, u32), layers: &[Layer], top: u32, over: Vec<(Scene, Affine)>, base: Color) -> Result<(), String> {
        self.target(window, size);
        let page = self.targets[&window].clone();
        let view = self.scratch(size);
        let shared = self.gpu.shared.clone();
        self.vello.render([], &mut self.overrides, &view, size, base, Some(&shared))?;
        let full = Px::sized(size);
        let dy = f64::from(top);
        let mut encoder = shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde host layers") });
        for layer in layers {
            let (backdrop, shadows, effect, bounds) = Self::part(layer, dy as f32);
            if let Some(backdrop) = backdrop {
                self.composer.backdrop(&mut encoder, &view, &backdrop);
            }
            let Some(drawn) = bounds.intersection(full) else { continue };
            let [ox, oy, w, h] = drawn.xywh();
            let (x, y) = (f64::from(ox), f64::from(oy));
            let scene = layer.drawing.scene_for(Rect::new(x, y - dy, x + f64::from(w), y + f64::from(h) - dy));
            if scene.commands.is_empty() {
                continue;
            }
            self.flush(&mut encoder);
            let canvas = self.composer.layer_view(size);
            self.vello.render([(scene, Affine::translate((-x, dy - y)))], &mut self.overrides, &canvas, (w, h), Color::TRANSPARENT, Some(&shared))?;
            for shadow in &shadows {
                self.composer.shadow(&mut encoder, &view, shadow, drawn.xywh(), drawn.xywh());
            }
            match effect.is_none() {
                true => self.composer.place(&mut encoder, &view, [ox, oy], drawn.xywh()),
                false => self.composer.filtered(&mut encoder, &view, &effect, drawn.xywh(), drawn.xywh()),
            }
        }
        if !over.is_empty() {
            self.flush(&mut encoder);
            let canvas = self.composer.layer_view(size);
            self.vello.render(over, &mut self.overrides, &canvas, size, Color::TRANSPARENT, Some(&shared))?;
            self.composer.place(&mut encoder, &view, [0, 0], full.xywh());
        }
        encoder.copy_texture_to_texture(
            view.texture().as_image_copy(),
            page.texture.as_image_copy(),
            wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        );
        self.flush(&mut encoder);
        self.straight(window, false);
        self.composer.end_frame();
        Ok(())
    }

    fn scratch(&mut self, size: (u32, u32)) -> wgpu::TextureView {
        if self.scratch.as_ref().is_none_or(|(s, ..)| *s != size) {
            let usage = wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST;
            let texture = acde_gpu::texture(&self.gpu.shared.device, size, usage, "acde host layers");
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.scratch = Some((size, texture, view));
        }
        self.scratch.as_ref().map(|(_, _, v)| v.clone()).expect("made just above")
    }

    fn flush(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let shared = &self.gpu.shared;
        self.composer.flush();
        let done = std::mem::replace(encoder, shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde host layers") }));
        shared.submit([done.finish()]);
    }

    fn part(layer: &Layer, dy: f32) -> (Option<Backdrop>, Vec<Shadow>, Effect, Px) {
        let backdrop = layer.backdrop.as_ref().map(|b| {
            let r = b.bounds.intersect(b.clip);
            Backdrop {
                rect: [r.x0 as f32, r.y0 as f32 + dy, r.width().max(0.0) as f32, r.height().max(0.0) as f32],
                radius: b.radius() as f32,
                blur: b.blur() as f32,
                saturate: b.saturate(),
                brightness: b.brightness(),
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
