use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Once};
use std::time::Duration;

use crate::{GpuImage, ImageSet};

type LostListener = Box<dyn Fn(&str) + Send>;
type Waiter = Box<dyn FnOnce(Option<Arc<Gpu>>) + Send>;
pub type ErrorSink = Box<dyn FnMut(wgpu::Error)>;

const WAIT: Duration = Duration::from_secs(10);
const POLL_BUSY: Duration = Duration::from_micros(500);
const POLL_IDLE: Duration = Duration::from_millis(4);

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    pub images: Arc<ImageSet>,
    submit: Mutex<()>,
    polls: Mutex<usize>,
    polling: Condvar,
    poller: Once,
    lost: Mutex<HashMap<u64, LostListener>>,
    gone: AtomicBool,
}

enum State {
    Unset,
    Expected,
    Own(Option<Arc<Gpu>>),
    Published(Option<Arc<Gpu>>),
}

struct Registry {
    state: State,
    waiters: Vec<Waiter>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry { state: State::Unset, waiters: Vec::new() });
static READY: Condvar = Condvar::new();
static NEXT_LISTENER: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static SINK: RefCell<Option<ErrorSink>> = const { RefCell::new(None) };
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn adapters() -> (wgpu::Instance, Vec<wgpu::Adapter>) {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor { backends: crate::BACKEND, ..wgpu::InstanceDescriptor::new_without_display_handle_from_env() });
    let mut adapters: Vec<_> =
        pollster::block_on(instance.enumerate_adapters(crate::BACKEND)).into_iter().filter(|a| a.get_info().device_type != wgpu::DeviceType::Cpu).collect();
    adapters.sort_by_key(|a| match a.get_info().device_type {
        wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => 0,
        _ => 1,
    });
    (instance, adapters)
}

pub fn no_adapter(instance: &wgpu::Instance) -> String {
    let (api, hint) = cfg_select! {
        windows => ("Direct3D 12", "install or update the GPU's driver from its vendor or Windows Update"),
        target_os = "macos" => ("Metal", "this Mac's GPU does not support Metal"),
        _ => ("Vulkan", "install the GPU's Vulkan driver (for example vulkan-intel, vulkan-radeon, nvidia-utils) or point VK_DRIVER_FILES at its ICD"),
    };
    let cause = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) {
        Err(error) => format!("wgpu: {error}"),
        Ok(adapter) => format!("only the software adapter {}", adapter.get_info().name),
    };
    let seen = system_gpu().map(|gpu| format!("the system has a GPU ({gpu}) but ")).unwrap_or_default();
    format!("{seen}no usable {api} driver was found: {hint} ({cause})")
}

#[cfg(target_os = "linux")]
fn system_gpu() -> Option<String> {
    let mut cards: Vec<_> = std::fs::read_dir("/sys/class/drm")
        .ok()?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.strip_prefix("card").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
        .collect();
    cards.sort();
    let card = cards.into_iter().next()?;
    let driver = std::fs::read_link(format!("/sys/class/drm/{card}/device/driver")).ok();
    let driver = driver.as_deref().and_then(|path| path.file_name()).map(|name| format!(", kernel driver {}", name.to_string_lossy()));
    Some(format!("{card}{}", driver.unwrap_or_default()))
}

#[cfg(not(target_os = "linux"))]
fn system_gpu() -> Option<String> {
    None
}

pub fn texture(device: &wgpu::Device, (width, height): (u32, u32), usage: wgpu::TextureUsages, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage,
        view_formats: &[],
    })
}

pub fn set_error_sink(sink: Option<ErrorSink>) {
    SINK.with(|s| *s.borrow_mut() = sink);
}

impl Gpu {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, info: wgpu::AdapterInfo) -> Arc<Self> {
        let gpu = Arc::new(Self {
            device,
            queue,
            info,
            images: Arc::default(),
            submit: Mutex::new(()),
            polls: Mutex::new(0),
            polling: Condvar::new(),
            poller: Once::new(),
            lost: Mutex::default(),
            gone: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&gpu);
        gpu.device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            let error = SINK.with(|sink| match sink.borrow_mut().as_mut() {
                Some(sink) => {
                    sink(error);
                    None
                }
                None => Some(error),
            });
            let Some(error) = error else { return };
            if weak.upgrade().is_some_and(|gpu| gpu.gone()) {
                return log::debug!("GPU error after the device was lost: {error}");
            }
            panic!("wgpu error: {error}");
        }));
        let weak = Arc::downgrade(&gpu);
        gpu.device.set_device_lost_callback(move |reason, message| {
            log::error!("web layer GPU device lost ({reason:?}): {message}");
            if let Some(gpu) = weak.upgrade() {
                gpu.gone.store(true, Ordering::SeqCst);
                for listener in lock(&gpu.lost).values() {
                    listener(&message);
                }
            }
        });
        gpu
    }

    pub fn open(label: &str) -> Result<(wgpu::Instance, wgpu::Adapter, Arc<Self>), String> {
        let (instance, adapters) = adapters();
        let Some(adapter) = adapters.into_iter().next() else { return Err(no_adapter(&instance)) };
        let info = adapter.get_info();
        let desc = wgpu::DeviceDescriptor { label: Some(label), required_limits: adapter.limits(), ..Default::default() };
        let (device, queue) = pollster::block_on(adapter.request_device(&desc)).map_err(|e| format!("opening {}: {e}", info.name))?;
        Ok((instance, adapter, Self::new(device, queue, info)))
    }

    pub fn expect() {
        let mut registry = lock(&REGISTRY);
        if matches!(registry.state, State::Unset) {
            registry.state = State::Expected;
        }
    }

    pub fn publish(gpu: Option<Arc<Gpu>>) -> Option<Arc<Gpu>> {
        let mut registry = lock(&REGISTRY);
        if let State::Published(published) = &registry.state {
            return published.clone();
        }
        registry.state = State::Published(gpu.clone());
        READY.notify_all();
        let waiters = std::mem::take(&mut registry.waiters);
        drop(registry);
        for waiter in waiters {
            waiter(gpu.clone());
        }
        gpu
    }

    pub fn get() -> Option<Option<Arc<Gpu>>> {
        match &lock(&REGISTRY).state {
            State::Published(gpu) => Some(gpu.clone()),
            _ => None,
        }
    }

    pub fn when_ready(f: impl FnOnce(Option<Arc<Gpu>>) + Send + 'static) {
        let mut registry = lock(&REGISTRY);
        match &registry.state {
            State::Published(gpu) => {
                let gpu = gpu.clone();
                drop(registry);
                f(gpu);
            }
            _ => registry.waiters.push(Box::new(f)),
        }
    }

    pub fn shared() -> Option<Arc<Gpu>> {
        let mut registry = lock(&REGISTRY);
        if matches!(registry.state, State::Unset) {
            registry.state = State::Own(Self::open("acde offscreen").map(|(.., gpu)| gpu).inspect_err(|e| log::warn!("render: GPU: {e}")).ok());
        }
        let (registry, _) = READY.wait_timeout_while(registry, WAIT, |r| matches!(r.state, State::Expected)).unwrap_or_else(|e| e.into_inner());
        match &registry.state {
            State::Own(gpu) | State::Published(gpu) => gpu.clone(),
            _ => None,
        }
    }

    pub fn gone(&self) -> bool {
        self.gone.load(Ordering::SeqCst)
    }

    pub fn destroy(&self) {
        self.gone.store(true, Ordering::SeqCst);
        self.device.destroy();
    }

    pub fn submit_lock(&self) -> MutexGuard<'_, ()> {
        lock(&self.submit)
    }

    pub fn submit<I: IntoIterator<Item = wgpu::CommandBuffer>>(&self, buffers: I) -> wgpu::SubmissionIndex {
        let _guard = self.submit_lock();
        self.queue.submit(buffers)
    }

    pub fn write(&self, image: &GpuImage, data: &[u8], (width, height): (u32, u32), from: [u32; 2], [x, y, w, h]: [u32; 4]) {
        if w == 0 || h == 0 || data.len() < (width * height * 4) as usize {
            return;
        }
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &image.texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: u64::from((from[1] * width + from[0]) * 4), bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
    }

    pub fn read(&self, texture: &wgpu::Texture, [x, y, w, h]: [u32; 4]) -> Result<Vec<u8>, String> {
        if w == 0 || h == 0 || x + w > texture.width() || y + h > texture.height() {
            return Err(format!("{w}x{h} at ({x}, {y}) is outside the {}x{} texture", texture.width(), texture.height()));
        }
        let stride = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("acde read back"),
            size: u64::from(stride) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde read back") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(h) },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let index = self.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, move |r| _ = tx.send(r));
        self.device.poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(WAIT) }).map_err(|e| format!("waiting for the read back: {e}"))?;
        rx.recv_timeout(WAIT).map_err(|e| e.to_string())?.map_err(|e| format!("read back: {e}"))?;
        let mapped = slice.get_mapped_range().map_err(|e| format!("read back: {e}"))?;
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for row in mapped.chunks_exact(stride as usize) {
            out.extend_from_slice(&row[..(w * 4) as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(out)
    }

    pub fn hold_poll(self: &Arc<Self>) {
        self.poller.call_once(|| {
            let gpu = self.clone();
            if let Err(e) = std::thread::Builder::new().name("acde-gpu-poll".into()).spawn(move || gpu.poll_forever()) {
                log::error!("WebGPU poll thread: {e}");
            }
        });
        *lock(&self.polls) += 1;
        self.polling.notify_all();
    }

    pub fn release_poll(&self) {
        let mut polls = lock(&self.polls);
        *polls = polls.saturating_sub(1);
        self.polling.notify_all();
    }

    fn poll_forever(&self) {
        loop {
            drop(self.polling.wait_while(lock(&self.polls), |p| *p == 0).unwrap_or_else(|e| e.into_inner()));
            let pause = match self.device.poll(wgpu::PollType::Poll) {
                Ok(wgpu::PollStatus::QueueEmpty) | Err(_) => POLL_IDLE,
                Ok(_) => POLL_BUSY,
            };
            let polls = lock(&self.polls);
            if *polls > 0 {
                drop(self.polling.wait_timeout(polls, pause).unwrap_or_else(|e| e.into_inner()));
            }
        }
    }

    pub fn on_lost(&self, f: impl Fn(&str) + Send + 'static) -> u64 {
        let id = NEXT_LISTENER.fetch_add(1, Ordering::Relaxed);
        lock(&self.lost).insert(id, Box::new(f));
        id
    }

    pub fn forget_lost(&self, id: u64) {
        lock(&self.lost).remove(&id);
    }
}
