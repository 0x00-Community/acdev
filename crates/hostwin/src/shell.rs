use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use acde_model::{Binding, Combo, Event, Inbox, Injected, Mode, Scope, Shortcuts, Waker};

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
    pub before_fullscreen: Option<[f64; 4]>,
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
    pub frame: f64,
    pub backdrop: Option<([f64; 4], [f64; 4])>,
    pub pending: Option<([f64; 4], [f64; 4])>,
    pub drawn: (u32, u32),
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

    pub fn bar(&self) -> acde_render::Bar {
        acde_render::Bar {
            title: self.title.clone(),
            width: self.rect[2],
            height: self.frame,
            scale: 1.0,
            style: acde_render::FrameStyle::current(),
            fullscreen: self.mode == Mode::Fullscreen,
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
            let child = self
                .entries
                .iter()
                .filter(|(_, e)| e.parent == Some(current) && e.modal && e.opened && !e.hidden)
                .max_by_key(|(_, e)| e.z)
                .map(|(&child, _)| child);
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
        let mut shown: Vec<(&u32, &Entry)> = self.entries.iter().filter(|(_, e)| e.opened && !e.hidden).collect();
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

    pub fn pixels(&self, rect: [f64; 4]) -> (u32, u32) {
        let scale = self.screen[2];
        (((rect[2] * scale).round() as u32).max(1), ((rect[3] * scale).round() as u32).max(1))
    }

    pub fn content(&self, e: &Entry) -> (u32, u32) {
        let [x, y, w, h] = e.rect;
        self.pixels([x, y, w, (h - e.frame).max(1.0)])
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
        let rect = match entry.mode {
            Mode::Fullscreen => return,
            Mode::Fixed => [rect[0], rect[1], entry.rect[2], entry.rect[3]],
            _ => rect,
        };
        drop(state);
        server().expect("hostwin").set_rect(window, rect);
    }

    pub fn focus(&self, window: u32) {
        if let Some(e) = self.state().entries.get_mut(&window) {
            e.hidden = false;
        }
        server().expect("hostwin").activate(window);
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
