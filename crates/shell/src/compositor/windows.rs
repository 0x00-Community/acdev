use std::cell::Cell;

use smithay::desktop::Window;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Size};
use smithay::wayland::compositor::with_states;
use smithay::wayland::shell::xdg::{SurfaceCachedState, ToplevelSurface, XdgToplevelSurfaceData};

use super::{Compositor, ShellEvent};

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

    pub fn sync_parent(&mut self, surface: &ToplevelSurface) {
        if let Some(window) = self.window_of(surface.wl_surface()) {
            self.sync_window_parent(&window);
        }
    }

    pub fn sync_window_parent(&mut self, window: &Window) {
        let Some(surface) = window.toplevel().cloned() else { return };
        let Some(managed) = self.managed_of(window) else { return };
        let granted = Self::bound(surface.wl_surface()).filter(|g| g.parent.is_some());
        let parent = match surface.parent() {
            Some(p) => self.window_of(&p).and_then(|p| self.managed_of(&p)),
            None => granted.and_then(|g| self.managed(g.parent?)),
        };
        let modal =
            with_states(surface.wl_surface(), |s| s.data_map.get::<XdgToplevelSurfaceData>().and_then(|d| d.lock().ok().map(|d| d.modal)).unwrap_or(false))
                || (surface.parent().is_none() && granted.is_some_and(|g| g.modal));
        if self.table.set_parent(managed, parent, modal).is_err() {
            return;
        }
        let focused = self.seat.get_keyboard().and_then(|k| k.current_focus());
        let parent_focused =
            parent.and_then(|p| self.window(p.0)).and_then(|p| p.toplevel().map(|t| t.wl_surface().clone())).is_some_and(|p| Some(p) == focused);
        if modal && parent_focused {
            self.focus_window(Some(window));
        }
    }

    pub fn modal_target(&self, window: &Window) -> Option<Window> {
        let managed = self.managed_of(window)?;
        self.window(self.table.modal_child(managed)?.0)
    }

    pub fn raise_children(&mut self, window: &Window) {
        let Some(managed) = self.managed_of(window) else { return };
        for child in self.table.descendants(managed) {
            if let Some(child) = self.window(child.0) {
                self.space.raise_element(&child, false);
            }
        }
    }

    pub fn parent_window(&self, window: &Window) -> Option<Window> {
        let parent = self.table.window(self.managed_of(window)?)?.parent?;
        self.window(parent.0)
    }

    fn min_size_changed(&mut self, window: &Window, size: Size<i32, Logical>) {
        let last = window.user_data().get_or_insert(|| MinSize(Cell::new(Size::default())));
        if last.0.replace(size) == size || (size.w <= 0 && size.h <= 0) {
            return;
        }
        self.emit(ShellEvent::WindowMinSize { window: Self::window_id(window), width: size.w, height: size.h });
    }

    fn emit_parent(&mut self, window: &Window, parent: Option<&Window>) {
        let Some(id) = Self::window_id(window) else { return };
        let parent = parent.and_then(Self::window_id);
        if parent.is_none() && window.user_data().get::<HadParent>().is_none() {
            return;
        }
        window.user_data().insert_if_missing(|| HadParent);
        self.emit(ShellEvent::WindowParent { window: id, parent });
    }
}

struct HadParent;
