use std::collections::HashMap;

use acde_model::{CompositePlan, Easing, Effect, Input, Look, Rect, Route, Transition, WindowId as Managed};
use smithay::backend::renderer::element::{Element, Id, RenderElement};
use smithay::backend::renderer::utils::CommitCounter;
use smithay::desktop::Window;
use smithay::wayland::compositor::with_states;

use super::acde_window::Hints;
use super::backend::Elements;
use super::effects::Backdrop;
use super::{Compositor, Event};

#[derive(Clone, Copy, Debug, Default)]
pub struct Animate {
    pub opacity: Option<f64>,
    pub scale: Option<f64>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub duration_ms: f64,
    pub delay_ms: f64,
    pub easing: Option<Easing>,
}

#[derive(Default)]
#[allow(clippy::mutable_key_type)]
pub struct Motion {
    looks: HashMap<Managed, Look>,
    transitions: HashMap<Managed, (Transition, u32)>,
    shown: HashMap<Managed, (Rect, Look, Rect)>,
    seen: HashMap<Id, CommitCounter>,
    order: Vec<Managed>,
    pub plans: u32,
    pub direct: u32,
}

impl Motion {
    pub fn active(&self) -> bool {
        !self.transitions.is_empty()
    }

    pub fn look(&self, managed: Managed) -> Look {
        self.looks.get(&managed).copied().unwrap_or_default()
    }

    pub fn forget(&mut self, managed: Managed) {
        self.looks.remove(&managed);
        self.transitions.remove(&managed);
    }
}

pub struct Shown {
    pub window: Window,
    pub managed: Option<Managed>,
    pub native: Option<u32>,
    pub elements: Vec<Elements>,
}

impl Compositor {
    fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }

    pub fn animate(&mut self, window: u32, spec: Animate) {
        let Some(managed) = self.native_ids.get(&window).or_else(|| self.extras.get(&window)).copied() else { return };
        let from = self.motion.look(managed);
        let to = Look {
            opacity: spec.opacity.map_or(from.opacity, |o| o.clamp(0.0, 1.0) as f32),
            scale: spec.scale.map_or(from.scale, |s| s.max(0.0)),
            dx: spec.dx.unwrap_or(from.dx),
            dy: spec.dy.unwrap_or(from.dy),
        };
        let transition = Transition { from, to, start_ms: self.now_ms() + spec.delay_ms.max(0.0), duration_ms: spec.duration_ms.max(0.0), easing: spec.easing.unwrap_or(Easing::Ease) };
        self.motion.transitions.insert(managed, (transition, window));
        self.backend.damaged();
    }

    pub fn advance_motion(&mut self) {
        let now = self.now_ms();
        let mut done = Vec::new();
        for (managed, (transition, native)) in &self.motion.transitions {
            let (look, finished) = transition.at(now);
            self.motion.looks.insert(*managed, look);
            if finished {
                done.push((*managed, *native));
            }
        }
        for (managed, native) in done {
            self.motion.transitions.remove(&managed);
            if self.motion.looks.get(&managed).is_some_and(|l| *l == Look::default()) {
                self.motion.looks.remove(&managed);
            }
            self.emit(Event { kind: "windowanimated".into(), window: Some(native), ..Default::default() });
        }
    }

    pub fn backdrop_of(window: &Window) -> Option<([i32; 4], [f64; 4])> {
        let surface = window.toplevel()?.wl_surface().clone();
        with_states(&surface, |s| s.data_map.get::<std::sync::Mutex<Hints>>()?.lock().ok()?.backdrop)
    }

    #[allow(clippy::mutable_key_type)]
    pub fn plan(&mut self, shown: &[Shown], scale: f64) -> CompositePlan {
        let mut inputs = Vec::new();
        let mut seen = HashMap::new();
        for s in shown.iter().rev() {
            let Some(managed) = s.managed else { continue };
            let Some(window) = self.table.window(managed) else { continue };
            let at = window.rect.scale(scale);
            let look = self.motion.look(managed);
            let mut input = Input { window: managed, look, ..Default::default() };
            for element in &s.elements {
                let geometry = element.geometry(scale.into());
                let local = |r: smithay::utils::Rectangle<i32, smithay::utils::Physical>| {
                    Rect::new(f64::from(geometry.loc.x + r.loc.x) - at.x, f64::from(geometry.loc.y + r.loc.y) - at.y, f64::from(r.size.w), f64::from(r.size.h))
                };
                let since = self.motion.seen.get(element.id()).copied();
                seen.insert(element.id().clone(), element.current_commit());
                match look.is_identity() {
                    true => {
                        input.damage.extend(element.damage_since(scale.into(), since).iter().copied().map(local));
                        input.opaque.extend(element.opaque_regions(scale.into()).iter().copied().map(local));
                    }
                    false if since != Some(element.current_commit()) => input.damage.push(Rect::new(0.0, 0.0, at.w, at.h)),
                    false => {}
                }
            }
            input.direct_buffer = s.elements.len() == 1 && s.elements.iter().all(|e| e.underlying_storage(&mut self.backend.renderer).is_some());
            if let Some(([x, y, w, h], [radius, blur, saturate, brightness])) = Self::backdrop_of(&s.window) {
                input.backdrop = Some(Effect::Backdrop {
                    rect: Rect::new(x.into(), y.into(), w.into(), h.into()),
                    radius: radius as f32,
                    blur: blur as f32,
                    saturate: saturate as f32,
                    brightness: brightness as f32,
                });
            }
            if let Some((rect, before, _)) = self.motion.shown.get(&managed) {
                input.moved_from = Some(*rect);
                input.changed_look = Some(*before);
            }
            inputs.push(input);
        }
        let order: Vec<Managed> = inputs.iter().map(|i| i.window).collect();
        let before: Vec<Managed> = self.motion.order.iter().filter(|m| order.contains(m)).copied().collect();
        let now: Vec<Managed> = order.iter().filter(|m| before.contains(m)).copied().collect();
        for input in &mut inputs {
            input.restacked = before.iter().position(|m| *m == input.window) != now.iter().position(|m| *m == input.window);
        }
        self.motion.order = order;
        let gone: Vec<Rect> = self.motion.shown.iter().filter(|(m, _)| !inputs.iter().any(|i| i.window == **m)).map(|(_, (_, _, clip))| *clip).collect();
        let plan = CompositePlan::build(&self.table, &inputs, &gone);
        self.motion.seen = seen;
        self.motion.shown = inputs
            .iter()
            .filter_map(|i| Some((i.window, (self.table.window(i.window)?.rect, i.look, plan.layer(i.window).map_or(Rect::default(), |l| l.clip)))))
            .collect();
        self.motion.plans += 1;
        self.motion.direct += u32::from(plan.route == Route::Direct);
        log::debug!(target: "perf::compose", "plan inputs={} layers={} damage={} route={:?}", inputs.len(), plan.layers.len(), plan.damage.len(), plan.route);
        plan
    }

    pub fn backdrop_element(&mut self, plan: &CompositePlan, managed: Managed, native: u32, below: &[Elements], scale: f64) -> Option<Elements> {
        let layer = plan.layer(managed)?;
        let Some(Effect::Backdrop { rect, radius, blur, saturate, brightness }) = layer.effect else { return None };
        let r = rect.round_out();
        let screen = self.backend.output.current_mode().map(|m| m.size)?;
        let rect = smithay::utils::Rectangle::new((r.x as i32, r.y as i32).into(), (r.w as i32, r.h as i32).into());
        let backdrop = Backdrop { rect, radius: radius * layer.look.scale as f32, blur, saturate, brightness, screen, scale };
        let element = self.effects.backdrop(&mut self.backend.renderer, native, backdrop, below, layer.redraw)?;
        Some(Elements::Backdrop(element))
    }
}
