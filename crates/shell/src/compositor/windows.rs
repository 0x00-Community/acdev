use std::cell::Cell;

use smithay::desktop::Window;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Size};
use smithay::wayland::compositor::with_states;
use smithay::wayland::shell::xdg::{SurfaceCachedState, ToplevelSurface, XdgToplevelSurfaceData};

use super::{Compositor, Event};

struct MinSize(Cell<Size<i32, Logical>>);

impl Compositor {
    pub fn toplevel_committed(&mut self, window: &Window, surface: &WlSurface) {
        if window.toplevel().is_none() {
            return;
        }
        let size = with_states(surface, |states| states.cached_state.get::<SurfaceCachedState>().current().min_size);
        self.min_size_changed(window, size);
    }

    pub fn toplevel_parent_changed(&mut self, surface: &ToplevelSurface) {
        let Some(window) = self.window_of(surface.wl_surface()) else { return };
        let parent = surface.parent().and_then(|p| self.window_of(&p));
        self.emit_parent(&window, parent.as_ref());
        self.sync_parent(surface);
    }

    fn managed_of(&self, window: &Window) -> Option<acde_model::WindowId> {
        Self::window_id(window).and_then(|id| self.native_ids.get(&id)).copied()
    }

    fn window_of_managed(&self, managed: acde_model::WindowId) -> Option<Window> {
        self.native_ids.iter().find(|(_, m)| **m == managed).and_then(|(id, _)| self.window(*id))
    }

    pub fn sync_parent(&mut self, surface: &ToplevelSurface) {
        if let Some(window) = self.window_of(surface.wl_surface()) {
            self.sync_window_parent(&window);
        }
    }

    pub fn sync_window_parent(&mut self, window: &Window) {
        let Some(surface) = window.toplevel().cloned() else { return };
        let Some(managed) = self.managed_of(window) else { return };
        let parent = surface.parent().and_then(|p| self.window_of(&p)).and_then(|p| self.managed_of(&p));
        let modal = with_states(surface.wl_surface(), |s| s.data_map.get::<XdgToplevelSurfaceData>().and_then(|d| d.lock().ok().map(|d| d.modal)).unwrap_or(false));
        if self.table.set_parent(managed, parent, modal).is_err() {
            return;
        }
        let focused = self.seat.get_keyboard().and_then(|k| k.current_focus());
        let parent_focused = parent.and_then(|p| self.window_of_managed(p)).and_then(|p| p.toplevel().map(|t| t.wl_surface().clone())).is_some_and(|p| Some(p) == focused);
        if modal && parent_focused {
            self.focus_window(Some(window));
        }
    }

    pub fn modal_target(&self, window: &Window) -> Option<Window> {
        let managed = self.managed_of(window)?;
        self.window_of_managed(self.table.modal_child(managed)?)
    }

    pub fn parent_window(&self, window: &Window) -> Option<Window> {
        let parent = self.table.window(self.managed_of(window)?)?.parent?;
        self.window_of_managed(parent)
    }

    fn min_size_changed(&mut self, window: &Window, size: Size<i32, Logical>) {
        let last = window.user_data().get_or_insert(|| MinSize(Cell::new(Size::default())));
        if last.0.replace(size) == size || (size.w <= 0 && size.h <= 0) {
            return;
        }
        let event = Event { kind: "windowminsize".into(), window: Self::window_id(window), width: Some(size.w.into()), height: Some(size.h.into()), ..Default::default() };
        self.emit(event);
    }

    fn emit_parent(&mut self, window: &Window, parent: Option<&Window>) {
        let Some(id) = Self::window_id(window) else { return };
        let parent = parent.and_then(Self::window_id);
        if parent.is_none() && window.user_data().get::<HadParent>().is_none() {
            return;
        }
        window.user_data().insert_if_missing(|| HadParent);
        self.emit(Event { kind: "windowparent".into(), window: Some(id), parent, ..Default::default() });
    }
}

struct HadParent;
