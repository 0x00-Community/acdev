use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use acde_model::{Binding, Combo, Event, Inbox, Scope, Shortcuts, Waker};

use crate::app::{Cmd, server};
use crate::surface::{Link, Shot};

const CAPTURE_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

pub const FIRST_WEB: u32 = 1 << 20;
const DEFAULT_SIZE: [f64; 2] = [800.0, 600.0];

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

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "fullscreen" => Mode::Fullscreen,
            "free" => Mode::Free,
            "fixed" => Mode::Fixed,
            "pinned" => Mode::Pinned,
            _ => return None,
        })
    }

    pub fn from_code(code: u32) -> Option<Self> {
        Some(match code {
            0 => Mode::Fullscreen,
            1 => Mode::Free,
            2 => Mode::Fixed,
            3 => Mode::Pinned,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Injected {
    Move(f64, f64),
    Motion(f64, f64),
    Button { button: u32, pressed: bool },
    Wheel(f64, f64),
    Key { code: u32, pressed: bool },
}

#[derive(Default)]
pub struct Grant {
    pub desktop: bool,
    pub hidden: bool,
    pub window: Option<u32>,
    pub mode: Option<Mode>,
    pub rect: Option<[f64; 4]>,
    pub size: Option<[f64; 2]>,
}

#[derive(Clone, Debug)]
pub struct WindowInfo {
    pub id: u32,
    pub mode: Mode,
    pub rect: [f64; 4],
    pub z: u64,
    pub focus: bool,
    pub hidden: bool,
}

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
    pub hints: Vec<([f64; 4], u32)>,
}

#[derive(Default)]
pub(crate) struct State {
    pub tokens: HashMap<u64, u32>,
    pub entries: BTreeMap<u32, Entry>,
    pub next: u32,
    pub focus: Option<u32>,
    pub z: u64,
    pub shortcuts: Shortcuts,
    pub names: HashMap<Combo, String>,
    pub screen: [f64; 3],
    pub origin: [f64; 2],
    pub frames: u64,
}

impl State {
    pub fn raise(&mut self, id: u32) {
        self.z += 1;
        let z = self.z;
        if let Some(e) = self.entries.get_mut(&id) {
            e.z = z;
        }
    }

    pub fn inbox(&self, id: u32) -> Option<Arc<Inbox>> {
        self.entries.get(&id).and_then(|e| e.inbox.clone())
    }

    fn token() -> u64 {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::collections::hash_map::RandomState::new().hash_one((n, acde_log::now_ms().to_bits()))
            | 1
    }

    fn centered(&self, [w, h]: [f64; 2]) -> [f64; 4] {
        let [sw, sh, _] = self.screen;
        let shown = self
            .entries
            .values()
            .filter(|e| !e.desktop && !e.panel)
            .count() as f64;
        let (w, h) = (w.min(sw.max(320.0)), h.min(sh.max(240.0)));
        [
            ((sw - w) / 2.0 + shown * 32.0).max(0.0),
            ((sh - h) / 2.0 + shown * 32.0).max(0.0),
            w,
            h,
        ]
    }
}

pub(crate) fn key_code(name: &str) -> Option<u32> {
    crate::keys::by_name(name)
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
        let mut state = self.state();
        let id = if grant.desktop {
            0
        } else if let Some(w) = grant.window {
            w
        } else {
            state.next = state.next.max(FIRST_WEB);
            let id = state.next;
            state.next += 1;
            id
        };
        let mode = grant.mode.unwrap_or(if grant.desktop {
            Mode::Fullscreen
        } else {
            Mode::Free
        });
        let placed = grant.rect.is_some();
        let rect = if grant.desktop {
            let [w, h, _] = state.screen;
            [0.0, 0.0, w, h]
        } else {
            grant
                .rect
                .unwrap_or_else(|| state.centered(grant.size.unwrap_or(DEFAULT_SIZE)))
        };
        let token = State::token();
        state.tokens.insert(token, id);
        let panel = mode == Mode::Pinned && !grant.desktop;
        let entry = state.entries.entry(id).or_insert_with(|| Entry {
            desktop: grant.desktop,
            panel,
            mode,
            rect,
            placed,
            before_fullscreen: None,
            title: String::new(),
            hidden: grant.hidden,
            opened: false,
            z: 0,
            inbox: None,
            link: None,
            hints: Vec::new(),
        });
        entry.mode = mode;
        if placed || !entry.opened {
            entry.rect = rect;
            entry.placed = placed;
        }
        state.raise(id);
        (id, token)
    }

    pub fn release(&self, window: u32) {
        let mut state = self.state();
        state.tokens.retain(|_, w| *w != window);
        if state
            .entries
            .get(&window)
            .is_some_and(|e| !e.opened && e.link.is_none())
        {
            state.entries.remove(&window);
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
        entry.rect = rect;
        let panel = entry.panel;
        let link = entry.link.clone();
        drop(state);
        if panel {
            return;
        }
        if let Some(link) = link {
            link.place(rect);
        }
        server().expect("hostwin").send(Cmd::Place(window, rect));
    }

    pub fn set_mode(&self, window: u32, mode: Mode) {
        crate::surface::set_mode(window, mode);
    }

    pub fn focus(&self, window: u32) {
        let mut state = self.state();
        if let Some(e) = state.entries.get_mut(&window) {
            e.hidden = false;
        }
        state.raise(window);
        drop(state);
        server().expect("hostwin").send(Cmd::Focus(window));
    }

    pub fn hide(&self, window: u32, hidden: bool) {
        let mut state = self.state();
        let Some(e) = state.entries.get_mut(&window) else {
            return;
        };
        e.hidden = hidden;
        drop(state);
        server().expect("hostwin").send(Cmd::Hide(window, hidden));
        if !hidden {
            self.focus(window);
        }
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

    pub fn dev_respond(&self, id: i64, result: Result<&str, &str>) -> Result<(), String> {
        crate::dev::respond(id, result)
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
            })
            .collect();
        list.sort_by_key(|w| (w.id != 0, w.z));
        list
    }

    pub fn screen(&self) -> [f64; 3] {
        self.state().screen
    }

    pub fn shortcut(&self, text: &str, scope: &str, owner: u32, on: bool) -> Result<(), String> {
        let combo = Combo::parse(text, key_code)?;
        let scope: Scope = scope.parse()?;
        let mut state = self.state();
        let binding = Binding {
            combo,
            scope,
            owner,
        };
        if on {
            state
                .shortcuts
                .register(binding)
                .map_err(|e| e.to_string())?;
            state.names.insert(combo, text.to_owned());
            Ok(())
        } else {
            state.shortcuts.unregister(combo, scope, owner);
            Ok(())
        }
    }

    pub fn animate(&self, window: u32) {
        if let Some(s) = server() {
            s.broker.push(Event {
                kind: "windowanimated".into(),
                window: Some(window),
                ..Default::default()
            });
        }
    }

    pub fn launch(
        &self,
        argv: &[String],
        cwd: Option<&str>,
        env: &[(String, String)],
    ) -> Result<u32, String> {
        let (program, args) = argv.split_first().ok_or("launch: no program")?;
        let mut command = std::process::Command::new(program);
        command.args(args).envs(env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command
            .spawn()
            .map(|child| child.id())
            .map_err(|e| format!("launch {program}: {e}"))
    }

    pub fn stats(&self) -> Vec<(&'static str, f64)> {
        let state = self.state();
        vec![
            ("frames", state.frames as f64),
            (
                "windows",
                state.entries.values().filter(|e| e.opened).count() as f64,
            ),
        ]
    }
}
