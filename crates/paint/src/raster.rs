//! A desktop or window isolate's raster thread: jobs from the painter go to acgpu's PageRaster, which draws each page on Xe3 when
//! it can and on the Vulkan fallback otherwise. acde keeps only the thread, the GBM canvases it hands over and the
//! WebGPU device it publishes from acgpu's.

use std::os::fd::OwnedFd;
use std::sync::mpsc;

use acde_render::acgpu::fallback::{self, Device, Dmabuf as AcgpuDmabuf, Raster as Vulkan};
use acde_render::acgpu::xe::Xe;
use acde_render::acgpu::{Gpu as _, PageRaster, Scene};
use acde_render::gpu::Overrides;
use smithay::backend::allocator::Buffer;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::reexports::calloop::ping::Ping;

use crate::gpu::Gpu;
use crate::plane::Content;

const IDLE_TRIM: std::time::Duration = std::time::Duration::from_secs(2);

const MAX_CANVAS: [u32; 2] = [3840, 2160];

pub type Pass = fallback::Pass<Content>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Painter {
    Vulkan,
    Xe3,
}

impl Painter {
    const ENV: &str = "ACDE_PAGES";

    fn chosen() -> Self {
        match std::env::var(Self::ENV).as_deref() {
            Ok("xe3") => Painter::Xe3,
            _ => Painter::Vulkan,
        }
    }
}

pub enum Job {
    Canvases(usize, Vec<Dmabuf>, (u32, u32)),
    Draw(Vec<Pass>),
    Release(usize),
    Icon { dmabuf: Dmabuf, size: (u32, u32), scene: Scene, reply: mpsc::Sender<Result<(), String>> },
}

pub type Ready = std::sync::Arc<std::sync::OnceLock<bool>>;

/// Set when the raster thread died (a panic): the isolate it draws for ends; the rest of the runtime goes on.
pub type Lost = std::sync::Arc<std::sync::atomic::AtomicBool>;

pub type Done = Result<Option<OwnedFd>, String>;

pub struct Raster<'d> {
    pages: PageRaster<'d>,
    overrides: Overrides,
    gpu: Option<std::sync::Arc<Gpu>>,
}

impl<'d> Raster<'d> {
    /// smithay's dma-buf as acgpu takes it (its first plane).
    fn plane(dmabuf: &Dmabuf) -> Option<AcgpuDmabuf<'_>> {
        let fd = dmabuf.handles().next()?;
        let stride = dmabuf.strides().next().unwrap_or(dmabuf.width() * 4);
        Some(AcgpuDmabuf { fd, offset: dmabuf.offsets().next().unwrap_or(0), stride, modifier: dmabuf.format().modifier.into() })
    }

    pub fn new(xe: Option<&'d Xe>) -> Result<Self, String> {
        let device = Device::open()?;
        log::info!("网页图层用 {} ({:?})", device.info.name, device.info.device_type);
        let published = (device.device.clone(), device.queue.clone(), device.info.clone());
        let started = std::time::Instant::now();
        let vulkan = Vulkan::new(device, std::env::var_os("ACDE_PAGE_POLL").is_some())?;
        log::info!("vello 预热 {:.1}ms", acde_log::since_ms(started));
        let gpu = Gpu::publish(Some(published), xe.is_some());
        let images = gpu.as_ref().map_or_else(Default::default, |g| g.images().clone());
        let pages = PageRaster::new(vulkan, xe, MAX_CANVAS, images.clone());
        log::info!("网页图层 Xe3: {}", pages.xe3());
        Ok(Self { pages, overrides: Overrides::from(images), gpu })
    }

    pub fn spawn(jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>, ready: Ready, lost: Lost, waker: Ping) -> std::io::Result<()> {
        acde_render::gpu::expect();
        std::thread::Builder::new().name("acde-raster".into()).spawn(move || {
            let xe = (Painter::chosen() == Painter::Xe3).then(|| Xe::open_first().inspect_err(|e| log::warn!("{}=xe3 但打不开 Xe3, 网页图层走 Vulkan: {e}", Painter::ENV)).ok()).flatten();
            let mut raster = match Raster::new(xe.as_ref()) {
                Ok(raster) => raster,
                Err(e) => {
                    log::error!("网页图层不可用: {e}");
                    Gpu::publish(None, false);
                    let _ = ready.set(false);
                    waker.ping();
                    return;
                }
            };
            let _ = ready.set(true);
            waker.ping();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raster.run(waker.clone(), jobs, done))).is_err() {
                log::error!("光栅化线程 panic, 结束它画的这个 isolate");
                lost.store(true, std::sync::atomic::Ordering::Release);
                waker.ping();
            }
        })?;
        Ok(())
    }

    fn run(&mut self, waker: Ping, jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>) {
        loop {
            let job = match jobs.recv_timeout(IDLE_TRIM) {
                Ok(job) => job,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.pages.vulkan.idle();
                    match jobs.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            match job {
                Job::Canvases(plane, dmabufs, size) => {
                    let planes: Vec<AcgpuDmabuf<'_>> = dmabufs.iter().filter_map(Self::plane).collect();
                    for e in self.pages.canvases(plane, &planes, size).into_iter().filter_map(Result::err) {
                        log::warn!("网页画布导入 Vulkan: {e}");
                    }
                }
                Job::Release(plane) => self.pages.release(plane),
                Job::Icon { dmabuf, size, scene, reply } => {
                    let drawn = Self::plane(&dmabuf).ok_or_else(|| "dmabuf 没有平面".to_string()).and_then(|d| self.pages.vulkan.icon(d, size, scene, &mut self.overrides));
                    let _ = reply.send(drawn);
                }
                Job::Draw(passes) => {
                    if done.send(self.draw(passes)).is_err() {
                        break;
                    }
                    waker.ping();
                }
            }
        }
    }

    fn draw(&mut self, passes: Vec<Pass>) -> Done {
        let started = std::time::Instant::now();
        let count = passes.len();
        let unlocked = std::sync::Mutex::new(());
        let lock = self.gpu.as_ref().map_or(&unlocked, |g| g.submit_mutex());
        let submitted = self.pages.draw(passes, &mut self.overrides, lock)?;
        if let Some(why) = self.pages.refused.take() {
            log::debug!(target: "perf::raster", "xe3 refused: {why}");
        }
        log::debug!(
            target: "perf::raster",
            "job surfaces={count} wait={:.3} record={:.3} ms={:.3}",
            submitted.waited.as_secs_f64() * 1000.0,
            submitted.recorded.as_secs_f64() * 1000.0,
            acde_log::since_ms(started),
        );
        Ok(submitted.fence)
    }
}
