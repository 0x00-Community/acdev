use smithay::desktop::{LayerSurface, WindowSurfaceType, layer_map_for_output};
use smithay::output::Output;
use smithay::reexports::calloop::LoopHandle;
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::reexports::wayland_server::protocol::{wl_output, wl_surface::WlSurface};
use smithay::wayland::compositor::with_states;
use smithay::wayland::idle_inhibit::{IdleInhibitHandler, IdleInhibitManagerState};
use smithay::wayland::idle_notify::{IdleNotifierHandler, IdleNotifierState};
use smithay::wayland::shell::wlr_layer::{Layer, LayerSurface as WlrLayerSurface, LayerSurfaceData, WlrLayerShellHandler, WlrLayerShellState};
use smithay::{delegate_idle_inhibit, delegate_idle_notify, delegate_layer_shell};

use super::Compositor;

pub struct Layers {
    pub layer_shell: WlrLayerShellState,
    pub idle: IdleNotifierState<Compositor>,
    _inhibit: IdleInhibitManagerState,
}

impl Layers {
    pub fn new(dh: &DisplayHandle, lh: LoopHandle<'static, Compositor>) -> Self {
        Self {
            layer_shell: WlrLayerShellState::new::<Compositor>(dh),
            idle: IdleNotifierState::new(dh, lh),
            _inhibit: IdleInhibitManagerState::new::<Compositor>(dh),
        }
    }
}

impl WlrLayerShellHandler for Compositor {
    fn shell_state(&mut self) -> &mut WlrLayerShellState {
        &mut self.layers.layer_shell
    }

    fn new_layer_surface(&mut self, surface: WlrLayerSurface, wl_output: Option<wl_output::WlOutput>, _: Layer, namespace: String) {
        let output = wl_output.as_ref().and_then(Output::from_resource).unwrap_or_else(|| self.backend.output.clone());
        let wl = surface.wl_surface().clone();
        let mapped = {
            let mut map = layer_map_for_output(&output);
            map.map_layer(&LayerSurface::new(surface, namespace))
        };
        match mapped {
            Ok(()) => self.extra_enter(&wl, smithay::utils::Rectangle::default(), None),
            Err(e) => log::warn!("layer surface: {e}"),
        }
    }

    fn layer_destroyed(&mut self, surface: WlrLayerSurface) {
        self.extra_leave(surface.wl_surface());
        for output in self.space.outputs() {
            let mut map = layer_map_for_output(output);
            let layer = map.layers().find(|l| l.layer_surface() == &surface).cloned();
            if let Some(layer) = layer {
                map.unmap_layer(&layer);
            }
        }
        self.backend.damaged();
    }
}

impl Compositor {
    pub fn commit_layer(&mut self, surface: &WlSurface) {
        let Some(output) = self.space.outputs().find(|o| layer_map_for_output(o).layer_for_surface(surface, WindowSurfaceType::TOPLEVEL).is_some()).cloned() else {
            return;
        };
        let geometry = {
            let mut map = layer_map_for_output(&output);
            map.arrange();
            map.layer_for_surface(surface, WindowSurfaceType::TOPLEVEL).and_then(|l| map.layer_geometry(l))
        };
        if let Some(geometry) = geometry {
            self.extra_place(surface, geometry);
        }
        let map = layer_map_for_output(&output);
        let sent = with_states(surface, |states| states.data_map.get::<LayerSurfaceData>().is_some_and(|d| d.lock().expect("layer 数据锁").initial_configure_sent));
        if !sent && let Some(layer) = map.layer_for_surface(surface, WindowSurfaceType::TOPLEVEL) {
            layer.layer_surface().send_configure();
        }
    }

    pub fn activity(&mut self) {
        self.layers.idle.notify_activity(&self.seat);
    }
}

impl IdleNotifierHandler for Compositor {
    fn idle_notifier_state(&mut self) -> &mut IdleNotifierState<Self> {
        &mut self.layers.idle
    }
}

impl IdleInhibitHandler for Compositor {
    fn inhibit(&mut self, _: WlSurface) {
        self.layers.idle.set_is_inhibited(true);
    }

    fn uninhibit(&mut self, _: WlSurface) {
        self.layers.idle.set_is_inhibited(false);
    }
}

delegate_layer_shell!(Compositor);
delegate_idle_notify!(Compositor);
delegate_idle_inhibit!(Compositor);
