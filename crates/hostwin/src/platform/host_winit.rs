use std::cell::Cell;
use std::sync::Arc;

use acde::gpu::wgpu;
use acde::model::{Combo, WindowState};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{DeviceEvent, DeviceId, ElementState, Ime, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{CursorGrabMode, CursorIcon, Fullscreen, ResizeDirection, Window, WindowId};

use super::{Cmd, Handler, HostEvent, LINE, Monitor};
use crate::keys;
use acde::render::ClipboardEntry;

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
    state: Cell<WindowState>,
    cursor: Cell<&'static str>,
    locked: Cell<bool>,
}

impl Host {
    fn show_cursor(&self) {
        if self.locked.get() {
            return;
        }
        let cursor = self.cursor.get();
        if cursor == "none" {
            return self.window.set_cursor_visible(false);
        }
        self.window.set_cursor(cursor.parse::<CursorIcon>().unwrap_or_else(|_| {
            log::debug!("host window: no system cursor for {cursor}, showing the default one");
            CursorIcon::Default
        }));
        self.window.set_cursor_visible(true);
    }

    fn state_now(&self) -> WindowState {
        if self.window.is_minimized() == Some(true) {
            WindowState::Minimized
        } else if self.window.fullscreen().is_some() {
            WindowState::Fullscreen
        } else if self.window.is_maximized() {
            WindowState::Filled
        } else {
            WindowState::Normal
        }
    }

    fn state_changed(&self) -> Option<WindowState> {
        let now = self.state_now();
        (self.state.replace(now) != now).then_some(now)
    }
}

impl super::Host for Host {
    fn controls(&self) -> bool {
        true
    }

    fn set_state(&self, to: Option<WindowState>) {
        let window = &self.window;
        match to {
            None if window.is_minimized() == Some(true) => window.set_minimized(false),
            None => window.set_fullscreen(None),
            Some(WindowState::Minimized) => window.set_minimized(true),
            Some(WindowState::Fullscreen) => window.set_fullscreen(Some(Fullscreen::Borderless(None))),
            Some(WindowState::Filled) => {
                window.set_fullscreen(None);
                window.set_maximized(true);
            }
            Some(WindowState::Normal) => {
                window.set_fullscreen(None);
                window.set_maximized(false);
                window.set_minimized(false);
            }
        }
    }

    fn drag(&self, edges: u32) -> bool {
        let (top, bottom, left, right) = (edges & 1 != 0, edges & 2 != 0, edges & 4 != 0, edges & 8 != 0);
        let direction = match (top, bottom, left, right) {
            (false, false, false, false) => return self.window.drag_window().map_err(|e| log::warn!("host window: move: {e}")).is_ok(),
            (true, _, true, _) => ResizeDirection::NorthWest,
            (true, _, _, true) => ResizeDirection::NorthEast,
            (_, true, true, _) => ResizeDirection::SouthWest,
            (_, true, _, true) => ResizeDirection::SouthEast,
            (true, ..) => ResizeDirection::North,
            (_, true, ..) => ResizeDirection::South,
            (.., true, _) => ResizeDirection::West,
            (.., true) => ResizeDirection::East,
        };
        self.window.drag_resize_window(direction).map_err(|e| log::warn!("host window: resize: {e}")).is_ok()
    }

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
        crate::system::chooser::folder(Some(&self.window), title, reply);
    }

    fn open_files(&self, request: crate::OpenRequest, reply: super::FilesReply) {
        crate::system::chooser::open(Some(&self.window), &request, reply);
    }

    fn save_file(&self, request: crate::SaveRequest, reply: super::FolderReply) {
        crate::system::chooser::save(Some(&self.window), &request, reply);
    }

    fn approve(&self, title: &str, message: &str, reply: super::ApproveReply) {
        crate::system::approve::ask(&self.window, title, message, reply);
    }

    fn resize(&self, [w, h]: [f64; 2], _: f64) -> Result<Option<(u32, u32)>, String> {
        Ok(self.window.request_inner_size(LogicalSize::new(w, h)).map(|size| (size.width.max(1), size.height.max(1))))
    }

    fn exit(&self, code: i32) {
        self.exit.set(Some(code));
    }

    fn lock_pointer(&self, on: bool) -> bool {
        if !on {
            if let Err(e) = self.window.set_cursor_grab(CursorGrabMode::None) {
                log::warn!("host window: release the pointer: {e}");
            }
            self.locked.set(false);
            self.show_cursor();
            return true;
        }
        match self.window.set_cursor_grab(CursorGrabMode::Locked).or_else(|_| self.window.set_cursor_grab(CursorGrabMode::Confined)) {
            Ok(()) => {
                self.locked.set(true);
                self.window.set_cursor_visible(false);
                true
            }
            Err(e) => {
                log::warn!("host window: lock the pointer: {e}");
                false
            }
        }
    }

    fn set_cursor(&self, cursor: &'static str) {
        log::debug!("host window: cursor {cursor}");
        self.cursor.set(cursor);
        self.show_cursor();
    }

    fn set_size(&self, [w, h]: [f64; 2]) -> Option<(u32, u32)> {
        if self.window.is_maximized() || self.window.fullscreen().is_some() {
            return None;
        }
        self.window.request_inner_size(LogicalSize::new(w, h)).map(|size| (size.width.max(1), size.height.max(1)))
    }
}

pub(crate) fn clipboard_set(entries: Vec<ClipboardEntry>) {
    let image = ClipboardEntry::find(&entries, ClipboardEntry::PNG).and_then(|entry| crate::clipimage::decode(&entry.data));
    let text = ClipboardEntry::find(&entries, ClipboardEntry::TEXT).map(|entry| String::from_utf8_lossy(&entry.data).into_owned());
    let done = arboard::Clipboard::new().and_then(|mut clipboard| match (image, text) {
        (Some((width, height, bytes)), _) => clipboard.set_image(arboard::ImageData { width, height, bytes: bytes.into() }),
        (None, Some(text)) => clipboard.set_text(text),
        (None, None) => clipboard.clear(),
    });
    if let Err(e) = done {
        log::warn!("clipboard: {e}");
    }
}

pub(crate) fn clipboard_types() -> Vec<String> {
    let Ok(mut clipboard) = arboard::Clipboard::new() else { return Vec::new() };
    let image = clipboard.get_image().is_ok();
    let text = clipboard.get_text().is_ok_and(|text| !text.is_empty());
    [(image, ClipboardEntry::PNG), (text, ClipboardEntry::TEXT)].into_iter().filter(|(has, _)| *has).map(|(_, mime)| mime.to_owned()).collect()
}

pub(crate) fn clipboard_read(mime: &str) -> Option<Vec<u8>> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    match mime {
        ClipboardEntry::TEXT => clipboard.get_text().ok().filter(|text| !text.is_empty()).map(String::into_bytes),
        ClipboardEntry::PNG => clipboard.get_image().ok().and_then(|image| crate::clipimage::encode(image.width, image.height, &image.bytes)),
        _ => None,
    }
}

pub(crate) fn click_settings() -> acde::model::ClickSettings {
    acde::model::ClickSettings::default()
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
    fn follow_state(&mut self, el: &ActiveEventLoop) {
        if let Some(state) = self.host.as_ref().and_then(Host::state_changed) {
            self.emit(el, HostEvent::State(state));
        }
    }

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
        let host = Host { window, exit: Cell::new(None), state: Cell::new(WindowState::Normal), cursor: Cell::new("default"), locked: Cell::new(false) };
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

    fn device_event(&mut self, el: &ActiveEventLoop, _: DeviceId, event: DeviceEvent) {
        if let DeviceEvent::MouseMotion { delta: (dx, dy) } = event {
            self.emit(el, HostEvent::Motion(dx, dy));
        }
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
            WindowEvent::Occluded(true) | WindowEvent::Moved(_) => return self.follow_state(el),
            _ => return,
        };
        let placed = matches!(event, HostEvent::Resized { .. } | HostEvent::Focused(_) | HostEvent::Redraw);
        self.emit(el, event);
        if placed {
            self.follow_state(el);
        }
    }
}
