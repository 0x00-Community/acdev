use std::collections::HashMap;

pub use acde_hostwin::{Event, Waker};

pub struct DragImage {
    pub width: u32,
    pub height: u32,
    pub scene: acde_gpu::Scene,
    pub hotspot: (i32, i32),
}

pub enum Surface {
    #[cfg(target_os = "linux")]
    Wayland(acde_window::Surface),
    Host(acde_hostwin::Surface),
}

macro_rules! each {
    ($self:ident, $s:ident => $body:expr) => {
        match $self {
            #[cfg(target_os = "linux")]
            Surface::Wayland($s) => $body,
            Surface::Host($s) => $body,
        }
    };
}

impl Surface {
    pub fn claim(token: u64, render: acde_render::RenderHandle, frame: u32) -> Result<Self, String> {
        if acde_hostwin::active() {
            return acde_hostwin::Surface::claim(token, render, frame).map(Surface::Host);
        }
        #[cfg(target_os = "linux")]
        return acde_window::Surface::claim(token, render, frame).map(Surface::Wayland);
        #[cfg(not(target_os = "linux"))]
        let _ = frame;
        #[cfg(not(target_os = "linux"))]
        Err("claimSurface: no windows here".into())
    }

    pub fn hosted(&self) -> bool {
        matches!(self, Surface::Host(_))
    }

    pub fn window(&self) -> u32 {
        each!(self, s => s.window())
    }

    pub fn content_offset(&self) -> (f64, f64) {
        match self {
            #[cfg(target_os = "linux")]
            Surface::Wayland(s) => s.content_offset(),
            Surface::Host(s) => s.content_offset(),
        }
    }

    pub fn pump(&self) -> Vec<Event> {
        each!(self, s => s.pump())
    }

    pub fn has_events(&self) -> bool {
        each!(self, s => s.has_events())
    }

    pub fn set_waker(&self, waker: Option<Waker>) {
        each!(self, s => s.set_waker(waker))
    }

    pub fn request_frame(&self) {
        each!(self, s => s.request_frame())
    }

    pub fn set_clipboard(&self, text: String) {
        each!(self, s => s.set_clipboard(text))
    }

    pub fn read_clipboard(&self, reply: Box<dyn FnOnce(String) + Send>) {
        each!(self, s => s.read_clipboard(reply))
    }

    pub fn start_drag(&self, data: HashMap<String, String>, icon: Option<DragImage>) {
        match self {
            #[cfg(target_os = "linux")]
            Surface::Wayland(s) => s.start_drag(
                data,
                icon.map(|i| acde_window::DragImage {
                    width: i.width,
                    height: i.height,
                    scene: i.scene,
                    hotspot: i.hotspot,
                }),
            ),
            Surface::Host(s) => s.start_drag(
                data,
                icon.map(|i| acde_hostwin::DragImage {
                    width: i.width,
                    height: i.height,
                    scene: i.scene,
                    hotspot: i.hotspot,
                }),
            ),
        }
    }

    pub fn request_mode(&self, mode: u32) {
        each!(self, s => s.request_mode(mode))
    }

    pub fn set_grab_hint(&self, rect: [i32; 4], edges: u32) {
        each!(self, s => s.set_grab_hint(rect, edges))
    }

    pub fn set_backdrop(&self, rect: [i32; 4], effect: [f64; 4]) {
        each!(self, s => s.set_backdrop(rect, effect))
    }

    pub fn request_activate(&self) {
        each!(self, s => s.request_activate())
    }

    pub fn request_grab(&self, kind: u32, on: bool) {
        each!(self, s => s.request_grab(kind, on))
    }

    pub fn open_panel(&self, id: u32, token: u64, rect: [i32; 4]) {
        each!(self, s => s.open_panel(id, token, rect))
    }

    pub fn place_panel(&self, id: u32, rect: [i32; 4], input: [i32; 4]) {
        each!(self, s => s.place_panel(id, rect, input))
    }

    pub fn close_panel(&self, id: u32) {
        each!(self, s => s.close_panel(id))
    }

    pub fn set_title(&self, title: &str) {
        match self {
            #[cfg(target_os = "linux")]
            Surface::Wayland(s) => s.set_title(title.to_owned()),
            Surface::Host(s) => s.set_title(title),
        }
    }

    pub fn set_ime_area(&self, rect: [f64; 4]) {
        match self {
            #[cfg(target_os = "linux")]
            Surface::Wayland(_) => {}
            Surface::Host(s) => s.set_ime_area(rect),
        }
    }
}
