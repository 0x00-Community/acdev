use std::os::fd::OwnedFd;
use std::sync::mpsc;

use acde_gpu::{Device, Dmabuf as GpuDmabuf, Raster as Pages, Scene};
use acde_render::gpu::Overrides;
use smithay::backend::allocator::Buffer;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::reexports::calloop::ping::Ping;

use crate::gpu::Gpu;
use crate::plane::Content;

const IDLE_TRIM: std::time::Duration = std::time::Duration::from_secs(2);

pub type Pass = acde_gpu::Pass<Content>;

pub enum Job {
    Canvases(usize, Vec<Dmabuf>, (u32, u32)),
    Draw(Vec<Pass>),
    Release(usize),
    Icon { dmabuf: Dmabuf, size: (u32, u32), scene: Scene, reply: mpsc::Sender<Result<(), String>> },
}

pub type Ready = std::sync::Arc<std::sync::OnceLock<bool>>;

pub type Done = Result<Option<OwnedFd>, String>;

pub struct Raster {
    pages: Pages,
    overrides: Overrides,
    gpu: Option<std::sync::Arc<Gpu>>,
}

impl Raster {
    fn plane(dmabuf: &Dmabuf) -> Option<GpuDmabuf<'_>> {
        let fd = dmabuf.handles().next()?;
        let stride = dmabuf.strides().next().unwrap_or(dmabuf.width() * 4);
        Some(GpuDmabuf { fd, offset: dmabuf.offsets().next().unwrap_or(0), stride, modifier: dmabuf.format().modifier.into() })
    }

    pub fn new() -> Result<Self, String> {
        let device = Device::open()?;
        log::info!("网页图层用 {} ({:?})", device.info.name, device.info.device_type);
        let published = (device.device.clone(), device.queue.clone(), device.info.clone());
        let started = std::time::Instant::now();
        let pages = Pages::new(device, std::env::var_os("ACDE_WEB_POLL").is_some())?;
        log::info!("vello 预热 {:.1}ms", acde_log::since_ms(started));
        let gpu = Gpu::publish(Some(published));
        let images = gpu.as_ref().map_or_else(Default::default, |g| g.images().clone());
        Ok(Self { pages, overrides: Overrides::from(images), gpu })
    }

    pub fn spawn(jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>, ready: Ready, waker: Ping) -> std::io::Result<()> {
        acde_render::gpu::expect();
        std::thread::Builder::new().name("acde-web".into()).spawn(move || {
            let mut raster = match Self::new() {
                Ok(raster) => raster,
                Err(e) => {
                    log::error!("网页图层不可用: {e}");
                    Gpu::publish(None);
                    let _ = ready.set(false);
                    waker.ping();
                    return;
                }
            };
            let _ = ready.set(true);
            waker.ping();
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
                    self.pages.idle();
                    match jobs.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            match job {
                Job::Canvases(plane, dmabufs, size) => {
                    let planes: Vec<GpuDmabuf<'_>> = dmabufs.iter().filter_map(Self::plane).collect();
                    for e in self.pages.canvases(plane, &planes, size).into_iter().filter_map(Result::err) {
                        log::warn!("网页画布导入 Vulkan: {e}");
                    }
                }
                Job::Release(plane) => self.pages.release(plane),
                Job::Icon { dmabuf, size, scene, reply } => {
                    let drawn =
                        Self::plane(&dmabuf).ok_or_else(|| "dmabuf 没有平面".to_string()).and_then(|d| self.pages.icon(d, size, scene, &mut self.overrides));
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
