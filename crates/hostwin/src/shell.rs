use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use acde_model::{Binding, Change, ClickSettings, Clicks, Combo, DoubleClick, Event, Inbox, Injected, Mode, Restore, Scope, Shortcuts, Waker, WindowState};

use crate::app::server;
use crate::output::compose::Layer;
use crate::output::surface::{Link, Shot};
use crate::platform::Cmd;

pub(crate) const CAPTURE_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

pub const FIRST_WEB: u32 = 1 << 20;
const DEFAULT_SIZE: [f64; 2] = [800.0, 600.0];

#[derive(Default)]
pub struct Grant {
    pub desktop: bool,
    pub hidden: bool,
    pub window: Option<u32>,
    pub mode: Option<Mode>,
    pub rect: Option<[f64; 4]>,
    pub size: Option<[f64; 2]>,
    pub parent: Option<u32>,
    pub modal: bool,
}

#[derive(Clone, Debug)]
pub struct WindowInfo {
    pub id: u32,
    pub mode: Mode,
    pub state: WindowState,
    pub rect: [f64; 4],
    pub z: u64,
    pub focus: bool,
    pub hidden: bool,
    pub parent: Option<u32>,
    pub modal: bool,
}

#[derive(Default)]
pub(crate) struct Entry {
    pub desktop: bool,
    pub panel: bool,
    pub mode: Mode,
    pub rect: [f64; 4],
    pub placed: bool,
    pub state: WindowState,
    pub restore: Restore,
    pub title: String,
    pub hidden: bool,
    pub opened: bool,
    pub z: u64,
    pub inbox: Option<Arc<Inbox>>,
    pub link: Option<Link>,
    pub app: Option<String>,
    pub hints: Vec<([f64; 4], u32)>,
    pub owner: Option<u32>,
    pub parent: Option<u32>,
    pub modal: bool,
    pub input: Option<[f64; 4]>,
    pub reserve: Option<(u32, f64)>,
    pub frame: f64,
    pub backdrop: Option<([f64; 4], [f64; 4])>,
    pub pending: Option<([f64; 4], [f64; 4])>,
    pub drawn: (u32, u32),
}

pub(crate) enum Press {
    Plain,
    Drag(u32, [f64; 4]),
    Double(Option<WindowState>),
}

pub(crate) struct Hit {
    pub entry: u32,
    pub target: u32,
    pub origin: [f64; 2],
    pub bar: bool,
    pub blocked: bool,
}

impl Entry {
    pub fn grab_hints(&self) -> Vec<([f64; 4], u32)> {
        let top = self.frame;
        let mut hints: Vec<([f64; 4], u32)> = self.hints.iter().map(|&([x, y, w, h], edges)| ([x, y + top, w, h], edges)).collect();
        if top > 0.0 {
            hints.extend(acde_render::Bar::grab_hints(self.rect[2], self.rect[3], top));
        }
        hints
    }

    pub fn shown(&self) -> bool {
        self.opened && !self.hidden && self.state.shown()
    }

    pub fn bar(&self) -> acde_render::Bar {
        acde_render::Bar {
            title: self.title.clone(),
            width: self.rect[2],
            height: self.frame,
            scale: 1.0,
            style: acde_render::FrameStyle::current(),
            fullscreen: self.mode == Mode::Fullscreen || self.state == WindowState::Fullscreen,
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub tokens: HashMap<u64, u32>,
    pub entries: BTreeMap<u32, Entry>,
    pub next: u32,
    pub focus: Option<u32>,
    pub z: u64,
    pub shortcuts: Shortcuts,
    pub screen: [f64; 3],
    pub refresh: Option<f64>,
    pub frames: u64,
    pub work: Option<[f64; 4]>,
    pub double_click: DoubleClick,
    pub clicks: Clicks,
}

impl State {
    pub fn raise(&mut self, id: u32) {
        self.z += 1;
        let z = self.z;
        if let Some(e) = self.entries.get_mut(&id) {
            e.z = z;
        }
        for child in self.descendants(id) {
            self.z += 1;
            let z = self.z;
            if let Some(e) = self.entries.get_mut(&child) {
                e.z = z;
            }
        }
    }

    fn descendants(&self, id: u32) -> Vec<u32> {
        let mut found: Vec<u32> = Vec::new();
        let mut next = vec![id];
        while let Some(parent) = next.pop() {
            for (&child, e) in &self.entries {
                if e.parent == Some(parent) && child != id && !found.contains(&child) {
                    found.push(child);
                    next.push(child);
                }
            }
        }
        found.sort_by_key(|child| self.entries[child].z);
        found
    }

    pub fn modal_child(&self, id: u32) -> Option<u32> {
        let mut found = None;
        let mut current = id;
        for _ in 0..self.entries.len() {
            let child =
                self.entries.iter().filter(|(_, e)| e.parent == Some(current) && e.modal && e.shown()).max_by_key(|(_, e)| e.z).map(|(&child, _)| child);
            match child {
                Some(child) if child != id => {
                    found = Some(child);
                    current = child;
                }
                _ => break,
            }
        }
        found
    }

    pub fn forget(&mut self, id: u32) -> Option<Entry> {
        let gone = self.entries.remove(&id)?;
        for e in self.entries.values_mut().filter(|e| e.parent == Some(id)) {
            e.parent = None;
            e.modal = false;
        }
        Some(gone)
    }

    pub fn grant(&mut self, grant: Grant) -> (u32, u64) {
        let id = if grant.desktop {
            0
        } else if let Some(w) = grant.window {
            w
        } else {
            self.next = self.next.max(FIRST_WEB);
            let id = self.next;
            self.next += 1;
            id
        };
        let parent = grant
            .parent
            .filter(|&p| p != id && !grant.desktop && self.entries.get(&p).is_some_and(|e| !e.desktop && !e.panel) && !self.descendants(id).contains(&p));
        let mode = grant.mode.unwrap_or(if grant.desktop { Mode::Fullscreen } else { Mode::Free });
        let placed = grant.rect.is_some();
        let rect = if mode == Mode::Fullscreen {
            let [w, h, _] = self.screen;
            [0.0, 0.0, w, h]
        } else {
            let size = grant.size.unwrap_or(DEFAULT_SIZE);
            grant.rect.unwrap_or_else(|| parent.map_or_else(|| self.centered(size), |p| self.over(p, size)))
        };
        let token = Self::token();
        self.tokens.insert(token, id);
        let panel = mode == Mode::Pinned && !grant.desktop;
        let entry =
            self.entries.entry(id).or_insert_with(|| Entry { desktop: grant.desktop, panel, mode, rect, placed, hidden: grant.hidden, ..Entry::default() });
        entry.mode = mode;
        entry.parent = parent;
        entry.modal = grant.modal && parent.is_some();
        if placed || !entry.opened {
            entry.rect = rect;
            entry.placed = placed;
        }
        self.raise(id);
        (id, token)
    }

    fn rank(id: u32, e: &Entry) -> (u8, u64) {
        if id == 0 {
            (0, 0)
        } else if e.panel || e.mode == Mode::Pinned {
            (2, e.z)
        } else {
            (1, e.z)
        }
    }

    pub fn place_when_drawn(entry: &mut Entry, scale: f64) -> bool {
        let Some((rect, input)) = entry.pending else { return false };
        let size = ((rect[2] * scale).round() as u32, (rect[3] * scale).round() as u32);
        if size.0.abs_diff(entry.drawn.0) > 1 || size.1.abs_diff(entry.drawn.1) > 1 {
            return false;
        }
        entry.rect = rect;
        entry.input = Some(input);
        entry.pending = None;
        true
    }

    pub fn layers(&self) -> Vec<Layer> {
        let mut shown: Vec<(&u32, &Entry)> = self.entries.iter().filter(|(_, e)| e.shown()).collect();
        shown.sort_by_key(|(id, e)| Self::rank(**id, e));
        shown.into_iter().map(|(&id, e)| Layer { id, rect: e.rect, backdrop: e.backdrop }).collect()
    }

    pub fn hit(&self, x: f64, y: f64) -> Option<Hit> {
        let inside = |[rx, ry, rw, rh]: [f64; 4]| x >= rx && y >= ry && x < rx + rw && y < ry + rh;
        self.layers().into_iter().rev().find_map(|layer| {
            let e = self.entries.get(&layer.id)?;
            let [rx, ry, ..] = e.rect;
            let area = match e.input {
                Some([ix, iy, iw, ih]) => [rx + ix, ry + iy, iw, ih],
                None => e.rect,
            };
            if !inside(area) {
                return None;
            }
            let hit = match e.owner {
                Some(owner) => Hit { entry: layer.id, target: owner, origin: [0.0, 0.0], bar: false, blocked: false },
                None => Hit { entry: layer.id, target: layer.id, origin: [rx, ry + e.frame], bar: y < ry + e.frame, blocked: false },
            };
            Some(match self.modal_child(hit.target) {
                Some(modal) => Hit { entry: modal, target: modal, origin: [0.0, 0.0], bar: false, blocked: true },
                None => hit,
            })
        })
    }

    pub fn press(&mut self, id: u32, at: [f64; 2], now_ms: f64, settings: ClickSettings) -> Press {
        let Some(e) = self.entries.get(&id).filter(|e| !e.desktop && !e.panel && e.owner.is_none()) else {
            self.clicks.reset();
            return Press::Plain;
        };
        let (x, y) = (at[0] - e.rect[0], at[1] - e.rect[1]);
        let edges = e.grab_hints().iter().rev().find(|([hx, hy, hw, hh], _)| x >= *hx && y >= *hy && x < hx + hw && y < hy + hh).map(|(_, edges)| *edges);
        let title = edges == Some(0) && matches!(e.mode, Mode::Free | Mode::Fixed);
        let allowed = e.state.moves() && (e.mode == Mode::Free || (e.mode == Mode::Fixed && edges == Some(0)));
        let (mode, state, rect) = (e.mode, e.state, e.rect);
        if !title {
            self.clicks.reset();
        } else if self.clicks.press(id, now_ms, at, settings) >= 2 {
            self.clicks.reset();
            return Press::Double(self.double_click.target(mode, state));
        }
        match edges {
            Some(edges) if allowed => Press::Drag(edges, rect),
            _ => Press::Plain,
        }
    }

    pub fn pixels(&self, rect: [f64; 4]) -> (u32, u32) {
        let scale = self.screen[2];
        (((rect[2] * scale).round() as u32).max(1), ((rect[3] * scale).round() as u32).max(1))
    }

    pub fn content(&self, e: &Entry) -> (u32, u32) {
        let [x, y, w, h] = e.rect;
        self.pixels([x, y, w, (h - e.frame).max(1.0)])
    }

    pub fn screen_rect(&self) -> [f64; 4] {
        [0.0, 0.0, self.screen[0], self.screen[1]]
    }

    pub fn work_area(&self) -> [f64; 4] {
        let [mut x, mut y, mut w, mut h] = self.screen_rect();
        for e in self.entries.values().filter(|e| e.panel && e.shown()) {
            let Some((edge, t)) = e.reserve else { continue };
            match edge {
                acde_model::edge::TOP => (y, h) = (y + t, h - t),
                acde_model::edge::BOTTOM => h -= t,
                acde_model::edge::LEFT => (x, w) = (x + t, w - t),
                acde_model::edge::RIGHT => w -= t,
                _ => {}
            }
        }
        [x, y, w.max(1.0), h.max(1.0)]
    }

    pub fn refill(&mut self) -> (Option<[f64; 4]>, Vec<u32>) {
        let work = self.work_area();
        let changed = (self.work != Some(work)).then_some(work);
        self.work = Some(work);
        let filled = self.entries.iter().filter(|(_, e)| e.state == WindowState::Filled && e.rect != work).map(|(&id, _)| id).collect();
        (changed, filled)
    }

    pub fn change_state(&mut self, id: u32, to: Option<WindowState>) -> Option<Change> {
        let (screen, work) = (self.screen_rect(), self.work_area());
        let entry = self.entries.get_mut(&id).filter(|e| !e.desktop && !e.panel)?;
        let to = to.unwrap_or_else(|| entry.restore.back(entry.state));
        let change = entry.restore.change(entry.mode, entry.state, to, entry.rect, work, screen)?;
        entry.state = change.state;
        Some(change)
    }

    pub fn inbox(&self, id: u32) -> Option<Arc<Inbox>> {
        self.entries.get(&id).and_then(|e| e.inbox.clone())
    }

    fn token() -> u64 {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::collections::hash_map::RandomState::new().hash_one((n, acde_log::now_ms().to_bits())) | 1
    }

    fn centered(&self, [w, h]: [f64; 2]) -> [f64; 4] {
        let [sw, sh, _] = self.screen;
        let shown = self.entries.values().filter(|e| !e.desktop && !e.panel).count() as f64;
        let (w, h) = (w.min(sw.max(320.0)), h.min(sh.max(240.0)));
        [((sw - w) / 2.0 + shown * 32.0).max(0.0), ((sh - h) / 2.0 + shown * 32.0).max(0.0), w, h]
    }

    fn over(&self, parent: u32, [w, h]: [f64; 2]) -> [f64; 4] {
        let [sw, sh, _] = self.screen;
        let [px, py, pw, ph] = self.entries[&parent].rect;
        let (w, h) = (w.min(sw.max(320.0)), h.min(sh.max(240.0)));
        [(px + (pw - w) / 2.0).clamp(0.0, (sw - w).max(0.0)), (py + (ph - h) / 2.0).clamp(0.0, (sh - h).max(0.0)), w, h]
    }
}

pub struct Shell(());

impl Shell {
    pub fn open() -> Option<Self> {
        server().map(|_| Shell(()))
    }

    fn state(&self) -> std::sync::MutexGuard<'static, State> {
        server().expect("hostwin").state()
    }

    pub fn set_waker(&self, waker: Option<Waker>) {
        if let Some(s) = server() {
            s.broker.set_waker(waker);
        }
    }

    pub fn pump(&self) -> Vec<Event> {
        server().map(|s| s.broker.drain()).unwrap_or_default()
    }

    pub fn grant(&self, grant: Grant) -> (u32, u64) {
        self.state().grant(grant)
    }

    pub fn release(&self, window: u32) {
        let mut state = self.state();
        state.tokens.retain(|_, w| *w != window);
        if state.entries.get(&window).is_some_and(|e| !e.opened && e.link.is_none()) {
            state.forget(window);
        }
    }

    pub fn place(&self, window: u32, rect: [f64; 4]) {
        let mut state = self.state();
        let Some(entry) = state.entries.get_mut(&window) else {
            return;
        };
        if !entry.state.moves() {
            return;
        }
        let rect = match entry.mode {
            Mode::Fullscreen => return,
            Mode::Fixed => [rect[0], rect[1], entry.rect[2], entry.rect[3]],
            _ => rect,
        };
        drop(state);
        server().expect("hostwin").set_rect(window, rect);
    }

    pub fn focus(&self, window: u32) {
        let minimized = match self.state().entries.get_mut(&window) {
            Some(e) => {
                e.hidden = false;
                e.state == WindowState::Minimized
            }
            None => false,
        };
        if minimized {
            crate::output::surface::request_state(window, None);
        }
        server().expect("hostwin").activate(window);
    }

    pub fn set_state(&self, window: u32, state: WindowState) {
        crate::output::surface::request_state(window, Some(state));
    }

    pub fn hide(&self, window: u32, hidden: bool) {
        let mut state = self.state();
        let Some(e) = state.entries.get_mut(&window) else {
            return;
        };
        e.hidden = hidden;
        let focused = state.focus == Some(window);
        drop(state);
        let server = server().expect("hostwin");
        if !hidden {
            self.focus(window);
        } else if focused {
            server.focus_top();
        }
        server.refill();
        server.relayout();
    }

    pub fn close(&self, window: u32) {
        let inbox = self.state().inbox(window);
        if let Some(inbox) = inbox {
            inbox.push(Event::named("close"));
        }
    }

    pub fn inject(&self, event: Injected) {
        server().expect("hostwin").send(Cmd::Inject(event));
    }

    pub fn capture(&self, window: u32) -> Result<Shot, String> {
        let link = self
            .state()
            .entries
            .get(&window)
            .ok_or_else(|| format!("no window {window}"))?
            .link
            .clone()
            .ok_or_else(|| format!("window {window} has no page"))?;
        link.capture(CAPTURE_WAIT)
    }

    pub fn screenshot(&self, path: std::path::PathBuf) -> Result<(u32, u32), String> {
        server().expect("hostwin").compositor().ok_or("the compositor has not started")?.screenshot(path)
    }

    pub fn quit(&self) {
        server().expect("hostwin").send(Cmd::Exit(0));
    }

    pub fn windows(&self) -> Vec<WindowInfo> {
        let state = self.state();
        let mut list: Vec<WindowInfo> = state
            .entries
            .iter()
            .filter(|(_, e)| e.opened || e.panel)
            .map(|(&id, e)| WindowInfo {
                id,
                mode: e.mode,
                state: e.state,
                rect: e.rect,
                z: e.z,
                focus: state.focus == Some(id),
                hidden: e.hidden,
                parent: e.parent,
                modal: e.modal,
            })
            .collect();
        list.sort_by_key(|w| (w.id != 0, w.z));
        list
    }

    pub fn shortcut(&self, text: &str, scope: &str, owner: u32, on: bool) -> Result<(), String> {
        let combo = Combo::parse(text, crate::keys::by_name)?;
        let scope: Scope = scope.parse()?;
        let mut state = self.state();
        let binding = Binding { combo, scope, owner };
        if on {
            state.shortcuts.register(binding, text).map_err(|e| e.to_string())
        } else {
            state.shortcuts.unregister(combo, scope, owner);
            Ok(())
        }
    }

    pub fn animate(&self, window: u32) {
        if let Some(s) = server() {
            s.broker.push(Event { kind: "windowanimated".into(), window: Some(window), ..Default::default() });
        }
    }

    pub fn launch(&self, argv: &[String], cwd: Option<&str>, env: &[(String, String)]) -> Result<u32, String> {
        let (program, args) = argv.split_first().ok_or("launch: no program")?;
        let mut command = std::process::Command::new(program);
        command.args(args).envs(env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command.spawn().map(|child| child.id()).map_err(|e| format!("launch {program}: {e}"))
    }

    pub fn stats(&self) -> Vec<(&'static str, f64)> {
        let state = self.state();
        vec![("frames", state.frames as f64), ("windows", state.entries.values().filter(|e| e.opened).count() as f64)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> State {
        State { screen: [1000.0, 800.0, 1.0], ..State::default() }
    }

    fn apply(state: &mut State, id: u32, to: Option<WindowState>) -> Option<WindowState> {
        let change = state.change_state(id, to)?;
        if let Some(rect) = change.rect {
            state.entries.get_mut(&id).expect("changed").rect = rect;
        }
        Some(change.state)
    }

    fn open(state: &mut State, grant: Grant) -> u32 {
        let (id, _) = state.grant(grant);
        state.entries.get_mut(&id).expect("granted").opened = true;
        id
    }

    fn order(state: &State) -> Vec<u32> {
        state.layers().iter().map(|l| l.id).collect()
    }

    #[test]
    fn a_child_opens_over_its_parent_and_stays_above_it() {
        let mut s = screen();
        let parent = open(&mut s, Grant { rect: Some([100.0, 100.0, 600.0, 400.0]), ..Grant::default() });
        let child = open(&mut s, Grant { parent: Some(parent), size: Some([200.0, 100.0]), ..Grant::default() });
        let inner = open(&mut s, Grant { parent: Some(child), size: Some([100.0, 50.0]), ..Grant::default() });
        assert_eq!(s.entries[&child].parent, Some(parent));
        assert_eq!(s.entries[&child].rect, [300.0, 250.0, 200.0, 100.0]);
        assert_eq!(s.entries[&inner].rect, [350.0, 275.0, 100.0, 50.0]);
        let other = open(&mut s, Grant::default());
        assert_eq!(order(&s), vec![parent, child, inner, other]);
        s.raise(parent);
        assert_eq!(order(&s), vec![other, parent, child, inner]);
        s.raise(other);
        s.raise(child);
        assert_eq!(order(&s), vec![parent, other, child, inner]);
    }

    #[test]
    fn a_modal_child_takes_its_parents_input() {
        let mut s = screen();
        let parent = open(&mut s, Grant { rect: Some([0.0, 0.0, 600.0, 400.0]), ..Grant::default() });
        let plain = open(&mut s, Grant { parent: Some(parent), rect: Some([400.0, 300.0, 100.0, 50.0]), ..Grant::default() });
        assert_eq!(s.modal_child(parent), None);
        let hit = s.hit(10.0, 10.0).expect("parent");
        assert_eq!((hit.target, hit.blocked), (parent, false));
        let dialog = open(&mut s, Grant { parent: Some(parent), modal: true, rect: Some([200.0, 150.0, 200.0, 100.0]), ..Grant::default() });
        let inner = open(&mut s, Grant { parent: Some(dialog), modal: true, rect: Some([250.0, 175.0, 50.0, 50.0]), ..Grant::default() });
        assert_eq!(s.modal_child(parent), Some(inner));
        assert_eq!(s.modal_child(dialog), Some(inner));
        assert_eq!(s.modal_child(plain), None);
        let hit = s.hit(10.0, 10.0).expect("blocked parent");
        assert_eq!((hit.target, hit.blocked), (inner, true));
        let hit = s.hit(210.0, 160.0).expect("blocked dialog");
        assert_eq!((hit.target, hit.blocked), (inner, true));
        let hit = s.hit(260.0, 180.0).expect("inner");
        assert_eq!((hit.target, hit.blocked), (inner, false));
        let hit = s.hit(410.0, 310.0).expect("plain child");
        assert_eq!((hit.target, hit.blocked), (plain, false));
        s.entries.get_mut(&inner).expect("inner").hidden = true;
        assert_eq!(s.modal_child(parent), Some(dialog));
        assert!(s.forget(dialog).is_some());
        assert_eq!(s.modal_child(parent), None);
        assert_eq!((s.entries[&inner].parent, s.entries[&inner].modal), (None, false));
        assert_eq!(s.hit(10.0, 10.0).map(|h| (h.target, h.blocked)), Some((parent, false)));
    }

    #[test]
    fn states_change_rects_and_restore_them() {
        let mut s = screen();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 300.0, 200.0]), ..Grant::default() });
        assert_eq!(apply(&mut s, w, Some(WindowState::Filled)), Some(WindowState::Filled));
        assert_eq!(s.entries[&w].rect, [0.0, 0.0, 1000.0, 800.0]);
        assert!(apply(&mut s, w, Some(WindowState::Fullscreen)).is_some());
        assert_eq!(apply(&mut s, w, None), Some(WindowState::Filled));
        assert!(apply(&mut s, w, Some(WindowState::Normal)).is_some());
        assert_eq!(s.entries[&w].rect, [100.0, 100.0, 300.0, 200.0]);
    }

    #[test]
    fn a_minimized_window_is_not_drawn_or_hit_and_comes_back() {
        let mut s = screen();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 300.0, 200.0]), ..Grant::default() });
        assert!(apply(&mut s, w, Some(WindowState::Minimized)).is_some());
        assert!(s.layers().iter().all(|l| l.id != w));
        assert!(s.hit(150.0, 150.0).is_none());
        assert_eq!(apply(&mut s, w, None), Some(WindowState::Normal));
        assert!(s.layers().iter().any(|l| l.id == w));
    }

    #[test]
    fn desktops_panels_and_fixed_windows_refuse_fill_and_full_screen() {
        let mut s = screen();
        let desktop = open(&mut s, Grant { desktop: true, ..Grant::default() });
        let panel = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 0.0, 100.0, 30.0]), ..Grant::default() });
        let fixed = open(&mut s, Grant { mode: Some(Mode::Fixed), rect: Some([10.0, 10.0, 100.0, 100.0]), ..Grant::default() });
        for id in [desktop, panel] {
            for state in WindowState::ALL {
                assert!(apply(&mut s, id, Some(*state)).is_none(), "{id} {state:?}");
            }
        }
        assert!(apply(&mut s, fixed, Some(WindowState::Filled)).is_none());
        assert!(apply(&mut s, fixed, Some(WindowState::Fullscreen)).is_none());
        assert_eq!(s.entries[&fixed].rect, [10.0, 10.0, 100.0, 100.0]);
    }

    #[test]
    fn panels_reserve_edges_of_the_work_area() {
        let mut s = screen();
        let top = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 0.0, 1000.0, 30.0]), ..Grant::default() });
        let dock = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 0.0, 80.0, 800.0]), ..Grant::default() });
        let plain = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 700.0, 1000.0, 100.0]), ..Grant::default() });
        for id in [top, dock, plain] {
            s.entries.get_mut(&id).expect("panel").panel = true;
        }
        s.entries.get_mut(&top).expect("top").reserve = Some((acde_model::edge::TOP, 30.0));
        s.entries.get_mut(&dock).expect("dock").reserve = Some((acde_model::edge::LEFT, 80.0));
        assert_eq!(s.work_area(), [80.0, 30.0, 920.0, 770.0]);
        let w = open(&mut s, Grant { rect: Some([200.0, 200.0, 300.0, 200.0]), ..Grant::default() });
        assert_eq!(apply(&mut s, w, Some(WindowState::Filled)), Some(WindowState::Filled));
        assert_eq!(s.entries[&w].rect, [80.0, 30.0, 920.0, 770.0]);
        assert_eq!(s.refill(), (Some([80.0, 30.0, 920.0, 770.0]), vec![]));
        s.entries.get_mut(&dock).expect("dock").hidden = true;
        assert_eq!(s.refill(), (Some([0.0, 30.0, 1000.0, 770.0]), vec![w]));
        s.entries.get_mut(&dock).expect("dock").hidden = false;
        s.entries.get_mut(&top).expect("top").reserve = Some((acde_model::edge::TOP, 50.0));
        assert_eq!(s.refill(), (Some([80.0, 50.0, 920.0, 750.0]), vec![w]));
        assert!(apply(&mut s, w, Some(WindowState::Fullscreen)).is_some());
        assert_eq!(s.entries[&w].rect, [0.0, 0.0, 1000.0, 800.0]);
        assert!(s.refill().1.is_empty());
    }

    #[test]
    fn a_double_click_on_a_title_area_acts_without_starting_a_move() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("framed").frame = 32.0;
        let title = [300.0, 115.0];
        assert!(matches!(s.press(w, title, 0.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, title, 200.0, settings), Press::Double(Some(WindowState::Filled))));
        assert!(matches!(s.press(w, title, 300.0, settings), Press::Drag(0, _)), "a third press starts over");
        apply(&mut s, w, Some(WindowState::Filled));
        let top = [300.0, 15.0];
        assert!(matches!(s.press(w, top, 1000.0, settings), Press::Plain), "a filled window does not move");
        assert!(matches!(s.press(w, top, 1100.0, settings), Press::Double(Some(WindowState::Normal))));
        apply(&mut s, w, Some(WindowState::Normal));
        assert!(matches!(s.press(w, title, 2000.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, title, 2600.0, settings), Press::Drag(0, _)), "too slow");
        assert!(matches!(s.press(w, [300.0, 300.0], 2700.0, settings), Press::Plain), "the page");
        assert!(matches!(s.press(w, title, 2800.0, settings), Press::Drag(0, _)), "a press elsewhere starts over");
    }

    #[test]
    fn page_grab_hints_without_edges_take_the_double_click() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("frameless").hints = vec![([0.0, 0.0, 400.0, 40.0], 0), ([0.0, 0.0, 400.0, 4.0], acde_model::edge::TOP)];
        let caption = [200.0, 120.0];
        assert!(matches!(s.press(w, caption, 0.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, caption, 100.0, settings), Press::Double(Some(WindowState::Filled))));
        let edge = [200.0, 101.0];
        assert!(matches!(s.press(w, edge, 1000.0, settings), Press::Drag(acde_model::edge::TOP, _)));
        assert!(matches!(s.press(w, edge, 1100.0, settings), Press::Drag(acde_model::edge::TOP, _)), "resize edges never double-click");
    }

    #[test]
    fn the_declared_action_decides_and_some_windows_ignore_the_gesture() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let double = |s: &mut State, id: u32, at: [f64; 2], t: f64| {
            s.press(id, at, t, settings);
            s.press(id, at, t + 100.0, settings)
        };
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("framed").frame = 32.0;
        s.double_click = DoubleClick::Minimize;
        assert!(matches!(double(&mut s, w, [300.0, 115.0], 0.0), Press::Double(Some(WindowState::Minimized))));
        s.double_click = DoubleClick::Off;
        assert!(matches!(double(&mut s, w, [300.0, 115.0], 1000.0), Press::Double(None)));
        s.double_click = DoubleClick::Fill;
        let fixed = open(&mut s, Grant { mode: Some(Mode::Fixed), rect: Some([600.0, 100.0, 300.0, 200.0]), ..Grant::default() });
        s.entries.get_mut(&fixed).expect("fixed").frame = 32.0;
        assert!(matches!(double(&mut s, fixed, [750.0, 115.0], 2000.0), Press::Double(None)));
        let pinned = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 700.0, 300.0, 100.0]), ..Grant::default() });
        s.entries.get_mut(&pinned).expect("pinned").hints = vec![([0.0, 0.0, 300.0, 100.0], 0)];
        assert!(matches!(double(&mut s, pinned, [100.0, 750.0], 3000.0), Press::Plain));
        let (desktop, _) = s.grant(Grant { desktop: true, ..Grant::default() });
        s.entries.get_mut(&desktop).expect("desktop").hints = vec![([0.0, 0.0, 1000.0, 800.0], 0)];
        assert!(matches!(double(&mut s, desktop, [10.0, 10.0], 4000.0), Press::Plain));
    }

    #[test]
    fn a_parent_must_be_another_open_window() {
        let mut s = screen();
        let (desktop, _) = s.grant(Grant { desktop: true, ..Grant::default() });
        let lone = open(&mut s, Grant { parent: Some(999), modal: true, ..Grant::default() });
        assert_eq!((s.entries[&lone].parent, s.entries[&lone].modal), (None, false));
        let on_desktop = open(&mut s, Grant { parent: Some(desktop), ..Grant::default() });
        assert_eq!(s.entries[&on_desktop].parent, None);
        let child = open(&mut s, Grant { parent: Some(lone), ..Grant::default() });
        open(&mut s, Grant { window: Some(lone), parent: Some(child), ..Grant::default() });
        assert_eq!(s.entries[&lone].parent, None);
        open(&mut s, Grant { window: Some(lone), parent: Some(lone), ..Grant::default() });
        assert_eq!(s.entries[&lone].parent, None);
    }
}
