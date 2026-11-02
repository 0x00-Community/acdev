use std::os::fd::{AsFd, AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::sync::mpsc;

use acde_render::anyrender::PaintScene;
use acde_render::anyrender_vello::VelloScenePainter;
use acde_render::anyrender_vello::wgpu;
use ash::vk;
use smithay::backend::allocator::Buffer;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::reexports::calloop::ping::Ping;
use smithay::reexports::rustix;
use vello::kurbo::Affine;
use vello::peniko::Color;
use wgpu::hal::vulkan::Api as Vk;

use crate::compose::{Composer, Shadow};
use crate::gpu::{CanvasImage, Gpu};
use crate::plane::{Content, Part, Pixels, Rect};

const EXTENSIONS: [&std::ffi::CStr; 4] = [
    ash::khr::external_memory_fd::NAME,
    ash::ext::external_memory_dma_buf::NAME,
    ash::ext::image_drm_format_modifier::NAME,
    ash::khr::external_semaphore_fd::NAME,
];

const SEMAPHORES: usize = 8;
const IDLE_TRIM: std::time::Duration = std::time::Duration::from_secs(2);

pub enum Job {
    Canvases(usize, Vec<Dmabuf>, (u32, u32)),
    Draw { surfaces: Vec<(Vec<Pass>, (u32, u32))> },
    Release(Vec<usize>),
}

pub struct Pass {
    pub plane: usize,
    pub parts: Vec<Part>,
    pub next: usize,
    pub targets: Option<Vec<Rect>>,
}

struct CpuRaster {
    workers: Vec<CpuWorker>,
    spare: Vec<Vec<u8>>,
}

#[derive(Default)]
struct CpuWorker {
    renderer: Option<anyrender_vello_cpu::VelloCpuImageRenderer>,
    size: [u32; 2],
}

struct CpuTask<'a> {
    scene: acde_render::anyrender::Scene,
    origin: Affine,
    size: [u32; 2],
    out: &'a mut [u8],
    piece: usize,
    y: u32,
}

pub struct Rastered {
    pub rgba: Vec<u8>,
    pub size: [u32; 2],
    pub opaque: Option<[u32; 4]>,
    pub shadowed: bool,
}

pub struct CpuPiece<'a> {
    pub content: &'a Content,
    pub drawn: Rect,
    pub shadows: &'a [Shadow],
}

impl CpuRaster {
    const BAND_ROWS: u32 = 32;

    fn wanted(software: bool) -> bool {
        match std::env::var("ACDE_WEB_CPU").as_deref() {
            Ok("0") => false,
            Ok("1") => true,
            _ => software,
        }
    }

    fn new() -> Self {
        let threads = std::env::var("ACDE_WEB_THREADS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1)).min(4))
            .max(1);
        log::info!("网页光栅化 (CPU) 用 {threads} 个线程");
        Self { workers: (0..threads).map(|_| CpuWorker::default()).collect(), spare: Vec::new() }
    }

    fn rasterize(&mut self, pieces: &[CpuPiece]) -> Vec<Rastered> {
        let threads = self.workers.len() as u32;
        let mut out: Vec<Vec<u8>> = pieces
            .iter()
            .map(|p| {
                let [_, _, w, h] = p.drawn.xywh();
                let mut buffer = self.spare.pop().unwrap_or_default();
                buffer.resize((w * h * 4) as usize, 0);
                buffer
            })
            .collect();
        let mut tasks = Vec::new();
        for (index, (piece, buffer)) in pieces.iter().zip(out.iter_mut()).enumerate() {
            let [ox, oy, w, h] = piece.drawn.xywh();
            let bands = (h / Self::BAND_ROWS).clamp(1, threads);
            let rows = h.div_ceil(bands);
            for (i, out) in buffer.chunks_mut((rows * w * 4) as usize).enumerate() {
                let y = oy + i as u32 * rows;
                let band = out.len() as u32 / (w * 4);
                let rect = Rect::new((ox as i32, y as i32).into(), (w as i32, band as i32).into());
                let origin = Affine::translate((-f64::from(ox), -f64::from(y)));
                tasks.push(CpuTask { scene: piece.content.scene_for(rect), origin, size: [w, band], out, piece: index, y: i as u32 * rows });
            }
        }
        tasks.sort_by_key(|t| t.size[0] * t.size[1]);
        let opaque = std::sync::Mutex::new(vec![None; pieces.len()]);
        if tasks.len() == 1 || self.workers.len() == 1 {
            for task in tasks {
                self.workers[0].draw(task, &opaque);
            }
        } else {
            let queue = std::sync::Mutex::new(tasks);
            let (first, rest) = self.workers.split_first_mut().expect("at least one worker");
            std::thread::scope(|scope| {
                for worker in rest {
                    let (queue, opaque) = (&queue, &opaque);
                    let spawned = std::thread::Builder::new().name("acde-web-cpu".into()).spawn_scoped(scope, move || worker.run(queue, opaque));
                    if let Err(e) = spawned {
                        log::warn!("网页光栅化线程: {e}");
                    }
                }
                first.run(&queue, &opaque);
            });
        }
        let mut opaque = opaque.into_inner().unwrap_or_default();
        self.shadows(pieces, &mut out, &mut opaque);
        out.into_iter()
            .zip(pieces)
            .zip(opaque)
            .map(|((rgba, piece), opaque)| {
                let [_, _, w, h] = piece.drawn.xywh();
                Rastered { rgba, size: [w, h], opaque: opaque.map(|[x0, y0, x1, y1]: [u32; 4]| [x0, y0, x1 - x0, y1 - y0]), shadowed: !piece.shadows.is_empty() }
            })
            .collect()
    }

    fn shadows(&self, pieces: &[CpuPiece], out: &mut [Vec<u8>], opaque: &mut [Option<[u32; 4]>]) {
        let mut jobs: Vec<_> = pieces.iter().zip(out.iter_mut()).zip(opaque.iter_mut()).filter(|((p, _), _)| !p.shadows.is_empty()).collect();
        if jobs.is_empty() {
            return;
        }
        type Job<'a> = ((&'a CpuPiece<'a>, &'a mut Vec<u8>), &'a mut Option<[u32; 4]>);
        let run = |jobs: &mut [Job]| {
            for ((piece, rgba), opaque) in jobs {
                let [_, _, w, h] = piece.drawn.xywh();
                Self::drop_shadows(rgba, [w, h], piece.shadows);
                **opaque = Self::opaque_bounds(rgba, w);
            }
        };
        let per = jobs.len().div_ceil(self.workers.len());
        if per == jobs.len() {
            return run(&mut jobs);
        }
        std::thread::scope(|scope| {
            for chunk in jobs.chunks_mut(per) {
                if let Err(e) = std::thread::Builder::new().name("acde-web-cpu".into()).spawn_scoped(scope, || run(chunk)) {
                    log::warn!("网页光栅化线程: {e}");
                }
            }
        });
    }

    fn drop_shadows(rgba: &mut [u8], [w, h]: [u32; 2], shadows: &[Shadow]) {
        let (w, h) = (w as usize, h as usize);
        let alpha: Vec<f32> = rgba.as_chunks::<4>().0.iter().map(|p| f32::from(p[3]) / 255.0).collect();
        let mut under = vec![[0f32; 4]; w * h];
        let mut blurred = alpha.clone();
        for s in shadows {
            blurred.copy_from_slice(&alpha);
            Self::gaussian(&mut blurred, w, h, s.blur);
            let (dx, dy) = (s.dx.round() as isize, s.dy.round() as isize);
            for y in 0..h {
                let sy = y as isize - dy;
                if sy < 0 || sy >= h as isize {
                    continue;
                }
                for x in 0..w {
                    let sx = x as isize - dx;
                    if sx < 0 || sx >= w as isize {
                        continue;
                    }
                    let a = blurred[sy as usize * w + sx as usize] * s.color[3];
                    if a <= 0.0 {
                        continue;
                    }
                    let px = &mut under[y * w + x];
                    let k = 1.0 - a;
                    *px = [s.color[0] * a + px[0] * k, s.color[1] * a + px[1] * k, s.color[2] * a + px[2] * k, a + px[3] * k];
                }
            }
        }
        for (p, u) in rgba.as_chunks_mut::<4>().0.iter_mut().zip(&under) {
            let k = 1.0 - f32::from(p[3]) / 255.0;
            for i in 0..4 {
                p[i] = (f32::from(p[i]) + u[i] * 255.0 * k).round().min(255.0) as u8;
            }
        }
    }

    fn gaussian(v: &mut [f32], w: usize, h: usize, sigma: f32) {
        if sigma < 0.5 {
            return;
        }
        let n = 3.0;
        let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
        let mut lower = ideal.floor() as i32;
        if lower % 2 == 0 {
            lower -= 1;
        }
        let l = lower as f32;
        let m = ((12.0 * sigma * sigma - n * l * l - 4.0 * n * l - 3.0 * n) / (-4.0 * l - 4.0)).round() as i32;
        let mut line = Vec::new();
        for i in 0..3 {
            let radius = ((if i < m { lower } else { lower + 2 }) - 1).max(0) as usize / 2;
            if radius == 0 {
                continue;
            }
            for row in v.chunks_exact_mut(w) {
                Self::box_line(row, 1, w, radius, &mut line);
            }
            for x in 0..w {
                Self::box_line(&mut v[x..], w, h, radius, &mut line);
            }
        }
    }

    fn box_line(v: &mut [f32], step: usize, len: usize, radius: usize, line: &mut Vec<f32>) {
        line.clear();
        line.extend((0..len).map(|i| v[i * step]));
        let scale = 1.0 / (2 * radius + 1) as f32;
        let mut sum: f32 = line.iter().take(radius).sum();
        for i in 0..len {
            if i + radius < len {
                sum += line[i + radius];
            }
            v[i * step] = sum * scale;
            if i >= radius {
                sum -= line[i - radius];
            }
        }
    }

    fn opaque_bounds(rgba: &[u8], width: u32) -> Option<[u32; 4]> {
        let mut bounds: Option<[u32; 4]> = None;
        for (y, line) in rgba.chunks_exact(width as usize * 4).enumerate() {
            if line.iter().all(|&b| b == 0) {
                continue;
            }
            let first = line.iter().position(|&b| b != 0).unwrap_or(0) as u32 / 4;
            let last = line.iter().rposition(|&b| b != 0).unwrap_or(0) as u32 / 4 + 1;
            let y = y as u32;
            bounds = Some(match bounds {
                Some([x0, y0, x1, _]) => [x0.min(first), y0, x1.max(last), y + 1],
                None => [first, y, last, y + 1],
            });
        }
        bounds
    }

    fn recycle(&mut self, buffers: impl IntoIterator<Item = Vec<u8>>) {
        self.spare.extend(buffers);
    }
}

impl CpuWorker {
    fn run(&mut self, queue: &std::sync::Mutex<Vec<CpuTask>>, opaque: &std::sync::Mutex<Vec<Option<[u32; 4]>>>) {
        loop {
            let Some(task) = queue.lock().ok().and_then(|mut q| q.pop()) else { return };
            self.draw(task, opaque);
        }
    }

    fn draw(&mut self, CpuTask { scene, origin, size, out, piece, y }: CpuTask, opaque: &std::sync::Mutex<Vec<Option<[u32; 4]>>>) {
        use acde_render::anyrender::ImageRenderer;
        let renderer = match self.renderer.as_mut() {
            Some(renderer) if self.size == size => {
                renderer.reset();
                renderer
            }
            Some(renderer) => {
                renderer.resize(size[0], size[1]);
                renderer
            }
            None => self.renderer.insert(anyrender_vello_cpu::VelloCpuImageRenderer::new(size[0], size[1])),
        };
        self.size = size;
        renderer.render(|painter| painter.append_scene(scene, origin), out);
        let Some([x0, y0, x1, y1]) = CpuRaster::opaque_bounds(out, size[0]) else { return };
        let band = [x0, y + y0, x1, y + y1];
        if let Ok(mut opaque) = opaque.lock() {
            let merged = opaque[piece].map_or(band, |[a, b, c, d]: [u32; 4]| [a.min(band[0]), b.min(band[1]), c.max(band[2]), d.max(band[3])]);
            opaque[piece] = Some(merged);
        }
    }
}

#[derive(Default)]
pub struct Status {
    pub software: std::sync::OnceLock<bool>,
    pub ready: std::sync::OnceLock<bool>,
}

pub struct Drew {
    pub fence: Option<OwnedFd>,
    pub partial: bool,
}

pub type Done = Result<Drew, String>;

pub struct Raster {
    device: wgpu::Device,
    queue: wgpu::Queue,
    vello: vello::Renderer,
    scene: vello::Scene,
    canvases: std::collections::HashMap<usize, Vec<Option<(wgpu::Texture, wgpu::TextureView)>>>,
    semaphores: Vec<vk::Semaphore>,
    next_semaphore: usize,
    submits: std::collections::VecDeque<(wgpu::SubmissionIndex, Option<OwnedFd>)>,
    composer: Composer,
    cpu: Option<CpuRaster>,
    gpu: Option<std::sync::Arc<Gpu>>,
    overrides: std::collections::HashMap<u64, (u64, u32, u32)>,
    copying: Vec<(std::sync::Arc<CanvasImage>, u64)>,
    poll: bool,
}

impl Raster {
    pub fn new(on_device: impl FnOnce(bool)) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let choice = std::env::var("ACDE_VK").unwrap_or_default();
        let mut adapters: Vec<_> = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN))
            .into_iter()
            .filter(|a| choice != "none" && (choice != "cpu" || a.get_info().device_type == wgpu::DeviceType::Cpu))
            .collect();
        adapters.sort_by_key(|a| match a.get_info().device_type {
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => 0,
            wgpu::DeviceType::VirtualGpu | wgpu::DeviceType::Other => 1,
            wgpu::DeviceType::Cpu => 2,
        });
        let mut errors = Vec::new();
        let (adapter, device, queue) = adapters
            .into_iter()
            .find_map(|adapter| match Self::open(&adapter) {
                Ok((device, queue)) => Some((adapter, device, queue)),
                Err(e) => {
                    errors.push(format!("{}: {e}", adapter.get_info().name));
                    None
                }
            })
            .ok_or_else(|| if errors.is_empty() { "没有 Vulkan 设备".to_string() } else { errors.join("; ") })?;
        log::info!("网页图层用 {} ({:?})", adapter.get_info().name, adapter.get_info().device_type);
        let software = adapter.get_info().device_type == wgpu::DeviceType::Cpu;
        on_device(software);
        let vello = vello::Renderer::new(
            &device,
            vello::RendererOptions { use_cpu: false, antialiasing_support: vello::AaSupport::area_only(), num_init_threads: None, pipeline_cache: None },
        )
        .map_err(|e| format!("vello: {e}"))?;
        let composer = Composer::new(&device, &queue);
        let cpu = CpuRaster::wanted(software).then(CpuRaster::new);
        let mut raster = Self {
            device,
            queue,
            vello,
            scene: vello::Scene::new(),
            canvases: Default::default(),
            semaphores: Vec::new(),
            next_semaphore: 0,
            submits: Default::default(),
            composer,
            gpu: None,
            overrides: Default::default(),
            copying: Vec::new(),
            cpu,
            poll: std::env::var_os("ACDE_WEB_POLL").is_some(),
        };
        raster.semaphores = raster.create_semaphores();
        raster.warm_up();
        let shared = raster.cpu.is_none().then(|| (raster.device.clone(), raster.queue.clone(), adapter.get_info()));
        raster.gpu = Gpu::publish(shared);
        Ok(raster)
    }

    pub fn spawn(jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>, status: std::sync::Arc<Status>, waker: Ping) -> std::io::Result<()> {
        std::thread::Builder::new().name("acde-web".into()).spawn(move || {
            let on_device = |software: bool| {
                let _ = status.software.set(software);
                waker.ping();
            };
            let mut raster = match Self::new(on_device) {
                Ok(raster) => raster,
                Err(e) => {
                    log::warn!("网页图层不可用: {e}");
                    Gpu::publish(None);
                    let _ = status.ready.set(false);
                    return;
                }
            };
            let _ = status.ready.set(true);
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raster.run(waker, jobs, done))).is_err() {
                log::error!("网页图层的光栅化线程 panic, 退出这个 web 进程");
                acde_log::flush();
                std::process::exit(101);
            }
        })?;
        Ok(())
    }

    fn run(&mut self, waker: Ping, jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>) {
        loop {
            let job = match jobs.recv_timeout(IDLE_TRIM) {
                Ok(job) => job,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.composer.trim();
                    match jobs.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            match job {
                Job::Canvases(plane, dmabufs, size) => {
                    let canvases = dmabufs
                        .iter()
                        .map(|d| {
                            let t = self.import_vulkan(d, size).inspect_err(|e| log::warn!("网页画布导入 Vulkan: {e}")).ok()?;
                            let view = t.create_view(&wgpu::TextureViewDescriptor::default());
                            Some((t, view))
                        })
                        .collect();
                    self.canvases.insert(plane, canvases);
                }
                Job::Release(planes) => {
                    for plane in planes {
                        self.canvases.remove(&plane);
                    }
                }
                Job::Draw { surfaces } => {
                    let result = self.draw(surfaces);
                    if done.send(result).is_err() {
                        break;
                    }
                    waker.ping();
                }
            }
        }
    }

    fn open(adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue), String> {
        let limits = adapter.limits();
        let features = adapter.features() & wgpu::Features::all_webgpu_mask();
        let hal = unsafe {
            let hal_adapter = adapter.as_hal::<Vk>().ok_or("不是 Vulkan adapter")?;
            let caps = hal_adapter.physical_device_capabilities();
            let missing: Vec<_> = EXTENSIONS.iter().filter(|e| !caps.supports_extension(e)).map(|e| e.to_string_lossy()).collect();
            if !missing.is_empty() {
                return Err(format!("缺 Vulkan 扩展 {}", missing.join(", ")));
            }
            hal_adapter
                .open_with_callback(
                    features,
                    &limits,
                    &wgpu::MemoryHints::MemoryUsage,
                    Some(Box::new(|args| args.extensions.extend(EXTENSIONS))),
                )
                .map_err(|e| format!("打开 Vulkan 设备: {e}"))?
        };
        let desc = wgpu::DeviceDescriptor { label: Some("acde web"), required_features: features, required_limits: limits, ..Default::default() };
        unsafe { adapter.create_device_from_hal::<Vk>(hal, &desc) }.map_err(|e| format!("wgpu 设备: {e}"))
    }

    fn draw(&mut self, surfaces: Vec<(Vec<Pass>, (u32, u32))>) -> Done {
        let started = std::time::Instant::now();
        self.copying.clear();
        let count = surfaces.len();
        let mut rasters = self.cpu.as_mut().map(|cpu| {
            let pieces: Vec<CpuPiece> = surfaces
                .iter()
                .flat_map(|(passes, size)| {
                    let full = Rect::from_size((size.0 as i32, size.1 as i32).into());
                    passes.iter().flat_map(move |pass| {
                        let targets = pass.targets.clone().unwrap_or_else(|| vec![full]);
                        pass.parts.iter().flat_map(move |part| {
                            let shadows: &[Shadow] = if part.effect.is_none() { &part.shadows } else { &[] };
                            Self::pieces(part, &targets, full).into_iter().map(move |(drawn, _)| CpuPiece { content: &part.content, drawn, shadows })
                        })
                    })
                })
                .collect();
            cpu.rasterize(&pieces).into_iter()
        });
        let mut used: Vec<Vec<u8>> = Vec::new();
        let oldest = if self.submits.len() > 1 { self.submits.pop_front() } else { None };
        let rastered = started.elapsed();
        let poll = match oldest {
            Some((_, Some(fence))) => {
                let mut fds = [rustix::event::PollFd::new(&fence, rustix::event::PollFlags::IN)];
                if let Err(e) = rustix::event::poll(&mut fds, Some(&rustix::event::Timespec { tv_sec: 1, tv_nsec: 0 })) {
                    log::warn!("等上一帧网页: {e}");
                }
                wgpu::PollType::Poll
            }
            Some((index, None)) => wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(std::time::Duration::from_secs(1)) },
            None => wgpu::PollType::Poll,
        };
        if let Err(e) = self.device.poll(poll) {
            log::warn!("等上一帧网页: {e}");
        }
        let waited = started.elapsed();
        let encoder_desc = wgpu::CommandEncoderDescriptor { label: Some("acde web") };
        let mut encoder = self.device.create_command_encoder(&encoder_desc);
        for (passes, size) in surfaces {
            for pass in passes {
                self.draw_pass(&mut encoder, pass, size, rasters.as_mut(), &mut used)?;
            }
        }
        let semaphore = self.semaphores.get(self.next_semaphore).copied().filter(|_| !self.poll);
        let lock = self.gpu.as_ref().map(|gpu| gpu.submit_lock());
        if let Some(s) = semaphore {
            if let Some(queue) = unsafe { self.queue.as_hal::<Vk>() } {
                queue.add_signal_semaphore(s, None);
            }
            self.next_semaphore = (self.next_semaphore + 1) % self.semaphores.len();
        }
        self.submits.push_back((Self::submit(&self.device, &self.queue, &mut self.composer, &mut encoder), None));
        drop(lock);
        for (canvas, generation) in self.copying.drain(..) {
            canvas.mark_copied(generation);
        }
        log::debug!(
            target: "perf::raster",
            "job surfaces={count} cpu={:.3} wait={:.3} record={:.3} ms={:.3}",
            rastered.as_secs_f64() * 1000.0,
            (waited - rastered).as_secs_f64() * 1000.0,
            (started.elapsed() - waited).as_secs_f64() * 1000.0,
            acde_log::since_ms(started),
        );
        self.composer.end_frame();
        self.forget_canvases();
        if let Some(cpu) = self.cpu.as_mut() {
            cpu.recycle(used);
        }
        match semaphore.and_then(|s| self.export_sync_file(s)) {
            Some(fd) => {
                if let Some(last) = self.submits.back_mut() {
                    last.1 = fd.try_clone().ok();
                }
                Ok(Drew { fence: Some(fd), partial: false })
            }
            None => {
                self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("等 GPU: {e}"))?;
                Ok(Drew { fence: None, partial: false })
            }
        }
    }

    fn submit(device: &wgpu::Device, queue: &wgpu::Queue, composer: &mut Composer, encoder: &mut wgpu::CommandEncoder) -> wgpu::SubmissionIndex {
        composer.flush();
        let done = std::mem::replace(encoder, device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde web") }));
        queue.submit([done.finish()])
    }

    fn pieces(part: &Part, targets: &[Rect], full: Rect) -> Vec<(Rect, Rect)> {
        let margin = part.shadows.iter().map(|s| (s.dx.abs().max(s.dy.abs()) + 4.0 * s.blur).ceil() as i32).max().unwrap_or(0).max((3.0 * part.effect.blur).ceil() as i32);
        targets
            .iter()
            .filter_map(|t| {
                let clip = part.bounds.map_or(Some(*t), |b| b.intersection(*t))?;
                let drawn = part.bounds.map_or(Some(*t), |b| b.intersection(t.grown(margin)))?.intersection(full)?;
                Some((drawn, clip))
            })
            .collect()
    }

    fn draw_pass(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        Pass { plane, parts, next, targets }: Pass,
        size: (u32, u32),
        mut rasters: Option<&mut std::vec::IntoIter<Rastered>>,
        used: &mut Vec<Vec<u8>>,
    ) -> Result<(), String> {
        let full = Rect::from_size((size.0 as i32, size.1 as i32).into());
        let (_, canvas_view) = self.canvases.get(&plane).and_then(|c| c.get(next)?.clone()).ok_or("网页画布还没导入")?;
        let layer = self.composer.layer_view(size);
        match &targets {
            Some(regions) => self.composer.clear_rects(encoder, &canvas_view, regions.iter().map(Pixels::xywh)),
            None => Composer::clear(encoder, &canvas_view),
        }
        let targets = targets.unwrap_or_else(|| vec![full]);
        for part in parts {
            if let Some(backdrop) = part.backdrop.as_ref().filter(|b| targets.iter().any(|t| Rect::covering(b.rect).overlaps(*t))) {
                self.composer.backdrop(encoder, None, &canvas_view, backdrop);
            }
            for (drawn, clip) in Self::pieces(&part, &targets, full) {
                let [ox, oy, width, height] = drawn.xywh();
                let origin = Affine::translate((-f64::from(ox), -f64::from(oy)));
                let premultiplied = match rasters.as_mut() {
                    Some(rasters) => {
                        let Rastered { rgba, size, opaque, shadowed } = rasters.next().ok_or("网页: CPU 画好的块不够")?;
                        let plain = part.effect.is_none() && (part.shadows.is_empty() || shadowed);
                        let region = match opaque {
                            None if plain => {
                                used.push(rgba);
                                continue;
                            }
                            Some(o) if plain => o,
                            _ => [0, 0, size[0], size[1]],
                        };
                        let [_, _, w, h] = region;
                        if !self.composer.staging_room([w, h]) {
                            Self::submit(&self.device, &self.queue, &mut self.composer, encoder);
                            self.composer.staging_room([w, h]);
                        }
                        self.composer.upload_layer(encoder, &rgba, size[0], region);
                        used.push(rgba);
                        if plain {
                            let at = Rect::new(((ox + region[0]) as i32, (oy + region[1]) as i32).into(), (w as i32, h as i32).into());
                            if let Some(clip) = clip.intersection(at) {
                                self.composer.place(encoder, &canvas_view, [ox + region[0], oy + region[1]], clip.xywh(), true);
                            }
                            continue;
                        }
                        true
                    }
                    None => {
                        let scene = part.content.scene_for(drawn);
                        if scene.commands.is_empty() {
                            continue;
                        }
                        Self::submit(&self.device, &self.queue, &mut self.composer, encoder);
                        self.scene.reset();
                        if CanvasImage::any() {
                            self.use_canvases(&scene);
                        }
                        VelloScenePainter::new(&mut self.scene).append_scene(scene, origin);
                        let params = vello::RenderParams { base_color: Color::TRANSPARENT, width, height, antialiasing_method: vello::AaConfig::Area };
                        Self::keep_atlas(&mut self.scene);
                        self.vello.render_to_texture(&self.device, &self.queue, &self.scene, &layer, &params).map_err(|e| format!("vello 渲染: {e}"))?;
                        false
                    }
                };
                for shadow in &part.shadows {
                    self.composer.shadow(encoder, &canvas_view, shadow, drawn.xywh(), clip.xywh());
                }
                match part.effect.is_none() {
                    true => self.composer.place(encoder, &canvas_view, [ox, oy], clip.xywh(), premultiplied),
                    false => self.composer.filtered(encoder, &canvas_view, &part.effect, drawn.xywh(), clip.xywh(), premultiplied),
                }
            }
        }
        Ok(())
    }

    fn use_canvases(&mut self, scene: &acde_render::anyrender::Scene) {
        use acde_render::anyrender::Paint;
        use acde_render::anyrender::recording::RenderCommand;
        for command in &scene.commands {
            let RenderCommand::Fill(fill) = command else { continue };
            let Paint::Image(brush) = &fill.brush else { continue };
            let id = brush.image.data.id();
            let Some(canvas) = CanvasImage::find(id) else { continue };
            let generation = canvas.generation();
            match self.overrides.get_mut(&id) {
                Some((seen, ..)) if *seen == generation => {}
                Some((seen, ..)) => {
                    *seen = generation;
                    self.vello.mark_override_image_dirty(&brush.image);
                    self.copying.push((canvas, generation));
                }
                None => {
                    let texture = wgpu::TexelCopyTextureInfoBase { texture: canvas.texture.clone(), mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
                    self.vello.override_image(&brush.image, Some(texture));
                    self.overrides.insert(id, (generation, brush.image.width, brush.image.height));
                    self.copying.push((canvas, generation));
                }
            }
        }
    }

    fn forget_canvases(&mut self) {
        if self.overrides.is_empty() {
            return;
        }
        let gone: Vec<_> = self.overrides.iter().filter(|(id, _)| CanvasImage::find(**id).is_none()).map(|(id, (_, w, h))| (*id, *w, *h)).collect();
        for (id, width, height) in gone {
            self.overrides.remove(&id);
            let image = vello::peniko::ImageData {
                data: vello::peniko::Blob::from_raw_parts(std::sync::Arc::new(Vec::<u8>::new()), id),
                format: vello::peniko::ImageFormat::Rgba8,
                alpha_type: vello::peniko::ImageAlphaType::Alpha,
                width,
                height,
            };
            self.vello.override_image(&image, None);
        }
    }

    fn keep_atlas(scene: &mut vello::Scene) {
        use vello::kurbo::Rect;
        use vello::peniko::{Fill, Gradient};
        let clear = Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops([Color::TRANSPARENT, Color::TRANSPARENT]);
        scene.fill(Fill::NonZero, Affine::IDENTITY, &clear, None, &Rect::new(0.0, 0.0, 1.0, 1.0));
    }

    fn warm_up(&mut self) {
        let started = std::time::Instant::now();
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("acde web warm-up"),
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
        if let Err(e) = self.vello.render_to_texture(&self.device, &self.queue, &vello::Scene::new(), &view, &params) {
            log::warn!("vello 预热: {e}");
        }
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        log::info!("vello 预热 {:.1}ms", started.elapsed().as_secs_f64() * 1000.0);
    }

    fn create_semaphores(&self) -> Vec<vk::Semaphore> {
        unsafe {
            let Some(hal_device) = self.device.as_hal::<Vk>() else { return Vec::new() };
            let raw = hal_device.raw_device();
            (0..SEMAPHORES)
                .map_while(|_| {
                    let mut export = vk::ExportSemaphoreCreateInfo::default().handle_types(vk::ExternalSemaphoreHandleTypeFlags::SYNC_FD);
                    raw.create_semaphore(&vk::SemaphoreCreateInfo::default().push_next(&mut export), None).ok()
                })
                .collect()
        }
    }

    fn export_sync_file(&self, semaphore: vk::Semaphore) -> Option<OwnedFd> {
        let fd = unsafe {
            let hal_device = self.device.as_hal::<Vk>()?;
            let ext = ash::khr::external_semaphore_fd::Device::new(hal_device.shared_instance().raw_instance(), hal_device.raw_device());
            let info = vk::SemaphoreGetFdInfoKHR::default().semaphore(semaphore).handle_type(vk::ExternalSemaphoreHandleTypeFlags::SYNC_FD);
            ext.get_semaphore_fd(&info).ok()?
        };
        (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn import_vulkan(&self, dmabuf: &Dmabuf, (width, height): (u32, u32)) -> Result<wgpu::Texture, String> {
        let plane = dmabuf.handles().next().ok_or("dmabuf 没有平面")?;
        let offset = dmabuf.offsets().next().unwrap_or(0);
        let stride = dmabuf.strides().next().unwrap_or(width * 4);
        let modifier: u64 = dmabuf.format().modifier.into();
        unsafe {
            let hal_device = self.device.as_hal::<Vk>().ok_or("不是 Vulkan 设备")?;
            let raw = hal_device.raw_device();
            let layouts = [vk::SubresourceLayout { offset: offset.into(), size: 0, row_pitch: stride.into(), array_pitch: 0, depth_pitch: 0 }];
            let mut explicit = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::default().drm_format_modifier(modifier).plane_layouts(&layouts);
            let mut external = vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
            let info = vk::ImageCreateInfo::default()
                .image_type(vk::ImageType::TYPE_2D)
                .format(vk::Format::R8G8B8A8_UNORM)
                .extent(vk::Extent3D { width, height, depth: 1 })
                .mip_levels(1)
                .array_layers(1)
                .samples(vk::SampleCountFlags::TYPE_1)
                .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
                .usage(
                    vk::ImageUsageFlags::STORAGE
                        | vk::ImageUsageFlags::SAMPLED
                        | vk::ImageUsageFlags::TRANSFER_DST
                        | vk::ImageUsageFlags::TRANSFER_SRC
                        | vk::ImageUsageFlags::COLOR_ATTACHMENT,
                )
                .sharing_mode(vk::SharingMode::EXCLUSIVE)
                .initial_layout(vk::ImageLayout::UNDEFINED)
                .push_next(&mut external)
                .push_next(&mut explicit);
            let image = raw.create_image(&info, None).map_err(|e| format!("VkImage: {e}"))?;
            let requirements = raw.get_image_memory_requirements(image);
            let fd_ext = ash::khr::external_memory_fd::Device::new(hal_device.shared_instance().raw_instance(), raw);
            let mut fd_props = vk::MemoryFdPropertiesKHR::default();
            if let Err(e) = fd_ext.get_memory_fd_properties(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT, plane.as_raw_fd(), &mut fd_props) {
                raw.destroy_image(image, None);
                return Err(format!("dmabuf 内存属性: {e}"));
            }
            let types = requirements.memory_type_bits & fd_props.memory_type_bits;
            if types == 0 {
                raw.destroy_image(image, None);
                return Err("没有能导入这块 dmabuf 的内存类型".into());
            }
            let fd = plane.as_fd().try_clone_to_owned().map_err(|e| e.to_string())?;
            let mut import = vk::ImportMemoryFdInfoKHR::default().handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT).fd(fd.as_raw_fd());
            let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
            let alloc = vk::MemoryAllocateInfo::default()
                .allocation_size(requirements.size)
                .memory_type_index(types.trailing_zeros())
                .push_next(&mut import)
                .push_next(&mut dedicated);
            let memory = match raw.allocate_memory(&alloc, None) {
                Ok(memory) => {
                    let _ = fd.into_raw_fd();
                    memory
                }
                Err(e) => {
                    raw.destroy_image(image, None);
                    return Err(format!("导入 dmabuf 内存: {e}"));
                }
            };
            if let Err(e) = raw.bind_image_memory(image, memory, 0) {
                raw.free_memory(memory, None);
                raw.destroy_image(image, None);
                return Err(format!("绑定内存: {e}"));
            }
            let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
            let hal_desc = wgpu::hal::TextureDescriptor {
                label: Some("acde web canvas"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUses::STORAGE_READ_WRITE
                    | wgpu::TextureUses::RESOURCE
                    | wgpu::TextureUses::COPY_DST
                    | wgpu::TextureUses::COPY_SRC
                    | wgpu::TextureUses::COLOR_TARGET,
                memory_flags: wgpu::hal::MemoryFlags::empty(),
                view_formats: vec![],
            };
            let hal_texture = hal_device.texture_from_raw(image, &hal_desc, None, wgpu::hal::vulkan::TextureMemory::Dedicated(memory));
            drop(hal_device);
            Ok(self.device.create_texture_from_hal::<Vk>(
                hal_texture,
                &wgpu::TextureDescriptor {
                    label: Some("acde web canvas"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::STORAGE_BINDING
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC
                        | wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            ))
        }
    }
}
