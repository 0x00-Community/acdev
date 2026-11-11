use std::collections::HashMap;

pub use acde_hostwin::{Event, Waker};
pub use acde_render::DragImage;
use acde_render::{RenderHandle, SurfaceCommand as C};

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

macro_rules! commands {
    ($($name:ident($($arg:ident: $t:ty),*) => $command:expr;)*) => {$(
        pub fn $name(&self, $($arg: $t),*) {
            each!(self, s => s.send($command))
        }
    )*};
}

impl Surface {
    pub fn claim(token: u64, render: RenderHandle, frame: u32, app: Option<String>) -> Result<Self, String> {
        if acde_hostwin::active() {
            return acde_hostwin::Surface::claim(token, render, frame, app).map(Surface::Host);
        }
        #[cfg(target_os = "linux")]
        return acde_window::Surface::claim(token, render, frame).map(Surface::Wayland);
        #[cfg(not(target_os = "linux"))]
        let _ = frame;
        #[cfg(not(target_os = "linux"))]
        Err("claimSurface: no windows here".into())
    }

    pub fn minimizable(&self) -> bool {
        match self {
            Surface::Host(s) => s.minimizable(),
            #[cfg(target_os = "linux")]
            Surface::Wayland(_) => true,
        }
    }

    pub fn host_controls(&self) -> bool {
        match self {
            Surface::Host(s) => s.host_controls(),
            #[cfg(target_os = "linux")]
            Surface::Wayland(_) => false,
        }
    }

    pub fn size(&self) -> Option<(u32, u32, f64)> {
        match self {
            Surface::Host(s) => s.size(),
            #[cfg(target_os = "linux")]
            Surface::Wayland(_) => None,
        }
    }

    pub fn hosted(&self) -> bool {
        matches!(self, Surface::Host(_))
    }

    pub fn window(&self) -> u32 {
        each!(self, s => s.window())
    }

    pub fn content_offset(&self) -> (f64, f64) {
        each!(self, s => s.content_offset())
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

    commands! {
        request_frame() => C::RequestFrame;
        set_clipboard(text: String) => C::SetClipboard(text);
        read_clipboard(reply: Box<dyn FnOnce(String) + Send>) => C::ReadClipboard(reply);
        start_drag(data: HashMap<String, String>, icon: Option<DragImage>) => C::StartDrag(data, icon);
        request_mode(mode: u32) => C::Mode(mode);
        request_state(state: u32) => C::State(state);
        set_grab_hint(rect: [i32; 4], edges: u32) => C::GrabHint(rect, edges);
        set_backdrop(rect: [i32; 4], effect: [f64; 4]) => C::Backdrop(rect, effect);
        request_activate() => C::Activate;
        request_grab(kind: u32, on: bool) => C::Grab(kind, on);
        open_panel(id: u32, token: u64, rect: [i32; 4]) => C::OpenPanel { id, token, rect };
        place_panel(id: u32, rect: [i32; 4], input: [i32; 4]) => C::PlacePanel { id, rect, input };
        close_panel(id: u32) => C::ClosePanel(id);
        reserve_panel(id: u32, edge: u32, thickness: f64) => C::ReservePanel { id, edge, thickness };
        set_double_click(action: u32) => C::DoubleClick(action);
        set_frame_theme(theme: acde_render::FrameTheme) => C::FrameTheme(theme);
        set_page_dark(dark: bool) => C::PageDark(dark);
        set_title(title: &str) => C::Title(title.to_owned());
        set_ime_area(rect: [f64; 4]) => C::ImeArea(rect);
    }
}
