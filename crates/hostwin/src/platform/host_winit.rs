use std::cell::Cell;
use std::sync::Arc;

use acde_gpu::wgpu;
use acde_model::Combo;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{ElementState, Ime, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowId};

use super::{Cmd, Handler, HostEvent, LINE, Monitor};
use crate::keys;

#[derive(Clone)]
pub(crate) struct Proxy(EventLoopProxy<Cmd>);

impl Proxy {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.0.send_event(cmd);
    }
}

pub(crate) struct Host {
    window: Arc<Window>,
    exit: Cell<Option<i32>>,
}

impl super::Host for Host {
    fn set_title(&self, title: &str) {
        self.window.set_title(title);
    }

    fn set_ime_area(&self, [x, y, w, h]: [f64; 4]) {
        self.window.set_ime_cursor_area(LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)));
    }

    fn surface(&self, instance: &wgpu::Instance) -> Result<Option<wgpu::Surface<'static>>, String> {
        instance.create_surface(self.window.clone()).map(Some).map_err(|e| e.to_string())
    }

    fn choose_folder(&self, title: &str, reply: super::FolderReply) {
        crate::chooser::folder(Some(&self.window), title, reply);
    }

    fn exit(&self, code: i32) {
        self.exit.set(Some(code));
    }
}

pub(crate) fn clipboard_set(text: String) {
    if let Err(e) = arboard::Clipboard::new().and_then(|mut c| c.set_text(text)) {
        log::warn!("clipboard: {e}");
    }
}

pub(crate) fn clipboard_get() -> String {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default()
}

struct Loop {
    handler: Box<dyn Handler>,
    proxy: EventLoopProxy<Cmd>,
    host: Option<Host>,
    code: i32,
    error: Option<String>,
}

pub(crate) fn run(handler: Box<dyn Handler>) -> Result<i32, String> {
    let event_loop = EventLoop::<Cmd>::with_user_event().build().map_err(|e| e.to_string())?;
    let proxy = event_loop.create_proxy();
    let mut state = Loop { handler, proxy, host: None, code: 0, error: None };
    event_loop.run_app(&mut state).map_err(|e| e.to_string())?;
    match state.error {
        Some(error) => Err(error),
        None => Ok(state.code),
    }
}

impl Loop {
    fn emit(&mut self, el: &ActiveEventLoop, event: HostEvent) {
        let Some(host) = &self.host else { return };
        self.handler.event(host, event);
        if let Some(code) = host.exit.take() {
            self.code = code;
            el.exit();
        }
    }
}

impl ApplicationHandler<Cmd> for Loop {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.host.is_some() {
            return;
        }
        let monitor = el.primary_monitor().or_else(|| el.available_monitors().next()).map(|m| {
            let scale = m.scale_factor();
            let size = m.size().to_logical::<f64>(scale);
            Monitor { size: [size.width, size.height], refresh: m.refresh_rate_millihertz().map(|mhz| f64::from(mhz) / 1000.0) }
        });
        let [w, h] = self.handler.size(monitor.as_ref());
        let attrs = Window::default_attributes().with_title("acde").with_inner_size(LogicalSize::new(w, h));
        let window = match el.create_window(attrs) {
            Ok(window) => Arc::new(window),
            Err(e) => {
                self.error = Some(format!("open window: {e}"));
                el.exit();
                return;
            }
        };
        window.set_ime_allowed(true);
        let size = window.inner_size();
        let scale = window.scale_factor();
        let host = Host { window, exit: Cell::new(None) };
        self.handler.started(&host, super::Proxy::Native(Proxy(self.proxy.clone())), monitor, (size.width.max(1), size.height.max(1)), scale);
        if let Some(code) = host.exit.take() {
            self.code = code;
            el.exit();
        }
        self.host = Some(host);
    }

    fn user_event(&mut self, el: &ActiveEventLoop, cmd: Cmd) {
        self.emit(el, HostEvent::Cmd(cmd));
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(host) = &self.host else { return };
        let scale = host.window.scale_factor();
        let event = match event {
            WindowEvent::Resized(size) => HostEvent::Resized { size: (size.width.max(1), size.height.max(1)), scale },
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                let size = host.window.inner_size();
                HostEvent::Resized { size: (size.width.max(1), size.height.max(1)), scale: scale_factor }
            }
            WindowEvent::CloseRequested => HostEvent::CloseRequested,
            WindowEvent::Focused(focused) => HostEvent::Focused(focused),
            WindowEvent::CursorMoved { position, .. } => {
                let at = position.to_logical::<f64>(scale);
                HostEvent::PointerMove(at.x, at.y)
            }
            WindowEvent::CursorLeft { .. } => HostEvent::PointerLeave,
            WindowEvent::MouseInput { state, button, .. } => HostEvent::Button(keys::winit_button(button), state == ElementState::Pressed),
            WindowEvent::MouseWheel { delta, .. } => match delta {
                MouseScrollDelta::LineDelta(dx, dy) => HostEvent::Wheel(-f64::from(dx) * LINE, -f64::from(dy) * LINE),
                MouseScrollDelta::PixelDelta(p) => HostEvent::Wheel(-p.x / scale, -p.y / scale),
            },
            WindowEvent::ModifiersChanged(m) => {
                let s = m.state();
                HostEvent::Modifiers(Combo::mods(s.control_key(), s.alt_key(), s.shift_key(), s.super_key()))
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(evdev) = keys::winit_key(event.physical_key) else {
                    return;
                };
                let text = event.text.as_ref().map(|t| t.to_string());
                HostEvent::Key { evdev, pressed: event.state == ElementState::Pressed, text }
            }
            WindowEvent::Ime(Ime::Preedit(text, _)) => HostEvent::ImePreedit(text),
            WindowEvent::Ime(Ime::Commit(text)) => HostEvent::ImeCommit(text),
            WindowEvent::DroppedFile(path) => HostEvent::Dropped(vec![path]),
            WindowEvent::Occluded(false) | WindowEvent::RedrawRequested => HostEvent::Redraw,
            _ => return,
        };
        self.emit(el, event);
    }
}
