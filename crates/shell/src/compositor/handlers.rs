use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::renderer::ImportDma;
use smithay::backend::renderer::utils::on_commit_buffer_handler;
use smithay::desktop::{PopupKind, Window, WindowSurfaceType, find_popup_root_surface, get_popup_toplevel_coords};
use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::reexports::calloop::Interest;
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::reexports::wayland_server::backend::ClientData;
use smithay::reexports::wayland_server::protocol::{wl_buffer, wl_seat, wl_surface::WlSurface};
use smithay::reexports::wayland_server::{Client, Resource};
use smithay::utils::Serial;
use smithay::wayland::buffer::BufferHandler;
use smithay::wayland::compositor::{
    BufferAssignment, CompositorClientState, CompositorHandler, CompositorState, SurfaceAttributes, add_blocker, add_pre_commit_hook, get_parent,
    is_sync_subsurface, with_states,
};
use smithay::wayland::dmabuf::get_dmabuf;
use smithay::wayland::dmabuf::{DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier};
use smithay::wayland::drm_syncobj::DrmSyncobjCachedState;
use smithay::wayland::output::OutputHandler;
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::selection::SelectionHandler;
use smithay::wayland::selection::data_device::{DataDeviceHandler, DataDeviceState, set_data_device_focus};
use smithay::wayland::shell::xdg::{PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState, XdgToplevelSurfaceData};
use smithay::wayland::shm::{ShmHandler, ShmState};
use smithay::{delegate_compositor, delegate_data_device, delegate_dmabuf, delegate_output, delegate_seat, delegate_shm, delegate_xdg_shell};

use super::{Compositor, NativeId, ShellEvent};

#[derive(Default)]
pub struct ClientState {
    pub compositor: CompositorClientState,
    pub shell: bool,
}

impl ClientData for ClientState {}

impl CompositorHandler for Compositor {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().expect("我们插入的客户端都带 ClientState").compositor
    }

    fn new_surface(&mut self, surface: &WlSurface) {
        add_pre_commit_hook::<Self, _>(surface, |state, _, surface| state.block_until_ready(surface));
    }

    fn commit(&mut self, surface: &WlSurface) {
        log::trace!("commit {:?}", surface.id());
        on_commit_buffer_handler::<Self>(surface);
        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            if let Some(at) = self.pending.iter().position(|w| w.toplevel().is_some_and(|t| t.wl_surface() == &root)) {
                let window = self.pending.swap_remove(at);
                self.register(window);
            }
            let window = self.window_of(&root);
            if let Some(window) = window {
                window.on_commit();
                self.settle(&window);
                self.place_new(&window);
                self.toplevel_committed(&window, &root);
                if let Some(id) = Self::window_id(&window) {
                    self.native_sync(&window, id);
                }
            }
        }
        self.initial_configure(surface);
        self.drag_icon_committed(surface);
        self.commit_layer(surface);
        self.backend.damaged();
    }
}

pub struct Unplaced(std::cell::Cell<bool>);

struct WantsFullscreen(std::sync::atomic::AtomicBool);

impl Compositor {
    fn client_drag(&mut self, surface: &ToplevelSurface, edges: u32, serial: Serial) {
        let Some(window) = self.window_of(surface.wl_surface()) else { return };
        let pointer = self.pointer();
        if !pointer.has_grab(serial) {
            return;
        }
        let Some(start) = pointer.grab_start_data() else { return };
        self.start_drag(&window, edges, serial, start);
    }

    fn block_until_ready(&mut self, surface: &WlSurface) {
        let (acquire, dmabuf) = with_states(surface, |states| {
            let acquire = states.cached_state.get::<DrmSyncobjCachedState>().pending().acquire_point.clone();
            let dmabuf = match states.cached_state.get::<SurfaceAttributes>().pending().buffer.as_ref() {
                Some(BufferAssignment::NewBuffer(buffer)) => get_dmabuf(buffer).ok().cloned(),
                _ => None,
            };
            (acquire, dmabuf)
        });
        let Some(dmabuf) = dmabuf else { return };
        let Some(client) = surface.client() else { return };
        let cleared = move |state: &mut Compositor| {
            let display = state.display.clone();
            state.client_compositor_state(&client).blocker_cleared(state, &display);
            Ok(())
        };
        match acquire {
            Some(acquire) => {
                if let Ok((blocker, source)) = acquire.generate_blocker()
                    && self.loop_handle.insert_source(source, move |_, _, state| cleared(state)).is_ok()
                {
                    add_blocker(surface, blocker);
                }
            }
            None => {
                if let Ok((blocker, source)) = dmabuf.generate_blocker(Interest::READ)
                    && self.loop_handle.insert_source(source, move |_, _, state| cleared(state)).is_ok()
                {
                    add_blocker(surface, blocker);
                }
            }
        }
    }
}

impl BufferHandler for Compositor {
    fn buffer_destroyed(&mut self, _: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for Compositor {
    fn shm_state(&self) -> &ShmState {
        &self.shm
    }
}

impl DmabufHandler for Compositor {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf
    }

    fn dmabuf_imported(&mut self, _: &DmabufGlobal, dmabuf: Dmabuf, notifier: ImportNotifier) {
        if self.backend.renderer.import_dmabuf(&dmabuf, None).is_ok() {
            let _ = notifier.successful::<Self>();
        } else {
            notifier.failed();
        }
    }
}

impl XdgShellHandler for Compositor {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        self.pending.push(Window::new_wayland_window(surface));
    }

    fn parent_changed(&mut self, surface: ToplevelSurface) {
        self.toplevel_parent_changed(&surface);
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        self.pending.retain(|w| w.toplevel() != Some(&surface));
        let Some(window) = self.window_of(surface.wl_surface()) else { return };
        let focused = self.seat.get_keyboard().and_then(|k| k.current_focus()).is_some_and(|f| f == *surface.wl_surface());
        let parent = self.parent_window(&window);
        let id = Self::window_id(&window);
        let last = id.and_then(|id| self.managed_window(id)).and_then(|w| match w.mode {
            acde_model::Mode::Free | acde_model::Mode::Fixed => Some(w.rect),
            acde_model::Mode::Fullscreen => window.user_data().get::<Restore>().and_then(|r| r.0.get()).map(super::table_rect),
            acde_model::Mode::Pinned => None,
        });
        self.space.unmap_elem(&window);
        if let Some(id) = id {
            self.native_leave(id);
        }
        if Self::bound(surface.wl_surface()).is_none() {
            self.emit(ShellEvent::WindowClose(id));
        } else if let Some(rect) = last {
            self.emit(ShellEvent::WindowGone { window: id, rect: [rect.x, rect.y, rect.w, rect.h].map(|v| v as i32) });
        }
        if focused && let Some(parent) = parent {
            self.focus_window(Some(&parent));
        }
        self.backend.damaged();
    }

    fn popup_destroyed(&mut self, surface: PopupSurface) {
        self.extra_leave(surface.wl_surface());
    }

    fn new_popup(&mut self, surface: PopupSurface, positioner: PositionerState) {
        let parent = surface.get_parent_surface().and_then(|p| self.window_of(&p));
        let at = parent.as_ref().and_then(|p| self.space.element_location(p)).unwrap_or_default() + positioner.get_geometry().loc;
        let rect = smithay::utils::Rectangle::new(at, positioner.get_geometry().size);
        self.extra_enter(surface.wl_surface(), rect, parent.as_ref().and_then(Self::window_id));
        self.unconstrain_popup(&surface);
        let _ = self.popups.track_popup(PopupKind::Xdg(surface));
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        surface.with_pending_state(|state| {
            state.geometry = positioner.get_geometry();
            state.positioner = positioner;
        });
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
    }

    fn grab(&mut self, surface: PopupSurface, seat: wl_seat::WlSeat, serial: Serial) {
        use smithay::desktop::{PopupKeyboardGrab, PopupPointerGrab, PopupUngrabStrategy};
        use smithay::input::pointer::Focus;
        let Some(seat) = Seat::<Self>::from_resource(&seat) else { return };
        let popup = PopupKind::Xdg(surface);
        let Ok(root) = find_popup_root_surface(&popup) else { return };
        let Ok(mut grab) = self.popups.grab_popup(root, popup, &seat, serial) else { return };
        if let Some(keyboard) = seat.get_keyboard().filter(|k| !k.is_grabbed() || k.has_grab(serial) || k.has_grab(grab.previous_serial().unwrap_or(serial))) {
            keyboard.set_focus(self, grab.current_grab(), serial);
            keyboard.set_grab(self, PopupKeyboardGrab::new(&grab), serial);
        }
        if let Some(pointer) = seat.get_pointer() {
            if pointer.is_grabbed() && !(pointer.has_grab(serial) || pointer.has_grab(grab.previous_serial().unwrap_or_else(|| grab.serial()))) {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            pointer.set_grab(self, PopupPointerGrab::new(&grab), serial, Focus::Keep);
        }
    }

    fn fullscreen_request(&mut self, surface: ToplevelSurface, _: Option<smithay::reexports::wayland_server::protocol::wl_output::WlOutput>) {
        let Some(window) = self.window_of(surface.wl_surface()) else { return Self::want_fullscreen(&surface, true) };
        let Some(id) = Self::window_id(&window) else { return };
        self.set_mode_managed(id, acde_model::Mode::Fullscreen);
        self.focus_window(Some(&window));
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        let Some(window) = self.window_of(surface.wl_surface()) else { return Self::want_fullscreen(&surface, false) };
        let Some(id) = Self::window_id(&window) else { return };
        self.set_mode_managed(id, acde_model::Mode::Free);
    }

    fn move_request(&mut self, surface: ToplevelSurface, _: wl_seat::WlSeat, serial: Serial) {
        self.client_drag(&surface, 0, serial);
    }

    fn resize_request(&mut self, surface: ToplevelSurface, _: wl_seat::WlSeat, serial: Serial, edges: xdg_toplevel::ResizeEdge) {
        self.client_drag(&surface, u32::from(edges), serial);
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
    }

    fn minimize_request(&mut self, surface: ToplevelSurface) {
        let window = self.window_of(surface.wl_surface());
        self.emit(ShellEvent::WindowMinimize(window.as_ref().and_then(Self::window_id)));
    }

    fn title_changed(&mut self, surface: ToplevelSurface) {
        let Some(window) = self.window_of(surface.wl_surface()) else { return };
        let (title, app_id) = Self::names(surface.wl_surface());
        self.emit(ShellEvent::WindowTitle { window: Self::window_id(&window), title, app_id });
    }

    fn app_id_changed(&mut self, surface: ToplevelSurface) {
        XdgShellHandler::title_changed(self, surface);
    }
}

pub struct Restore(pub std::cell::Cell<Option<smithay::utils::Rectangle<i32, smithay::utils::Logical>>>);

impl Compositor {
    fn initial_configure(&mut self, surface: &WlSurface) {
        if let Some(window) = self.window_of(surface) {
            let sent = with_states(surface, |states| {
                states.data_map.get::<XdgToplevelSurfaceData>().is_some_and(|d| d.lock().expect("xdg 数据锁").initial_configure_sent)
            });
            if !sent {
                window.toplevel().expect("找到时已确认是 toplevel").send_configure();
            }
        }
        self.popups.commit(surface);
        if let Some(PopupKind::Xdg(popup)) = self.popups.find_popup(surface)
            && !popup.is_initial_configure_sent()
        {
            let _ = popup.send_configure();
        }
    }

    fn names(surface: &WlSurface) -> (Option<String>, Option<String>) {
        with_states(surface, |states| {
            let data = states.data_map.get::<XdgToplevelSurfaceData>().map(|d| d.lock().expect("xdg 数据锁"));
            data.map_or((None, None), |d| (d.title.clone(), d.app_id.clone()))
        })
    }

    fn register(&mut self, window: Window) {
        let Some(surface) = window.toplevel().map(|t| t.wl_surface().clone()) else { return };
        let grant = Self::bound(&surface);
        let id = match grant {
            Some(g) => g.id,
            None => self.next_window_id(),
        };
        window.user_data().insert_if_missing(|| NativeId(id));
        let screen = self.space.output_geometry(&self.backend.output).unwrap_or_default();
        match grant {
            Some(grant) if grant.desktop || (grant.rect.is_none() && grant.mode == acde_model::Mode::Fullscreen) => {
                self.space.map_element(window.clone(), screen.loc, false);
                self.native_enter(&window, id, acde_model::Mode::Fullscreen);
                if grant.desktop {
                    if let Some(managed) = self.managed(id) {
                        let _ = self.table.lower(managed);
                    }
                    self.desktop = Some(id);
                }
                if let Some(toplevel) = window.toplevel() {
                    toplevel.with_pending_state(|state| {
                        state.states.set(xdg_toplevel::State::Fullscreen);
                        state.size = Some(screen.size);
                    });
                    toplevel.send_pending_configure();
                }
                self.native_place(id, screen);
                self.focus_window(Some(&window));
            }
            Some(super::Grant { rect: Some([x, y, w, h]), mode, .. }) => {
                let rect = smithay::utils::Rectangle::new((x, y).into(), (w, h).into());
                self.space.map_element(window.clone(), rect.loc, false);
                self.native_enter(&window, id, mode);
                self.place(&window, rect);
                if mode != acde_model::Mode::Pinned {
                    self.focus_window(Some(&window));
                }
            }
            Some(grant) => {
                let [w, h] = grant.size.unwrap_or([800, 600]);
                let size = smithay::utils::Size::from((w.min(screen.size.w), h.min(screen.size.h)));
                let loc = self.landing(size, None);
                self.space.map_element(window.clone(), loc, false);
                self.native_enter(&window, id, grant.mode);
                self.place(&window, smithay::utils::Rectangle::new(loc, size));
                self.focus_window(Some(&window));
            }
            None => {
                self.space.map_element(window.clone(), screen.loc, false);
                window.user_data().insert_if_missing(|| Unplaced(std::cell::Cell::new(true)));
                self.native_enter(&window, id, acde_model::Mode::Free);
                self.focus_window(Some(&window));
                let (title, app_id) = Self::names(&surface);
                self.emit(ShellEvent::WindowOpen { window: id, title, app_id });
                self.milestone("第一个原生窗口");
                if let Some(toplevel) = window.toplevel().filter(|t| Self::wants_fullscreen(t)).cloned() {
                    XdgShellHandler::fullscreen_request(self, toplevel, None);
                }
            }
        }
    }

    fn want_fullscreen(surface: &ToplevelSurface, on: bool) {
        with_states(surface.wl_surface(), |s| {
            s.data_map
                .get_or_insert_threadsafe(|| WantsFullscreen(std::sync::atomic::AtomicBool::new(false)))
                .0
                .store(on, std::sync::atomic::Ordering::Relaxed);
        });
    }

    fn wants_fullscreen(surface: &ToplevelSurface) -> bool {
        with_states(surface.wl_surface(), |s| s.data_map.get::<WantsFullscreen>().is_some_and(|w| w.0.load(std::sync::atomic::Ordering::Relaxed)))
    }

    fn landing(
        &self,
        size: smithay::utils::Size<i32, smithay::utils::Logical>,
        parent: Option<&Window>,
    ) -> smithay::utils::Point<i32, smithay::utils::Logical> {
        let screen = self.space.output_geometry(&self.backend.output).unwrap_or_default();
        let over = parent.and_then(|p| Some(smithay::utils::Rectangle::new(self.space.element_location(p)?, p.geometry().size))).unwrap_or(screen);
        let cascade = if parent.is_some() { 0 } else { (self.native_ids.len() as i32 % 8) * 32 };
        let loc = over.loc + smithay::utils::Point::from(((over.size.w - size.w) / 2 + cascade, (over.size.h - size.h) / 2 + cascade));
        (
            loc.x.clamp(screen.loc.x, (screen.loc.x + screen.size.w - size.w).max(screen.loc.x)),
            loc.y.clamp(screen.loc.y, (screen.loc.y + screen.size.h - size.h).max(screen.loc.y)),
        )
            .into()
    }

    fn place_new(&mut self, window: &Window) {
        let size = window.geometry().size;
        if size.w <= 0 || size.h <= 0 || !window.user_data().get::<Unplaced>().is_some_and(|u| u.0.replace(false)) {
            return;
        }
        let parent = window.toplevel().and_then(|t| t.parent()).and_then(|p| self.window_of(&p));
        let loc = self.landing(size, parent.as_ref());
        self.space.map_element(window.clone(), loc, false);
        if let Some(id) = Self::window_id(window) {
            self.native_sync(window, id);
        }
    }

    fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else { return };
        let Some(window) = self.window_of(&root) else {
            return;
        };
        let (Some(output), Some(window_geo)) = (self.space.outputs().next(), self.space.element_geometry(&window)) else {
            return;
        };
        let Some(mut target) = self.space.output_geometry(output) else { return };
        target.loc -= get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        target.loc -= window_geo.loc;
        popup.with_pending_state(|state| state.geometry = state.positioner.get_unconstrained_geometry(target));
    }

    pub fn focus_window(&mut self, window: Option<&Window>) {
        if self.lock.locked() {
            return;
        }
        let modal = window.and_then(|w| self.modal_target(w));
        let window = modal.as_ref().or(window);
        if !self.grab_holds(window) {
            self.lose_grabs(super::grabs::Lost::Focus);
        }
        let serial = smithay::utils::SERIAL_COUNTER.next_serial();
        if let Some(window) = window {
            self.space.raise_element(window, true);
        }
        for w in self.space.elements() {
            w.set_activated(Some(w) == window);
            if let Some(toplevel) = w.toplevel() {
                toplevel.send_pending_configure();
            }
        }
        let focus = window.and_then(|w| w.wl_surface()).map(std::borrow::Cow::into_owned);
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, focus, serial);
        }
        self.native_focus(window);
    }

    pub fn surface_under(
        &self,
        pos: smithay::utils::Point<f64, smithay::utils::Logical>,
    ) -> Option<(WlSurface, smithay::utils::Point<f64, smithay::utils::Logical>)> {
        use smithay::desktop::layer_map_for_output;
        use smithay::wayland::shell::wlr_layer::Layer;
        let output = self.space.outputs().find(|o| self.space.output_geometry(o).is_some_and(|g| g.to_f64().contains(pos)));
        let origin = output.and_then(|o| self.space.output_geometry(o)).map(|g| g.loc).unwrap_or_default();
        if self.lock.locked() {
            return output.and_then(|o| self.lock.focus(o)).map(|surface| (surface, origin.to_f64()));
        }
        let layer_under = |layers: &[Layer]| {
            let map = layer_map_for_output(output?);
            layers.iter().find_map(|&layer| {
                let surface = map.layer_under(layer, pos - origin.to_f64())?;
                let loc = map.layer_geometry(surface)?.loc + origin;
                surface.surface_under(pos - loc.to_f64(), WindowSurfaceType::ALL).map(|(s, p)| (s, (p + loc).to_f64()))
            })
        };
        layer_under(&[Layer::Overlay, Layer::Top])
            .or_else(|| {
                self.window_under(pos).and_then(|(window, location)| {
                    window.surface_under(pos - location.to_f64(), WindowSurfaceType::ALL).map(|(surface, p)| (surface, (p + location).to_f64()))
                })
            })
            .or_else(|| layer_under(&[Layer::Bottom, Layer::Background]))
    }
}

impl SeatHandler for Compositor {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn cursor_image(&mut self, _: &Seat<Self>, image: smithay::input::pointer::CursorImageStatus) {
        self.cursor.status = image;
        if matches!(self.backend.target, super::backend::Target::Drm(_)) {
            self.backend.damaged();
        }
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|s| self.display.get_client(s.id()).ok());
        set_data_device_focus(&self.display, seat, client);
    }
}

impl SelectionHandler for Compositor {
    type SelectionUserData = ();
}

impl DataDeviceHandler for Compositor {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device
    }
}

impl OutputHandler for Compositor {}

delegate_compositor!(Compositor);
delegate_shm!(Compositor);
delegate_dmabuf!(Compositor);
delegate_xdg_shell!(Compositor);
delegate_seat!(Compositor);
delegate_data_device!(Compositor);
delegate_output!(Compositor);
