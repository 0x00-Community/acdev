use std::collections::HashMap;

use smithay::backend::renderer::element::Kind;
use smithay::backend::renderer::element::surface::render_elements_from_surface_tree;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::delegate_session_lock;
use smithay::output::Output;
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::reexports::wayland_server::protocol::wl_output::WlOutput;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::wayland::session_lock::{LockSurface, SessionLockHandler, SessionLockManagerState, SessionLocker};

use super::Compositor;
use super::backend::Elements;

pub struct Lock {
    state: SessionLockManagerState,
    pub surfaces: Option<HashMap<String, LockSurface>>,
}

impl Lock {
    pub fn new(dh: &DisplayHandle) -> Self {
        Self { state: SessionLockManagerState::new::<Compositor, _>(dh, |_| true), surfaces: None }
    }

    pub fn locked(&self) -> bool {
        self.surfaces.is_some()
    }

    pub fn elements(&self, renderer: &mut GlesRenderer, output: &Output) -> Option<Vec<Elements>> {
        let surfaces = self.surfaces.as_ref()?;
        Some(surfaces.get(&output.name()).map_or_else(Vec::new, |surface| {
            render_elements_from_surface_tree(renderer, surface.wl_surface(), (0, 0), output.current_scale().fractional_scale(), 1.0, Kind::Unspecified)
                .into_iter()
                .map(Elements::Surface)
                .collect()
        }))
    }

    pub fn focus(&self, output: &Output) -> Option<WlSurface> {
        self.surfaces.as_ref()?.get(&output.name()).map(|s| s.wl_surface().clone())
    }
}

impl SessionLockHandler for Compositor {
    fn lock_state(&mut self) -> &mut SessionLockManagerState {
        &mut self.lock.state
    }

    fn lock(&mut self, confirmation: SessionLocker) {
        self.focus_window(None);
        self.lock.surfaces = Some(HashMap::new());
        self.backend.damaged();
        confirmation.lock();
    }

    fn unlock(&mut self) {
        self.lock.surfaces = None;
        self.backend.damaged();
    }

    fn new_surface(&mut self, surface: LockSurface, wl_output: WlOutput) {
        let Some(output) = Output::from_resource(&wl_output) else { return };
        let Some(geometry) = self.space.output_geometry(&output) else { return };
        surface.with_pending_state(|state| {
            state.size = Some((u32::try_from(geometry.size.w).unwrap_or(0), u32::try_from(geometry.size.h).unwrap_or(0)).into());
        });
        surface.send_configure();
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, Some(surface.wl_surface().clone()), smithay::utils::SERIAL_COUNTER.next_serial());
        }
        if let Some(surfaces) = self.lock.surfaces.as_mut() {
            surfaces.insert(output.name(), surface);
        }
        self.backend.damaged();
    }
}

delegate_session_lock!(Compositor);
