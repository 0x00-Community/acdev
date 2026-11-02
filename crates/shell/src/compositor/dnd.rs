use smithay::backend::renderer::element::Kind;
use smithay::backend::renderer::element::surface::render_elements_from_surface_tree;
use smithay::input::Seat;
use smithay::reexports::wayland_server::protocol::wl_data_source::WlDataSource;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Point};
use smithay::wayland::compositor::{SurfaceAttributes, with_states};
use smithay::wayland::selection::data_device::{ClientDndGrabHandler, ServerDndGrabHandler};

use super::Compositor;
use super::backend::Elements;

pub struct Drag {
    icon: Option<(WlSurface, Point<i32, Logical>)>,
}

impl ClientDndGrabHandler for Compositor {
    fn started(&mut self, _: Option<WlDataSource>, icon: Option<WlSurface>, _: Seat<Self>) {
        self.drag = Some(Drag { icon: icon.map(|s| (s, Point::default())) });
    }

    fn dropped(&mut self, _: Option<WlSurface>, _: bool, _: Seat<Self>) {
        self.drag = None;
        self.backend.damaged();
    }
}

impl ServerDndGrabHandler for Compositor {}

impl Compositor {
    pub fn drag_icon_committed(&mut self, surface: &WlSurface) {
        let Some((icon, offset)) = self.drag.as_mut().and_then(|d| d.icon.as_mut()).filter(|(icon, _)| icon == surface) else { return };
        let delta = with_states(icon, |states| states.cached_state.get::<SurfaceAttributes>().current().buffer_delta.take());
        *offset += delta.unwrap_or_default();
    }

    pub fn drag_icon(&self) -> Option<WlSurface> {
        self.drag.as_ref().and_then(|d| d.icon.as_ref()).map(|(icon, _)| icon.clone())
    }

    pub fn drag_icon_shown(&self) -> bool {
        self.drag.as_ref().is_some_and(|d| d.icon.is_some())
    }

    pub fn screen_elements(&mut self, output: &smithay::output::Output, cursor: bool) -> Vec<Elements> {
        let origin = self.space.output_geometry(output).map(|g| g.loc.to_f64()).unwrap_or_default();
        let scale = output.current_scale().fractional_scale();
        let mut elements = match cursor {
            true => {
                let pointer = self.seat.get_pointer().map(|p| p.current_location()).unwrap_or_default();
                self.cursor.elements(&mut self.backend.renderer, pointer - origin, scale)
            }
            false => Vec::new(),
        };
        elements.extend(self.drag_icon_elements(origin, scale));
        match self.lock.elements(&mut self.backend.renderer, output) {
            Some(locked) => elements.extend(locked),
            None => elements.extend(self.output_elements(output)),
        }
        elements
    }

    fn drag_icon_elements(&mut self, origin: Point<f64, Logical>, scale: f64) -> Vec<Elements> {
        let pointer = self.seat.get_pointer().map(|p| p.current_location()).unwrap_or_default();
        let Some((icon, offset)) = self.drag.as_ref().and_then(|d| d.icon.as_ref()) else { return Vec::new() };
        let at = (pointer - origin + offset.to_f64()).to_physical(scale).to_i32_round();
        render_elements_from_surface_tree(&mut self.backend.renderer, icon, at, scale, 1.0, Kind::Unspecified).into_iter().map(Elements::Surface).collect()
    }
}
