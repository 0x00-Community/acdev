use std::path::PathBuf;

use crate::{OpenRequest, SaveRequest};

pub(crate) type FolderReply = std::sync::mpsc::SyncSender<Result<Option<PathBuf>, String>>;
pub(crate) type FilesReply = std::sync::mpsc::SyncSender<Result<Option<Vec<PathBuf>>, String>>;
pub(crate) type ApproveReply = std::sync::mpsc::SyncSender<Result<Option<bool>, String>>;
pub(crate) type ResizeReply = std::sync::mpsc::SyncSender<Result<(), String>>;

pub(crate) enum Cmd {
    Title(String),
    ImeArea([f64; 4]),
    Inject(acde::model::Injected),
    StartDrag { window: u32, data: std::collections::HashMap<String, String> },
    Drop { window: u32, at: Option<[f64; 2]>, paths: Vec<PathBuf> },
    ChooseFolder { title: String, reply: FolderReply },
    OpenFiles { request: OpenRequest, reply: FilesReply },
    SaveFile { request: SaveRequest, reply: FolderReply },
    Approve { title: String, message: String, reply: ApproveReply },
    HostState(Option<acde::model::WindowState>),
    HostSize([f64; 2]),
    Resize { size: [f64; 2], reply: ResizeReply },
    Device,
    PointerLock { window: u32, on: bool },
    Cursor { window: u32, cursor: &'static str },
    FocusMoved,
    Exit(i32),
}

pub(crate) struct Monitor {
    pub size: [f64; 2],
    pub refresh: Option<f64>,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum HostEvent {
    Resized {
        size: (u32, u32),
        scale: f64,
    },
    CloseRequested,
    Focused(bool),
    PointerMove(f64, f64),
    #[cfg_attr(windows, allow(dead_code))]
    Motion(f64, f64),
    PointerLeave,
    Button(u32, bool),
    Wheel(f64, f64),
    Key {
        evdev: u32,
        pressed: bool,
        text: Option<String>,
    },
    Modifiers(u8),
    ImePreedit(String),
    ImeCommit(String),
    Dropped(Vec<PathBuf>),
    State(acde::model::WindowState),
    Output {
        size: (u32, u32),
        scale: f64,
        work: [f64; 4],
    },
    Refresh(Option<f64>),
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
    fn surface(&self, instance: &acde::gpu::wgpu::Instance) -> Result<Option<acde::gpu::wgpu::Surface<'static>>, String>;
    fn choose_folder(&self, title: &str, reply: FolderReply);
    fn open_files(&self, request: OpenRequest, reply: FilesReply);
    fn save_file(&self, request: SaveRequest, reply: FolderReply);
    fn resize(&self, size: [f64; 2], scale: f64) -> Result<Option<(u32, u32)>, String>;
    fn exit(&self, code: i32);

    fn controls(&self) -> bool {
        false
    }

    fn set_state(&self, _: Option<acde::model::WindowState>) {}

    fn set_size(&self, _: [f64; 2]) -> Option<(u32, u32)> {
        None
    }

    fn approve(&self, _: &str, _: &str, reply: ApproveReply) {
        let _ = reply.send(Ok(None));
    }

    fn lock_pointer(&self, _: bool) -> bool {
        false
    }

    fn set_cursor(&self, _: &'static str) {}

    fn drag(&self, _: u32) -> bool {
        false
    }
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

pub(crate) fn clipboard_set(entries: Vec<acde::render::ClipboardEntry>) {
    if headless() { headless::clipboard_set(entries) } else { native::clipboard_set(entries) }
}

pub(crate) fn clipboard_types() -> Vec<String> {
    if headless() { headless::clipboard_types() } else { native::clipboard_types() }
}

pub(crate) fn clipboard_read(mime: &str) -> Option<Vec<u8>> {
    if headless() { headless::clipboard_read(mime) } else { native::clipboard_read(mime) }
}

pub(crate) fn dismiss_approval() {
    if headless() {
        return;
    }
    #[cfg(windows)]
    native::dismiss_approval();
    #[cfg(not(windows))]
    crate::system::approve::dismiss();
}

pub(crate) fn pointer_lock() -> bool {
    headless() || cfg!(not(windows))
}

pub(crate) fn click_settings() -> acde::model::ClickSettings {
    if headless() { acde::model::ClickSettings::default() } else { native::click_settings() }
}
