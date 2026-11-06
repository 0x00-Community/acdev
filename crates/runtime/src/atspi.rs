use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use futures_util::future::{join3, join5};
use futures_util::stream::{self, StreamExt};
use napi::Result;
use napi_derive::napi;
use serde_json::{Map, Value, json};
use zbus::Connection;
use zbus::zvariant::{DynamicDeserialize, DynamicType, OwnedObjectPath, OwnedValue, Value as Variant};

use crate::{blocking, failure};

const A11Y_BUS: &str = "org.a11y.Bus";
const A11Y_PATH: &str = "/org/a11y/bus";
const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT: &str = "/org/a11y/atspi/accessible/root";
const NULL: &str = "/org/a11y/atspi/null";
const CACHE_PATH: &str = "/org/a11y/atspi/cache";
const CACHE: &str = "org.a11y.atspi.Cache";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const ACTION: &str = "org.a11y.atspi.Action";
const TEXT: &str = "org.a11y.atspi.Text";
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
const VALUE: &str = "org.a11y.atspi.Value";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const CALL_TIMEOUT: Duration = Duration::from_secs(2);
const PARALLEL: usize = 64;
const COORD_WINDOW: u32 = 1;
const VALUE_CHARS: usize = 200;
const CLICKS: [&str; 6] = ["click", "press", "activate", "toggle", "jump", "open"];

const CHECKED: u32 = 4;
const DEFUNCT: u32 = 6;
const EDITABLE: u32 = 7;
const ENABLED: u32 = 8;
const EXPANDABLE: u32 = 9;
const EXPANDED: u32 = 10;
const FOCUSABLE: u32 = 11;
const FOCUSED: u32 = 12;
const MODAL: u32 = 16;
const PRESSED: u32 = 20;
const SELECTED: u32 = 23;
const SENSITIVE: u32 = 24;
const SHOWING: u32 = 25;

const ROLES: [&str; 130] = [
    "invalid",
    "accelerator label",
    "alert",
    "animation",
    "arrow",
    "calendar",
    "canvas",
    "check box",
    "check menu item",
    "color chooser",
    "column header",
    "combo box",
    "date editor",
    "desktop icon",
    "desktop frame",
    "dial",
    "dialog",
    "directory pane",
    "drawing area",
    "file chooser",
    "filler",
    "focus traversable",
    "font chooser",
    "frame",
    "glass pane",
    "html container",
    "icon",
    "image",
    "internal frame",
    "label",
    "layered pane",
    "list",
    "list item",
    "menu",
    "menu bar",
    "menu item",
    "option pane",
    "page tab",
    "page tab list",
    "panel",
    "password text",
    "popup menu",
    "progress bar",
    "push button",
    "radio button",
    "radio menu item",
    "root pane",
    "row header",
    "scroll bar",
    "scroll pane",
    "separator",
    "slider",
    "spin button",
    "split pane",
    "status bar",
    "table",
    "table cell",
    "table column header",
    "table row header",
    "tearoff menu item",
    "terminal",
    "text",
    "toggle button",
    "tool bar",
    "tool tip",
    "tree",
    "tree table",
    "unknown",
    "viewport",
    "window",
    "extended",
    "header",
    "footer",
    "paragraph",
    "ruler",
    "application",
    "autocomplete",
    "editbar",
    "embedded",
    "entry",
    "chart",
    "caption",
    "document frame",
    "heading",
    "page",
    "section",
    "redundant object",
    "form",
    "link",
    "input method window",
    "table row",
    "tree item",
    "document spreadsheet",
    "document presentation",
    "document text",
    "document web",
    "document email",
    "comment",
    "list box",
    "grouping",
    "image map",
    "notification",
    "info bar",
    "level bar",
    "title bar",
    "block quote",
    "audio",
    "video",
    "definition",
    "article",
    "landmark",
    "log",
    "marquee",
    "math",
    "rating",
    "timer",
    "static",
    "math fraction",
    "math root",
    "subscript",
    "superscript",
    "description list",
    "description term",
    "description value",
    "footnote",
    "content deletion",
    "content insertion",
    "mark",
    "suggestion",
    "push button menu",
];

type Wire = (String, OwnedObjectPath);
type CacheItem = (Wire, Wire, Wire, i32, i32, Vec<String>, String, u32, String, Vec<u32>);
type LegacyCacheItem = (Wire, Wire, Wire, Vec<Wire>, Vec<String>, String, u32, String, Vec<u32>);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Ref {
    bus: String,
    path: String,
}

impl Ref {
    fn new(bus: &str, path: &str) -> Self {
        Self { bus: bus.to_owned(), path: path.to_owned() }
    }

    fn id(&self) -> String {
        format!("{}|{}", self.bus, self.path)
    }
}

impl From<Wire> for Ref {
    fn from((bus, path): Wire) -> Self {
        Self { bus, path: path.as_str().to_owned() }
    }
}

#[derive(Clone)]
struct Item {
    role: u32,
    name: String,
    description: String,
    states: u64,
    interfaces: Vec<String>,
    child_count: i32,
    children: Option<Vec<Ref>>,
}

impl Item {
    fn has(&self, state: u32) -> bool {
        self.states & (1 << state) != 0
    }

    fn implements(&self, interface: &str) -> bool {
        self.interfaces.iter().any(|i| i == interface)
    }

    fn shown(&self) -> bool {
        self.has(SHOWING) && !self.has(DEFUNCT)
    }

    fn role_name(&self) -> &'static str {
        ROLES.get(self.role as usize).copied().unwrap_or("unknown")
    }
}

fn bits(states: &[u32]) -> u64 {
    states.iter().take(2).enumerate().fold(0, |acc, (i, word)| acc | (u64::from(*word) << (32 * i)))
}

fn role(name: &str, in_tree: bool) -> String {
    match name {
        "push button" | "push button menu" | "toggle button" => "button",
        "check box" => "checkbox",
        "check menu item" => "menuitemcheckbox",
        "radio button" => "radio",
        "radio menu item" => "menuitemradio",
        "text" | "entry" | "password text" => "textbox",
        "spin button" => "spinbutton",
        "slider" => "slider",
        "combo box" => "combobox",
        "menu bar" => "menubar",
        "menu" | "popup menu" => "menu",
        "menu item" | "tearoff menu item" => "menuitem",
        "page tab" => "tab",
        "page tab list" => "tablist",
        "list" | "list box" => "list",
        "list item" => "listitem",
        "tree" | "tree table" => "tree",
        "tree item" => "treeitem",
        "table row" if in_tree => "treeitem",
        "table row" => "row",
        "table" => "table",
        "table cell" => "cell",
        "column header" | "table column header" => "columnheader",
        "label" | "static" => "text",
        "heading" => "heading",
        "link" => "link",
        "image" | "icon" => "img",
        "tool bar" => "toolbar",
        "status bar" => "status",
        "scroll bar" => "scrollbar",
        "dialog" | "alert" => "dialog",
        "frame" | "window" => "window",
        "document web" | "document frame" => "document",
        "panel" | "filler" | "section" | "unknown" | "redundant object" => "generic",
        other => return other.replace(' ', "-"),
    }
    .to_owned()
}

fn control(role: &str) -> bool {
    matches!(
        role,
        "button"
            | "checkbox"
            | "menuitemcheckbox"
            | "radio"
            | "menuitemradio"
            | "textbox"
            | "spinbutton"
            | "slider"
            | "combobox"
            | "menuitem"
            | "tab"
            | "link"
            | "listitem"
            | "treeitem"
    )
}

fn states(item: &Item, role: &str, focused: bool) -> Vec<&'static str> {
    let mut out = Vec::new();
    if focused {
        out.push("focused");
    }
    let toggle = item.role_name() == "toggle button";
    if item.has(CHECKED) && !toggle {
        out.push("checked");
    }
    if item.has(SELECTED) {
        out.push("selected");
    }
    if item.has(EXPANDED) {
        out.push("expanded");
    } else if item.has(EXPANDABLE) {
        out.push("collapsed");
    }
    let interactive = control(role) || item.has(FOCUSABLE) || item.has(EDITABLE);
    if interactive && !(item.has(ENABLED) && item.has(SENSITIVE)) {
        out.push("disabled");
    }
    if item.has(PRESSED) || toggle && item.has(CHECKED) {
        out.push("pressed");
    }
    if item.has(EDITABLE) {
        out.push("editable");
    }
    if item.has(MODAL) {
        out.push("modal");
    }
    out
}

fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 { format!("{}", value as i64) } else { format!("{value}") }
}

struct Emitted {
    at: Ref,
    in_tree: bool,
    children: Vec<usize>,
    more: usize,
}

#[derive(Default)]
struct Details {
    rect: Option<[i32; 4]>,
    actions: Vec<String>,
    value: Option<String>,
}

#[derive(Clone)]
struct Walker {
    bus: Connection,
}

impl Walker {
    async fn open() -> zbus::Result<Self> {
        let session = Connection::session().await?;
        session.call_method(Some(A11Y_BUS), A11Y_PATH, Some(PROPERTIES), "Set", &("org.a11y.Status", "IsEnabled", Variant::from(true))).await?;
        let address: String = session.call_method(Some(A11Y_BUS), A11Y_PATH, Some(A11Y_BUS), "GetAddress", &()).await?.body().deserialize()?;
        let bus = zbus::connection::Builder::address(address.as_str())?.build().await?;
        Ok(Self { bus })
    }

    async fn message<B>(&self, bus: &str, path: &str, interface: &str, method: &str, body: &B) -> zbus::Result<zbus::Message>
    where
        B: serde::Serialize + DynamicType,
    {
        let reply = self.bus.call_method(Some(bus), path, Some(interface), method, body);
        let timeout = async {
            async_io::Timer::after(CALL_TIMEOUT).await;
            Err(zbus::Error::Failure(format!("{interface}.{method}: no answer in {} s", CALL_TIMEOUT.as_secs())))
        };
        futures_lite::future::or(reply, timeout).await
    }

    async fn call<B, R>(&self, at: &Ref, interface: &str, method: &str, body: &B) -> zbus::Result<R>
    where
        B: serde::Serialize + DynamicType,
        R: for<'d> DynamicDeserialize<'d>,
    {
        let message = self.message(&at.bus, &at.path, interface, method, body).await?;
        message.body().deserialize::<R>()
    }

    async fn property<R: TryFrom<OwnedValue>>(&self, at: &Ref, interface: &str, name: &str) -> Option<R> {
        let value: OwnedValue = self.call(at, PROPERTIES, "Get", &(interface, name)).await.ok()?;
        R::try_from(value).ok()
    }

    async fn pid(&self, bus: &str) -> Option<u32> {
        let message =
            self.message("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", &(bus,)).await.ok()?;
        message.body().deserialize::<u32>().ok()
    }

    async fn children(&self, at: &Ref) -> zbus::Result<Vec<Ref>> {
        let list: Vec<Wire> = self.call(at, ACCESSIBLE, "GetChildren", &()).await?;
        Ok(list.into_iter().map(Ref::from).filter(|r| r.path != NULL && !r.bus.is_empty()).collect())
    }

    async fn item(&self, at: &Ref) -> Option<Item> {
        let (role, states, name, interfaces, count) = join5(
            self.call::<_, u32>(at, ACCESSIBLE, "GetRole", &()),
            self.call::<_, Vec<u32>>(at, ACCESSIBLE, "GetState", &()),
            self.property::<String>(at, ACCESSIBLE, "Name"),
            self.call::<_, Vec<String>>(at, ACCESSIBLE, "GetInterfaces", &()),
            self.property::<i32>(at, ACCESSIBLE, "ChildCount"),
        )
        .await;
        let child_count = count.unwrap_or(0);
        Some(Item {
            role: role.ok()?,
            name: name.unwrap_or_default(),
            description: String::new(),
            states: bits(&states.ok()?),
            interfaces: interfaces.unwrap_or_default(),
            child_count,
            children: (child_count <= 0).then(Vec::new),
        })
    }

    async fn items(&self, refs: &[Ref]) -> Vec<Option<Item>> {
        stream::iter(refs.iter().map(|r| self.item(r))).buffered(PARALLEL).collect().await
    }

    async fn cached(&self, bus: &str) -> HashMap<Ref, Item> {
        let mut items = HashMap::new();
        let Ok(message) = self.message(bus, CACHE_PATH, CACHE, "GetItems", &()).await else { return items };
        let body = message.body();
        if let Ok(list) = body.deserialize::<Vec<CacheItem>>() {
            let mut kids: HashMap<Ref, Vec<(i32, Ref)>> = HashMap::new();
            for (me, _, parent, index, child_count, interfaces, name, role, description, states) in list {
                let me = Ref::from(me);
                kids.entry(Ref::from(parent)).or_default().push((index, me.clone()));
                items.insert(me, Item { role, name, description, states: bits(&states), interfaces, child_count, children: None });
            }
            for (parent, mut list) in kids {
                if let Some(item) = items.get_mut(&parent)
                    && list.len() as i32 >= item.child_count
                {
                    list.sort_by_key(|(index, _)| *index);
                    item.children = Some(list.into_iter().map(|(_, r)| r).collect());
                }
            }
        } else if let Ok(list) = body.deserialize::<Vec<LegacyCacheItem>>() {
            for (me, _, _, children, interfaces, name, role, description, states) in list {
                let children: Vec<Ref> = children.into_iter().map(Ref::from).filter(|r| r.path != NULL).collect();
                let item = Item { role, name, description, states: bits(&states), interfaces, child_count: children.len() as i32, children: Some(children) };
                items.insert(Ref::from(me), item);
            }
        }
        for item in items.values_mut() {
            if item.children.is_none() && item.child_count <= 0 {
                item.children = Some(Vec::new());
            }
        }
        items
    }

    async fn window(&self, pid: u32, title: Option<&str>) -> zbus::Result<Option<(Ref, Item)>> {
        let apps = self.children(&Ref::new(REGISTRY, ROOT)).await?;
        let pids: Vec<Option<u32>> = stream::iter(apps.iter().map(|app| self.pid(&app.bus))).buffered(PARALLEL).collect().await;
        let mut tops = Vec::new();
        for (app, _) in apps.iter().zip(pids).filter(|(_, p)| *p == Some(pid)) {
            tops.extend(self.children(app).await.unwrap_or_default());
        }
        let items = self.items(&tops).await;
        let tops: Vec<(Ref, Item)> = tops.into_iter().zip(items).filter_map(|(r, i)| Some((r, i?))).collect();
        let named = title.and_then(|t| tops.iter().find(|(_, i)| i.name == t));
        Ok(named.or_else(|| tops.iter().find(|(_, i)| i.shown())).or_else(|| tops.first()).cloned())
    }

    async fn tree(&self, pid: u32, title: Option<String>, limit: usize) -> zbus::Result<Option<(Value, usize, bool)>> {
        let Some((root, top)) = self.window(pid, title.as_deref()).await? else { return Ok(None) };
        let mut known = self.cached(&root.bus).await;
        let cache = !known.is_empty();
        known.entry(root.clone()).or_insert(top);
        let mut seen = HashSet::from([root.clone()]);
        let mut level = vec![root.clone()];
        while !level.is_empty() && seen.len() < limit {
            let open: Vec<Ref> = level.iter().filter(|r| known.get(*r).is_some_and(|i| i.children.is_none())).cloned().collect();
            let found: Vec<Vec<Ref>> =
                stream::iter(open.iter().map(|r| async { self.children(r).await.unwrap_or_default() })).buffered(PARALLEL).collect().await;
            for (r, children) in open.iter().zip(found) {
                if let Some(item) = known.get_mut(r) {
                    item.children = Some(children);
                }
            }
            let next: Vec<Ref> =
                level.iter().flat_map(|r| known.get(r).and_then(|i| i.children.clone()).unwrap_or_default()).filter(|r| !seen.contains(r)).collect();
            let missing: Vec<Ref> = next.iter().filter(|r| !known.contains_key(*r)).cloned().collect();
            for (r, item) in missing.iter().zip(self.items(&missing).await) {
                if let Some(item) = item {
                    known.insert(r.clone(), item);
                }
            }
            level = next.into_iter().filter(|r| known.get(r).is_some_and(Item::shown)).collect();
            seen.extend(level.iter().cloned());
        }
        let mut emitted = Vec::new();
        let mut visited = HashSet::new();
        Self::emit(&known, &root, false, limit, &mut emitted, &mut visited);
        let details: Vec<Details> = stream::iter(emitted.iter().map(|e| self.details(&e.at, &known[&e.at]))).buffered(PARALLEL).collect().await;
        let focused: Vec<bool> = emitted.iter().map(|e| known[&e.at].has(FOCUSED)).collect();
        let editable = |i: usize| known[&emitted[i].at].has(EDITABLE);
        let focused: Vec<bool> = match (focused.iter().filter(|f| **f).count(), (0..emitted.len()).any(|i| focused[i] && editable(i))) {
            (2.., true) => (0..emitted.len()).map(|i| focused[i] && editable(i)).collect(),
            _ => focused,
        };
        let count = emitted.len();
        Ok(Some((Self::json(&known, &emitted, &details, &focused, 0), count, cache)))
    }

    fn emit(known: &HashMap<Ref, Item>, at: &Ref, in_tree: bool, limit: usize, out: &mut Vec<Emitted>, visited: &mut HashSet<Ref>) -> usize {
        let index = out.len();
        visited.insert(at.clone());
        out.push(Emitted { at: at.clone(), in_tree, children: Vec::new(), more: 0 });
        let item = &known[at];
        let in_tree = in_tree || matches!(item.role_name(), "tree" | "tree table");
        let Some(children) = &item.children else {
            out[index].more = item.child_count.max(0) as usize;
            return index;
        };
        let mut unknown = 0;
        let mut shown = Vec::new();
        for child in children {
            match known.get(child) {
                Some(c) if c.shown() && !visited.contains(child) => shown.push(child),
                Some(_) => {}
                None => unknown += 1,
            }
        }
        for (n, child) in shown.iter().enumerate() {
            if out.len() >= limit {
                out[index].more = shown.len() - n;
                break;
            }
            let c = Self::emit(known, child, in_tree, limit, out, visited);
            out[index].children.push(c);
        }
        out[index].more += unknown;
        index
    }

    async fn details(&self, at: &Ref, item: &Item) -> Details {
        let rect = async {
            if !item.implements(COMPONENT) {
                return None;
            }
            let (x, y, w, h) = self.call::<_, (i32, i32, i32, i32)>(at, COMPONENT, "GetExtents", &(COORD_WINDOW,)).await.ok()?;
            Some([x, y, w, h])
        };
        let actions = async {
            if !item.implements(ACTION) {
                return Vec::new();
            }
            let list: Vec<(String, String, String)> = self.call(at, ACTION, "GetActions", &()).await.unwrap_or_default();
            list.into_iter().map(|(name, _, _)| name).collect()
        };
        let value = async {
            if item.implements(VALUE)
                && let Some(current) = self.property::<f64>(at, VALUE, "CurrentValue").await
            {
                return Some(number(current));
            }
            if !(item.implements(TEXT) && item.has(EDITABLE)) {
                return None;
            }
            if item.role_name() == "password text" {
                return Some("•••".to_owned());
            }
            let text: String = self.call(at, TEXT, "GetText", &(0i32, -1i32)).await.ok()?;
            Some(text.chars().take(VALUE_CHARS).collect())
        };
        let (rect, actions, value) = join3(rect, actions, value).await;
        Details { rect, actions, value }
    }

    fn json(known: &HashMap<Ref, Item>, emitted: &[Emitted], details: &[Details], focused: &[bool], index: usize) -> Value {
        let e = &emitted[index];
        let item = &known[&e.at];
        let d = &details[index];
        let name = if item.name.is_empty() { &item.description } else { &item.name };
        let mut node = Map::new();
        node.insert("id".into(), json!(e.at.id()));
        let role = role(item.role_name(), e.in_tree);
        let states = states(item, &role, focused[index]);
        node.insert("role".into(), json!(role));
        node.insert("name".into(), json!(name));
        if let Some(value) = &d.value {
            node.insert("value".into(), json!(value));
        }
        node.insert("states".into(), json!(states));
        node.insert("rect".into(), json!(d.rect));
        node.insert("actions".into(), json!(d.actions));
        let children: Vec<Value> = e.children.iter().map(|&c| Self::json(known, emitted, details, focused, c)).collect();
        node.insert("children".into(), Value::Array(children));
        if e.more > 0 {
            node.insert("more".into(), json!(e.more));
        }
        Value::Object(node)
    }

    async fn act(&self, node: &str, action: &str, text: Option<String>) -> std::result::Result<bool, String> {
        let (bus, path) = node.split_once('|').ok_or_else(|| format!("{node}: not a node id"))?;
        let at = Ref::new(bus, path);
        match action {
            "click" => {
                let Ok(actions) = self.call::<_, Vec<(String, String, String)>>(&at, ACTION, "GetActions", &()).await else { return Ok(false) };
                let index = match actions.len() {
                    1 => Some(0),
                    _ => actions.iter().position(|(name, _, _)| CLICKS.contains(&name.to_lowercase().as_str())),
                };
                let Some(index) = index else { return Ok(false) };
                Ok(self.call::<_, bool>(&at, ACTION, "DoAction", &(index as i32,)).await.unwrap_or(false))
            }
            "focus" => Ok(self.call::<_, bool>(&at, COMPONENT, "GrabFocus", &()).await.unwrap_or(false)),
            "type" | "settext" => {
                let text = text.unwrap_or_default();
                let Ok(states) = self.call::<_, Vec<u32>>(&at, ACCESSIBLE, "GetState", &()).await else { return Ok(false) };
                if bits(&states) & (1 << EDITABLE) == 0 {
                    return Ok(false);
                }
                if action == "settext" {
                    return Ok(self.call::<_, bool>(&at, EDITABLE_TEXT, "SetTextContents", &(text.as_str(),)).await.unwrap_or(false));
                }
                let caret = match self.property::<i32>(&at, TEXT, "CaretOffset").await {
                    Some(caret) if caret >= 0 => caret,
                    _ => self.property::<i32>(&at, TEXT, "CharacterCount").await.unwrap_or(0).max(0),
                };
                let length = text.len() as i32;
                Ok(self.call::<_, bool>(&at, EDITABLE_TEXT, "InsertText", &(caret, text.as_str(), length)).await.unwrap_or(false))
            }
            other => Err(format!("unknown action {other}: click, focus, type or settext")),
        }
    }
}

#[napi]
pub struct Accessibility {
    walker: Walker,
}

#[napi]
impl Accessibility {
    #[napi(factory)]
    pub async fn open() -> Result<Self> {
        blocking(|| {
            let walker = async_io::block_on(Walker::open()).map_err(|e| failure("a11y_unavailable", &format!("no AT-SPI bus: {e}")))?;
            Ok(Self { walker })
        })
        .await
    }

    #[napi]
    pub async fn tree(&self, pid: u32, title: Option<String>, limit: u32) -> Result<Option<String>> {
        let walker = self.walker.clone();
        blocking(move || {
            let started = Instant::now();
            let tree = async_io::block_on(walker.tree(pid, title, limit.max(1) as usize)).map_err(|e| failure("a11y_failed", &e.to_string()))?;
            let Some((tree, nodes, cache)) = tree else { return Ok(None) };
            log::debug!(target: "perf::a11y", "tree pid={pid} nodes={nodes} cache={} ms={:.1}", cache as u8, started.elapsed().as_secs_f64() * 1000.0);
            Ok(Some(tree.to_string()))
        })
        .await
    }

    #[napi]
    pub async fn act(&self, node: String, action: String, text: Option<String>) -> Result<bool> {
        let walker = self.walker.clone();
        blocking(move || {
            let started = Instant::now();
            let done = async_io::block_on(walker.act(&node, &action, text)).map_err(|e| failure("invalid_request", &e))?;
            log::debug!(target: "perf::a11y", "act {action} done={} ms={:.1}", done as u8, started.elapsed().as_secs_f64() * 1000.0);
            Ok(done)
        })
        .await
    }
}
