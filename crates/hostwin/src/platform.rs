use std::path::PathBuf;

pub(crate) type FolderReply = std::sync::mpsc::SyncSender<Result<Option<PathBuf>, String>>;

pub(crate) enum Cmd {
    Title(String),
    ImeArea([f64; 4]),
    Inject(crate::shell::Injected),
    ChooseFolder { title: String, reply: FolderReply },
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
    fn started(&mut self, host: &Host, proxy: Proxy, monitor: Option<Monitor>, size: (u32, u32), scale: f64);
    fn event(&mut self, host: &Host, event: HostEvent);
}

pub(crate) const LINE: f64 = 40.0;

cfg_select! {
    windows => {
        mod win32;
        pub(crate) use win32::{Host, Proxy, clipboard_get, clipboard_set, run};
    }
    _ => {
        mod host_winit;
        pub(crate) use host_winit::{Host, Proxy, clipboard_get, clipboard_set, run};
    }
}
