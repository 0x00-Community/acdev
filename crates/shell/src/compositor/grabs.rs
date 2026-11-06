use smithay::desktop::Window;
use smithay::input::pointer::{
    AxisFrame, ButtonEvent, Focus, GestureHoldBeginEvent, GestureHoldEndEvent, GesturePinchBeginEvent, GesturePinchEndEvent, GesturePinchUpdateEvent,
    GestureSwipeBeginEvent, GestureSwipeEndEvent, GestureSwipeUpdateEvent, GrabStartData, MotionEvent, PointerGrab, PointerInnerHandle, RelativeMotionEvent,
};
use smithay::reexports::wayland_server::Resource;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Point, Rectangle, Serial};

use super::Compositor;
use super::acde_window::{AcdeWindow, WireGrab, WireLost};

pub(super) const TOP: u32 = 1;
pub(super) const BOTTOM: u32 = 2;
pub(super) const LEFT: u32 = 4;
pub(super) const RIGHT: u32 = 8;
const MIN: (i32, i32) = (96, 64);

pub struct Drag {
    start: GrabStartData<Compositor>,
    window: Window,
    initial: Rectangle<i32, Logical>,
    edges: u32,
}

impl Drag {
    fn target(&self, delta: Point<i32, Logical>) -> Rectangle<i32, Logical> {
        let mut r = self.initial;
        if self.edges == 0 {
            r.loc += delta;
            return r;
        }
        if self.edges & LEFT != 0 {
            let dx = delta.x.min(r.size.w - MIN.0);
            r.loc.x += dx;
            r.size.w -= dx;
        }
        if self.edges & RIGHT != 0 {
            r.size.w = (r.size.w + delta.x).max(MIN.0);
        }
        if self.edges & TOP != 0 {
            let dy = delta.y.min(r.size.h - MIN.1);
            r.loc.y += dy;
            r.size.h -= dy;
        }
        if self.edges & BOTTOM != 0 {
            r.size.h = (r.size.h + delta.y).max(MIN.1);
        }
        r
    }
}

macro_rules! forward {
    ($($f:ident $event:ty;)*) => {$(
        fn $f(&mut self, data: &mut Compositor, handle: &mut PointerInnerHandle<'_, Compositor>, event: &$event) {
            handle.$f(data, event);
        }
    )*};
}

impl PointerGrab<Compositor> for Drag {
    fn motion(
        &mut self,
        data: &mut Compositor,
        handle: &mut PointerInnerHandle<'_, Compositor>,
        _: Option<(WlSurface, Point<f64, Logical>)>,
        event: &MotionEvent,
    ) {
        handle.motion(data, None, event);
        let delta = (event.location - self.start.location).to_i32_round();
        let rect = self.target(delta);
        data.place(&self.window, rect);
    }

    fn relative_motion(
        &mut self,
        data: &mut Compositor,
        handle: &mut PointerInnerHandle<'_, Compositor>,
        _: Option<(WlSurface, Point<f64, Logical>)>,
        event: &RelativeMotionEvent,
    ) {
        handle.relative_motion(data, None, event);
    }

    fn button(&mut self, data: &mut Compositor, handle: &mut PointerInnerHandle<'_, Compositor>, event: &ButtonEvent) {
        handle.button(data, event);
        if handle.current_pressed().is_empty() {
            handle.unset_grab(self, data, event.serial, event.time, true);
        }
    }

    fn axis(&mut self, data: &mut Compositor, handle: &mut PointerInnerHandle<'_, Compositor>, details: AxisFrame) {
        handle.axis(data, details);
    }

    fn frame(&mut self, data: &mut Compositor, handle: &mut PointerInnerHandle<'_, Compositor>) {
        handle.frame(data);
    }

    forward! {
        gesture_swipe_begin GestureSwipeBeginEvent; gesture_swipe_update GestureSwipeUpdateEvent; gesture_swipe_end GestureSwipeEndEvent;
        gesture_pinch_begin GesturePinchBeginEvent; gesture_pinch_update GesturePinchUpdateEvent; gesture_pinch_end GesturePinchEndEvent;
        gesture_hold_begin GestureHoldBeginEvent; gesture_hold_end GestureHoldEndEvent;
    }

    fn start_data(&self) -> &GrabStartData<Compositor> {
        &self.start
    }

    fn unset(&mut self, data: &mut Compositor) {
        data.cursor.drag = None;
        data.backend.damaged();
    }
}

impl Compositor {
    pub fn start_drag(&mut self, window: &Window, edges: u32, serial: Serial, start: GrabStartData<Compositor>) -> bool {
        let Some(mode) = self.managed_of(window).and_then(|m| self.table.window(m)).map(|w| w.mode) else { return false };
        if (edges == 0 && !mode.can_move()) || (edges != 0 && !mode.can_resize()) {
            return false;
        }
        let (Some(loc), size) = (self.space.element_location(window), window.geometry().size) else { return false };
        let drag = Drag { start, window: window.clone(), initial: Rectangle::new(loc, size), edges };
        self.pointer().set_grab(self, drag, serial, Focus::Clear);
        self.cursor.drag = Some(super::cursor::Cursor::for_edges(edges));
        self.cursor.hover = None;
        self.backend.damaged();
        true
    }

    pub fn hover_cursor(&mut self, pos: Point<f64, Logical>) {
        let hover = match self.pointer().is_grabbed() {
            true => None,
            false => self.window_under(pos).and_then(|(w, _)| self.grab_hint_at(&w, pos)).filter(|&e| e != 0).map(super::cursor::Cursor::for_edges),
        };
        if hover != self.cursor.hover {
            self.cursor.hover = hover;
            self.backend.damaged();
        }
    }

    pub fn grab_hint_at(&self, window: &Window, pos: Point<f64, Logical>) -> Option<u32> {
        let local = pos - self.space.element_location(window)?.to_f64();
        Self::with_hints(window.toplevel()?.wl_surface(), |hints| {
            hints
                .grab
                .iter()
                .rev()
                .find(|([x, y, w, h], _)| Rectangle::<i32, Logical>::new((*x, *y).into(), (*w, *h).into()).to_f64().contains(local))
                .map(|(_, edges)| *edges)
        })
        .flatten()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GrabKind {
    Pointer,
    Keyboard,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lost {
    Esc,
    OtherWindow,
    Focus,
}

#[derive(Clone)]
pub struct Holder {
    pub surface: WlSurface,
    pub resource: AcdeWindow,
}

#[derive(Default)]
pub struct InputGrabs {
    pointer: Option<Holder>,
    keyboard: Option<Holder>,
}

impl InputGrabs {
    fn slot(&mut self, kind: GrabKind) -> &mut Option<Holder> {
        match kind {
            GrabKind::Pointer => &mut self.pointer,
            GrabKind::Keyboard => &mut self.keyboard,
        }
    }

    fn alive(&mut self) {
        for kind in [GrabKind::Pointer, GrabKind::Keyboard] {
            let slot = self.slot(kind);
            if slot.as_ref().is_some_and(|h| !h.surface.is_alive()) {
                *slot = None;
            }
        }
    }

    pub fn any(&mut self) -> bool {
        self.alive();
        self.pointer.is_some() || self.keyboard.is_some()
    }
}

impl From<GrabKind> for WireGrab {
    fn from(kind: GrabKind) -> Self {
        match kind {
            GrabKind::Pointer => WireGrab::Pointer,
            GrabKind::Keyboard => WireGrab::Keyboard,
        }
    }
}

impl From<Lost> for WireLost {
    fn from(lost: Lost) -> Self {
        match lost {
            Lost::Esc => WireLost::Esc,
            Lost::OtherWindow => WireLost::OtherWindow,
            Lost::Focus => WireLost::FocusLost,
        }
    }
}

impl Compositor {
    pub fn request_grab(&mut self, surface: &WlSurface, resource: &AcdeWindow, kind: GrabKind) {
        self.grabs.alive();
        let framework = kind == GrabKind::Pointer && self.pointer().is_grabbed();
        let taken = self.grabs.slot(kind).as_ref().is_some_and(|h| h.surface != *surface);
        let window = self.window_of(surface);
        let granted = !framework && !taken && window.is_some() && !self.lock.locked();
        if granted {
            *self.grabs.slot(kind) = Some(Holder { surface: surface.clone(), resource: resource.clone() });
            if kind == GrabKind::Keyboard {
                self.focus_window(window.as_ref());
            }
        }
        resource.grab(u32::from(granted), kind.into());
    }

    pub fn release_grab(&mut self, surface: &WlSurface, kind: GrabKind) {
        let slot = self.grabs.slot(kind);
        if slot.as_ref().is_some_and(|h| h.surface == *surface) {
            *slot = None;
        }
    }

    pub fn lose_grabs(&mut self, reason: Lost) {
        self.grabs.alive();
        let mut told = Vec::new();
        for kind in [GrabKind::Pointer, GrabKind::Keyboard] {
            if let Some(holder) = self.grabs.slot(kind).take()
                && !told.contains(&holder.surface)
            {
                holder.resource.grab_lost(reason.into());
                told.push(holder.surface);
            }
        }
    }

    pub fn pointer_holder(&mut self) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.grabs.alive();
        let surface = self.grabs.pointer.as_ref()?.surface.clone();
        let window = self.window_of(&surface)?;
        let origin = self.space.element_location(&window)? - window.geometry().loc;
        Some((surface, origin.to_f64()))
    }

    pub fn grab_holds(&mut self, window: Option<&Window>) -> bool {
        self.grabs.alive();
        let surface = window.and_then(|w| w.toplevel()).map(|t| t.wl_surface().clone());
        [&self.grabs.pointer, &self.grabs.keyboard].into_iter().flatten().all(|h| Some(&h.surface) == surface.as_ref())
    }
}
