use std::path::PathBuf;

use crate::{OpenRequest, SaveRequest};

pub(crate) type FolderReply = std::sync::mpsc::SyncSender<Result<Option<PathBuf>, String>>;
pub(crate) type FilesReply = std::sync::mpsc::SyncSender<Result<Option<Vec<PathBuf>>, String>>;

pub(crate) enum Cmd {
    Title(String),
    ImeArea([f64; 4]),
    Inject(acde_model::Injected),
    ChooseFolder { title: String, reply: FolderReply },
    OpenFiles { request: OpenRequest, reply: FilesReply },
    SaveFile { request: SaveRequest, reply: FolderReply },
    Exit(i32),
}

pub(crate) struct Monitor {
    pub size: [f64; 2],
    pub refresh: Option<f64>,
}

pub(crate) enum HostEvent {
    Resized { size: (u32, u32), scale: f64 },
    CloseRequested,
    Focused(bool),
    PointerMove(f64, f64),
    PointerLeave,
    Button(u32, bool),
    Wheel(f64, f64),
    Key { evdev: u32, pressed: bool, text: Option<String> },
    Modifiers(u8),
    ImePreedit(String),
    ImeCommit(String),
    Dropped(Vec<PathBuf>),
    Redraw,
    Cmd(Cmd),
}

pub(crate) trait Handler {
    fn size(&mut self, monitor: Option<&Monitor>) -> [f64; 2];
    fn started(&mut self, host: &dyn Host, proxy: Proxy, monitor: Option<Monitor>, size: (u32, u32), scale: f64);
    fn event(&mut self, host: &dyn Host, event: HostEvent);
}

pub(crate) const LINE: f64 = 40.0;

mod headless;

cfg_select! {
    windows => {
        mod win32;
        use win32 as native;
    }
    _ => {
        mod host_winit;
        use host_winit as native;
    }
}

pub fn headless() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("ACDE_HEADLESS").is_ok_and(|v| !v.is_empty() && v != "0"))
}

pub(crate) trait Host {
    fn set_title(&self, title: &str);
    fn set_ime_area(&self, area: [f64; 4]);
    fn surface(&self, instance: &acde_gpu::wgpu::Instance) -> Result<Option<acde_gpu::wgpu::Surface<'static>>, String>;
    fn choose_folder(&self, title: &str, reply: FolderReply);
    fn open_files(&self, request: OpenRequest, reply: FilesReply);
    fn save_file(&self, request: SaveRequest, reply: FolderReply);
    fn exit(&self, code: i32);
}

#[derive(Clone)]
pub(crate) enum Proxy {
    Native(native::Proxy),
    Headless(headless::Proxy),
}

impl Proxy {
    pub fn send(&self, cmd: Cmd) {
        match self {
            Proxy::Native(proxy) => proxy.send(cmd),
            Proxy::Headless(proxy) => proxy.send(cmd),
        }
    }
}

pub(crate) fn run(handler: Box<dyn Handler>) -> Result<i32, String> {
    if headless() { headless::run(handler) } else { native::run(handler) }
}

pub(crate) fn clipboard_set(text: String) {
    if headless() { headless::clipboard_set(text) } else { native::clipboard_set(text) }
}

pub(crate) fn clipboard_get() -> String {
    if headless() { headless::clipboard_get() } else { native::clipboard_get() }
}
