use std::num::{NonZeroU16, NonZeroUsize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ironrdp_server::{
    BitmapUpdate, Credentials, DesktopSize, ExactMatchCredentialValidator, DisplayUpdate, KeyboardEvent, MouseEvent, PixelFormat, RdpServer, RdpServerDisplay, RdpServerDisplayUpdates,
    RdpServerInputHandler, TlsIdentityCtx,
};
use smithay::backend::allocator::Fourcc;
use smithay::backend::drm::DrmNode;
use smithay::backend::egl::{EGLContext, EGLDisplay};
use smithay::backend::input::AxisSource;
use smithay::backend::renderer::damage::OutputDamageTracker;
use smithay::backend::renderer::gles::{GlesRenderer, GlesTexture};
use smithay::backend::renderer::{Bind, ExportMem, Offscreen};
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::calloop::channel::{self, Channel, Sender};
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::calloop::LoopHandle;
use smithay::reexports::gbm;
use smithay::utils::{DeviceFd, Point, Rectangle};

use super::backend::{Backend, CLEAR, Target};
use super::input::{Injected, WHEEL_STEP};
use super::Compositor;

const REFRESH_MHZ: i32 = 60_000;

enum Request {
    Input(Injected),
    Full,
}

#[derive(Default)]
struct Shared {
    updates: Mutex<Option<async_channel::Sender<DisplayUpdate>>>,
}

pub struct RdpTarget {
    texture: GlesTexture,
    damage: OutputDamageTracker,
    shared: Arc<Shared>,
    rendered: bool,
    full: bool,
}

impl RdpTarget {
    pub fn start(lh: &LoopHandle<'static, Compositor>) -> Result<(Backend, DrmNode), String> {
        let path = std::env::var_os("ACDE_RENDER_NODE").map_or_else(|| PathBuf::from("/dev/dri/renderD128"), PathBuf::from);
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let node = DrmNode::from_path(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let gbm = gbm::Device::new(DeviceFd::from(std::os::fd::OwnedFd::from(file))).map_err(|e| format!("GBM: {e}"))?;
        let egl = unsafe { EGLDisplay::new(gbm.clone()) }.map_err(|e| format!("EGL: {e}"))?;
        let context = EGLContext::new(&egl).map_err(|e| format!("EGL context: {e}"))?;
        let mut renderer = unsafe { GlesRenderer::new(context) }.map_err(|e| format!("GLES: {e}"))?;

        let (w, h) = std::env::var("ACDE_SIZE")
            .ok()
            .and_then(|s| {
                let (w, h) = s.split_once('x')?;
                Some((w.trim().parse::<u16>().ok()?, h.trim().parse::<u16>().ok()?))
            })
            .unwrap_or((1440, 900));
        let texture: GlesTexture = renderer.create_buffer(Fourcc::Abgr8888, (i32::from(w), i32::from(h)).into()).map_err(|e| format!("离屏纹理: {e}"))?;
        let mode = Mode { size: (i32::from(w), i32::from(h)).into(), refresh: REFRESH_MHZ };
        let output = Output::new("acde".into(), PhysicalProperties { size: (0, 0).into(), subpixel: Subpixel::Unknown, make: "acde".into(), model: "RDP".into() });
        output.change_current_state(Some(mode), None, None, Some((0, 0).into()));
        output.set_preferred(mode);
        let damage = OutputDamageTracker::from_output(&output);

        let shared = Arc::new(Shared::default());
        let (tx, rx): (Sender<Request>, Channel<Request>) = channel::channel();
        lh.insert_source(rx, |event, _, state| {
            if let channel::Event::Msg(request) = event {
                state.on_rdp(request);
            }
        })
        .map_err(|e| e.to_string())?;
        Server::spawn(w, h, shared.clone(), tx)?;

        let target = Target::Rdp(Box::new(Self { texture, damage, shared, rendered: false, full: true }));
        Ok((Backend::new(renderer, output, target), node))
    }
}

impl Compositor {
    fn on_rdp(&mut self, request: Request) {
        match request {
            Request::Input(event) => self.inject(event),
            Request::Full => {
                if let Target::Rdp(rdp) = &mut self.backend.target {
                    rdp.full = true;
                }
                self.backend.damaged();
            }
        }
    }

    pub fn render_rdp(&mut self) {
        let output = self.backend.output.clone();
        let elements = self.screen_elements(&output, false);
        let Backend { renderer, target, .. } = &mut self.backend;
        let Target::Rdp(rdp) = target else { return };
        let sender = rdp.shared.updates.lock().expect("rdp 锁").clone();
        let age = usize::from(rdp.rendered);
        let started = std::time::Instant::now();
        let (states, updates) = {
            let Ok(mut fb) = renderer.bind(&mut rdp.texture) else { return };
            let result = match rdp.damage.render_output(renderer, &mut fb, age, &elements, CLEAR) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("RDP 渲染失败: {e}");
                    return;
                }
            };
            let size = output.current_mode().map_or((0, 0).into(), |m| m.size);
            let rects: Vec<Rectangle<i32, smithay::utils::Physical>> = match (sender.is_some(), rdp.full) {
                (false, _) => Vec::new(),
                (true, true) => vec![Rectangle::from_size(size)],
                (true, false) => result.damage.cloned().unwrap_or_default(),
            };
            let copies: Vec<_> = rects
                .iter()
                .filter_map(|r| r.intersection(Rectangle::from_size(size)))
                .filter_map(|rect| {
                    let region = Rectangle::new((rect.loc.x, rect.loc.y).into(), (rect.size.w, rect.size.h).into());
                    renderer.copy_framebuffer(&fb, region, Fourcc::Abgr8888).inspect_err(|e| log::warn!("RDP 读回失败: {e}")).ok().map(|m| (rect, m))
                })
                .collect();
            let mut updates = Vec::new();
            for (rect, mapping) in copies {
                match renderer.map_texture(&mapping) {
                    Ok(data) => updates.extend(Self::bitmap(rect.loc.x, rect.loc.y, rect.size.w, rect.size.h, data.to_vec())),
                    Err(e) => log::warn!("RDP 读回失败: {e}"),
                }
            }
            log::debug!(target: "perf::compose", "rdp elements={} rects={} ms={:.3}", elements.len(), rects.len(), acde_log::since_ms(started));
            (result.states, updates)
        };
        rdp.rendered = true;
        if let Some(sender) = sender {
            rdp.full = false;
            for update in updates {
                if sender.try_send(update).is_err() {
                    break;
                }
            }
        }
        self.backend.dirty = false;
        self.backend.presenting = true;
        self.timing.pending = Some(self.post_repaint(&states, &output));
        let _ = self.loop_handle.insert_source(Timer::from_duration(self.frame_duration()), |_, _, state| {
            let feedback = state.timing.pending.take();
            state.on_vblank(feedback);
            TimeoutAction::Drop
        });
    }

    fn bitmap(x: i32, y: i32, w: i32, h: i32, data: Vec<u8>) -> Option<DisplayUpdate> {
        let width = NonZeroU16::new(u16::try_from(w).ok()?)?;
        let height = NonZeroU16::new(u16::try_from(h).ok()?)?;
        let stride = NonZeroUsize::new(usize::from(width.get()) * 4)?;
        (data.len() >= stride.get() * usize::from(height.get())).then(|| {
            DisplayUpdate::Bitmap(BitmapUpdate { x: u16::try_from(x).unwrap_or(0), y: u16::try_from(y).unwrap_or(0), width, height, format: PixelFormat::RgbX32, data: data.into(), stride })
        })
    }
}

struct Server;

impl Server {
    fn spawn(w: u16, h: u16, shared: Arc<Shared>, tx: Sender<Request>) -> Result<(), String> {
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let (Some(username), Some(password)) = (env("ACDE_RDP_USER"), env("ACDE_RDP_PASSWORD")) else {
            return Err("RDP 后端要 ACDE_RDP_USER 和 ACDE_RDP_PASSWORD".into());
        };
        let dir = env("XDG_CONFIG_HOME").map_or_else(|| PathBuf::from(env("HOME").unwrap_or_default()).join(".config"), PathBuf::from).join("agentos/rdp");
        let cert = env("ACDE_RDP_CERT").map_or_else(|| dir.join("cert.pem"), PathBuf::from);
        let key = env("ACDE_RDP_KEY").map_or_else(|| dir.join("key.pem"), PathBuf::from);
        let identity = TlsIdentityCtx::init_from_paths(&cert, &key).map_err(|e| format!("RDP 证书 ({}): {e:#}", cert.display()))?;
        let acceptor = identity.make_acceptor().map_err(|e| format!("RDP TLS: {e:#}"))?;
        let addr: std::net::SocketAddr = env("ACDE_RDP_ADDR").unwrap_or_else(|| "0.0.0.0:3390".into()).parse().map_err(|e| format!("ACDE_RDP_ADDR: {e}"))?;
        let size = DesktopSize { width: w, height: h };
        let pub_key = identity.pub_key;
        let nla = env("ACDE_RDP_SECURITY").as_deref() == Some("nla");
        std::thread::Builder::new()
            .name("acde-rdp".into())
            .spawn(move || {
                let credentials = Credentials { username, password, domain: None };
                let builder = RdpServer::builder().with_addr(addr);
                let builder = if nla { builder.with_hybrid(acceptor, pub_key) } else { builder.with_tls(acceptor) };
                let mut server = builder
                    .with_input_handler(Input { tx: tx.clone(), size })
                    .with_display_handler(Display { size, shared, tx })
                    .with_credential_validator(Some(Arc::new(ExactMatchCredentialValidator::new(credentials.clone()))))
                    .build();
                server.set_credentials(Some(credentials));
                log::info!("RDP 服务在 {addr}");
                let system = ntex::rt::System::build().name("acde-rdp").build(ntex::rt::DefaultRuntime);
                if let Err(e) = system.block_on(async move { server.run().await }) {
                    log::warn!("RDP 服务停了: {e:#}");
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

struct Display {
    size: DesktopSize,
    shared: Arc<Shared>,
    tx: Sender<Request>,
}

#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        let (sender, receiver) = async_channel::unbounded();
        let _ = sender.try_send(DisplayUpdate::DefaultPointer);
        *self.shared.updates.lock().expect("rdp 锁") = Some(sender);
        let _ = self.tx.send(Request::Full);
        log::info!("RDP 客户端连上了");
        Ok(Box::new(Updates { receiver }))
    }
}

struct Updates {
    receiver: async_channel::Receiver<DisplayUpdate>,
}

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for Updates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        Ok(self.receiver.recv().await.ok())
    }
}

struct Input {
    tx: Sender<Request>,
    size: DesktopSize,
}

impl Input {
    const BTN_RIGHT: u32 = 0x111;
    const BTN_MIDDLE: u32 = 0x112;
    const BTN_SIDE: u32 = 0x113;
    const BTN_EXTRA: u32 = 0x114;

    fn send(&self, event: Injected) {
        let _ = self.tx.send(Request::Input(event));
    }

    fn evdev(code: u8, extended: bool) -> Option<u32> {
        if !extended {
            return Some(u32::from(code));
        }
        Some(match code {
            0x1c => 96,
            0x1d => 97,
            0x35 => 98,
            0x37 => 99,
            0x38 => 100,
            0x47 => 102,
            0x48 => 103,
            0x49 => 104,
            0x4b => 105,
            0x4d => 106,
            0x4f => 107,
            0x50 => 108,
            0x51 => 109,
            0x52 => 110,
            0x53 => 111,
            0x5b => 125,
            0x5c => 126,
            0x5d => 127,
            _ => return None,
        })
    }
}

impl RdpServerInputHandler for Input {
    fn keyboard(&mut self, event: KeyboardEvent) {
        match event {
            KeyboardEvent::Pressed { code, extended } | KeyboardEvent::Released { code, extended } => {
                let pressed = matches!(event, KeyboardEvent::Pressed { .. });
                if let Some(code) = Self::evdev(code, extended) {
                    self.send(Injected::Key { code, pressed });
                }
            }
            _ => {}
        }
    }

    fn mouse(&mut self, event: MouseEvent) {
        let button = |button, pressed| Injected::Button { button, pressed };
        let wheel = |dx: f64, dy: f64| Injected::Wheel { delta: Point::from((dx, dy)), source: AxisSource::Wheel };
        let event = match event {
            MouseEvent::Move { x, y } => Injected::Move(Point::from((f64::from(x.min(self.size.width.saturating_sub(1))), f64::from(y.min(self.size.height.saturating_sub(1)))))),
            MouseEvent::RelMove { x, y } => Injected::Motion(Point::from((f64::from(x), f64::from(y)))),
            MouseEvent::LeftPressed => button(super::BTN_LEFT, true),
            MouseEvent::LeftReleased => button(super::BTN_LEFT, false),
            MouseEvent::RightPressed => button(Self::BTN_RIGHT, true),
            MouseEvent::RightReleased => button(Self::BTN_RIGHT, false),
            MouseEvent::MiddlePressed => button(Self::BTN_MIDDLE, true),
            MouseEvent::MiddleReleased => button(Self::BTN_MIDDLE, false),
            MouseEvent::Button4Pressed => button(Self::BTN_SIDE, true),
            MouseEvent::Button4Released => button(Self::BTN_SIDE, false),
            MouseEvent::Button5Pressed => button(Self::BTN_EXTRA, true),
            MouseEvent::Button5Released => button(Self::BTN_EXTRA, false),
            MouseEvent::VerticalScroll { value } => wheel(0.0, -f64::from(value) / 120.0 * WHEEL_STEP),
            MouseEvent::Scroll { x, y } => wheel(f64::from(x) / 120.0 * WHEEL_STEP, -f64::from(y) / 120.0 * WHEEL_STEP),
        };
        self.send(event);
    }
}
