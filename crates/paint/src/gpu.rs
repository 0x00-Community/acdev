use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};

use acde_gpu::wgpu;
use acde_render::gpu::Shared;

type LostListener = Box<dyn Fn(&str) + Send>;
type Waiter = Box<dyn FnOnce(Option<Arc<Gpu>>) + Send>;
pub type ErrorSink = Box<dyn FnMut(wgpu::Error)>;

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    shared: Arc<Shared>,
    polls: Mutex<usize>,
    polling: Condvar,
    poller: std::sync::Once,
    lost: Mutex<HashMap<u64, LostListener>>,
}

const POLL_BUSY: std::time::Duration = std::time::Duration::from_micros(500);
const POLL_IDLE: std::time::Duration = std::time::Duration::from_millis(4);

static GPU: OnceLock<Option<Arc<Gpu>>> = OnceLock::new();
static WAITERS: Mutex<Vec<Waiter>> = Mutex::new(Vec::new());
static NEXT_LISTENER: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static SINK: RefCell<Option<ErrorSink>> = const { RefCell::new(None) };
}

impl Gpu {
    pub(crate) fn publish(gpu: Option<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo)>) -> Option<Arc<Gpu>> {
        let gpu = gpu.map(|(device, queue, info)| {
            let gpu = Arc::new(Gpu {
                shared: Shared::new(device.clone(), queue.clone()),
                device,
                queue,
                info,
                polls: Mutex::new(0),
                polling: Condvar::new(),
                poller: std::sync::Once::new(),
                lost: Mutex::new(HashMap::new()),
            });
            gpu.device.on_uncaptured_error(Arc::new(|error: wgpu::Error| {
                let error = SINK.with(|sink| match sink.borrow_mut().as_mut() {
                    Some(sink) => {
                        sink(error);
                        None
                    }
                    None => Some(error),
                });
                if let Some(error) = error {
                    panic!("wgpu error: {error}");
                }
            }));
            let weak = Arc::downgrade(&gpu);
            gpu.device.set_device_lost_callback(move |reason, message| {
                log::error!("网页图层的 GPU 设备丢了 ({reason:?}): {message}");
                if let Some(gpu) = weak.upgrade() {
                    for listener in gpu.lost.lock().unwrap_or_else(|e| e.into_inner()).values() {
                        listener(&message);
                    }
                }
            });
            gpu
        });
        if GPU.set(gpu.clone()).is_err() {
            return GPU.get().cloned().flatten();
        }
        acde_render::gpu::install(gpu.as_ref().map(|g| g.shared.clone()));
        let waiters = std::mem::take(&mut *WAITERS.lock().unwrap_or_else(|e| e.into_inner()));
        for waiter in waiters {
            waiter(gpu.clone());
        }
        gpu
    }

    pub fn get() -> Option<Option<Arc<Gpu>>> {
        GPU.get().cloned()
    }

    pub fn when_ready(f: impl FnOnce(Option<Arc<Gpu>>) + Send + 'static) {
        let mut waiters = WAITERS.lock().unwrap_or_else(|e| e.into_inner());
        match GPU.get() {
            Some(gpu) => {
                drop(waiters);
                f(gpu.clone());
            }
            None => waiters.push(Box::new(f)),
        }
    }

    pub fn submit<I: IntoIterator<Item = wgpu::CommandBuffer>>(&self, buffers: I) -> wgpu::SubmissionIndex {
        let _guard = self.submit_lock();
        self.queue.submit(buffers)
    }

    pub(crate) fn submit_lock(&self) -> MutexGuard<'_, ()> {
        self.shared.submit_lock()
    }

    pub(crate) fn submit_mutex(&self) -> &Mutex<()> {
        self.shared.submit_mutex()
    }

    /// The GPU images made on this device (canvases a page can paint with).
    pub fn images(&self) -> &Arc<acde_gpu::ImageSet> {
        &self.shared.images
    }

    pub fn hold_poll(self: &Arc<Self>) {
        self.poller.call_once(|| {
            let gpu = self.clone();
            if let Err(e) = std::thread::Builder::new().name("acde-gpu-poll".into()).spawn(move || gpu.poll_forever()) {
                log::error!("WebGPU poll 线程: {e}");
            }
        });
        let mut polls = self.polls.lock().unwrap_or_else(|e| e.into_inner());
        *polls += 1;
        self.polling.notify_all();
    }

    pub fn release_poll(&self) {
        let mut polls = self.polls.lock().unwrap_or_else(|e| e.into_inner());
        *polls = polls.saturating_sub(1);
        self.polling.notify_all();
    }

    fn poll_forever(&self) {
        loop {
            {
                let polls = self.polls.lock().unwrap_or_else(|e| e.into_inner());
                drop(self.polling.wait_while(polls, |p| *p == 0).unwrap_or_else(|e| e.into_inner()));
            }
            let pause = match self.device.poll(wgpu::PollType::Poll) {
                Ok(wgpu::PollStatus::QueueEmpty) | Err(_) => POLL_IDLE,
                Ok(_) => POLL_BUSY,
            };
            let polls = self.polls.lock().unwrap_or_else(|e| e.into_inner());
            if *polls > 0 {
                drop(self.polling.wait_timeout(polls, pause).unwrap_or_else(|e| e.into_inner()));
            }
        }
    }

    pub fn on_lost(&self, f: impl Fn(&str) + Send + 'static) -> u64 {
        let id = NEXT_LISTENER.fetch_add(1, Ordering::Relaxed);
        self.lost.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Box::new(f));
        id
    }

    pub fn forget_lost(&self, id: u64) {
        self.lost.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
}

pub fn set_error_sink(sink: Option<ErrorSink>) {
    SINK.with(|s| *s.borrow_mut() = sink);
}
