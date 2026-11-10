use std::io::{Read, Write};
use std::os::fd::OwnedFd;

use acde_model::Event;
use smithay_client_toolkit::compositor::CompositorHandler;
use smithay_client_toolkit::data_device_manager::WritePipe;
use smithay_client_toolkit::data_device_manager::data_device::DataDeviceHandler;
use smithay_client_toolkit::data_device_manager::data_offer::{DataOfferHandler, DragOffer};
use smithay_client_toolkit::data_device_manager::data_source::DataSourceHandler;
use smithay_client_toolkit::dispatch2::Dispatch2;
use smithay_client_toolkit::dmabuf::{DmabufFeedback, DmabufHandler, DmabufState};
use smithay_client_toolkit::output::{OutputHandler, OutputState};
use smithay_client_toolkit::registry::{ProvidesRegistryState, RegistryState};
use smithay_client_toolkit::seat::keyboard::{KeyEvent, KeyboardHandler, Keysym, Modifiers, RawModifiers};
use smithay_client_toolkit::seat::pointer::{PointerEvent, PointerEventKind, PointerHandler};
use smithay_client_toolkit::seat::{Capability, SeatHandler, SeatState};
use smithay_client_toolkit::shell::WaylandSurface;
use smithay_client_toolkit::shell::xdg::window::{Window, WindowConfigure, WindowHandler};
use smithay_client_toolkit::shm::{Shm, ShmHandler};
use smithay_client_toolkit::{delegate_dispatch2, registry_handlers};
use wayland_client::protocol::{
    wl_buffer, wl_data_device, wl_data_device_manager::DndAction, wl_data_source, wl_keyboard, wl_output, wl_pointer, wl_seat, wl_surface,
};
use wayland_client::{Connection, QueueHandle};
use wayland_protocols::wp::cursor_shape::v1::client::wp_cursor_shape_device_v1::Shape;
use wayland_protocols::wp::fractional_scale::v1::client::{wp_fractional_scale_manager_v1, wp_fractional_scale_v1};
use wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_buffer_params_v1;
use wayland_protocols::wp::viewporter::client::{wp_viewport, wp_viewporter};

use crate::client::{App, Data, TEXT};
use crate::protocol::{acde_window, acde_window_manager};

delegate_dispatch2!(App);
smithay_client_toolkit::delegate_registry!(App);

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    registry_handlers![SeatState, OutputState];
}

impl CompositorHandler for App {
    fn scale_factor_changed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, factor: i32) {
        if !self.fractional_scale && f64::from(factor) != self.scale {
            self.scale = f64::from(factor.max(1));
            self.tell_size();
        }
    }

    fn transform_changed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: wl_output::Transform) {}

    fn frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {
        self.frame_pending = false;
        for trace in self.presenting.drain(..) {
            trace.presented(self.window_id);
        }
        if self.pacer.want_frame || self.pacer.animating {
            self.pace();
            self.ask_frame();
        }
    }

    fn surface_enter(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: &wl_output::WlOutput) {}

    fn surface_leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: &wl_output::WlOutput) {}
}

impl OutputHandler for App {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.outputs
    }

    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {
        self.note_refresh();
    }

    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {
        self.note_refresh();
    }

    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {
        self.note_refresh();
    }
}

impl WindowHandler for App {
    fn request_close(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &Window) {
        self.events.push(Event::named("close"));
    }

    fn configure(&mut self, _: &Connection, _: &QueueHandle<Self>, window: &Window, configure: WindowConfigure, _: u32) {
        if self.panel_configured(window, configure.is_activated()) {
            return;
        }
        let size = (configure.new_size.0.map_or(self.logical.0, |v| v.get()), configure.new_size.1.map_or(self.logical.1, |v| v.get()));
        self.logical = if size.0 == 0 || size.1 == 0 { (800, 600) } else { size };
        self.configured = true;
        self.decorate(configure.is_fullscreen());
        self.tell_state(match (configure.is_fullscreen(), configure.is_maximized()) {
            (true, _) => acde_model::WindowState::Fullscreen,
            (false, true) => acde_model::WindowState::Filled,
            _ => acde_model::WindowState::Normal,
        });
        self.tell_size();
        self.active = configure.is_activated();
        self.paint();
    }
}

impl SeatHandler for App {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}

    fn new_capability(&mut self, _: &Connection, qh: &QueueHandle<Self>, seat: wl_seat::WlSeat, capability: Capability) {
        if self.device.is_none()
            && let Some(manager) = self.data_devices.as_ref()
        {
            self.device = Some(manager.get_data_device(qh, &seat));
        }
        match capability {
            Capability::Keyboard if self.keyboard.is_none() => self.keyboard = self.seat_state.get_keyboard(qh, &seat, None).ok(),
            Capability::Pointer if self.pointer.is_none() => {
                let pointer = self.seat_state.get_pointer(qh, &seat).ok();
                self.shape = pointer.as_ref().zip(self.cursor_shapes.as_ref()).map(|(p, m)| m.get_shape_device(p, qh));
                self.pointer = pointer;
            }
            _ => {}
        }
    }

    fn remove_capability(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat, capability: Capability) {
        match capability {
            Capability::Keyboard => {
                if let Some(k) = self.keyboard.take() {
                    k.release();
                }
            }
            Capability::Pointer => {
                self.shape = None;
                if let Some(p) = self.pointer.take() {
                    p.release();
                }
            }
            _ => {}
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
}

impl PointerHandler for App {
    fn pointer_frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_pointer::WlPointer, events: &[PointerEvent]) {
        for event in events {
            if self.decoration_pointer(event) {
                continue;
            }
            if let PointerEventKind::Leave { .. } = event.kind {
                self.left = true;
                continue;
            }
            let Some((ox, oy)) = self.origin_of(&event.surface) else { continue };
            let (x, y) = (event.position.0 + ox, event.position.1 + oy);
            let s = self.scale;
            match event.kind {
                PointerEventKind::Enter { serial } => {
                    self.left = false;
                    self.pointer_serial = serial;
                    if let Some(shape) = &self.shape {
                        shape.set_shape(serial, Shape::Default);
                    }
                    self.render.pointer((x * s) as f32, (y * s) as f32);
                    self.events.push(Event { kind: "pointermove".into(), x: Some(x), y: Some(y), ..Default::default() });
                }
                PointerEventKind::Leave { .. } => {}
                PointerEventKind::Motion { .. } => {
                    self.render.pointer((x * s) as f32, (y * s) as f32);
                    self.events.push(Event { kind: "pointermove".into(), x: Some(x), y: Some(y), ..Default::default() });
                }
                PointerEventKind::Press { button, serial, .. } | PointerEventKind::Release { button, serial, .. } => {
                    let down = matches!(event.kind, PointerEventKind::Press { .. });
                    self.serial = serial;
                    if down {
                        self.pointer_serial = serial;
                    }
                    let kind = if down { "pointerdown" } else { "pointerup" };
                    self.events.push(Event { kind: kind.into(), x: Some(x), y: Some(y), button: Some(button), ..Default::default() });
                }
                PointerEventKind::Axis { horizontal, vertical, .. } => {
                    let (dx, dy) = (horizontal.absolute, vertical.absolute);
                    if dx == 0.0 && dy == 0.0 {
                        continue;
                    }
                    self.render.scroll_at((x * s) as f32, (y * s) as f32, dx * s, dy * s);
                    self.events.push(Event { kind: "wheel".into(), x: Some(x), y: Some(y), delta_x: Some(dx), delta_y: Some(dy), ..Default::default() });
                }
            }
        }
    }
}

impl KeyboardHandler for App {
    fn enter(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: &wl_surface::WlSurface, serial: u32, _: &[u32], _: &[Keysym]) {
        self.serial = serial;
    }

    fn leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: &wl_surface::WlSurface, _: u32) {}

    fn press_key(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, serial: u32, event: KeyEvent) {
        self.serial = serial;
        self.key("keydown", &event);
    }

    fn repeat_key(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: u32, _: KeyEvent) {}

    fn release_key(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, serial: u32, event: KeyEvent) {
        self.serial = serial;
        self.key("keyup", &event);
    }

    fn update_modifiers(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: u32, _: Modifiers, _: RawModifiers, _: u32) {}
}

impl App {
    fn key(&self, kind: &str, event: &KeyEvent) {
        let key = event.keysym.key_char().map(String::from);
        self.events.push(Event { kind: kind.into(), code: Some(event.raw_code), key, ..Default::default() });
    }

    fn mimes(offer: &DragOffer) -> Vec<String> {
        offer.with_mime_types(<[String]>::to_vec)
    }
}

impl DataDeviceHandler for App {
    fn enter(&mut self, _: &Connection, _: &QueueHandle<Self>, device: &wl_data_device::WlDataDevice, x: f64, y: f64, surface: &wl_surface::WlSurface) {
        if surface != self.window.wl_surface() {
            return;
        }
        let Some(offer) = self.device.as_ref().filter(|d| d.inner() == device).and_then(|d| d.data().drag_offer()) else { return };
        let mime = Self::mimes(&offer);
        offer.accept_mime_type(offer.serial, mime.first().cloned());
        offer.set_actions(DndAction::Copy | DndAction::Move, DndAction::Copy);
        self.over = Some((x, y));
        self.events.push(Event { kind: "dndenter".into(), x: Some(x), y: Some(y), mime: Some(mime), ..Default::default() });
    }

    fn leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_data_device::WlDataDevice) {
        if self.over.take().is_some() {
            self.events.push(Event::named("dndleave"));
        }
    }

    fn motion(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_data_device::WlDataDevice, x: f64, y: f64) {
        let Some(offer) = self.device.as_ref().and_then(|d| d.data().drag_offer()) else { return };
        self.over = Some((x, y));
        let mime = Self::mimes(&offer);
        self.events.push(Event { kind: "dndmove".into(), x: Some(x), y: Some(y), mime: Some(mime), ..Default::default() });
    }

    fn selection(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_data_device::WlDataDevice) {}

    fn drop_performed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_data_device::WlDataDevice) {
        let (Some(offer), Some((x, y))) = (self.device.as_ref().and_then(|d| d.data().drag_offer()), self.over.take()) else { return };
        let pipes: Vec<(String, OwnedFd)> =
            Self::mimes(&offer).into_iter().filter_map(|m| offer.receive(m.clone()).ok().map(|p| (m, OwnedFd::from(p)))).collect();
        let _ = self.conn.flush();
        let events = self.events.clone();
        let conn = self.conn.clone();
        std::thread::spawn(move || {
            let mut data: std::collections::HashMap<String, String> = pipes
                .into_iter()
                .filter_map(|(mime, fd)| {
                    let mut text = String::new();
                    std::fs::File::from(fd).read_to_string(&mut text).ok()?;
                    Some((mime, text))
                })
                .collect();
            offer.finish();
            offer.destroy();
            let _ = conn.flush();
            let dropped = dropped_paths(data.get("text/uri-list").map_or("", String::as_str));
            if !dropped.is_empty() {
                data.remove("text/uri-list");
                data.remove("text/plain");
            }
            let files = Some(dropped.iter().map(|path| path.display().to_string()).collect());
            events.push(Event { kind: "dnddrop".into(), x: Some(x), y: Some(y), data: Some(data), files, ..Default::default() });
        });
    }
}

impl DataOfferHandler for App {
    fn source_actions(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &mut DragOffer, _: DndAction) {}

    fn selected_action(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &mut DragOffer, _: DndAction) {}
}

impl DataSourceHandler for App {
    fn accept_mime(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_data_source::WlDataSource, _: Option<String>) {}

    fn send_request(&mut self, _: &Connection, _: &QueueHandle<Self>, source: &wl_data_source::WlDataSource, mime: String, pipe: WritePipe) {
        let text = match (&self.clipboard, &self.drag) {
            (Some((s, text)), _) if s.inner() == source => TEXT.contains(&mime.as_str()).then(|| text.clone()),
            (_, Some(drag)) if drag.source.inner() == source => drag.data.get(&mime).cloned(),
            _ => None,
        };
        let Some(text) = text else { return };
        std::thread::spawn(move || {
            let _ = std::fs::File::from(OwnedFd::from(pipe)).write_all(text.as_bytes());
        });
    }

    fn cancelled(&mut self, _: &Connection, _: &QueueHandle<Self>, source: &wl_data_source::WlDataSource) {
        if self.clipboard.as_ref().is_some_and(|(s, _)| s.inner() == source) {
            self.clipboard = None;
        }
        if self.drag.as_ref().is_some_and(|d| d.source.inner() == source) {
            self.end_drag();
        }
    }

    fn dnd_dropped(&mut self, _: &Connection, _: &QueueHandle<Self>, source: &wl_data_source::WlDataSource) {
        if let Some(drag) = self.drag.as_mut().filter(|d| d.source.inner() == source) {
            drag.dropped = true;
        }
    }

    fn dnd_finished(&mut self, _: &Connection, _: &QueueHandle<Self>, source: &wl_data_source::WlDataSource) {
        if self.drag.as_ref().is_some_and(|d| d.source.inner() == source) {
            self.end_drag();
        }
    }

    fn action(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_data_source::WlDataSource, _: DndAction) {}
}

impl App {
    pub(crate) fn settle_pointer(&mut self) {
        if std::mem::take(&mut self.left) {
            self.render.pointer(-1.0, -1.0);
            self.events.push(Event::named("pointerleave"));
        }
    }

    fn end_drag(&mut self) {
        let Some(drag) = self.drag.take() else { return };
        if let Some((surface, buffer)) = &drag.icon {
            surface.destroy();
            buffer.destroy();
        }
        self.events.push(Event { kind: "dragend".into(), button: Some(u32::from(drag.dropped)), ..Default::default() });
    }
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

impl DmabufHandler for App {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf
    }

    fn dmabuf_feedback(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_dmabuf_feedback_v1::ZwpLinuxDmabufFeedbackV1,
        _: DmabufFeedback,
    ) {
    }

    fn created(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1, _: wl_buffer::WlBuffer) {}

    fn failed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1) {
        log::warn!("the compositor rejected the web canvas (linux-dmabuf)");
    }

    fn released(&mut self, _: &Connection, _: &QueueHandle<Self>, buffer: &wl_buffer::WlBuffer) {
        self.release_buffer(buffer);
    }
}

impl Dispatch2<acde_window_manager::AcdeWindowManager, App> for Data {
    fn event(&self, _: &mut App, _: &acde_window_manager::AcdeWindowManager, _: acde_window_manager::Event, _: &Connection, _: &QueueHandle<App>) {}
}

impl Dispatch2<acde_window::AcdeWindow, App> for Data {
    fn event(&self, app: &mut App, acde: &acde_window::AcdeWindow, event: acde_window::Event, _: &Connection, _: &QueueHandle<App>) {
        if acde != &app.acde {
            return;
        }
        match event {
            acde_window::Event::Window { id } => {
                app.window_id = id;
                if let Some(ready) = app.ready.take() {
                    let _ = ready.send(Ok(id));
                }
            }
            acde_window::Event::Grab { granted, kind } => {
                let kind = match kind.into_result() {
                    Ok(acde_window::GrabKind::Pointer) => "pointer",
                    _ => "keyboard",
                };
                app.events.push(Event { kind: "grab".into(), key: Some(kind.into()), code: Some(granted), ..Default::default() });
            }
            acde_window::Event::GrabLost { reason } => {
                let reason = match reason.into_result() {
                    Ok(acde_window::GrabLostReason::Esc) => "esc",
                    Ok(acde_window::GrabLostReason::OtherWindow) => "other_window",
                    Ok(acde_window::GrabLostReason::FocusLost) => "focus_lost",
                    _ => "denied",
                };
                app.events.push(Event { kind: "grablost".into(), title: Some(reason.into()), ..Default::default() });
            }
            acde_window::Event::Mode { .. } => {}
        }
    }
}

impl Dispatch2<wp_viewporter::WpViewporter, App> for Data {
    fn event(&self, _: &mut App, _: &wp_viewporter::WpViewporter, _: wp_viewporter::Event, _: &Connection, _: &QueueHandle<App>) {}
}

impl Dispatch2<wp_viewport::WpViewport, App> for Data {
    fn event(&self, _: &mut App, _: &wp_viewport::WpViewport, _: wp_viewport::Event, _: &Connection, _: &QueueHandle<App>) {}
}

impl Dispatch2<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1, App> for Data {
    fn event(
        &self,
        _: &mut App,
        _: &wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1,
        _: wp_fractional_scale_manager_v1::Event,
        _: &Connection,
        _: &QueueHandle<App>,
    ) {
    }
}

impl Dispatch2<wp_fractional_scale_v1::WpFractionalScaleV1, App> for Data {
    fn event(
        &self,
        app: &mut App,
        _: &wp_fractional_scale_v1::WpFractionalScaleV1,
        event: wp_fractional_scale_v1::Event,
        _: &Connection,
        _: &QueueHandle<App>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = event {
            app.fractional_scale = true;
            let scale = f64::from(scale) / 120.0;
            if scale > 0.0 && scale != app.scale {
                app.scale = scale;
                app.tell_size();
            }
        }
    }
}

fn dropped_paths(uris: &str) -> Vec<std::path::PathBuf> {
    uris.lines().map(str::trim).filter(|line| line.starts_with("file://")).filter_map(|line| url::Url::parse(line).ok()?.to_file_path().ok()).collect()
}
