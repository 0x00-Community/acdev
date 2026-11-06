use std::collections::HashMap;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use acde_gpu::{Images, Overrides, VelloScene, vello, wgpu};
use acde_gpu::{PaintScene, Scene};
use acde_model::{Inbox, Pacer};
use acde_render::{Bar, Decoration, Plane, RenderHandle};
use vello::kurbo::Affine;
use vello::peniko::Color;

use crate::app::server;
use crate::compose::Page;
use crate::gpu::Gpu;
use crate::surface::{Msg, Shot};

const DEFAULT_HZ: f64 = 60.0;

pub(crate) struct Presenter {
    gpu: Arc<Gpu>,
    vello: vello::Renderer,
    scene: vello::Scene,
    overrides: Overrides,
    render: RenderHandle,
    inbox: Arc<Inbox>,
    id: u32,
    size: (u32, u32),
    scale: f64,
    panels: HashMap<u32, u32>,
    targets: HashMap<u32, Arc<Page>>,
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
        let options =
            vello::RendererOptions { use_cpu: false, antialiasing_support: vello::AaSupport::area_only(), num_init_threads: None, pipeline_cache: None };
        let vello = vello::Renderer::new(gpu.device(), options).map_err(|e| format!("vello: {e}"))?;
        let overrides = Overrides::from(gpu.shared.images.clone());
        let hz = refresh.filter(|hz| *hz > 1.0).unwrap_or(DEFAULT_HZ);
        Ok(Self {
            gpu,
            vello,
            scene: vello::Scene::new(),
            overrides,
            render,
            inbox,
            id,
            size,
            scale,
            panels: HashMap::new(),
            targets: HashMap::new(),
            pacer: Pacer::new(Some(Duration::from_secs_f64(0.9 / hz))),
            dirty: true,
            decoration: (bar.height > 0.0).then(Decoration::new),
            bar,
        })
    }

    pub fn run(&mut self, rx: &mpsc::Receiver<Msg>) {
        self.pacer.tell_size(&self.inbox, self.size, self.scale);
        loop {
            let first = match self.pacer.wait() {
                Some(wait) => match rx.recv_timeout(wait) {
                    Ok(msg) => Some(msg),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(msg) => Some(msg),
                    Err(_) => break,
                },
            };
            let mut stop = false;
            for msg in first.into_iter().chain(std::iter::from_fn(|| rx.try_recv().ok())) {
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

    fn scenes(plane: &Plane, place: Affine) -> Vec<(Scene, Affine)> {
        if plane.layers.is_empty() { vec![(plane.scene(), place)] } else { plane.layers.iter().map(|l| (l.scene(), place)).collect() }
    }

    fn paint(&mut self) {
        self.dirty = false;
        let Some(frame) = self.render.frame() else { return };
        if frame.commit == 0 {
            return;
        }
        self.pacer.animating = frame.animating;
        let started = Instant::now();
        let (main, size) = self.framed(Self::scenes(&frame.plane, Affine::IDENTITY));
        let mut result = self.draw(self.id, size, main, Color::WHITE);
        for panel in &frame.panels {
            let Some(&window) = self.panels.get(&panel.id) else { continue };
            let scenes = Self::scenes(&panel.plane, Affine::IDENTITY);
            let size = (panel.size.0.max(1), panel.size.1.max(1));
            result = result.and(self.draw(window, size, scenes, Color::TRANSPARENT));
        }
        if let Err(e) = result {
            log::warn!("网页窗口: {e}");
        }
        if let Some(compositor) = server().and_then(|s| s.compositor()) {
            compositor.dirty();
        }
        log::debug!(target: "perf::raster", "surface ms={:.3}", acde_log::since_ms(started));
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
        let texture = self.gpu.page_texture(size);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let page = Arc::new(Page { size, view: view.clone(), texture });
        if let Some(compositor) = server().and_then(|s| s.compositor()) {
            compositor.page(window, page.clone());
        }
        self.targets.insert(window, page);
        view
    }

    fn draw(&mut self, window: u32, size: (u32, u32), scenes: Vec<(Scene, Affine)>, base: Color) -> Result<(), String> {
        let view = self.target(window, size);
        self.overrides.forget(&mut self.vello);
        self.scene.reset();
        {
            let vello = &mut self.vello;
            let overrides = &mut self.overrides;
            let mut target = VelloScene::from(&mut self.scene);
            for (scene, place) in scenes {
                overrides.apply(vello, &scene);
                target.append_scene(scene, place);
            }
        }
        VelloScene::keep_atlas(&mut self.scene);
        let params = vello::RenderParams { base_color: base, width: size.0, height: size.1, antialiasing_method: vello::AaConfig::Area };
        let gpu = self.gpu.clone();
        {
            let _lock = gpu.shared.submit_lock();
            self.vello.render_to_texture(gpu.device(), gpu.queue(), &self.scene, &view, &params).map_err(|e| format!("vello: {e}"))?;
        }
        self.scene.reset();
        self.overrides.submitted();
        Ok(())
    }
}
