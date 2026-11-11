use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ironrdp_server::ironrdp_dvc::encode_dvc_messages;
use ironrdp_server::ironrdp_egfx::pdu::{Avc420Region, CapabilitiesAdvertisePdu, CapabilitySet};
use ironrdp_server::ironrdp_egfx::server::{GraphicsPipelineHandler, GraphicsPipelineServer};
use ironrdp_server::ironrdp_svc::ChannelFlags;
use ironrdp_server::{BitmapUpdate, DesktopSize, EgfxServerMessage, GfxDvcBridge, GfxServerFactory, GfxServerHandle, ServerEvent, ServerEventSender};
use openh264::OpenH264API;
use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, RateControlMode, UsageType};
use openh264::formats::{RgbaSliceU8, YUVBuffer};

enum Job {
    Frame(Vec<BitmapUpdate>),
    Wake,
    Reset,
    Refresh,
}

struct Shared {
    handle: Mutex<Option<GfxServerHandle>>,
    sender: Mutex<Option<async_channel::Sender<ServerEvent>>>,
    jobs: Sender<Job>,
    size: DesktopSize,
}

#[derive(Clone)]
pub(crate) struct Video(Arc<Shared>);

struct Factory(Video);

struct Handler(Sender<Job>);

struct Encoding {
    video: Video,
    encoder: Encoder,
    framebuffer: Vec<u8>,
    yuv: YUVBuffer,
    surface: Option<u16>,
    dirty: bool,
    last: Option<Instant>,
    start: Instant,
}

impl Video {
    const FPS: f32 = 30.0;
    const FRAME: Duration = Duration::from_micros(33_333);
    const IDLE: Duration = Duration::from_secs(1);
    const BLOCKED: Duration = Duration::from_millis(100);
    const BYTES_PER_PIXEL: usize = 4;
    const QP: u8 = 22;
    const QUALITY: u8 = 100;

    pub(crate) fn start(size: DesktopSize, kbps: u32) -> Result<Self, String> {
        let (width, height) = (usize::from(size.width), usize::from(size.height));
        if width % 2 != 0 || height % 2 != 0 {
            return Err(format!("H.264 要偶数尺寸, 桌面是 {width}x{height}"));
        }
        let config = EncoderConfig::new()
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .bitrate(BitRate::from_bps(kbps.saturating_mul(1000)))
            .max_frame_rate(FrameRate::from_hz(Self::FPS))
            .skip_frames(false);
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config).map_err(|e| format!("H.264 编码器: {e}"))?;
        let (jobs, rx) = channel();
        let video = Self(Arc::new(Shared { handle: Mutex::new(None), sender: Mutex::new(None), jobs, size }));
        let encoding = Encoding {
            video: video.clone(),
            encoder,
            framebuffer: vec![0; width * height * Self::BYTES_PER_PIXEL],
            yuv: YUVBuffer::new(width, height),
            surface: None,
            dirty: false,
            last: None,
            start: Instant::now(),
        };
        std::thread::Builder::new().name("acde-rdp-h264".into()).spawn(move || encoding.run(&rx)).map_err(|e| e.to_string())?;
        log::info!("RDP 视频: H.264 {width}x{height}, {kbps} kbps, 最多 {} 帧/秒", Self::FPS);
        Ok(video)
    }

    pub(crate) fn factory(&self) -> Box<dyn GfxServerFactory> {
        Box::new(Factory(self.clone()))
    }

    fn handle(&self) -> Option<GfxServerHandle> {
        self.0.handle.lock().expect("rdp 视频锁").clone()
    }

    pub(crate) fn active(&self) -> bool {
        self.handle().is_some_and(|h| {
            let gfx = h.lock().expect("rdp 视频锁");
            gfx.is_ready() && gfx.supports_avc420()
        })
    }

    pub(crate) fn refresh(&self) {
        let _ = self.0.jobs.send(Job::Refresh);
    }

    pub(crate) fn frame(&self, bitmaps: &[BitmapUpdate]) {
        let _ = self.0.jobs.send(Job::Frame(bitmaps.to_vec()));
    }
}

impl ServerEventSender for Factory {
    fn set_sender(&mut self, sender: async_channel::Sender<ServerEvent>) {
        *self.0.0.sender.lock().expect("rdp 视频锁") = Some(sender);
    }
}

impl GfxServerFactory for Factory {
    fn build_gfx_handler(&self) -> Box<dyn GraphicsPipelineHandler> {
        Box::new(Handler(self.0.0.jobs.clone()))
    }

    fn build_server_with_handle(&self) -> Option<(GfxDvcBridge, GfxServerHandle)> {
        let shared = &self.0.0;
        let mut server = GraphicsPipelineServer::new(self.build_gfx_handler());
        server.set_output_dimensions(shared.size.width, shared.size.height);
        let handle: GfxServerHandle = Arc::new(Mutex::new(server));
        *shared.handle.lock().expect("rdp 视频锁") = Some(handle.clone());
        let _ = shared.jobs.send(Job::Reset);
        Some((GfxDvcBridge::new(handle.clone()), handle))
    }
}

impl GraphicsPipelineHandler for Handler {
    fn capabilities_advertise(&mut self, _pdu: &CapabilitiesAdvertisePdu) {}

    fn on_ready(&mut self, negotiated: &CapabilitySet) {
        log::info!("RDP 视频通道就绪: {negotiated:?}");
        let _ = self.0.send(Job::Wake);
    }

    fn on_frame_ack(&mut self, frame_id: u32, queue_depth: u32, total_frames_decoded: u32) {
        log::debug!(target: "perf::rdp", "h264 ack frame={frame_id} queue={queue_depth} decoded={total_frames_decoded}");
        let _ = self.0.send(Job::Wake);
    }
}

impl Encoding {
    fn run(mut self, jobs: &Receiver<Job>) {
        loop {
            let wait = match (self.dirty, self.last) {
                (false, _) => Video::IDLE,
                (true, Some(last)) => Video::FRAME.saturating_sub(last.elapsed()),
                (true, None) => Duration::ZERO,
            };
            match jobs.recv_timeout(wait) {
                Ok(job) => self.take(job),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            while let Ok(job) = jobs.try_recv() {
                self.take(job);
            }
            if self.dirty && self.last.is_none_or(|last| last.elapsed() >= Video::FRAME) {
                match self.send() {
                    Ok(true) => {
                        self.dirty = false;
                        self.last = Some(Instant::now());
                    }
                    Ok(false) => {
                        if let Ok(job) = jobs.recv_timeout(Video::BLOCKED) {
                            self.take(job);
                        }
                    }
                    Err(e) => log::warn!("RDP 视频: {e}"),
                }
            }
        }
    }

    fn take(&mut self, job: Job) {
        match job {
            Job::Frame(bitmaps) => {
                bitmaps.iter().for_each(|b| self.paint(b));
                self.dirty = true;
            }
            Job::Wake => {}
            Job::Reset => {
                self.surface = None;
                self.dirty = true;
            }
            Job::Refresh => {
                self.encoder.force_intra_frame();
                self.dirty = true;
            }
        }
    }

    fn paint(&mut self, bitmap: &BitmapUpdate) {
        let width = usize::from(self.video.0.size.width);
        let row = usize::from(bitmap.width.get()) * Video::BYTES_PER_PIXEL;
        let (x, y) = (usize::from(bitmap.x), usize::from(bitmap.y));
        for line in 0..usize::from(bitmap.height.get()) {
            let src = line * bitmap.stride.get();
            let dst = ((y + line) * width + x) * Video::BYTES_PER_PIXEL;
            if let (Some(from), Some(to)) = (bitmap.data.get(src..src + row), self.framebuffer.get_mut(dst..dst + row)) {
                to.copy_from_slice(from);
            }
        }
    }

    fn send(&mut self) -> Result<bool, String> {
        let Some(handle) = self.video.handle() else { return Ok(false) };
        let size = self.video.0.size;
        let messages = {
            let mut gfx = handle.lock().expect("rdp 视频锁");
            if !gfx.is_ready() || !gfx.supports_avc420() || gfx.should_backpressure() {
                log::debug!(target: "perf::rdp", "h264 blocked ready={} in_flight={} queue={}", gfx.is_ready(), gfx.frames_in_flight(), gfx.client_queue_depth());
                return Ok(false);
            }
            let surface = match self.surface {
                Some(surface) => surface,
                None => {
                    let surface = gfx.create_surface(size.width, size.height).ok_or("建不了视频 surface")?;
                    gfx.map_surface_to_output(surface, 0, 0);
                    self.encoder.force_intra_frame();
                    self.surface = Some(surface);
                    surface
                }
            };
            let started = Instant::now();
            self.yuv.read_rgba8(RgbaSliceU8::new(&self.framebuffer, (usize::from(size.width), usize::from(size.height))));
            let converted = started.elapsed();
            let bits = self.encoder.encode(&self.yuv).map_err(|e| format!("H.264 编码: {e}"))?.to_vec();
            log::debug!(target: "perf::rdp", "h264 bytes={} ms={:.3} yuv={:.3}", bits.len(), started.elapsed().as_secs_f64() * 1000.0, converted.as_secs_f64() * 1000.0);
            if bits.is_empty() {
                return Ok(true);
            }
            let region = Avc420Region { left: 0, top: 0, right: size.width - 1, bottom: size.height - 1, quantization_parameter: Video::QP, quality: Video::QUALITY };
            let timestamp = u32::try_from(self.start.elapsed().as_millis()).unwrap_or(u32::MAX);
            if gfx.send_avc420_frame(surface, &bits, &[region], timestamp).is_none() {
                return Ok(false);
            }
            let channel = gfx.channel_id().ok_or("视频通道没有编号")?;
            encode_dvc_messages(channel, gfx.drain_output(), ChannelFlags::SHOW_PROTOCOL).map_err(|e| e.to_string())?
        };
        let sender = self.video.0.sender.lock().expect("rdp 视频锁").clone().ok_or("RDP 服务还没起")?;
        sender.try_send(ServerEvent::Egfx(EgfxServerMessage::SendMessages { messages })).map_err(|e| e.to_string())?;
        Ok(true)
    }
}
