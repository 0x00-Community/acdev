use acde_model::Look;
use smithay::backend::renderer::element::surface::render_elements_from_surface_tree;
use smithay::backend::renderer::element::utils::{Relocate, RelocateRenderElement, RescaleRenderElement};
use smithay::backend::renderer::element::{AsRenderElements, Kind};
use smithay::desktop::{PopupManager, Window, layer_map_for_output};
use smithay::output::Output;
use smithay::utils::{Logical, Point, Rectangle};
use smithay::wayland::shell::wlr_layer::Layer;

use super::Compositor;
use super::backend::Elements;
use super::composite::Shown;

impl Compositor {
    pub fn output_elements(&mut self, output: &Output) -> Vec<Elements> {
        let Some(geometry) = self.space.output_geometry(output) else { return Vec::new() };
        let scale = output.current_scale().fractional_scale();
        self.advance_motion();
        let mut elements = self.layer_elements(output, &[Layer::Overlay, Layer::Top]);
        let windows = self.stack();
        for window in &windows {
            let Some(location) = self.space.element_location(window).map(|l| l - window.geometry().loc - geometry.loc) else { continue };
            elements.extend(self.popup_elements(window, location, scale));
        }
        let shown: Vec<Shown> = windows
            .iter()
            .map(|window| {
                let native = Self::window_id(window);
                let managed = native.and_then(|id| self.managed(id));
                let look = managed.map(|m| self.motion.look(m)).unwrap_or_default();
                let elements = self.native_elements(window, geometry, scale, look);
                Shown { window: window.clone(), managed, native, elements }
            })
            .collect();
        let plan = (*output == self.backend.output).then(|| self.plan(&shown, scale));
        let mut backdrops = Vec::new();
        for s in shown {
            let layer = plan.as_ref().zip(s.managed).map(|(p, m)| p.layer(m).is_some());
            if layer == Some(false) {
                continue;
            }
            elements.extend(s.elements);
            if let (Some(managed), Some(native)) = (s.managed, s.native) {
                backdrops.push((elements.len(), managed, native));
            }
        }
        elements.extend(self.layer_elements(output, &[Layer::Bottom, Layer::Background]));
        if let Some(plan) = plan {
            for (at, managed, native) in backdrops.into_iter().rev() {
                if let Some(backdrop) = self.backdrop_element(&plan, managed, native, &elements[at..], scale) {
                    elements.insert(at, backdrop);
                }
            }
            let live: Vec<u32> = plan.layers.iter().filter(|l| l.effect.is_some()).filter_map(|l| self.native_of(l.window)).collect();
            self.effects.retain(|id| live.contains(&id));
        }
        elements
    }

    pub fn stack(&self) -> Vec<Window> {
        let z = |w: &Window| {
            let managed = self.managed_of(w)?;
            self.table.canvas(self.canvas?)?.z.iter().position(|x| *x == managed)
        };
        let mut windows: Vec<(Option<usize>, usize, Window)> = self
            .space
            .elements()
            .rev()
            .filter(|w| Self::window_id(w).is_none_or(|id| !self.hidden.contains(&id)))
            .enumerate()
            .map(|(i, w)| (z(w), i, w.clone()))
            .collect();
        windows.sort_by_key(|(z, i, _)| (std::cmp::Reverse(z.map_or(-1, |z| z as i64)), *i));
        windows.into_iter().map(|(_, _, w)| w).collect()
    }

    pub fn native_elements(&mut self, window: &Window, geometry: Rectangle<i32, Logical>, scale: f64, look: Look) -> Vec<Elements> {
        let Some(location) = self.space.element_location(window).map(|l| l - window.geometry().loc - geometry.loc) else { return Vec::new() };
        let at = location.to_physical_precise_round(scale);
        let Some(toplevel) = window.toplevel() else {
            return AsRenderElements::render_elements::<Elements>(window, &mut self.backend.renderer, at, scale.into(), look.opacity);
        };
        let surfaces = render_elements_from_surface_tree(&mut self.backend.renderer, toplevel.wl_surface(), at, scale, look.opacity, Kind::Unspecified);
        if look.is_identity() {
            return surfaces.into_iter().map(Elements::Surface).collect();
        }
        let box_ =
            Rectangle::new(self.space.element_location(window).unwrap_or_default() - geometry.loc, window.geometry().size).to_physical_precise_round(scale);
        let center = box_.loc + Point::from((box_.size.w / 2, box_.size.h / 2));
        let shift = Point::from(((look.dx * scale).round() as i32, (look.dy * scale).round() as i32));
        surfaces
            .into_iter()
            .map(|e| Elements::Moved(RelocateRenderElement::from_element(RescaleRenderElement::from_element(e, center, look.scale), shift, Relocate::Relative)))
            .collect()
    }

    fn popup_elements(&mut self, window: &Window, location: Point<i32, Logical>, scale: f64) -> Vec<Elements> {
        let at = location.to_physical_precise_round(scale);
        match window.toplevel() {
            Some(toplevel) => PopupManager::popups_for_surface(toplevel.wl_surface())
                .flat_map(|(popup, offset)| {
                    let at = at + (window.geometry().loc + offset - popup.geometry().loc).to_physical_precise_round(scale);
                    render_elements_from_surface_tree(&mut self.backend.renderer, popup.wl_surface(), at, scale, 1.0, Kind::Unspecified)
                })
                .map(Elements::Surface)
                .collect(),
            None => Vec::new(),
        }
    }

    fn layer_elements(&mut self, output: &Output, layers: &[Layer]) -> Vec<Elements> {
        let scale = output.current_scale().fractional_scale();
        let map = layer_map_for_output(output);
        let mut elements = Vec::new();
        for layer in layers {
            for surface in map.layers_on(*layer).rev() {
                let Some(at) = map.layer_geometry(surface).map(|g| g.loc.to_physical_precise_round(scale)) else { continue };
                elements.extend(AsRenderElements::render_elements::<Elements>(surface, &mut self.backend.renderer, at, scale.into(), 1.0));
            }
        }
        elements
    }

    pub fn window_under(&self, pos: Point<f64, Logical>) -> Option<(Window, Point<i32, Logical>)> {
        self.stack().into_iter().find_map(|w| {
            let location = self.space.element_location(&w)?;
            let look = self.managed_of(&w).map(|m| self.motion.look(m)).unwrap_or_default();
            let at = acde_model::Rect::new(location.x.into(), location.y.into(), w.geometry().size.w.into(), w.geometry().size.h.into());
            let seen = pos;
            let pos: Point<f64, Logical> = look.unmap(&at, 1.0, pos.x, pos.y).into();
            let shift = (seen - pos).to_i32_round();
            let geometry = Rectangle::new(location, w.geometry().size).to_f64();
            let render_location = location - w.geometry().loc;
            let hit = w.surface_under(pos - render_location.to_f64(), smithay::desktop::WindowSurfaceType::ALL)?;
            let popup = w.toplevel().map_or(Self::window_id(&w).is_none(), |t| hit.0 != *t.wl_surface());
            (geometry.contains(pos) || popup).then_some((w, render_location + shift))
        })
    }
}
