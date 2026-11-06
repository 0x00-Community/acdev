use smithay::backend::drm::DrmDeviceFd;
use smithay::desktop::{PopupKind, PopupManager};
use smithay::input::pointer::PointerHandle;
use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as DecorationMode;
use smithay::reexports::wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::{Mode as KdeMode, OrgKdeKwinServerDecoration};
use smithay::reexports::wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration_manager::Mode as KdeDefaultMode;
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::reexports::wayland_server::WEnum;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::Rectangle;
use smithay::utils::{DeviceFd, Logical, Point};
use smithay::wayland::compositor::with_states;
use smithay::wayland::cursor_shape::CursorShapeManagerState;
use smithay::wayland::drm_syncobj::{DrmSyncobjHandler, DrmSyncobjState, supports_syncobj_eventfd};
use smithay::wayland::fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState, with_fractional_scale};
use smithay::wayland::input_method::{InputMethodHandler, InputMethodManagerState, PopupSurface as ImePopup};
use smithay::wayland::keyboard_shortcuts_inhibit::{KeyboardShortcutsInhibitHandler, KeyboardShortcutsInhibitState, KeyboardShortcutsInhibitor};
use smithay::wayland::pointer_constraints::{PointerConstraintsHandler, PointerConstraintsState, with_pointer_constraint};
use smithay::wayland::pointer_gestures::PointerGesturesState;
use smithay::wayland::relative_pointer::RelativePointerManagerState;
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::selection::primary_selection::{PrimarySelectionHandler, PrimarySelectionState};
use smithay::wayland::shell::kde::decoration::{KdeDecorationHandler, KdeDecorationState};
use smithay::wayland::shell::xdg::ToplevelSurface;
use smithay::wayland::shell::xdg::decoration::{XdgDecorationHandler, XdgDecorationState};
use smithay::wayland::shell::xdg::dialog::{XdgDialogHandler, XdgDialogState};
use smithay::wayland::single_pixel_buffer::SinglePixelBufferState;
use smithay::wayland::text_input::TextInputManagerState;
use smithay::wayland::viewporter::ViewporterState;
use smithay::wayland::virtual_keyboard::VirtualKeyboardManagerState;
use smithay::wayland::xdg_activation::{XdgActivationHandler, XdgActivationState, XdgActivationToken, XdgActivationTokenData};
use smithay::{
    delegate_cursor_shape, delegate_drm_syncobj, delegate_fractional_scale, delegate_input_method_manager, delegate_kde_decoration,
    delegate_keyboard_shortcuts_inhibit, delegate_pointer_constraints, delegate_pointer_gestures, delegate_primary_selection, delegate_relative_pointer,
    delegate_single_pixel_buffer, delegate_text_input_manager, delegate_viewporter, delegate_virtual_keyboard_manager, delegate_xdg_activation,
    delegate_xdg_decoration, delegate_xdg_dialog,
};

use super::Compositor;

pub struct Protocols {
    pub primary_selection: PrimarySelectionState,
    pub activation: XdgActivationState,
    pub syncobj: Option<DrmSyncobjState>,
    _decoration: XdgDecorationState,
    kde_decoration: KdeDecorationState,
    _fractional_scale: FractionalScaleManagerState,
    _viewporter: ViewporterState,
    _single_pixel: SinglePixelBufferState,
    _constraints: PointerConstraintsState,
    _relative: RelativePointerManagerState,
    _gestures: PointerGesturesState,
    _cursor_shape: CursorShapeManagerState,
    _text_input: TextInputManagerState,
    _input_method: InputMethodManagerState,
    _virtual_keyboard: VirtualKeyboardManagerState,
    _dialog: XdgDialogState,
    shortcuts_inhibit: KeyboardShortcutsInhibitState,
}

impl Protocols {
    pub fn new(dh: &DisplayHandle, render_node: Option<std::path::PathBuf>) -> Self {
        let syncobj = render_node
            .and_then(|path| std::fs::OpenOptions::new().read(true).write(true).open(path).ok())
            .map(|file| DrmDeviceFd::new(DeviceFd::from(std::os::fd::OwnedFd::from(file))))
            .filter(supports_syncobj_eventfd)
            .map(|device| DrmSyncobjState::new::<Compositor>(dh, device));
        if syncobj.is_none() {
            log::warn!("显式同步不可用 (没有 render node 或内核不支持 syncobj eventfd)");
        }
        Self {
            primary_selection: PrimarySelectionState::new::<Compositor>(dh),
            activation: XdgActivationState::new::<Compositor>(dh),
            syncobj,
            _decoration: XdgDecorationState::new::<Compositor>(dh),
            kde_decoration: KdeDecorationState::new::<Compositor>(dh, KdeDefaultMode::Client),
            _fractional_scale: FractionalScaleManagerState::new::<Compositor>(dh),
            _viewporter: ViewporterState::new::<Compositor>(dh),
            _single_pixel: SinglePixelBufferState::new::<Compositor>(dh),
            _constraints: PointerConstraintsState::new::<Compositor>(dh),
            _relative: RelativePointerManagerState::new::<Compositor>(dh),
            _gestures: PointerGesturesState::new::<Compositor>(dh),
            _cursor_shape: CursorShapeManagerState::new::<Compositor>(dh),
            _text_input: TextInputManagerState::new::<Compositor>(dh),
            _input_method: InputMethodManagerState::new::<Compositor, _>(dh, |_| true),
            _virtual_keyboard: VirtualKeyboardManagerState::new::<Compositor, _>(dh, |_| true),
            _dialog: XdgDialogState::new::<Compositor>(dh),
            shortcuts_inhibit: KeyboardShortcutsInhibitState::new::<Compositor>(dh),
        }
    }
}

impl XdgDecorationHandler for Compositor {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        self.client_side(&toplevel);
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, _: DecorationMode) {
        self.client_side(&toplevel);
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        self.client_side(&toplevel);
    }
}

impl KdeDecorationHandler for Compositor {
    fn kde_decoration_state(&self) -> &KdeDecorationState {
        &self.protocols.kde_decoration
    }

    fn request_mode(&mut self, _: &WlSurface, decoration: &OrgKdeKwinServerDecoration, _: WEnum<KdeMode>) {
        decoration.mode(KdeMode::Client);
    }
}

impl Compositor {
    fn client_side(&self, toplevel: &ToplevelSurface) {
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ClientSide));
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }
}

impl PrimarySelectionHandler for Compositor {
    fn primary_selection_state(&self) -> &PrimarySelectionState {
        &self.protocols.primary_selection
    }
}

impl XdgActivationHandler for Compositor {
    fn activation_state(&mut self) -> &mut XdgActivationState {
        &mut self.protocols.activation
    }

    fn token_created(&mut self, _: XdgActivationToken, data: XdgActivationTokenData) -> bool {
        let Some((serial, _)) = data.serial else { return false };
        self.seat.get_keyboard().and_then(|k| k.last_enter()).is_some_and(|enter| serial.is_no_older_than(&enter))
    }

    fn request_activation(&mut self, _: XdgActivationToken, data: XdgActivationTokenData, surface: WlSurface) {
        if data.timestamp.elapsed().as_secs() >= 10 {
            return;
        }
        let window = self.window_of(&surface);
        if let Some(window) = window {
            self.focus_window(Some(&window));
        }
    }
}

impl FractionalScaleHandler for Compositor {
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        let Some(scale) = self.space.outputs().next().map(|o| o.current_scale().fractional_scale()) else { return };
        with_states(&surface, |states| with_fractional_scale(states, |f| f.set_preferred_scale(scale)));
    }
}

impl PointerConstraintsHandler for Compositor {
    fn new_constraint(&mut self, surface: &WlSurface, pointer: &PointerHandle<Self>) {
        if pointer.current_focus().as_ref() == Some(surface) {
            with_pointer_constraint(surface, pointer, |constraint| {
                if let Some(constraint) = constraint {
                    constraint.activate();
                }
            });
        }
    }

    fn cursor_position_hint(&mut self, surface: &WlSurface, pointer: &PointerHandle<Self>, location: Point<f64, Logical>) {
        let active = with_pointer_constraint(surface, pointer, |c| c.is_some_and(|c| c.is_active()));
        if !active {
            return;
        }
        let origin =
            self.space.elements().find(|w| w.wl_surface().as_deref() == Some(surface)).and_then(|w| self.space.element_location(w)).unwrap_or_default();
        pointer.set_location(origin.to_f64() + location);
    }
}

impl InputMethodHandler for Compositor {
    fn new_popup(&mut self, surface: ImePopup) {
        if let Err(e) = self.popups.track_popup(PopupKind::from(surface)) {
            log::warn!("输入法候选框: {e}");
        }
    }

    fn popup_repositioned(&mut self, _: ImePopup) {}

    fn dismiss_popup(&mut self, surface: ImePopup) {
        if let Some(parent) = surface.get_parent().map(|p| p.surface.clone()) {
            let _ = PopupManager::dismiss_popup(&parent, &PopupKind::from(surface));
        }
    }

    fn parent_geometry(&self, parent: &WlSurface) -> Rectangle<i32, Logical> {
        self.space.elements().find(|w| w.wl_surface().as_deref() == Some(parent)).map(|w| w.geometry()).unwrap_or_default()
    }
}

impl smithay::wayland::tablet_manager::TabletSeatHandler for Compositor {}

impl XdgDialogHandler for Compositor {
    fn modal_changed(&mut self, toplevel: ToplevelSurface, _: bool) {
        self.sync_parent(&toplevel);
    }
}

impl KeyboardShortcutsInhibitHandler for Compositor {
    fn keyboard_shortcuts_inhibit_state(&mut self) -> &mut KeyboardShortcutsInhibitState {
        &mut self.protocols.shortcuts_inhibit
    }

    fn new_inhibitor(&mut self, inhibitor: KeyboardShortcutsInhibitor) {
        inhibitor.activate();
    }
}

impl DrmSyncobjHandler for Compositor {
    fn drm_syncobj_state(&mut self) -> Option<&mut DrmSyncobjState> {
        self.protocols.syncobj.as_mut()
    }
}

delegate_xdg_decoration!(Compositor);
delegate_kde_decoration!(Compositor);
delegate_primary_selection!(Compositor);
delegate_xdg_activation!(Compositor);
delegate_fractional_scale!(Compositor);
delegate_viewporter!(Compositor);
delegate_single_pixel_buffer!(Compositor);
delegate_pointer_constraints!(Compositor);
delegate_relative_pointer!(Compositor);
delegate_pointer_gestures!(Compositor);
delegate_cursor_shape!(Compositor);
delegate_drm_syncobj!(Compositor);
delegate_text_input_manager!(Compositor);
delegate_input_method_manager!(Compositor);
delegate_virtual_keyboard_manager!(Compositor);
delegate_xdg_dialog!(Compositor);
delegate_keyboard_shortcuts_inhibit!(Compositor);
