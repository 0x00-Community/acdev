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
}

pub type RdpNotify = Arc<dyn Fn(RdpEvent) + Send + Sync>;

pub struct RdpBitmap {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub data: Vec<u8>,
}

impl TryFrom<RdpBitmap> for DisplayUpdate {
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
        Ok(Self::Bitmap(BitmapUpdate { x, y, width, height, format: PixelFormat::RgbX32, data: bitmap.data.into(), stride }))
    }
}

#[derive(Clone, Default)]
pub struct RdpUpdates(Arc<Mutex<Option<async_channel::Sender<DisplayUpdate>>>>);

impl RdpUpdates {
    fn sender(&self) -> Option<async_channel::Sender<DisplayUpdate>> {
        self.0.lock().expect("rdp 锁").clone()
    }

    pub fn connected(&self) -> bool {
        self.sender().is_some()
    }

    pub fn send(&self, bitmaps: impl IntoIterator<Item = RdpBitmap>) {
        let Some(sender) = self.sender() else { return };
        let _ = bitmaps.into_iter().filter_map(|b| DisplayUpdate::try_from(b).ok()).try_for_each(|update| sender.try_send(update));
    }

    fn open(&self) -> async_channel::Receiver<DisplayUpdate> {
        let (sender, receiver) = async_channel::unbounded();
        let _ = sender.try_send(DisplayUpdate::DefaultPointer);
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
        Ok(Box::new(UpdateStream { receiver }))
    }
}

struct UpdateStream {
    receiver: async_channel::Receiver<DisplayUpdate>,
}

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for UpdateStream {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        Ok(self.receiver.recv().await.ok())
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
