//! `acde:inspect` (AGENTS.md「看和操作桌面」): the screen as a text tree a harness reads, and acting on its refs. One
//! inspector for the runtime (the desktop and the package's services share its window refs and diff baselines), run
//! on the caller's thread off its loop. A window's tree is its page's (asked of that isolate: its document and its JS
//! for where to click, typing, focus, settling) or, for a window no isolate draws, AT-SPI's. Clicks and keys go
//! through the compositor's `inject`, like real input.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use acde_shell::compositor::{BTN_LEFT, Injected, WheelKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Ask, Desk, Done, Failure};

const BTN_RIGHT: u32 = 0x111;
const LIMIT: usize = 600;
const FIND_LIMIT: usize = 3000;
const SETTLE: Duration = Duration::from_millis(400);
const QUIET_MS: u32 = 200;
const BUSY_MS: u32 = 3000;
const OPEN_WAIT: Duration = Duration::from_secs(5);
const ASK_WAIT: Duration = Duration::from_secs(10);
const GENERIC: [&str; 15] = ["generic", "filler", "panel", "section", "unknown", "redundant-object", "split-pane", "layered-pane", "scroll-pane", "viewport", "internal-frame", "root-pane", "glass-pane", "option-pane", "window"];
const PRESSABLE: [&str; 6] = ["button", "link", "menuitem", "checkbox", "radio", "tab"];

/// What a harness does to a ref.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Click,
    Double,
    Right,
    Hover,
    Scroll,
    Type,
    Settext,
    Focus,
    Key,
    Restore,
    Minimize,
    Close,
}

impl Action {
    const fn name(self) -> &'static str {
        match self {
            Action::Click => "click",
            Action::Double => "double",
            Action::Right => "right",
            Action::Hover => "hover",
            Action::Scroll => "scroll",
            Action::Type => "type",
            Action::Settext => "settext",
            Action::Focus => "focus",
            Action::Key => "key",
            Action::Restore => "restore",
            Action::Minimize => "minimize",
            Action::Close => "close",
        }
    }
}

#[derive(Deserialize)]
pub struct Step {
    #[serde(rename = "ref")]
    pub target: String,
    pub action: Action,
    #[serde(default)]
    pub text: Option<Value>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SnapshotOptions {
    window: Option<String>,
    #[serde(rename = "ref")]
    target: Option<String>,
    all: bool,
    diff: bool,
    limit: Option<f64>,
    find: Option<String>,
    tree: Option<bool>,
}

/// A window as inspect shows it (acde-api `InspectWindow`).
#[derive(Serialize, Clone)]
struct Win {
    #[serde(rename = "ref")]
    target: String,
    id: u32,
    kind: &'static str,
    app: Option<String>,
    title: Option<String>,
    mode: &'static str,
    rect: [i32; 4],
    z: i32,
    focus: bool,
    hidden: bool,
    pid: Option<u32>,
    #[serde(skip)]
    page: bool,
}

impl Win {
    fn desktop(&self) -> bool {
        self.id == 0
    }

    fn header(&self) -> String {
        let kind = if self.desktop() { "桌面".to_owned() } else { format!("窗口 {}", self.app.as_deref().unwrap_or("")).trim().to_owned() };
        let flags: Vec<&str> = [self.focus.then_some("焦点"), self.hidden.then_some("最小化"), (self.mode != "free").then_some(self.mode)].into_iter().flatten().collect();
        let title = self.title.as_ref().map(|t| format!(" {}", Value::from(t.as_str()))).unwrap_or_default();
        let flags = if flags.is_empty() { String::new() } else { format!(" {}", flags.join(" ")) };
        format!("{} {kind}{title}{flags}", self.target)
    }
}

/// A node of the tree (acde-api `InspectNode`).
#[derive(Serialize, Clone)]
struct Node {
    #[serde(rename = "ref")]
    target: String,
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    states: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    level: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rect: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    more: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<Node>,
}

/// The page's tree (acde-host `pageinspect.ts`).
#[derive(Deserialize)]
struct PageTree {
    #[serde(default)]
    hidden: u32,
    #[serde(default)]
    truncated: bool,
    nodes: Vec<PageNode>,
}

#[derive(Deserialize)]
struct PageNode {
    id: u32,
    role: String,
    name: Option<String>,
    value: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    level: Option<u32>,
    rect: [f64; 4],
    more: Option<u32>,
    #[serde(default)]
    children: Vec<PageNode>,
}

/// AT-SPI's tree (crates/runtime `atspi.rs`).
#[derive(Deserialize)]
struct AccessibleNode {
    id: String,
    role: String,
    name: Option<String>,
    value: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    rect: Option<[f64; 4]>,
    #[serde(default)]
    actions: Vec<String>,
    more: Option<u32>,
    #[serde(default)]
    children: Vec<AccessibleNode>,
}

/// Where to click an element, in the page (its `{error}` answers come back as failures).
#[derive(Deserialize)]
struct PagePoint {
    x: f64,
    y: f64,
}

#[derive(Default)]
struct Aliases {
    by_key: HashMap<String, u32>,
    by_number: HashMap<u32, (String, Option<[f64; 4]>)>,
    next: u32,
}

/// What inspect remembers within a session: window refs, AT-SPI node numbers, and what each tree last showed.
#[derive(Default)]
pub struct Inspector {
    refs: HashMap<u32, String>,
    next: u32,
    accessible: HashMap<u32, Aliases>,
    seen: HashMap<String, Vec<(String, String)>>,
    headers: String,
}

/// `w3` or `w3.12`.
struct Target {
    window: u32,
    node: Option<u32>,
}

impl TryFrom<&str> for Target {
    type Error = ();

    fn try_from(text: &str) -> Result<Self, ()> {
        let rest = text.trim().strip_prefix('w').ok_or(())?;
        let (window, node) = match rest.split_once('.') {
            Some((w, n)) => (w, Some(n.parse().map_err(|_| ())?)),
            None => (rest, None),
        };
        Ok(Target { window: window.parse().map_err(|_| ())?, node })
    }
}

/// Key names as harnesses write them (`ctrl+a backspace`) to evdev codes.
struct Keys;

impl Keys {
    const NAMED: [(&'static str, u32); 63] = [
        ("ctrl", 29), ("control", 29), ("shift", 42), ("alt", 56), ("super", 125), ("meta", 125), ("win", 125), ("enter", 28), ("return", 28),
        ("esc", 1), ("escape", 1), ("tab", 15), ("space", 57), ("backspace", 14), ("delete", 111), ("del", 111), ("up", 103), ("down", 108),
        ("left", 105), ("right", 106), ("home", 102), ("end", 107), ("pageup", 104), ("pagedown", 109), ("insert", 110), ("menu", 127),
        ("-", 12), ("=", 13), ("[", 26), ("]", 27), (";", 39), ("'", 40), ("`", 41), ("\\", 43), (",", 51), (".", 52), ("/", 53),
        ("minus", 12), ("equal", 13), ("bracketleft", 26), ("bracketright", 27), ("semicolon", 39), ("quote", 40), ("backquote", 41),
        ("backslash", 43), ("comma", 51), ("period", 52), ("slash", 53), ("capslock", 58), ("printscreen", 99), ("contextmenu", 127),
        ("arrowup", 103), ("arrowdown", 108), ("arrowleft", 105), ("arrowright", 106), ("controlleft", 29), ("shiftleft", 42),
        ("altleft", 56), ("metaleft", 125), ("controlright", 97), ("altright", 100), ("shiftright", 54), ("numpadenter", 96),
    ];
    const ROWS: [(&'static str, u32); 3] = [("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)];

    fn code(name: &str) -> Option<u32> {
        let lower = name.to_ascii_lowercase();
        if let Some((_, code)) = Self::NAMED.iter().find(|(n, _)| *n == lower) {
            return Some(*code);
        }
        let single = lower.strip_prefix("key").filter(|k| k.len() == 1).or_else(|| lower.strip_prefix("digit").filter(|k| k.len() == 1)).unwrap_or(&lower);
        let mut chars = single.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if let Some(code) = Self::ROWS.iter().find_map(|(row, start)| row.find(c).map(|i| start + i as u32)) {
                return Some(code);
            }
            if let Some(i) = "1234567890".find(c) {
                return Some(2 + i as u32);
            }
        }
        let f: u32 = lower.strip_prefix('f')?.parse().ok()?;
        match f {
            1..=10 => Some(58 + f),
            11 => Some(87),
            12 => Some(88),
            _ => None,
        }
    }
}

struct Acted {
    ok: bool,
    text: String,
    window: Option<Win>,
}

impl Acted {
    fn no(text: impl Into<String>) -> Self {
        Acted { ok: false, text: text.into(), window: None }
    }
}

impl Desk {
    fn inspector(&self) -> std::sync::MutexGuard<'_, Inspector> {
        self.inspector.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn accessibility(&self) -> Option<Arc<acde_runtime::Accessibility>> {
        let mut slot = self.accessibility.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            match acde_runtime::Accessibility::connect() {
                Ok(access) => *slot = Some(Some(Arc::new(access))),
                Err(e) => {
                    log::warn!("AT-SPI: {e}; windows no isolate draws have no semantics");
                    *slot = Some(None);
                }
            }
        }
        slot.clone().flatten()
    }

    /// Opens the accessibility bus ahead (in its own session, so programs started later report from the start).
    pub fn warm_accessibility(self: &Arc<Self>) {
        let desk = self.clone();
        std::thread::spawn(move || drop(desk.accessibility()));
    }

    fn windows_now(&self) -> Vec<Win> {
        let rows = self.link().list().0;
        let state = self.state();
        let mut inspector = self.inspector();
        let mut out = Vec::new();
        for row in rows {
            let id = row.window.unwrap_or(row.id);
            if id != 0 && state.panels.contains(&id) {
                continue;
            }
            let record = state.records.get(&id);
            if id != 0 && record.is_none() {
                continue;
            }
            let target = if id == 0 {
                "w0".to_owned()
            } else {
                let inspector = &mut *inspector;
                let next = &mut inspector.next;
                inspector.refs.entry(id).or_insert_with(|| {
                    *next += 1;
                    format!("w{next}")
                }).clone()
            };
            out.push(Win {
                target,
                id,
                kind: if id == 0 { "desktop" } else { "window" },
                app: record.and_then(|r| r.app.as_ref().map(|a| a.id.clone()).or(r.app_id.clone())),
                title: record.and_then(|r| r.title.clone()),
                mode: row.mode.as_str(),
                rect: [row.x, row.y, row.width as i32, row.height as i32],
                z: row.z,
                focus: row.focus,
                hidden: row.hidden,
                pid: row.pid,
                page: state.live.contains_key(&id),
            });
        }
        out.sort_by_key(|w| std::cmp::Reverse(w.z));
        out
    }

    fn shape(windows: &[Win]) -> String {
        windows.iter().map(|w| format!("{}{}{}", w.target, if w.focus { "*" } else { "" }, if w.hidden { "-" } else { "" })).collect::<Vec<_>>().join(" ")
    }

    /// Asks the page of `window` (acde-host `pageinspect.ts`); `{error}` it answers is a failure with that message.
    fn ask_page(&self, window: u32, method: &str, args: Value) -> Done<Value> {
        let answer = self.ask(window, Ask::Inspect, json!({ "method": method, "args": args })).recv_timeout(ASK_WAIT).map_err(|_| Failure::from(format!("window {window}'s page did not answer")))?;
        match answer.get("error").and_then(Value::as_str) {
            Some(error) => Err(Failure::from(error.to_owned())),
            None => Ok(answer),
        }
    }

    /// `snapshot(options)`: the windows (topmost first) and the focused window's tree (or the asked ones), as text.
    pub fn inspect_snapshot(&self, options: SnapshotOptions) -> Done<Value> {
        let windows = self.windows_now();
        let find = options.find.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(str::to_lowercase);
        let limit = if find.is_some() { FIND_LIMIT } else { options.limit.map_or(LIMIT, |l| (l as usize).clamp(20, 3000)) };
        let parsed = options.target.as_deref().and_then(|t| Target::try_from(t).ok());
        let wanted = parsed.as_ref().map(|p| format!("w{}", p.window)).or(options.window.clone());
        let targets: Vec<Win> = if options.tree == Some(false) {
            Vec::new()
        } else if let Some(wanted) = &wanted {
            windows.iter().filter(|w| &w.target == wanted).cloned().collect()
        } else if options.all || find.is_some() {
            windows.iter().filter(|w| !w.hidden).cloned().collect()
        } else {
            windows.iter().find(|w| w.focus && !w.hidden).or_else(|| windows.iter().find(|w| w.desktop())).cloned().into_iter().collect()
        };
        if let Some(wanted) = &wanted
            && targets.is_empty()
        {
            return Err(Failure::missing(format!("没有窗口 {wanted}")));
        }
        let headers: Vec<String> = windows.iter().map(Win::header).collect();
        let joined = headers.join("\n");
        let same = options.diff && self.inspector().headers == joined;
        self.inspector().headers = joined;
        let mut lines: Vec<String> = if same { vec!["窗口没变.".into()] } else { std::iter::once("窗口 (上面的在前):".to_owned()).chain(headers).collect() };
        let mut trees = serde_json::Map::new();
        let node = parsed.as_ref().and_then(|p| p.node);
        let under = node.map(|_| format!(" ({} 以下)", options.target.as_deref().unwrap_or(""))).unwrap_or_default();
        for window in &targets {
            let (nodes, notes) = self.tree(window, node, limit);
            if let Some(needle) = &find {
                let found: Vec<Node> = nodes.into_iter().filter_map(|n| Self::found(n, needle)).collect();
                if found.is_empty() {
                    continue;
                }
                let mut body = Vec::new();
                Self::lines(&found, 0, &mut body);
                lines.push(String::new());
                lines.push(format!("{} 里含 {} 的{under}:", window.target, Value::from(options.find.as_deref().unwrap_or("").trim())));
                lines.extend(body.into_iter().map(|(_, l)| l));
                trees.insert(window.target.clone(), serde_json::to_value(found).unwrap_or_default());
                continue;
            }
            let mut body = Vec::new();
            Self::lines(&nodes, 0, &mut body);
            trees.insert(window.target.clone(), serde_json::to_value(&nodes).unwrap_or_default());
            let key = node.map_or_else(|| window.target.clone(), |n| format!("{}.{n}", window.target));
            let before = self.inspector().seen.insert(key, body.clone());
            lines.push(String::new());
            lines.push(format!("{} 的内容{under}:", window.target));
            match before {
                Some(before) if options.diff => lines.extend(Self::diff(&before, &body)),
                _ if body.is_empty() => lines.push("(空)".into()),
                _ => lines.extend(body.into_iter().map(|(_, l)| l)),
            }
            lines.extend(notes);
        }
        if find.is_some() && trees.is_empty() {
            lines.push(String::new());
            lines.push(format!("没找到含 {} 的元素 (可见范围外的找不到; scroll 或换个窗口再找)", Value::from(options.find.as_deref().unwrap_or("").trim())));
        }
        Ok(json!({ "text": lines.join("\n"), "windows": windows, "trees": trees }))
    }

    /// `act(ref, action, arg)` / `run(steps)`: does them in turn (each waits for the page to settle), stops at a failure,
    /// then shows what changed.
    pub fn inspect_run(self: &Arc<Self>, steps: Vec<Step>) -> Done<Value> {
        if steps.is_empty() {
            return Ok(json!({ "ok": false, "text": "没有要做的步骤" }));
        }
        let before = Self::shape(&self.windows_now());
        let opening = self.opening();
        let mut said = Vec::new();
        let mut last: Option<Win> = None;
        let mut failed = false;
        let many = steps.len() > 1;
        for (i, step) in steps.iter().enumerate() {
            let done = self.step(step);
            said.push(if many { format!("{}. {}", i + 1, done.text) } else { done.text });
            let Some(window) = done.window.filter(|_| done.ok) else {
                failed = true;
                break;
            };
            if step.action == Action::Close {
                std::thread::sleep(SETTLE);
            } else {
                self.settle(&window);
            }
            last = Some(window);
        }
        let Some(last) = last else { return Ok(json!({ "ok": false, "text": said.join("\n") })) };
        if failed && many {
            said.push("(后面的步骤没做)".into());
        }
        self.arrive(&opening);
        let windows = self.windows_now();
        let moved = Self::shape(&windows) != before;
        if moved && let Some(focused) = windows.iter().find(|w| w.focus && !w.hidden).filter(|f| f.id != last.id) {
            self.settle(focused);
        }
        let after = if moved { SnapshotOptions { diff: true, ..Default::default() } } else { SnapshotOptions { window: Some(last.target.clone()), diff: true, ..Default::default() } };
        let after = self.inspect_snapshot(after)?;
        let text = format!("{}{}\n\n{}", said.join("\n"), if moved { " (窗口变了)" } else { "" }, after["text"].as_str().unwrap_or(""));
        Ok(json!({ "ok": !failed, "text": text }))
    }

    /// `open(name)`: an app by id or name, then the snapshot once its window is there.
    pub fn inspect_open(self: &Arc<Self>, name: &str) -> Done<Value> {
        let wanted = name.trim().to_lowercase();
        let apps: Vec<Arc<super::App>> = self.state().apps.iter().filter(|(_, ok)| *ok).map(|(a, _)| a.clone()).collect();
        let app = apps.iter().find(|a| a.id.to_lowercase() == wanted).or_else(|| apps.iter().find(|a| a.label.to_lowercase() == wanted)).or_else(|| apps.iter().find(|a| a.label.to_lowercase().contains(&wanted)));
        let Some(app) = app else {
            let names: Vec<&str> = apps.iter().map(|a| a.label.as_str()).collect();
            return Ok(json!({ "ok": false, "text": format!("没有叫 {name} 的应用 (有: {})", names.join(", ")) }));
        };
        let before = Self::shape(&self.windows_now());
        let window = self.launch(&app.id, None, acde_model::Mode::Free)?;
        self.raise(window);
        let started = Instant::now();
        while Self::shape(&self.windows_now()) == before && started.elapsed() < OPEN_WAIT {
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(focused) = self.windows_now().into_iter().find(|w| w.focus && !w.hidden) {
            self.settle(&focused);
        }
        let after = self.inspect_snapshot(SnapshotOptions::default())?;
        Ok(json!({ "ok": true, "text": format!("打开了应用 {} ({})\n\n{}", app.label, app.id, after["text"].as_str().unwrap_or("")) }))
    }

    fn step(&self, step: &Step) -> Acted {
        let Ok(target) = Target::try_from(step.target.as_str()) else { return Acted::no(format!("看不懂 ref {} (应该像 w3 或 w3.12)", step.target)) };
        let Some(window) = self.windows_now().into_iter().find(|w| w.target == format!("w{}", target.window)) else { return Acted::no(format!("没有窗口 w{}", target.window)) };
        let arg = step.text.clone().unwrap_or(Value::Null);
        let done = match target.node {
            None => self.window_act(&window, step.action, &arg),
            Some(node) if window.page => self.page_act(&window, node, step.action, &arg),
            Some(node) => self.accessible_act(&window, node, step.action, &arg),
        };
        match done {
            Ok((ok, text)) => Acted { ok, text, window: Some(window) },
            Err(failure) => Acted::no(failure.message),
        }
    }

    fn settle(&self, window: &Win) {
        if !window.page || self.ask_page(window.id, "settle", json!([QUIET_MS, BUSY_MS])).is_err() {
            std::thread::sleep(SETTLE);
        }
    }

    /// App windows the desk has opened that the compositor does not show yet.
    fn opening(&self) -> Vec<u32> {
        let shown: Vec<u32> = self.link().list().0.iter().map(|r| r.window.unwrap_or(r.id)).collect();
        self.state().records.iter().filter(|(id, r)| r.app.is_some() && !shown.contains(id)).map(|(id, _)| *id).collect()
    }

    fn arrive(&self, before: &[u32]) {
        let started = Instant::now();
        while self.opening().iter().any(|id| !before.contains(id)) && started.elapsed() < OPEN_WAIT {
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn text_of(arg: &Value) -> String {
        match arg {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        }
    }

    fn focus_window(&self, window: &Win) {
        if !window.desktop() {
            self.link().focus(window.id);
        }
    }

    fn window_act(&self, window: &Win, action: Action, arg: &Value) -> Done<(bool, String)> {
        Ok(match action {
            Action::Focus | Action::Restore => {
                if window.hidden {
                    self.hide(window.id, false);
                }
                self.focus_window(window);
                (true, format!("{} 到了最前面", window.target))
            }
            Action::Minimize if window.desktop() => (false, "桌面不能最小化".into()),
            Action::Minimize => {
                self.hide(window.id, true);
                (true, format!("{} 最小化了", window.target))
            }
            Action::Close if window.desktop() => (false, "桌面不能关".into()),
            Action::Close => {
                self.inspect_close(window.id);
                (true, format!("关了 {}", window.target))
            }
            Action::Key => {
                self.focus_window(window);
                self.keys(&Self::text_of(arg))?;
                (true, format!("在 {} 按了 {}", window.target, Self::text_of(arg)))
            }
            Action::Click | Action::Double | Action::Right | Action::Hover | Action::Scroll => {
                let [x, y, w, h] = window.rect;
                return self.pointer(window, f64::from(x) + f64::from(w) / 2.0, f64::from(y) + f64::from(h) / 2.0, action, arg);
            }
            Action::Type | Action::Settext => (false, format!("窗口不能 {}; 给一个元素的 ref", action.name())),
        })
    }

    /// Closing from inspect: an app window is asked (`beforeclose`), any other asked by the compositor.
    fn inspect_close(&self, window: u32) {
        let page = self.state().live.contains_key(&window);
        if !page {
            self.link().close(window);
            return;
        }
        if self.ask(window, Ask::BeforeClose, Value::Null).recv_timeout(Self::CLOSE_WAIT) == Ok(Value::Bool(false)) {
            return;
        }
        if let Some(live) = self.state().live.get_mut(&window) {
            live.closing = true;
            live.handle.terminate();
        }
        self.wait_gone(window);
    }

    fn page_act(&self, window: &Win, node: u32, action: Action, arg: &Value) -> Done<(bool, String)> {
        Ok(match action {
            Action::Type | Action::Settext => {
                self.focus_window(window);
                let typed = self.ask_page(window.id, "type", json!([node, Self::text_of(arg), action == Action::Settext]))?;
                (true, format!("输入了, 现在的值: {}", Value::from(typed["value"].as_str().unwrap_or(""))))
            }
            Action::Focus => {
                self.focus_window(window);
                self.ask_page(window.id, "focus", json!([node]))?;
                (true, format!("焦点给了 {}.{node}", window.target))
            }
            Action::Key => {
                self.focus_window(window);
                self.ask_page(window.id, "focus", json!([node]))?;
                self.keys(&Self::text_of(arg))?;
                (true, format!("按了 {}", Self::text_of(arg)))
            }
            _ => match self.ask_page(window.id, "point", json!([node])).map(serde_json::from_value::<PagePoint>) {
                Ok(Ok(PagePoint { x, y })) => return self.pointer(window, f64::from(window.rect[0]) + x, f64::from(window.rect[1]) + y, action, arg),
                Ok(Err(e)) => (false, e.to_string()),
                Err(failure) => (false, failure.message),
            },
        })
    }

    fn accessible_act(&self, window: &Win, node: u32, action: Action, arg: &Value) -> Done<(bool, String)> {
        let entry = self.inspector().accessible.get(&window.id).and_then(|a| a.by_number.get(&node).cloned());
        let Some((key, rect)) = entry else { return Ok((false, format!("{}.{node} 不认识, 先 look {}", window.target, window.target))) };
        let access = self.accessibility();
        let tried = |name: &str, text: Option<String>| access.as_ref().is_some_and(|a| a.act_now(&key, name, text).unwrap_or(false));
        match action {
            Action::Click if tried("click", None) => return Ok((true, format!("点了 {}.{node}", window.target))),
            Action::Type | Action::Settext => {
                let text = Self::text_of(arg);
                return Ok(if tried(action.name(), Some(text.clone())) { (true, format!("输入了 {}", Value::from(text))) } else { (false, "这个元素不能直接输入; 先 click 它, 再用 key 或对窗口 type".into()) });
            }
            Action::Focus if tried("focus", None) => return Ok((true, format!("焦点给了 {}.{node}", window.target))),
            Action::Key => {
                self.focus_window(window);
                tried("focus", None);
                self.keys(&Self::text_of(arg))?;
                return Ok((true, format!("按了 {}", Self::text_of(arg))));
            }
            _ => {}
        }
        let Some([x, y, w, h]) = rect else { return Ok((false, format!("{}.{node} 没有位置, 做不了 {}", window.target, action.name()))) };
        let at = (f64::from(window.rect[0]) + x + w / 2.0, f64::from(window.rect[1]) + y + h / 2.0);
        self.pointer(window, at.0, at.1, if action == Action::Focus { Action::Click } else { action }, arg)
    }

    /// The window drawn over (x, y) above this one, if any (the desktop's panels count as the desktop).
    fn cover(&self, window: &Win, x: f64, y: f64) -> Option<String> {
        let rows = self.link().list().0;
        let own_z = rows.iter().find(|r| r.window.unwrap_or(r.id) == window.id).map(|r| r.z);
        let panels = self.state().panels.clone();
        for row in &rows {
            let id = row.window.unwrap_or(row.id);
            if id == window.id || row.hidden || own_z.is_some_and(|z| row.z <= z) || (window.desktop() && panels.contains(&id)) {
                continue;
            }
            let inside = x >= f64::from(row.x) && y >= f64::from(row.y) && x < f64::from(row.x) + f64::from(row.width) && y < f64::from(row.y) + f64::from(row.height);
            if !inside {
                continue;
            }
            if panels.contains(&id) {
                return Some("w0 (桌面的面板)".into());
            }
            return Some(self.windows_now().into_iter().find(|w| w.id == id).map_or_else(|| format!("窗口 {id}"), |w| format!("{} ({})", w.target, w.title.or(w.app).unwrap_or_else(|| w.kind.into()))));
        }
        None
    }

    fn pointer(&self, window: &Win, x: f64, y: f64, action: Action, arg: &Value) -> Done<(bool, String)> {
        if let Some(cover) = self.cover(window, x, y) {
            if window.desktop() {
                return Ok((false, format!("那里被 {cover} 挡住了; 先把它最小化或关掉")));
            }
            self.focus_window(window);
        }
        let link = self.link();
        link.inject(Injected::moved(x, y));
        let press = |button: u32| {
            link.inject(Injected::Button { button, pressed: true });
            link.inject(Injected::Button { button, pressed: false });
        };
        let at = format!("{},{}", x.round(), y.round());
        Ok(match action {
            Action::Hover => (true, format!("指针移到了 {at}")),
            Action::Right => {
                press(BTN_RIGHT);
                (true, format!("右键点了 {at}"))
            }
            Action::Double => {
                press(BTN_LEFT);
                press(BTN_LEFT);
                (true, format!("双击了 {at}"))
            }
            Action::Scroll => {
                let dy = arg.as_f64().or_else(|| arg.as_str().and_then(|s| s.parse().ok())).filter(|d| *d != 0.0).unwrap_or(400.0);
                link.inject(Injected::wheel(0.0, dy, WheelKind::Wheel));
                (true, format!("在 {at} 滚动了 {dy}"))
            }
            Action::Click => {
                press(BTN_LEFT);
                (true, format!("点了 {at}"))
            }
            other => (false, format!("不支持 {}", other.name())),
        })
    }

    /// Presses `ctrl+a backspace`: chords separated by spaces, keys in a chord by `+`; a capital letter adds Shift.
    fn keys(&self, spec: &str) -> Done<()> {
        for chord in spec.split_whitespace() {
            let parts: Vec<&str> = chord.split('+').collect();
            let mut codes = parts.iter().map(|p| Keys::code(p)).collect::<Option<Vec<u32>>>().ok_or_else(|| Failure::from(format!("不认识的键: {chord}")))?;
            if let [one] = parts.as_slice()
                && one.len() == 1
                && one.chars().all(|c| c.is_ascii_uppercase())
            {
                codes.insert(0, 42);
            }
            for code in &codes {
                self.link().inject(Injected::Key { code: *code, pressed: true });
            }
            for code in codes.iter().rev() {
                self.link().inject(Injected::Key { code: *code, pressed: false });
            }
        }
        Ok(())
    }

    fn tree(&self, window: &Win, node: Option<u32>, limit: usize) -> (Vec<Node>, Vec<String>) {
        if window.hidden {
            return (Vec::new(), vec!["(最小化了; act 它 restore 再看)".into()]);
        }
        if !window.page {
            return self.accessible_tree(window, limit);
        }
        let tree = match self.ask_page(window.id, "tree", json!([node.map_or(-1, i64::from), limit])).map(serde_json::from_value::<PageTree>) {
            Ok(Ok(tree)) => tree,
            Ok(Err(e)) => return (Vec::new(), vec![format!("(页面的树读不懂: {e})")]),
            Err(_) => return (Vec::new(), vec!["(页面没在运行)".into()]),
        };
        let (ox, oy) = (f64::from(window.rect[0]), f64::from(window.rect[1]));
        fn convert(n: PageNode, prefix: &str, ox: f64, oy: f64) -> Node {
            Node {
                target: format!("{prefix}.{}", n.id),
                role: n.role,
                name: n.name.filter(|s| !s.is_empty()),
                value: n.value,
                states: n.states,
                level: n.level.filter(|l| *l > 0),
                rect: Some([n.rect[0] + ox, n.rect[1] + oy, n.rect[2], n.rect[3]]),
                more: n.more.filter(|m| *m > 0),
                children: n.children.into_iter().map(|c| convert(c, prefix, ox, oy)).collect(),
            }
        }
        let mut notes = Vec::new();
        if tree.hidden > 0 {
            notes.push(format!("(可见范围外还有 {} 个元素没列出; scroll 再看)", tree.hidden));
        }
        if tree.truncated {
            notes.push(format!("(元素太多, 只列了 {limit} 个; look 某个 ref 看它下面)"));
        }
        (tree.nodes.into_iter().map(|n| convert(n, &window.target, ox, oy)).collect(), notes)
    }

    fn accessible_tree(&self, window: &Win, limit: usize) -> (Vec<Node>, Vec<String>) {
        let Some(access) = self.accessibility() else { return (Vec::new(), vec!["(这个会话没有 AT-SPI, 看不到这个窗口的内容)".into()]) };
        let Some(pid) = window.pid else { return (Vec::new(), vec!["(不知道这个窗口的进程)".into()]) };
        let root = match access.tree_now(pid, window.title.clone(), limit) {
            Ok(Some(json)) => serde_json::from_str::<AccessibleNode>(&json),
            Ok(None) => return (Vec::new(), vec!["(这个程序没有上报无障碍信息)".into()]),
            Err(e) => return (Vec::new(), vec![format!("(AT-SPI: {e})")]),
        };
        let Ok(root) = root else { return (Vec::new(), vec!["(AT-SPI 的树读不懂)".into()]) };
        let mut inspector = self.inspector();
        let table = inspector.accessible.entry(window.id).or_default();
        let (ox, oy) = (f64::from(window.rect[0]), f64::from(window.rect[1]));
        fn convert(n: AccessibleNode, table: &mut Aliases, prefix: &str, ox: f64, oy: f64) -> Vec<Node> {
            let number = *table.by_key.entry(n.id.clone()).or_insert_with(|| {
                table.next += 1;
                table.next
            });
            table.by_number.insert(number, (n.id, n.rect));
            let children: Vec<Node> = n.children.into_iter().flat_map(|c| convert(c, table, prefix, ox, oy)).collect();
            let name = n.name.filter(|s| !s.is_empty());
            if GENERIC.contains(&n.role.as_str()) && name.is_none() && n.more.is_none_or(|m| m == 0) {
                return children;
            }
            let mut states = n.states;
            if !n.actions.is_empty() && !PRESSABLE.contains(&n.role.as_str()) {
                states.push("clickable".into());
            }
            vec![Node {
                target: format!("{prefix}.{number}"),
                role: n.role,
                name,
                value: n.value,
                states,
                level: None,
                rect: n.rect.map(|r| [r[0] + ox, r[1] + oy, r[2], r[3]]),
                more: n.more.filter(|m| *m > 0),
                children,
            }]
        }
        let nodes = root.children.into_iter().flat_map(|c| convert(c, table, &window.target, ox, oy)).collect();
        (nodes, Vec::new())
    }

    fn lines(nodes: &[Node], depth: usize, out: &mut Vec<(String, String)>) {
        let pad = "  ".repeat(depth);
        for n in nodes {
            let mut line = format!("{pad}- {}", n.role);
            if let Some(name) = &n.name {
                line.push_str(&format!(" {}", Value::from(name.as_str())));
            }
            if let Some(value) = &n.value {
                line.push_str(&format!(": {}", Value::from(value.as_str())));
            }
            if let Some(level) = n.level {
                line.push_str(&format!(" [level={level}]"));
            }
            for state in &n.states {
                line.push_str(&format!(" [{state}]"));
            }
            line.push_str(&format!(" [{}]", n.target));
            out.push((format!("{}|{}", n.target, n.role), line));
            Self::lines(&n.children, depth + 1, out);
            if let Some(more) = n.more {
                out.push((format!("{}|more", n.target), format!("{pad}  - …还有 {more} 项没列出")));
            }
        }
    }

    /// The nodes whose name or value contains `needle` (lower case), with their ancestors.
    fn found(mut node: Node, needle: &str) -> Option<Node> {
        let hit = [&node.name, &node.value].into_iter().flatten().any(|s| s.to_lowercase().contains(needle));
        if hit {
            return Some(node);
        }
        let children: Vec<Node> = std::mem::take(&mut node.children).into_iter().filter_map(|c| Self::found(c, needle)).collect();
        if children.is_empty() {
            return None;
        }
        node.more = None;
        node.children = children;
        Some(node)
    }

    fn diff(before: &[(String, String)], after: &[(String, String)]) -> Vec<String> {
        fn keyed(lines: &[(String, String)]) -> Vec<(String, &str)> {
            let mut seen: HashMap<&str, usize> = HashMap::new();
            lines.iter().map(|(key, line)| {
                let n = seen.entry(key.as_str()).or_default();
                *n += 1;
                (format!("{key}#{}", *n - 1), line.as_str())
            }).collect()
        }
        let old = keyed(before);
        let old_map: HashMap<&str, &str> = old.iter().map(|(k, l)| (k.as_str(), *l)).collect();
        let now = keyed(after);
        let kept: std::collections::HashSet<&str> = now.iter().map(|(k, _)| k.as_str()).collect();
        let mut out = Vec::new();
        for (key, line) in &now {
            match old_map.get(key.as_str()) {
                None => out.push(format!("+ {}", line.trim_start())),
                Some(was) if was != line => out.push(format!("~ {}", line.trim_start())),
                _ => {}
            }
        }
        for (key, line) in &old {
            if !kept.contains(key.as_str()) {
                out.push(format!("- {}", line.trim_start()));
            }
        }
        if out.is_empty() {
            return vec!["(没有变化)".into()];
        }
        if out.len() as f64 > after.len() as f64 * 0.6 && after.len() > 10 {
            return std::iter::once("(变化很大, 全部重列)".to_owned()).chain(after.iter().map(|(_, l)| l.clone())).collect();
        }
        out
    }
}
