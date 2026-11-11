mod event;
mod motion;
mod plan;
mod shortcut;

pub use event::*;
pub use motion::*;
pub use plan::*;
pub use shortcut::*;

use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }

    pub fn is_empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }

    pub fn covers(&self, o: &Rect) -> bool {
        self.x <= o.x && self.y <= o.y && self.right() >= o.right() && self.bottom() >= o.bottom()
    }

    pub fn intersects(&self, o: &Rect) -> bool {
        self.intersect(o).is_some()
    }

    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let r = Rect::new(self.x.max(o.x), self.y.max(o.y), self.right().min(o.right()), self.bottom().min(o.bottom()));
        let r = Rect::new(r.x, r.y, r.w - r.x, r.h - r.y);
        (!r.is_empty()).then_some(r)
    }

    pub fn union(&self, o: &Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        Rect::new(x, y, self.right().max(o.right()) - x, self.bottom().max(o.bottom()) - y)
    }

    pub fn translate(&self, x: f64, y: f64) -> Rect {
        Rect::new(self.x + x, self.y + y, self.w, self.h)
    }

    pub fn scale(&self, s: f64) -> Rect {
        Rect::new(self.x * s, self.y * s, self.w * s, self.h * s)
    }

    pub fn round_out(&self) -> Rect {
        let (x, y) = (self.x.floor(), self.y.floor());
        Rect::new(x, y, self.right().ceil() - x, self.bottom().ceil() - y)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Fullscreen,
    Free,
    Fixed,
    Pinned,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Fullscreen => "fullscreen",
            Mode::Free => "free",
            Mode::Fixed => "fixed",
            Mode::Pinned => "pinned",
        }
    }

    pub fn can_move(self) -> bool {
        matches!(self, Mode::Free | Mode::Fixed)
    }

    pub fn can_resize(self) -> bool {
        matches!(self, Mode::Free)
    }
}

impl std::str::FromStr for Mode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "fullscreen" => Mode::Fullscreen,
            "free" => Mode::Free,
            "fixed" => Mode::Fixed,
            "pinned" => Mode::Pinned,
            other => return Err(format!("unknown mode {other}")),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CanvasId(pub u64);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WindowId(pub u64);

pub struct Canvas {
    pub id: CanvasId,
    pub rect: Rect,
    pub scale: f64,
    pub z: Vec<WindowId>,
    pub focus: Option<WindowId>,
}

impl Canvas {
    pub fn physical(&self) -> Rect {
        self.rect.scale(self.scale)
    }
}

pub struct Window {
    pub id: WindowId,
    pub canvas: CanvasId,
    pub mode: Mode,
    pub rect: Rect,
    pub parent: Option<WindowId>,
    pub modal: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    UnknownCanvas,
    UnknownWindow,
    NotOnCanvas,
    NotAbove,
    ModeRefusesMove,
    ModeRefusesResize,
    EmptyRect,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::UnknownCanvas => "unknown canvas",
            Error::UnknownWindow => "unknown window",
            Error::NotOnCanvas => "window is on another canvas",
            Error::NotAbove => "the window to raise above is not on this canvas",
            Error::ModeRefusesMove => "this mode does not move",
            Error::ModeRefusesResize => "this mode does not resize",
            Error::EmptyRect => "empty rect",
        })
    }
}

impl std::error::Error for Error {}

#[derive(Default)]
pub struct WindowTable {
    canvases: BTreeMap<CanvasId, Canvas>,
    windows: BTreeMap<WindowId, Window>,
    next_canvas: u64,
    next_window: u64,
}

impl WindowTable {
    pub fn add_canvas(&mut self, rect: Rect, scale: f64) -> CanvasId {
        self.next_canvas += 1;
        let id = CanvasId(self.next_canvas);
        self.canvases.insert(id, Canvas { id, rect, scale, z: Vec::new(), focus: None });
        id
    }

    pub fn replace_canvas(&mut self, old: CanvasId, rect: Rect, scale: f64) -> Result<CanvasId, Error> {
        let before = self.canvases.remove(&old).ok_or(Error::UnknownCanvas)?;
        self.next_canvas += 1;
        let id = CanvasId(self.next_canvas);
        for w in self.windows.values_mut().filter(|w| w.canvas == old) {
            w.canvas = id;
            if w.mode == Mode::Fullscreen {
                w.rect = rect;
            }
        }
        self.canvases.insert(id, Canvas { id, rect, scale, z: before.z, focus: before.focus });
        Ok(id)
    }

    pub fn canvas(&self, id: CanvasId) -> Option<&Canvas> {
        self.canvases.get(&id)
    }

    pub fn canvases(&self) -> impl Iterator<Item = &Canvas> {
        self.canvases.values()
    }

    pub fn window(&self, id: WindowId) -> Option<&Window> {
        self.windows.get(&id)
    }

    pub fn create(&mut self, canvas: CanvasId, mode: Mode, rect: Rect) -> Result<WindowId, Error> {
        self.create_child(canvas, mode, rect, None)
    }

    pub fn create_child(&mut self, canvas: CanvasId, mode: Mode, rect: Rect, parent: Option<WindowId>) -> Result<WindowId, Error> {
        let c = self.canvases.get(&canvas).ok_or(Error::UnknownCanvas)?;
        if let Some(p) = parent
            && self.windows.get(&p).is_none_or(|w| w.canvas != canvas)
        {
            return Err(Error::NotOnCanvas);
        }
        let rect = match mode {
            Mode::Fullscreen => c.rect,
            _ => rect,
        };
        if rect.is_empty() {
            return Err(Error::EmptyRect);
        }
        self.next_window += 1;
        let id = WindowId(self.next_window);
        self.windows.insert(id, Window { id, canvas, mode, rect, parent, modal: false });
        self.canvases.get_mut(&canvas).expect("checked above").z.push(id);
        Ok(id)
    }

    pub fn remove(&mut self, id: WindowId) -> Option<Window> {
        let w = self.windows.remove(&id)?;
        if let Some(c) = self.canvases.get_mut(&w.canvas) {
            c.z.retain(|&x| x != id);
            if c.focus == Some(id) {
                c.focus = None;
            }
        }
        for other in self.windows.values_mut() {
            if other.parent == Some(id) {
                other.parent = None;
            }
        }
        Some(w)
    }

    pub fn set_parent(&mut self, id: WindowId, parent: Option<WindowId>, modal: bool) -> Result<(), Error> {
        let canvas = self.windows.get(&id).ok_or(Error::UnknownWindow)?.canvas;
        if let Some(p) = parent
            && (p == id || self.windows.get(&p).is_none_or(|w| w.canvas != canvas))
        {
            return Err(Error::NotOnCanvas);
        }
        let w = self.windows.get_mut(&id).ok_or(Error::UnknownWindow)?;
        w.parent = parent;
        w.modal = modal && parent.is_some();
        Ok(())
    }

    pub fn modal_child(&self, id: WindowId) -> Option<WindowId> {
        let canvas = self.canvases.get(&self.windows.get(&id)?.canvas)?;
        let mut found = None;
        let mut current = id;
        while let Some(&child) = canvas.z.iter().rev().find(|c| self.windows.get(c).is_some_and(|w| w.parent == Some(current) && w.modal)) {
            if Some(child) == found {
                break;
            }
            found = Some(child);
            current = child;
        }
        found
    }

    pub fn set_mode(&mut self, id: WindowId, mode: Mode) -> Result<(), Error> {
        let w = self.windows.get_mut(&id).ok_or(Error::UnknownWindow)?;
        if mode == Mode::Fullscreen {
            let c = self.canvases.get(&w.canvas).ok_or(Error::UnknownCanvas)?;
            w.rect = c.rect;
        }
        w.mode = mode;
        Ok(())
    }

    pub fn place(&mut self, id: WindowId, x: f64, y: f64) -> Result<(), Error> {
        let w = self.windows.get_mut(&id).ok_or(Error::UnknownWindow)?;
        if !w.mode.can_move() {
            return Err(Error::ModeRefusesMove);
        }
        w.rect.x = x;
        w.rect.y = y;
        Ok(())
    }

    pub fn resize(&mut self, id: WindowId, w: f64, h: f64) -> Result<(), Error> {
        let win = self.windows.get_mut(&id).ok_or(Error::UnknownWindow)?;
        if !win.mode.can_resize() {
            return Err(Error::ModeRefusesResize);
        }
        if w <= 0.0 || h <= 0.0 {
            return Err(Error::EmptyRect);
        }
        win.rect.w = w;
        win.rect.h = h;
        Ok(())
    }

    pub fn set_rect(&mut self, id: WindowId, rect: Rect) -> Result<(), Error> {
        let win = self.windows.get_mut(&id).ok_or(Error::UnknownWindow)?;
        if rect.w <= 0.0 || rect.h <= 0.0 {
            return Err(Error::EmptyRect);
        }
        win.rect = rect;
        Ok(())
    }

    pub fn raise(&mut self, id: WindowId, above: Option<WindowId>) -> Result<(), Error> {
        let canvas = self.windows.get(&id).ok_or(Error::UnknownWindow)?.canvas;
        let z = &mut self.canvases.get_mut(&canvas).ok_or(Error::UnknownCanvas)?.z;
        if above.is_some_and(|a| a == id || !z.contains(&a)) {
            return Err(Error::NotAbove);
        }
        z.retain(|&x| x != id);
        match above {
            Some(a) => {
                let at = z.iter().position(|&x| x == a).expect("checked above") + 1;
                z.insert(at, id);
            }
            None => z.push(id),
        }
        Ok(())
    }

    pub fn lower(&mut self, id: WindowId) -> Result<(), Error> {
        let canvas = self.windows.get(&id).ok_or(Error::UnknownWindow)?.canvas;
        let z = &mut self.canvases.get_mut(&canvas).ok_or(Error::UnknownCanvas)?.z;
        z.retain(|&x| x != id);
        z.insert(0, id);
        Ok(())
    }

    pub fn front(&mut self, id: WindowId) -> Result<(), Error> {
        let window = self.windows.get(&id).ok_or(Error::UnknownWindow)?;
        let canvas = window.canvas;
        let pinned = window.mode == Mode::Pinned;
        let modes: BTreeMap<WindowId, Mode> = self.windows.iter().map(|(k, w)| (*k, w.mode)).collect();
        let z = &mut self.canvases.get_mut(&canvas).ok_or(Error::UnknownCanvas)?.z;
        z.retain(|&x| x != id);
        let at = if pinned { z.len() } else { z.iter().position(|x| modes.get(x) == Some(&Mode::Pinned)).unwrap_or(z.len()) };
        z.insert(at, id);
        Ok(())
    }

    pub fn focus(&mut self, canvas: CanvasId, id: Option<WindowId>) -> Result<(), Error> {
        let c = self.canvases.get_mut(&canvas).ok_or(Error::UnknownCanvas)?;
        if let Some(id) = id
            && !c.z.contains(&id)
        {
            return Err(Error::NotOnCanvas);
        }
        c.focus = id;
        Ok(())
    }

    pub fn can_direct(&self, id: WindowId, opaque: bool, effects: bool, opacity: f32, identity: bool, buffer_ok: bool) -> bool {
        let Some(w) = self.window(id) else { return false };
        let Some(c) = self.canvas(w.canvas) else { return false };
        opaque && !effects && opacity == 1.0 && identity && buffer_ok && w.rect.covers(&c.rect)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> (WindowTable, CanvasId) {
        let mut t = WindowTable::default();
        let c = t.add_canvas(Rect::new(0.0, 0.0, 100.0, 100.0), 2.0);
        (t, c)
    }

    #[test]
    fn canvas_gives_the_only_absolute_size() {
        let (mut t, c) = table();
        let canvas = t.canvas(c).unwrap();
        assert_eq!(canvas.physical(), Rect::new(0.0, 0.0, 200.0, 200.0));
        let w = t.create(c, Mode::Free, Rect::new(10.0, 10.0, 20.0, 10.0)).unwrap();
        let plan = CompositePlan::build(&t, &[input(w, false, Rect::default())], &[]);
        assert_eq!(plan.layer(w).unwrap().dst, Rect::new(20.0, 20.0, 40.0, 20.0));
    }

    #[test]
    fn fullscreen_fills_the_canvas() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Fullscreen, Rect::new(1.0, 2.0, 3.0, 4.0)).unwrap();
        assert_eq!(t.window(w).unwrap().rect, Rect::new(0.0, 0.0, 100.0, 100.0));
        assert!(!t.place(w, 5.0, 5.0).is_ok());
        assert!(!t.resize(w, 10.0, 10.0).is_ok());
        assert!(t.set_mode(w, Mode::Free).is_ok());
        assert!(t.place(w, 5.0, 5.0).is_ok());
    }

    #[test]
    fn a_new_canvas_takes_the_windows() {
        let (mut t, c) = table();
        let full = t.create(c, Mode::Fullscreen, Rect::default()).unwrap();
        let free = t.create(c, Mode::Free, Rect::new(10.0, 10.0, 20.0, 20.0)).unwrap();
        t.focus(c, Some(free)).unwrap();
        let n = t.replace_canvas(c, Rect::new(0.0, 0.0, 50.0, 50.0), 4.0).unwrap();
        assert!(t.canvas(c).is_none());
        let canvas = t.canvas(n).unwrap();
        assert_eq!((canvas.z.clone(), canvas.focus, canvas.scale), (vec![full, free], Some(free), 4.0));
        assert_eq!(t.window(full).unwrap().rect, Rect::new(0.0, 0.0, 50.0, 50.0));
        assert_eq!(t.window(free).unwrap().rect, Rect::new(10.0, 10.0, 20.0, 20.0));
        assert_eq!(t.window(free).unwrap().canvas, n);
    }

    #[test]
    fn fixed_moves_but_does_not_resize() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Fixed, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        assert!(t.place(w, 20.0, 20.0).is_ok());
        assert_eq!(t.resize(w, 30.0, 30.0), Err(Error::ModeRefusesResize));
        assert_eq!(t.window(w).unwrap().rect, Rect::new(20.0, 20.0, 10.0, 10.0));
    }

    #[test]
    fn pinned_never_moves() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Pinned, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        assert_eq!(t.place(w, 20.0, 20.0), Err(Error::ModeRefusesMove));
        assert_eq!(t.resize(w, 30.0, 30.0), Err(Error::ModeRefusesResize));
    }

    #[test]
    fn windows_may_exceed_the_canvas_and_are_clipped() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Free, Rect::new(90.0, 10.0, 30.0, 10.0)).unwrap();
        let shown = |t: &WindowTable| CompositePlan::build(t, &[input(w, false, Rect::default())], &[]).layer(w).map(|l| l.clip);
        assert_eq!(shown(&t), Some(Rect::new(180.0, 20.0, 20.0, 20.0)));
        t.place(w, 200.0, 0.0).unwrap();
        assert_eq!(shown(&t), None);
    }

    #[test]
    fn raise_orders_the_z_list() {
        let (mut t, c) = table();
        let a = t.create(c, Mode::Free, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        let b = t.create(c, Mode::Free, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        let d = t.create(c, Mode::Free, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        assert_eq!(t.canvas(c).unwrap().z, vec![a, b, d]);
        t.raise(a, Some(b)).unwrap();
        assert_eq!(t.canvas(c).unwrap().z, vec![b, a, d]);
        t.raise(b, None).unwrap();
        assert_eq!(t.canvas(c).unwrap().z, vec![a, d, b]);
        assert_eq!(t.raise(a, Some(a)), Err(Error::NotAbove));
    }

    #[test]
    fn focus_is_per_canvas() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Free, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        t.focus(c, Some(w)).unwrap();
        assert_eq!(t.canvas(c).unwrap().focus, Some(w));
        t.remove(w);
        assert_eq!(t.canvas(c).unwrap().focus, None);
        assert_eq!(t.focus(c, Some(w)), Err(Error::NotOnCanvas));
    }

    #[test]
    fn damage_scales_and_clips_to_the_canvas() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Free, Rect::new(50.0, 50.0, 20.0, 20.0)).unwrap();
        let damaged = |t: &WindowTable, local: Rect| {
            let mut i = input(w, false, Rect::default());
            i.damage = vec![local];
            CompositePlan::build(t, &[i], &[]).damage
        };
        assert_eq!(damaged(&t, Rect::new(0.0, 0.0, 20.0, 20.0)), vec![Rect::new(100.0, 100.0, 20.0, 20.0)]);
        t.place(w, 90.0, 50.0).unwrap();
        assert_eq!(damaged(&t, Rect::new(0.0, 0.0, 40.0, 40.0)), vec![Rect::new(180.0, 100.0, 20.0, 40.0)]);
    }

    #[test]
    fn moving_merges_the_old_and_new_rects() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Free, Rect::new(0.0, 0.0, 10.0, 10.0)).unwrap();
        let old = t.window(w).unwrap().rect;
        t.place(w, 40.0, 0.0).unwrap();
        let mut i = input(w, false, Rect::default());
        i.moved_from = Some(old);
        let d = CompositePlan::build(&t, &[i], &[]).damage;
        assert_eq!(d.len(), 2);
        assert!(d.contains(&Rect::new(0.0, 0.0, 20.0, 20.0)));
        assert!(d.contains(&Rect::new(80.0, 0.0, 20.0, 20.0)));
    }

    #[test]
    fn direct_needs_one_opaque_fullscreen_window() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Fullscreen, Rect::new(0.0, 0.0, 1.0, 1.0)).unwrap();
        assert!(t.can_direct(w, true, false, 1.0, true, true));
        assert!(!t.can_direct(w, false, false, 1.0, true, true));
        assert!(!t.can_direct(w, true, true, 1.0, true, true));
        assert!(!t.can_direct(w, true, false, 0.5, true, true));
        assert!(!t.can_direct(w, true, false, 1.0, false, true));
        assert!(!t.can_direct(w, true, false, 1.0, true, false));
        t.place(w, 0.0, 0.0).ok();
        t.set_mode(w, Mode::Free).unwrap();
        t.resize(w, 50.0, 50.0).unwrap();
        assert!(!t.can_direct(w, true, false, 1.0, true, true));
    }

    fn input(w: WindowId, opaque: bool, rect: Rect) -> Input {
        Input { window: w, opaque: if opaque { vec![Rect::new(0.0, 0.0, rect.w * 2.0, rect.h * 2.0)] } else { Vec::new() }, ..Default::default() }
    }

    #[test]
    fn plan_culls_what_opaque_windows_cover() {
        let (mut t, c) = table();
        let below = t.create(c, Mode::Free, Rect::new(10.0, 10.0, 20.0, 20.0)).unwrap();
        let top = t.create(c, Mode::Fullscreen, Rect::default()).unwrap();
        let full = t.window(top).unwrap().rect;
        let mut inputs = vec![input(below, false, Rect::new(10.0, 10.0, 20.0, 20.0)), input(top, true, full)];
        inputs[0].damage = vec![Rect::new(0.0, 0.0, 4.0, 4.0)];
        let plan = CompositePlan::build(&t, &inputs, &[]);
        assert_eq!(plan.layers.iter().map(|l| l.window).collect::<Vec<_>>(), vec![top]);
        assert!(plan.damage.is_empty(), "damage under an opaque window is not shown: {:?}", plan.damage);
        assert_eq!(plan.route, Route::Composite);
        inputs[1].direct_buffer = true;
        assert_eq!(CompositePlan::build(&t, &inputs, &[]).route, Route::Direct);
        inputs[1].look.opacity = 0.5;
        let plan = CompositePlan::build(&t, &inputs, &[]);
        assert_eq!(plan.layers.len(), 2);
        assert_eq!(plan.route, Route::Composite);
    }

    #[test]
    fn plan_keeps_at_most_eight_damage_rects() {
        let (mut t, c) = table();
        let w = t.create(c, Mode::Fullscreen, Rect::default()).unwrap();
        let mut i = input(w, false, Rect::default());
        i.damage = (0..20).map(|k| Rect::new(f64::from(k) * 10.0, 0.0, 2.0, 2.0)).collect();
        let plan = CompositePlan::build(&t, &[i], &[]);
        assert!(plan.damage.len() <= MAX_DAMAGE);
        for k in 0..20 {
            let x = f64::from(k) * 10.0;
            assert!(plan.damage.iter().any(|d| d.covers(&Rect::new(x, 0.0, 2.0, 2.0))));
        }
    }

    #[test]
    fn backdrop_redraws_when_what_is_under_it_changes() {
        let (mut t, c) = table();
        let below = t.create(c, Mode::Fullscreen, Rect::default()).unwrap();
        let glass = t.create(c, Mode::Free, Rect::new(10.0, 10.0, 40.0, 40.0)).unwrap();
        let mut under = input(below, true, Rect::default());
        under.damage = vec![Rect::new(30.0, 30.0, 2.0, 2.0)];
        let mut top = input(glass, false, Rect::default());
        top.backdrop = Some(Effect::Backdrop { rect: Rect::new(0.0, 0.0, 80.0, 80.0), radius: 0.0, blur: 8.0, saturate: 1.0, brightness: 1.0 });
        let plan = CompositePlan::build(&t, &[under.clone(), top.clone()], &[]);
        assert!(plan.layers[1].redraw);
        assert!(plan.damage.iter().any(|d| d.covers(&Rect::new(20.0, 20.0, 80.0, 80.0))), "{:?}", plan.damage);
        under.damage.clear();
        top.damage = vec![Rect::new(0.0, 0.0, 2.0, 2.0)];
        let plan = CompositePlan::build(&t, &[under, top], &[]);
        assert!(!plan.layers[1].redraw, "the glass window's own content does not blur again");
    }

    #[test]
    fn backdrop_redraws_when_a_window_leaves_from_under_it() {
        let (mut t, c) = table();
        let moving = t.create(c, Mode::Free, Rect::new(10.0, 10.0, 20.0, 20.0)).unwrap();
        let glass = t.create(c, Mode::Free, Rect::new(0.0, 0.0, 50.0, 50.0)).unwrap();
        let old = t.window(moving).unwrap().rect;
        t.place(moving, 300.0, 0.0).unwrap();
        let mut under = input(moving, false, Rect::default());
        under.moved_from = Some(old);
        let mut top = input(glass, false, Rect::default());
        top.backdrop = Some(Effect::Backdrop { rect: Rect::new(0.0, 0.0, 100.0, 100.0), radius: 0.0, blur: 8.0, saturate: 1.0, brightness: 1.0 });
        let plan = CompositePlan::build(&t, &[under, top], &[]);
        assert_eq!(plan.layers.iter().map(|l| l.window).collect::<Vec<_>>(), vec![glass]);
        assert!(plan.layers[0].redraw);
        assert!(plan.damage.iter().any(|d| d.covers(&Rect::new(20.0, 20.0, 40.0, 40.0))), "{:?}", plan.damage);
    }

    #[test]
    fn shortcuts_first_come_session_wins() {
        let mut s = Shortcuts::default();
        let combo = Combo { mods: Combo::CTRL, key: 20 };
        let b = |scope, owner| Binding { combo, scope, owner };
        assert!(s.register(b(Scope::Desktop, 1)).is_ok());
        assert!(s.register(b(Scope::Desktop, 2)).is_err());
        assert!(s.register(b(Scope::App, 7)).is_ok());
        assert!(s.register(b(Scope::App, 7)).is_ok());
        assert!(s.register(b(Scope::App, 8)).is_ok());
        assert!(s.register(b(Scope::Session, 0)).is_err());
        assert_eq!(s.find(combo, Some(8)).map(|b| b.owner), Some(8));
        assert_eq!(s.find(combo, Some(3)).map(|b| b.scope), Some(Scope::Desktop));
        s.forget(8);
        assert_eq!(s.find(combo, Some(8)).map(|b| b.scope), Some(Scope::Desktop));
        let other = Combo { mods: Combo::ALT, key: 20 };
        assert!(s.register(Binding { combo: other, scope: Scope::Session, owner: 0 }).is_ok());
        assert!(s.register(Binding { combo: other, scope: Scope::App, owner: 9 }).is_err());
    }

    #[test]
    fn transition_runs_from_delay_to_end() {
        let to = Look { opacity: 0.0, scale: 0.5, ..Look::default() };
        let tr = Transition { from: Look::default(), to, start_ms: 100.0, duration_ms: 200.0, easing: Easing::Linear };
        assert_eq!(tr.at(50.0), (Look::default(), false));
        let (mid, done) = tr.at(200.0);
        assert!(!done && (mid.scale - 0.75).abs() < 1e-6 && (mid.opacity - 0.5).abs() < 1e-6);
        assert_eq!(tr.at(300.0), (to, true));
        assert!((Easing::EaseInOut.at(0.5) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn modal_children_take_the_parents_turn() {
        let (mut t, c) = table();
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        let parent = t.create(c, Mode::Free, r).unwrap();
        let dialog = t.create(c, Mode::Free, r).unwrap();
        let inner = t.create(c, Mode::Free, r).unwrap();
        assert_eq!(t.modal_child(parent), None);
        t.set_parent(dialog, Some(parent), false).unwrap();
        assert_eq!(t.modal_child(parent), None);
        t.set_parent(dialog, Some(parent), true).unwrap();
        t.set_parent(inner, Some(dialog), true).unwrap();
        assert_eq!(t.modal_child(parent), Some(inner));
        assert_eq!(t.set_parent(parent, Some(parent), true), Err(Error::NotOnCanvas));
        t.remove(dialog);
        assert_eq!(t.modal_child(parent), None);
    }
}
