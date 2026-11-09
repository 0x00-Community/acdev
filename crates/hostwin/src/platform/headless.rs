use std::cell::Cell;
use std::sync::{Mutex, mpsc};

use acde_gpu::wgpu;

use super::{Cmd, FilesReply, FolderReply, Handler, HostEvent};
use crate::{OpenRequest, SaveRequest};

#[derive(Clone)]
pub(crate) struct Proxy(mpsc::Sender<Cmd>);

impl Proxy {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.0.send(cmd);
    }
}

#[derive(Default)]
pub(crate) struct Host {
    exit: Cell<Option<i32>>,
}

impl super::Host for Host {
    fn set_title(&self, _: &str) {}

    fn set_ime_area(&self, _: [f64; 4]) {}

    fn surface(&self, _: &wgpu::Instance) -> Result<Option<wgpu::Surface<'static>>, String> {
        Ok(None)
    }

    fn choose_folder(&self, _: &str, reply: FolderReply) {
        let _ = reply.send(Err("no folder chooser without a host window (ACDE_HEADLESS): answer it beforehand (acde dev op choose)".to_owned()));
    }

    fn open_files(&self, _: OpenRequest, reply: FilesReply) {
        let _ = reply.send(Err("no file chooser without a host window (ACDE_HEADLESS): answer it beforehand (acde dev op choose)".to_owned()));
    }

    fn save_file(&self, _: SaveRequest, reply: FolderReply) {
        let _ = reply.send(Err("no save chooser without a host window (ACDE_HEADLESS): answer it beforehand (acde dev op choose)".to_owned()));
    }

    fn exit(&self, code: i32) {
        self.exit.set(Some(code));
    }
}

static CLIPBOARD: Mutex<String> = Mutex::new(String::new());

pub(crate) fn clipboard_set(text: String) {
    *CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner()) = text;
}

pub(crate) fn clipboard_get() -> String {
    CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub(crate) fn scale() -> f64 {
    std::env::var("ACDE_SCALE").ok().and_then(|s| s.trim().parse::<f64>().ok()).filter(|s| s.is_finite() && (0.5..=4.0).contains(s)).unwrap_or(1.0)
}

pub(crate) fn run(mut handler: Box<dyn Handler>) -> Result<i32, String> {
    let (tx, rx) = mpsc::channel();
    let host = Host::default();
    let scale = scale();
    let [w, h] = handler.size(None);
    let size = (((w * scale).round() as u32).max(1), ((h * scale).round() as u32).max(1));
    log::info!("host window: hidden (ACDE_HEADLESS), screen {w}x{h}, scale {scale}");
    handler.started(&host, super::Proxy::Headless(Proxy(tx)), None, size, scale);
    if let Some(code) = host.exit.take() {
        return Ok(code);
    }
    handler.event(&host, HostEvent::Focused(true));
    while let Ok(cmd) = rx.recv() {
        handler.event(&host, HostEvent::Cmd(cmd));
        if let Some(code) = host.exit.take() {
            return Ok(code);
        }
    }
    Ok(0)
}
