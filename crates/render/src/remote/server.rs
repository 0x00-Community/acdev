use std::collections::VecDeque;
use std::num::{NonZeroU16, NonZeroUsize};
use std::sync::{Arc, Mutex};

use ironrdp_server::{
    BitmapUpdate, Credentials, DesktopSize, DisplayUpdate, ExactMatchCredentialValidator, PixelFormat, RdpServer, RdpServerDisplay, RdpServerDisplayUpdates, TlsIdentityCtx,
};

use super::input::{Handler, RdpInput};
use super::settings::{RdpSecurity, RdpSettings};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RdpEvent {
    Input(RdpInput),
    Full,
    Drained,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RdpSlot {
    Closed,
    Busy,
    Free,
}

pub type RdpNotify = Arc<dyn Fn(RdpEvent) + Send + Sync>;

pub struct RdpBitmap {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub data: Vec<u8>,
}

impl TryFrom<RdpBitmap> for BitmapUpdate {
    type Error = ();

    fn try_from(bitmap: RdpBitmap) -> Result<Self, Self::Error> {
        let width = u16::try_from(bitmap.width).ok().and_then(NonZeroU16::new).ok_or(())?;
        let height = u16::try_from(bitmap.height).ok().and_then(NonZeroU16::new).ok_or(())?;
        let stride = NonZeroUsize::new(usize::from(width.get()) * usize::from(PixelFormat::RgbX32.bytes_per_pixel())).ok_or(())?;
        if bitmap.data.len() < stride.get() * usize::from(height.get()) {
            return Err(());
        }
        let x = u16::try_from(bitmap.x).unwrap_or(0);
        let y = u16::try_from(bitmap.y).unwrap_or(0);
        Ok(Self { x, y, width, height, format: PixelFormat::RgbX32, data: bitmap.data.into(), stride })
    }
}

type Frame = Vec<BitmapUpdate>;

#[derive(Clone, Default)]
pub struct RdpUpdates(Arc<Mutex<Option<async_channel::Sender<Frame>>>>);

impl RdpUpdates {
    fn sender(&self) -> Option<async_channel::Sender<Frame>> {
        self.0.lock().expect("rdp 锁").clone()
    }

    pub fn slot(&self) -> RdpSlot {
        match self.sender() {
            None => RdpSlot::Closed,
            Some(sender) if sender.is_full() => RdpSlot::Busy,
            Some(_) => RdpSlot::Free,
        }
    }

    pub fn send(&self, bitmaps: impl IntoIterator<Item = RdpBitmap>) {
        let Some(sender) = self.sender() else { return };
        let frame: Frame = bitmaps.into_iter().filter_map(|b| BitmapUpdate::try_from(b).ok()).collect();
        if !frame.is_empty() {
            let _ = sender.try_send(frame);
        }
    }

    fn open(&self) -> async_channel::Receiver<Frame> {
        let (sender, receiver) = async_channel::bounded(1);
        *self.0.lock().expect("rdp 锁") = Some(sender);
        receiver
    }
}

struct Display {
    size: DesktopSize,
    updates: RdpUpdates,
    notify: RdpNotify,
}

#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        let receiver = self.updates.open();
        (self.notify)(RdpEvent::Full);
        log::info!("RDP 客户端连上了");
        Ok(Box::new(UpdateStream { receiver, frame: VecDeque::from([DisplayUpdate::DefaultPointer]), notify: self.notify.clone() }))
    }
}

struct UpdateStream {
    receiver: async_channel::Receiver<Frame>,
    frame: VecDeque<DisplayUpdate>,
    notify: RdpNotify,
}

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for UpdateStream {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        loop {
            if let Some(update) = self.frame.pop_front() {
                return Ok(Some(update));
            }
            let Ok(frame) = self.receiver.recv().await else { return Ok(None) };
            (self.notify)(RdpEvent::Drained);
            return Ok(Some(DisplayUpdate::Frame(frame)));
        }
    }
}

impl RdpSettings {
    pub fn serve(self, updates: RdpUpdates, notify: RdpNotify) -> Result<(), String> {
        let identity = TlsIdentityCtx::init_from_paths(&self.cert, &self.key).map_err(|e| format!("RDP 证书 ({}): {e:#}", self.cert.display()))?;
        let acceptor = identity.make_acceptor().map_err(|e| format!("RDP TLS: {e:#}"))?;
        let size = DesktopSize { width: self.size.width, height: self.size.height };
        let pub_key = identity.pub_key;
        let Self { user, password, addr, security, .. } = self;
        std::thread::Builder::new()
            .name("acde-rdp".into())
            .spawn(move || {
                let credentials = Credentials { username: user, password, domain: None };
                let builder = RdpServer::builder().with_addr(addr);
                let builder = match security {
                    RdpSecurity::Nla => builder.with_hybrid(acceptor, pub_key),
                    RdpSecurity::Tls => builder.with_tls(acceptor),
                };
                let mut server = builder
                    .with_input_handler(Handler { notify: notify.clone(), size })
                    .with_display_handler(Display { size, updates, notify })
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
