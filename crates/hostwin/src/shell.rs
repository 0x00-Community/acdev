use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use acde_model::{Binding, Change, Clicks, Combo, DoubleClick, Event, Inbox, Injected, Mode, Restore, Scope, Shortcuts, Waker, WindowState};

use crate::app::server;
use crate::output::compose::Layer;
use crate::output::surface::{Link, Shot};
use crate::platform::Cmd;

pub(crate) mod pointer;
pub(crate) use pointer::Press;

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
    pub host: bool,
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
    pub minimize: bool,
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
    pub host: bool,
    pub minimize: bool,
    pub input: Option<[f64; 4]>,
    pub reserve: Option<(u32, f64)>,
    pub frame: f64,
    pub backdrop: Option<([f64; 4], [f64; 4])>,
    pub pending: Option<([f64; 4], [f64; 4])>,
    pub drawn: (u32, u32),
}

impl Entry {
    pub fn grab_hints(&self, theme: &acde_render::FrameTheme) -> Vec<([f64; 4], u32)> {
        let top = self.frame;
        let mut hints: Vec<([f64; 4], u32)> = self.hints.iter().map(|&([x, y, w, h], edges)| ([x, y + top, w, h], edges)).collect();
        if top > 0.0 {
            hints.extend(theme.grab_hints(self.rect[2], self.rect[3], top));
        }
        hints
    }

    pub fn shown(&self) -> bool {
        self.opened && !self.hidden && self.state.shown()
    }

    pub fn bar(&self, theme: acde_render::FrameTheme, active: bool) -> acde_render::Bar {
        acde_render::Bar {
            title: self.title.clone(),
            width: self.rect[2],
            height: self.frame,
            scale: 1.0,
            style: acde_render::FrameStyle::current(),
            fullscreen: self.mode == Mode::Fullscreen || self.state == WindowState::Fullscreen,
            theme,
            active,
            minimize: self.minimize,
        }
    }
}

pub(crate) struct Resized {
    pub rescaled: bool,
    pub rects: Vec<(u32, [f64; 4])>,
    pub work: Option<[f64; 4]>,
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
    pub theme: acde_render::FrameTheme,
    pub controls: bool,
    pub standalone: bool,
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

    pub fn focus_target(&self, id: u32) -> Option<u32> {
        let id = match self.entries.get(&id) {
            Some(e) if e.panel => e.owner?,
            _ => id,
        };
        Some(self.modal_child(id).unwrap_or(id))
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

    pub fn host_size(&self, grant: &Grant) -> Option<[f64; 2]> {
        grant.size.filter(|_| grant.host && !grant.desktop && !self.standalone)
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
        entry.host = grant.host && self.controls && !grant.desktop;
        self.standalone |= grant.host;
        let entry = self.entries.get_mut(&id).expect("granted");
        entry.minimize = grant.host || !self.standalone;
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

    pub fn host_entry(&self) -> Option<u32> {
        self.entries.iter().find(|(_, e)| e.host).map(|(&id, _)| id)
    }

    pub fn set_refresh(&mut self, hz: Option<f64>) -> Option<Vec<Link>> {
        if self.refresh == hz {
            return None;
        }
        self.refresh = hz;
        Some(self.entries.values().filter(|e| !e.panel).filter_map(|e| e.link.clone()).collect())
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

    pub fn resize(&mut self, screen: [f64; 2], scale: f64) -> Resized {
        let rescaled = self.screen[2] != scale;
        self.screen = [screen[0], screen[1], scale];
        let (whole, work) = (self.screen_rect(), self.work_area());
        let rects = self
            .entries
            .iter()
            .filter_map(|(&id, e)| match e.state {
                _ if id == 0 || e.mode == Mode::Fullscreen || e.state == WindowState::Fullscreen => Some((id, whole)),
                WindowState::Filled => Some((id, work)),
                _ => None,
            })
            .collect();
        let (work, _) = self.refill();
        Resized { rescaled, rects, work }
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
        if to == WindowState::Minimized && !entry.minimize {
            return None;
        }
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
        let (granted, size) = {
            let mut state = self.state();
            let size = state.host_size(&grant);
            (state.grant(grant), size)
        };
        if let Some(size) = size.filter(|_| crate::app::size_from_env().is_none()) {
            server().expect("hostwin").send(Cmd::HostSize(size));
        }
        granted
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
        let panel = e.panel;
        let focused = state.focus == Some(window);
        drop(state);
        let server = server().expect("hostwin");
        if !hidden && !panel {
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

    pub fn drop_files(&self, window: u32, at: Option<[f64; 2]>, paths: Vec<std::path::PathBuf>) -> Result<(), String> {
        if !self.state().entries.get(&window).is_some_and(|e| e.shown()) {
            return Err(format!("no window {window} on screen"));
        }
        server().expect("hostwin").send(Cmd::Drop { window, at, paths });
        Ok(())
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

    pub fn resize_screen(&self, width: f64, height: f64) -> Result<(), String> {
        if !(width.is_finite() && height.is_finite() && width >= 1.0 && height >= 1.0) {
            return Err(format!("resize: {width}x{height} is not a size"));
        }
        let (reply, got) = std::sync::mpsc::sync_channel(1);
        server().expect("hostwin").send(Cmd::Resize { size: [width, height], reply });
        got.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| "the host window did not answer".to_owned())?
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
                minimize: e.minimize,
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
pub(crate) mod tests {
    use super::*;

    pub(crate) fn screen() -> State {
        State { screen: [1000.0, 800.0, 1.0], ..State::default() }
    }

    pub(crate) fn apply(state: &mut State, id: u32, to: Option<WindowState>) -> Option<WindowState> {
        let change = state.change_state(id, to)?;
        if let Some(rect) = change.rect {
            state.entries.get_mut(&id).expect("changed").rect = rect;
        }
        Some(change.state)
    }

    pub(crate) fn open(state: &mut State, grant: Grant) -> u32 {
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
    fn focus_asked_for_a_panel_goes_to_its_owner() {
        let mut s = screen();
        let desktop = open(&mut s, Grant { desktop: true, ..Grant::default() });
        let panel = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 0.0, 400.0, 40.0]), ..Grant::default() });
        assert!(s.entries[&panel].panel);
        assert_eq!(s.focus_target(panel), None, "a panel not yet opened by a page focuses nothing");
        s.entries.get_mut(&panel).expect("panel").owner = Some(desktop);
        assert_eq!(s.focus_target(panel), Some(desktop));
        assert_eq!(s.focus_target(desktop), Some(desktop));
        let window = open(&mut s, Grant { rect: Some([0.0, 0.0, 600.0, 400.0]), ..Grant::default() });
        let dialog = open(&mut s, Grant { parent: Some(window), modal: true, size: Some([200.0, 100.0]), ..Grant::default() });
        assert_eq!(s.focus_target(window), Some(dialog), "modal children still take their parent's focus");
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
    fn a_resized_output_reports_its_work_area_and_moves_what_fills_it() {
        let mut s = screen();
        let desktop = open(&mut s, Grant { desktop: true, ..Grant::default() });
        assert_eq!(s.refill().0, Some([0.0, 0.0, 1000.0, 800.0]));
        let filled = open(&mut s, Grant { rect: Some([200.0, 200.0, 300.0, 200.0]), ..Grant::default() });
        let free = open(&mut s, Grant { rect: Some([10.0, 10.0, 100.0, 100.0]), ..Grant::default() });
        assert_eq!(apply(&mut s, filled, Some(WindowState::Filled)), Some(WindowState::Filled));
        let resized = s.resize([400.0, 300.0], 1.0);
        assert!(!resized.rescaled);
        assert_eq!(resized.work, Some([0.0, 0.0, 400.0, 300.0]));
        assert_eq!(resized.rects, vec![(desktop, [0.0, 0.0, 400.0, 300.0]), (filled, [0.0, 0.0, 400.0, 300.0])]);
        assert_eq!(s.entries[&free].rect, [10.0, 10.0, 100.0, 100.0]);
        let again = s.resize([400.0, 300.0], 2.0);
        assert!(again.rescaled);
        assert_eq!(again.work, None);
        let dock = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 0.0, 80.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&dock).expect("dock").panel = true;
        s.entries.get_mut(&dock).expect("dock").reserve = Some((acde_model::edge::LEFT, 80.0));
        assert_eq!(s.resize([900.0, 600.0], 2.0).work, Some([80.0, 0.0, 820.0, 600.0]));
    }

    #[test]
    fn standalone_secondary_windows_cannot_minimize() {
        let mut s = screen();
        let free = open(&mut s, Grant::default());
        assert!(s.entries[&free].minimize);
        let primary = open(&mut s, Grant { host: true, mode: Some(Mode::Fullscreen), ..Grant::default() });
        let second = open(&mut s, Grant { rect: Some([10.0, 10.0, 300.0, 200.0]), ..Grant::default() });
        assert!(s.entries[&primary].minimize && !s.entries[&second].minimize);
        assert!(apply(&mut s, second, Some(WindowState::Minimized)).is_none());
        assert!(apply(&mut s, second, Some(WindowState::Filled)).is_some(), "other states still work");
        s.entries.get_mut(&second).expect("second").frame = 32.0;
        assert!(!s.entries[&second].bar(s.theme, true).minimize);
    }

    #[test]
    fn only_the_first_host_grant_sizes_the_host_window() {
        let mut s = screen();
        let free = Grant { size: Some([520.0, 680.0]), ..Grant::default() };
        assert_eq!(s.host_size(&free), None);
        let primary = Grant { host: true, mode: Some(Mode::Fullscreen), size: Some([520.0, 680.0]), ..Grant::default() };
        assert_eq!(s.host_size(&primary), Some([520.0, 680.0]));
        assert_eq!(s.host_size(&Grant { host: true, ..Grant::default() }), None);
        open(&mut s, primary);
        let again = Grant { host: true, mode: Some(Mode::Fullscreen), size: Some([300.0, 200.0]), ..Grant::default() };
        assert_eq!(s.host_size(&again), None);
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

    #[test]
    fn a_new_monitor_rate_reaches_each_window_once() {
        let mut s = screen();
        let window = open(&mut s, Grant::default());
        let panel = open(&mut s, Grant { mode: Some(Mode::Pinned), ..Grant::default() });
        let ((link, got), (shared, _)) = (Link::pair(), Link::pair());
        s.entries.get_mut(&window).expect("window").link = Some(link);
        s.entries.get_mut(&panel).expect("panel").link = Some(shared);
        let links = s.set_refresh(Some(60.0)).expect("changed");
        assert_eq!(links.len(), 1, "a panel is drawn by its owner");
        links[0].send(crate::output::surface::Msg::Refresh(Some(60.0)));
        assert!(matches!(got.try_recv(), Ok(crate::output::surface::Msg::Refresh(Some(60.0)))));
        assert!(s.set_refresh(Some(60.0)).is_none(), "another monitor at the same rate");
        assert!(s.set_refresh(Some(144.0)).is_some());
        assert_eq!(s.refresh, Some(144.0));
    }
}
