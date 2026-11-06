use std::collections::HashMap;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use acde_model::{Event, Inbox};
use acde_render::acgpu::fallback::{Images, Overrides, VelloScene, vello, wgpu};
use acde_render::acgpu::{PaintScene, Scene};
use acde_render::{Plane, RenderHandle};
use vello::kurbo::Affine;
use winit::window::Window;

use crate::app::{Opened, server};
use crate::gpu::Gpu;
use crate::surface::{Msg, Shot};

const DEFAULT_HZ: f64 = 60.0;
const RETRY: Duration = Duration::from_millis(100);

struct Page {
    size: (u32, u32),
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
}

pub(crate) struct Presenter {
    gpu: Arc<Gpu>,
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    page: Option<Page>,
    vello: vello::Renderer,
    scene: vello::Scene,
    overrides: Overrides,
    render: RenderHandle,
    inbox: Arc<Inbox>,
    panels: HashMap<u32, [f64; 4]>,
    scale: f64,
    want_frame: bool,
    animating: bool,
    dirty: bool,
    last_tick: Option<Instant>,
    interval: Duration,
    told: Option<(u32, u32, u64)>,
    retry: Option<Instant>,
    id: u32,
    dump: Option<std::path::PathBuf>,
}

impl Presenter {
    pub fn new(
        id: u32,
        gpu: Arc<Gpu>,
        opened: Opened,
        render: RenderHandle,
        inbox: Arc<Inbox>,
    ) -> Result<Self, String> {
        let Opened {
            window,
            surface,
            size,
            scale,
            refresh,
        } = opened;
        let caps = surface.get_capabilities(&gpu.adapter);
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .or_else(|| caps.formats.iter().copied().find(|f| !f.is_srgb()))
        .or_else(|| caps.formats.first().copied())
        .ok_or("窗口的 surface 没有可用的格式")?;
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto)
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: size.0,
            height: size.1,
            desired_maximum_frame_latency: 2,
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode,
            view_formats: vec![],
        };
        {
            let _lock = gpu.shared.submit_lock();
            surface.configure(gpu.device(), &config);
        }
        let options = vello::RendererOptions {
            use_cpu: false,
            antialiasing_support: vello::AaSupport::area_only(),
            num_init_threads: None,
            pipeline_cache: None,
        };
        let vello =
            vello::Renderer::new(gpu.device(), options).map_err(|e| format!("vello: {e}"))?;
        let overrides = Overrides::from(gpu.shared.images.clone());
        let pipeline = gpu.blit(format);
        let hz = refresh.filter(|hz| *hz > 1.0).unwrap_or(DEFAULT_HZ);
        let interval = std::env::var("ACDE_WEB_FPS")
            .ok()
            .and_then(|f| f.parse::<f64>().ok())
            .filter(|f| *f > 0.0)
            .map_or(Duration::from_secs_f64(0.9 / hz), |fps| {
                Duration::from_secs_f64(1.0 / fps)
            });
        Ok(Self {
            gpu,
            window,
            surface,
            config,
            pipeline,
            page: None,
            vello,
            scene: vello::Scene::new(),
            overrides,
            render,
            inbox,
            panels: HashMap::new(),
            scale,
            want_frame: false,
            animating: false,
            dirty: true,
            last_tick: None,
            interval,
            told: None,
            retry: None,
            id,
            dump: std::env::var_os("ACDE_HOST_DUMP").map(std::path::PathBuf::from),
        })
    }

    pub fn run(&mut self, rx: mpsc::Receiver<Msg>) {
        self.tell_size();
        loop {
            let first = match self.wait() {
                Some(wait) => match rx.recv_timeout(wait) {
                    Ok(msg) => Some(msg),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                },
                None => match rx.recv() {
                    Ok(msg) => Some(msg),
                    Err(_) => return,
                },
            };
            let mut stop = false;
            for msg in first
                .into_iter()
                .chain(std::iter::from_fn(|| rx.try_recv().ok()))
            {
                stop |= self.handle(msg);
            }
            if stop {
                return;
            }
            if self.due() {
                self.tick();
            }
            if self.retry.is_some_and(|at| at.elapsed() >= RETRY) {
                self.show();
            }
            if self.dirty {
                self.paint();
            }
        }
    }

    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Wake => self.dirty = true,
            Msg::Frame => self.want_frame = true,
            Msg::Resized(width, height, scale) => {
                if (width, height) != (self.config.width, self.config.height) {
                    self.config.width = width;
                    self.config.height = height;
                    self.configure();
                }
                self.scale = scale;
                self.tell_size();
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Panel(id, rect) => {
                match rect {
                    Some(rect) => self.panels.insert(id, rect),
                    None => self.panels.remove(&id),
                };
                self.render.invalidate();
                self.dirty = true;
            }
            Msg::Redraw => self.show(),
            Msg::Capture(reply) => {
                let _ = reply.send(self.capture());
            }
            Msg::Stop => return true,
        }
        false
    }

    fn configure(&self) {
        let _lock = self.gpu.shared.submit_lock();
        self.surface.configure(self.gpu.device(), &self.config);
    }

    fn wait(&self) -> Option<Duration> {
        let retry = self.retry.map(|at| RETRY.saturating_sub(at.elapsed()));
        let tick = (self.want_frame || self.animating).then(|| {
            self.last_tick.map_or(Duration::ZERO, |t| {
                self.interval.saturating_sub(t.elapsed())
            })
        });
        match (retry, tick) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn due(&self) -> bool {
        (self.want_frame || self.animating)
            && self.last_tick.is_none_or(|t| t.elapsed() >= self.interval)
    }

    fn tick(&mut self) {
        let now = acde_log::now_ms();
        self.last_tick = Some(Instant::now());
        if std::mem::take(&mut self.want_frame) {
            self.inbox.push(Event {
                kind: "frame".into(),
                time: Some(now),
                ..Default::default()
            });
        }
        if self.animating {
            self.render.tick(now);
        }
    }

    fn tell_size(&mut self) {
        let (w, h) = (self.config.width, self.config.height);
        let told = (w, h, self.scale.to_bits());
        if self.told == Some(told) {
            return;
        }
        self.told = Some(told);
        self.inbox.push(Event {
            kind: "resize".into(),
            width: Some(f64::from(w)),
            height: Some(f64::from(h)),
            scale: Some(self.scale),
            ..Default::default()
        });
    }

    fn scenes(plane: &Plane) -> Vec<Scene> {
        if plane.layers.is_empty() {
            vec![plane.scene()]
        } else {
            plane.layers.iter().map(|l| l.scene()).collect()
        }
    }

    fn page(&mut self, size: (u32, u32)) -> &Page {
        if self.page.as_ref().is_none_or(|p| p.size != size) {
            let texture = self.gpu.page_texture(size);
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let bind = self
                .gpu
                .device()
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("acde host page"),
                    layout: &self.gpu.layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    }],
                });
            self.page = Some(Page {
                size,
                texture,
                view,
                bind,
            });
        }
        self.page.as_ref().expect("page")
    }

    fn paint(&mut self) {
        self.dirty = false;
        let Some(frame) = self.render.frame() else {
            return;
        };
        if frame.commit == 0 {
            return;
        }
        self.animating = frame.animating;
        let started = Instant::now();
        if let Err(e) = self.draw(&frame) {
            log::warn!("网页窗口: {e}");
        }
        if let Some(server) = server() {
            server.state().frames += 1;
        }
        log::debug!(target: "perf::raster", "surface ms={:.3}", acde_log::since_ms(started));
    }

    fn capture(&self) -> Result<Shot, String> {
        let page = self.page.as_ref().ok_or("the window has not drawn a frame yet")?;
        let (width, height) = page.size;
        let rgba = self.gpu.shared.read(&page.texture, [0, 0, width, height])?;
        let png = acde_render::encode_png(width, height, &rgba).ok_or("png encoding failed")?;
        Ok(Shot { width, height, png })
    }

    fn dump(&self) {
        let Some(dir) = &self.dump else {
            return;
        };
        let written = self.capture().and_then(|shot| {
            let _ = std::fs::create_dir_all(dir);
            std::fs::write(dir.join(format!("{}.png", self.id)), shot.png).map_err(|e| e.to_string())
        });
        if let Err(e) = written {
            log::warn!("ACDE_HOST_DUMP: {e}");
        }
    }

    fn draw(&mut self, frame: &acde_render::Frame) -> Result<(), String> {
        let size = (self.config.width, self.config.height);
        let mut scenes: Vec<(Scene, Affine)> = Self::scenes(&frame.plane)
            .into_iter()
            .map(|s| (s, Affine::IDENTITY))
            .collect();
        for panel in &frame.panels {
            if let Some([x, y, ..]) = self.panels.get(&panel.id) {
                let place = Affine::translate((x * self.scale, y * self.scale));
                scenes.extend(Self::scenes(&panel.plane).into_iter().map(|s| (s, place)));
            }
        }
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
        let params = vello::RenderParams {
            base_color: vello::peniko::Color::WHITE,
            width: size.0,
            height: size.1,
            antialiasing_method: vello::AaConfig::Area,
        };
        let gpu = self.gpu.clone();
        let view = self.page(size).view.clone();
        {
            let _lock = gpu.shared.submit_lock();
            self.vello
                .render_to_texture(gpu.device(), gpu.queue(), &self.scene, &view, &params)
                .map_err(|e| format!("vello: {e}"))?;
        }
        self.scene.reset();
        self.overrides.submitted();
        self.dump();
        self.show();
        Ok(())
    }

    fn show(&mut self) {
        let Some(bind) = self.page.as_ref().map(|p| p.bind.clone()) else {
            return;
        };
        let gpu = self.gpu.clone();
        self.retry = None;
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                log::debug!("窗口的 surface 过期, 重新配置");
                self.configure();
                self.retry = Some(Instant::now());
                return;
            }
            wgpu::CurrentSurfaceTexture::Occluded => {
                log::debug!("窗口 {} 被挡住, 等它露出来再上屏", self.id);
                return;
            }
            _ => {
                self.retry = Some(Instant::now());
                return;
            }
        };
        let target = texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu
            .device()
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("acde host blit"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("acde host blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        {
            let _lock = gpu.shared.submit_lock();
            gpu.queue().submit([encoder.finish()]);
        }
        self.window.pre_present_notify();
        gpu.queue().present(texture);
    }
}
