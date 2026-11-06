use smithay::backend::input::PointerMotionEvent;
use smithay::backend::input::{
    AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event as _, InputBackend, InputEvent, KeyState, KeyboardKeyEvent, PointerAxisEvent,
    PointerButtonEvent,
};
use smithay::input::keyboard::FilterResult;
use smithay::input::pointer::{AxisFrame, ButtonEvent, MotionEvent, PointerHandle, RelativeMotionEvent};
use smithay::utils::{Logical, Point, SERIAL_COUNTER};
use smithay::wayland::pointer_constraints::{PointerConstraint, with_pointer_constraint};

use smithay::input::keyboard::keysyms;

use acde_model::{Binding, Combo, Scope};
use smithay::input::keyboard::{ModifiersState, xkb};

use super::grabs::Lost;
use super::{Compositor, ShellEvent};

enum Key {
    Vt(i32),
    Esc,
    Shortcut(Binding),
    Held,
}

pub enum Injected {
    Move(Point<f64, Logical>),
    Motion(Point<f64, Logical>),
    Button { button: u32, pressed: bool },
    Wheel { delta: Point<f64, Logical>, source: AxisSource },
    Key { code: u32, pressed: bool },
}

pub(super) const WHEEL_STEP: f64 = 15.0;

impl Compositor {
    pub fn on_input<I: InputBackend>(&mut self, event: InputEvent<I>) {
        self.activity();
        match event {
            InputEvent::Keyboard { event } => self.on_key(event.key_code().raw(), event.state(), event.time_msec()),
            InputEvent::PointerMotionAbsolute { event } => {
                let Some(output) = self.space.outputs().next() else { return };
                let Some(geo) = self.space.output_geometry(output) else { return };
                let pos = event.position_transformed(geo.size) + geo.loc.to_f64();
                let delta = pos - self.pointer().current_location();
                self.pointer_moved(pos, delta, delta, event.time(), event.time_msec());
            }
            InputEvent::PointerMotion { event } => {
                let current = self.pointer().current_location();
                let pos = self.clamp_to_outputs(current + event.delta());
                self.pointer_moved(pos, event.delta(), event.delta_unaccel(), event.time(), event.time_msec());
            }
            InputEvent::PointerButton { event } => self.on_button(event.button_code(), event.state(), event.time_msec()),
            InputEvent::PointerAxis { event } => {
                let amount = |axis| event.amount(axis).unwrap_or_else(|| event.amount_v120(axis).unwrap_or(0.0) * WHEEL_STEP / 120.0);
                let (dx, dy) = (amount(Axis::Horizontal), amount(Axis::Vertical));
                let mut frame = AxisFrame::new(event.time_msec()).source(event.source());
                for (axis, value) in [(Axis::Horizontal, dx), (Axis::Vertical, dy)] {
                    if value != 0.0 {
                        frame = frame.value(axis, value);
                        if let Some(v120) = event.amount_v120(axis) {
                            frame = frame.v120(axis, v120 as i32);
                        }
                    } else if event.source() == AxisSource::Finger && event.amount(axis) == Some(0.0) {
                        frame = frame.stop(axis);
                    }
                }
                self.on_axis(frame);
            }
            _ => {}
        }
    }

    pub fn inject(&mut self, event: Injected) {
        self.activity();
        let time = self.start.elapsed().as_millis() as u32;
        match event {
            Injected::Move(pos) => {
                let pos = self.clamp_to_outputs(pos);
                let delta = pos - self.pointer().current_location();
                self.pointer_moved(pos, delta, delta, u64::from(time) * 1000, time);
            }
            Injected::Motion(delta) => {
                let pos = self.clamp_to_outputs(self.pointer().current_location() + delta);
                self.pointer_moved(pos, delta, delta, u64::from(time) * 1000, time);
            }
            Injected::Button { button, pressed } => self.on_button(button, if pressed { ButtonState::Pressed } else { ButtonState::Released }, time),
            Injected::Wheel { delta, source } => {
                let mut frame = AxisFrame::new(time).source(source);
                for (axis, value) in [(Axis::Horizontal, delta.x), (Axis::Vertical, delta.y)] {
                    frame = match (value != 0.0, source) {
                        (true, AxisSource::Wheel) => frame.value(axis, value).v120(axis, (value / WHEEL_STEP * 120.0) as i32),
                        (true, _) => frame.value(axis, value),
                        (false, AxisSource::Finger) if delta == Point::default() => frame.stop(axis),
                        (false, _) => frame,
                    };
                }
                self.on_axis(frame);
            }
            Injected::Key { code, pressed } => self.on_key(code + 8, if pressed { KeyState::Pressed } else { KeyState::Released }, time),
        }
    }

    pub fn pointer(&self) -> PointerHandle<Self> {
        self.seat.get_pointer().expect("seat 有 pointer")
    }

    fn on_button(&mut self, button: u32, state: ButtonState, time: u32) {
        let pointer = self.pointer();
        let pos = pointer.current_location();
        let pressed = state == ButtonState::Pressed;
        let window = self.window_under(pos).map(|(w, _)| w);
        if pressed && super::env::ENV.debug_input {
            let target = window.as_ref().and_then(Self::window_id);
            self.emit(ShellEvent::InputTarget { window: target, x: pos.x, y: pos.y, button });
        }
        let serial = SERIAL_COUNTER.next_serial();
        if pressed && self.grabs.any() && !self.grab_holds(window.as_ref()) {
            self.lose_grabs(Lost::OtherWindow);
        }
        if pressed {
            if pointer.is_grabbed() {
                self.swallowed.insert(button);
            } else {
                self.focus_window(window.as_ref());
                if let Some(w) = window.as_ref() {
                    self.emit(ShellEvent::WindowActivate(Self::window_id(w)));
                    if let Some(edges) = self.grab_hint_at(w, pos) {
                        let start = smithay::input::pointer::GrabStartData { focus: None, button, location: pos };
                        self.start_drag(w, edges, serial, start);
                    }
                }
            }
        } else {
            self.swallowed.remove(&button);
        }
        pointer.button(self, &ButtonEvent { button, state, serial, time });
        pointer.frame(self);
    }

    fn on_axis(&mut self, frame: AxisFrame) {
        let pointer = self.pointer();
        pointer.axis(self, frame);
        pointer.frame(self);
    }

    fn pointer_moved(&mut self, pos: Point<f64, Logical>, delta: Point<f64, Logical>, delta_unaccel: Point<f64, Logical>, utime: u64, time: u32) {
        let under = self.pointer_holder().or_else(|| self.surface_under(pos));
        let pointer = self.pointer();
        pointer.relative_motion(self, under.clone(), &RelativeMotionEvent { delta, delta_unaccel, utime });
        let constraint = under.as_ref().and_then(|(surface, origin)| {
            with_pointer_constraint(surface, &pointer, |c| {
                let c = c?;
                if !c.is_active() {
                    c.activate();
                }
                Some(match &*c {
                    PointerConstraint::Locked(_) => None,
                    PointerConstraint::Confined(_) => Some(surface.clone()),
                })
            })
            .map(|confined| (confined, *origin))
        });
        match constraint {
            Some((None, _)) => {}
            Some((Some(surface), origin)) => {
                let size = smithay::wayland::compositor::with_states(&surface, |s| {
                    s.data_map.get::<smithay::backend::renderer::utils::RendererSurfaceStateUserData>().and_then(|d| d.lock().ok()?.surface_size())
                });
                let pos = size.map_or(pos, |size| {
                    (pos.x.clamp(origin.x, origin.x + f64::from(size.w) - 1.0), pos.y.clamp(origin.y, origin.y + f64::from(size.h) - 1.0)).into()
                });
                let under = Some((surface, origin));
                pointer.motion(self, under, &MotionEvent { location: pos, serial: SERIAL_COUNTER.next_serial(), time });
            }
            None => pointer.motion(self, under, &MotionEvent { location: pos, serial: SERIAL_COUNTER.next_serial(), time }),
        }
        pointer.frame(self);
        self.hover_cursor(pos);
        if matches!(self.backend.target, super::backend::Target::Drm(_)) || self.drag_icon_shown() {
            self.backend.damaged();
        }
    }

    fn clamp_to_outputs(&self, pos: Point<f64, Logical>) -> Point<f64, Logical> {
        let Some(bounds) = self.space.outputs().filter_map(|o| self.space.output_geometry(o)).reduce(|a, b| a.merge(b)) else { return pos };
        let max = (bounds.loc + bounds.size).to_f64();
        (pos.x.clamp(bounds.loc.x.into(), max.x - 1.0), pos.y.clamp(bounds.loc.y.into(), max.y - 1.0)).into()
    }

    fn on_key(&mut self, keycode: u32, state: KeyState, time: u32) {
        let keyboard = self.seat.get_keyboard().expect("seat 有 keyboard");
        let serial = SERIAL_COUNTER.next_serial();
        let focused = keyboard.current_focus().and_then(|s| Self::bound(&s)).map(|g| g.id);
        let inhibited = {
            use smithay::wayland::keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitorSeat;
            self.seat.keyboard_shortcuts_inhibited()
        };
        let grabbed = self.grabs.any();
        let action = keyboard.input::<Key, _>(self, keycode.into(), state, serial, time, |state_, mods, handle| {
            if state == KeyState::Released {
                return match state_.held_keys.remove(&keycode) {
                    true => FilterResult::Intercept(Key::Held),
                    false => FilterResult::Forward,
                };
            }
            let sym = handle.modified_sym().raw();
            if (keysyms::KEY_XF86Switch_VT_1..=keysyms::KEY_XF86Switch_VT_12).contains(&sym) {
                return FilterResult::Intercept(Key::Vt((sym - keysyms::KEY_XF86Switch_VT_1 + 1).try_into().unwrap_or(1)));
            }
            if grabbed && sym == keysyms::KEY_Escape {
                state_.held_keys.insert(keycode);
                return FilterResult::Intercept(Key::Esc);
            }
            let key = handle.raw_latin_sym_or_raw_current_sym().map_or(sym, |k| k.raw());
            match state_.shortcuts.find(Combo { mods: Self::mods(mods), key }, focused).filter(|b| !inhibited || b.scope == Scope::Session) {
                Some(binding) => {
                    state_.held_keys.insert(keycode);
                    FilterResult::Intercept(Key::Shortcut(binding))
                }
                None => FilterResult::Forward,
            }
        });
        match action {
            Some(Key::Vt(vt)) => self.change_vt(vt),
            Some(Key::Esc) => self.lose_grabs(Lost::Esc),
            Some(Key::Shortcut(binding)) => {
                let name = self.shortcut_names.get(&binding.combo).cloned();
                self.emit(ShellEvent::Shortcut { owner: binding.owner, key: name, scope: binding.scope });
            }
            Some(Key::Held) | None => {}
        }
    }

    fn mods(m: &ModifiersState) -> u8 {
        [(m.ctrl, Combo::CTRL), (m.alt, Combo::ALT), (m.shift, Combo::SHIFT), (m.logo, Combo::SUPER)]
            .into_iter()
            .filter(|(on, _)| *on)
            .fold(0, |a, (_, bit)| a | bit)
    }

    fn combo(text: &str) -> Result<Combo, String> {
        Combo::parse(text, |name| Some(xkb::keysym_from_name(name, xkb::KEYSYM_CASE_INSENSITIVE).raw()).filter(|k| *k != 0))
    }

    pub fn register_shortcut(&mut self, text: &str, scope: Scope, owner: u32) -> Result<(), String> {
        let combo = Self::combo(text)?;
        self.shortcuts.register(Binding { combo, scope, owner }).map_err(|e| format!("{text}: {e}"))?;
        self.shortcut_names.insert(combo, text.to_owned());
        Ok(())
    }

    pub fn unregister_shortcut(&mut self, text: &str, scope: Scope, owner: u32) {
        if let Ok(combo) = Self::combo(text) {
            self.shortcuts.unregister(combo, scope, owner);
        }
    }
}
