use blitz_dom::{Node, NodeData, NodeId};
use style::computed_values::visibility::T as Visibility;

use super::{Control, Dom};
use crate::Rect;
use crate::engine::Engine;
use crate::geometry::Geometry;

const NAME_MAX: usize = 120;
const VALUE_MAX: usize = 200;
const CHILDREN_MAX: usize = 60;

struct Sem {
    node: NodeId,
    role: String,
    name: String,
    value: Option<String>,
    states: Vec<&'static str>,
    rect: Rect,
    level: Option<u8>,
    children: Vec<Sem>,
    more: usize,
}

struct Walk<'a> {
    e: &'a Engine,
    geometry: Geometry<'a>,
    focus: Option<NodeId>,
    budget: usize,
    hidden: usize,
}

impl Dom {
    pub fn semantics(&self, root: u32, limit: u32) -> crate::Result<String> {
        self.read(|e| {
            let root = match root {
                super::NONE => match e.doc.try_root_element() {
                    Some(r) => r.id,
                    None => return Ok("{\"hidden\":0,\"truncated\":false,\"nodes\":[]}".into()),
                },
                id => e.n(id)?,
            };
            e.resolved();
            let viewport = e.doc.viewport();
            let scale = viewport.scale_f64();
            let screen = Rect { x: 0.0, y: 0.0, width: f64::from(viewport.window_size.0) / scale, height: f64::from(viewport.window_size.1) / scale };
            let mut walk = Walk { e, geometry: Geometry { doc: &e.doc }, focus: e.doc.get_focussed_node_id(), budget: limit.max(1) as usize, hidden: 0 };
            let mut truncated = false;
            let nodes = walk.element(root, screen, &mut truncated);
            let hidden = walk.hidden;
            let mut out = String::with_capacity(4096);
            out.push_str(&format!("{{\"hidden\":{hidden},\"truncated\":{truncated},\"nodes\":"));
            write_list(&nodes, &mut out, &mut |n| e.ids.id_of(n));
            out.push('}');
            Ok(out)
        })
    }
}

fn write_list(list: &[Sem], out: &mut String, ids: &mut dyn FnMut(NodeId) -> u32) {
    out.push('[');
    for (i, sem) in list.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_sem(sem, out, ids);
    }
    out.push(']');
}

fn write_sem(sem: &Sem, out: &mut String, ids: &mut dyn FnMut(NodeId) -> u32) {
    out.push_str("{\"id\":");
    out.push_str(&ids(sem.node).to_string());
    out.push_str(",\"role\":");
    string(&sem.role, out);
    if !sem.name.is_empty() {
        out.push_str(",\"name\":");
        string(&sem.name, out);
    }
    if let Some(value) = &sem.value {
        out.push_str(",\"value\":");
        string(value, out);
    }
    if !sem.states.is_empty() {
        out.push_str(",\"states\":[");
        for (i, s) in sem.states.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            string(s, out);
        }
        out.push(']');
    }
    if let Some(level) = sem.level {
        out.push_str(",\"level\":");
        out.push_str(&level.to_string());
    }
    let r = sem.rect;
    out.push_str(&format!(",\"rect\":[{:.0},{:.0},{:.0},{:.0}]", r.x, r.y, r.width, r.height));
    if sem.more > 0 {
        out.push_str(",\"more\":");
        out.push_str(&sem.more.to_string());
    }
    if !sem.children.is_empty() {
        out.push_str(",\"children\":");
        write_list(&sem.children, out, ids);
    }
    out.push('}');
}

fn string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn collapse(text: &str, max: usize) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
        if out.chars().count() > max {
            break;
        }
    }
    if out.chars().count() > max {
        out = out.chars().take(max).collect::<String>() + "…";
    }
    out
}

fn intersects(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    Rect { x, y, width: (right - x).max(0.0), height: (bottom - y).max(0.0) }
}

const SKIPPED: [&str; 10] = ["script", "style", "template", "head", "meta", "link", "noscript", "title", "iframe", "acde-frame"];

const INTERACTIVE: [&str; 19] = [
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "clickable", "listbox", "scrollbar",
];

const FROM_CONTENT: [&str; 17] = [
    "button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "cell", "columnheader", "rowheader", "clickable", "checkbox", "radio", "switch", "tooltip",
];


impl<'a> Walk<'a> {
    fn node(&self, id: NodeId) -> Option<&'a Node> {
        self.e.doc.get_node(id)
    }

    fn element(&mut self, id: NodeId, clip: Rect, truncated: &mut bool) -> Vec<Sem> {
        let Some(n) = self.node(id) else { return Vec::new() };
        let Some(e) = n.element_data() else { return Vec::new() };
        let tag = e.name.local.to_string();
        if SKIPPED.contains(&tag.as_str()) {
            return Vec::new();
        }
        let attr = |name: &str| e.attrs().iter().find(|a| &*a.name.local == name).map(|a| a.value.to_string());
        if attr("aria-hidden").as_deref() == Some("true") || attr("inert").is_some() {
            return Vec::new();
        }
        let Some(style) = n.primary_styles() else { return Vec::new() };
        if style.get_box().display.is_none() || style.get_effects().opacity <= 0.0 || style.clone_visibility() != Visibility::Visible {
            return Vec::new();
        }
        let rect = self.geometry.client_rect(id).unwrap_or_default();
        let sized = rect.width > 0.0 && rect.height > 0.0;
        if sized && !intersects(rect, clip) {
            self.hidden += 1;
            return Vec::new();
        }
        if self.budget == 0 {
            *truncated = true;
            return Vec::new();
        }
        let resolved = |p: &str| self.e.doc.resolved_style_value(id, p);
        let overflow = [resolved("overflow-x"), resolved("overflow-y")];
        let clips = sized && overflow.iter().any(|o| o != "visible" && !o.is_empty());
        let inner = if clips { intersect(clip, rect) } else { clip };
        let role = self.role(n, &tag, &attr);
        let mut states = self.states(n, &tag, &attr, role.as_deref());
        if clips && overflow.iter().any(|o| o == "auto" || o == "scroll") {
            let l = n.final_layout();
            if l.scroll_height() > 0.5 || l.scroll_width() > 0.5 {
                states.push("scrollable");
            }
        }
        let control = self.e.control(id);
        let content_named = role.as_deref().is_some_and(|r| FROM_CONTENT.contains(&r)) && !matches!(control, Control::Editor(_) | Control::Select);
        let name = self.name(n, &tag, &attr, content_named);
        let value = self.value(id, &tag, &attr, control);
        let level = match tag.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => tag[1..].parse().ok(),
            _ => None,
        }
        .or_else(|| attr("aria-level").and_then(|l| l.parse().ok()));
        let mut children = Vec::new();
        let mut more = 0;
        let child_ids: Vec<NodeId> = n.children.to_vec();
        let named_by_content = content_named && !name.is_empty();
        for child in child_ids {
            let Some(c) = self.node(child) else { continue };
            if let NodeData::Text(t) = &c.data {
                if named_by_content || !sized && rect.width <= 0.0 {
                    continue;
                }
                let text = collapse(&t.content, NAME_MAX);
                if text.is_empty() {
                    continue;
                }
                match children.last_mut() {
                    Some(Sem { role, node: last, name, .. }) if role == "text" && *last == id => {
                        if name.chars().count() < NAME_MAX {
                            name.push(' ');
                            name.push_str(&text);
                            *name = collapse(name, NAME_MAX);
                        }
                    }
                    _ => children.push(Sem { node: id, role: "text".into(), name: text, value: None, states: Vec::new(), rect, level: None, children: Vec::new(), more: 0 }),
                }
                continue;
            }
            if children.len() >= CHILDREN_MAX || self.budget == 0 {
                more += 1;
                continue;
            }
            let found = self.element(child, inner, truncated);
            if named_by_content {
                children.extend(found.into_iter().filter(|s| s.role != "text"));
            } else {
                children.extend(found);
            }
        }
        if more > 0 {
            *truncated = true;
        }
        let meaningful = role.is_some() || !states.is_empty() && states != ["scrollable"] || value.is_some();
        let generic_named = role.is_none() && (attr("aria-label").is_some() || attr("title").is_some()) && !name.is_empty();
        let scroller = states.contains(&"scrollable");
        if !(meaningful || generic_named || scroller) {
            if more > 0
                && let Some(last) = children.last_mut()
            {
                last.more += more;
            }
            return children;
        }
        self.budget = self.budget.saturating_sub(1);
        let role = role.unwrap_or_else(|| "generic".into());
        if role == "generic" && children.len() == 1 && name.is_empty() && !scroller {
            return children;
        }
        if children.is_empty() && name.is_empty() && value.is_none() && more == 0 && !INTERACTIVE.contains(&role.as_str()) {
            return Vec::new();
        }
        vec![Sem { node: id, role, name, value, states, rect: if sized { rect } else { Rect::default() }, level, children, more }]
    }

    fn role(&self, n: &Node, tag: &str, attr: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        if let Some(role) = attr("role").and_then(|r| r.split_whitespace().next().map(str::to_ascii_lowercase)) {
            match role.as_str() {
                "presentation" | "none" | "generic" => return None,
                _ => return Some(role),
            }
        }
        let input = || attr("type").map(|t| t.to_ascii_lowercase()).unwrap_or_else(|| "text".into());
        let role = match tag {
            "a" if attr("href").is_some() => "link",
            "button" | "summary" => "button",
            "input" => match input().as_str() {
                "hidden" => return None,
                "checkbox" => "checkbox",
                "radio" => "radio",
                "range" => "slider",
                "number" => "spinbutton",
                "search" => "searchbox",
                "button" | "submit" | "reset" | "image" | "file" | "color" => "button",
                _ => "textbox",
            },
            "textarea" => "textbox",
            "select" => "combobox",
            "option" => "option",
            "img" => match attr("alt") {
                Some(alt) if !alt.trim().is_empty() => "img",
                _ => return None,
            },
            "svg" => match n.children.iter().any(|&c| self.node(c).is_some_and(|c| c.element_data().is_some_and(|e| &*e.name.local == "title"))) {
                true => "img",
                false => return None,
            },
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => "heading",
            "ul" | "ol" | "menu" => "list",
            "li" => "listitem",
            "nav" => "navigation",
            "main" => "main",
            "aside" => "complementary",
            "dialog" => "dialog",
            "form" => "form",
            "table" => "table",
            "tr" => "row",
            "td" => "cell",
            "th" => "columnheader",
            "progress" => "progressbar",
            "meter" => "meter",
            "hr" => "separator",
            "details" => "group",
            "fieldset" => "group",
            _ if attr("contenteditable").is_some_and(|v| v != "false") => "textbox",
            _ if self.clickable(n) => "clickable",
            _ => return None,
        };
        Some(role.into())
    }

    fn clickable(&self, n: &Node) -> bool {
        let pointer = |id: NodeId| self.e.doc.resolved_style_value(id, "cursor") == "pointer";
        if !pointer(n.id) {
            return false;
        }
        n.parent.is_none_or(|p| self.node(p).is_none_or(|p| !p.is_element() || !pointer(p.id)))
    }

    fn states(&self, n: &Node, tag: &str, attr: &dyn Fn(&str) -> Option<String>, role: Option<&str>) -> Vec<&'static str> {
        let mut states = Vec::new();
        let on = |name: &str| attr(name).is_some_and(|v| v == "true");
        if self.focus == Some(n.id) && !matches!(tag, "body" | "html") {
            states.push("focused");
        }
        let checkable = tag == "input" && matches!(role, Some("checkbox" | "radio"));
        if checkable && self.e.checked(n.id) || on("aria-checked") {
            states.push("checked");
        }
        if attr("aria-checked").as_deref() == Some("mixed") {
            states.push("mixed");
        }
        let option_selected = tag == "option" && n.parent.is_some_and(|p| {
            let select = self.e.ancestors(p).into_iter().find(|&a| self.node(a).is_some_and(|a| a.element_data().is_some_and(|e| &*e.name.local == "select")));
            select.is_some_and(|s| usize::try_from(self.e.selected_index(s)).ok().and_then(|i| self.e.options(s).get(i).copied()) == Some(n.id))
        });
        if on("aria-selected") || option_selected {
            states.push("selected");
        }
        match attr("aria-expanded").as_deref() {
            Some("true") => states.push("expanded"),
            Some("false") => states.push("collapsed"),
            _ if tag == "details" => states.push(if attr("open").is_some() { "expanded" } else { "collapsed" }),
            _ => {}
        }
        let form = matches!(tag, "button" | "input" | "select" | "textarea" | "option" | "fieldset");
        if on("aria-disabled") || form && attr("disabled").is_some() {
            states.push("disabled");
        }
        if on("aria-pressed") {
            states.push("pressed");
        }
        if attr("aria-current").is_some_and(|v| v != "false") {
            states.push("current");
        }
        if attr("readonly").is_some() || on("aria-readonly") {
            states.push("readonly");
        }
        if on("aria-modal") || tag == "dialog" && attr("open").is_some() {
            states.push("modal");
        }
        states
    }

    fn name(&self, n: &Node, tag: &str, attr: &dyn Fn(&str) -> Option<String>, content: bool) -> String {
        if let Some(label) = attr("aria-label").filter(|l| !l.trim().is_empty()) {
            return collapse(&label, NAME_MAX);
        }
        if let Some(ids) = attr("aria-labelledby") {
            let text: Vec<String> = ids.split_whitespace().filter_map(|id| self.e.doc.get_element_by_id(id)).map(|l| self.e.inner_text(l)).collect();
            let text = collapse(&text.join(" "), NAME_MAX);
            if !text.is_empty() {
                return text;
            }
        }
        if matches!(tag, "input" | "select" | "textarea") {
            if let Some(label) = self.label_of(n, attr) {
                return label;
            }
            if let Some(p) = attr("placeholder").filter(|p| !p.trim().is_empty()) {
                return collapse(&p, NAME_MAX);
            }
            if matches!(attr("type").as_deref(), Some("button" | "submit" | "reset"))
                && let Some(v) = attr("value")
            {
                return collapse(&v, NAME_MAX);
            }
        }
        if tag == "img"
            && let Some(alt) = attr("alt")
        {
            return collapse(&alt, NAME_MAX);
        }
        if tag == "svg"
            && let Some(&title) = n.children.iter().find(|&&c| self.node(c).is_some_and(|c| c.element_data().is_some_and(|e| &*e.name.local == "title")))
        {
            return collapse(&self.e.inner_text(title), NAME_MAX);
        }
        if content {
            let text = collapse(&self.e.inner_text(n.id), NAME_MAX);
            if !text.is_empty() {
                return text;
            }
            if let Some(alt) = self.inner_label(n.id) {
                return alt;
            }
        }
        attr("title").map(|t| collapse(&t, NAME_MAX)).unwrap_or_default()
    }

    fn inner_label(&self, id: NodeId) -> Option<String> {
        for d in self.e.descendants(id) {
            let Some(e) = self.node(d).and_then(|n| n.element_data()) else { continue };
            for key in ["aria-label", "alt", "title"] {
                if let Some(v) = e.attrs().iter().find(|a| &*a.name.local == key).map(|a| a.value.trim().to_owned()).filter(|v| !v.is_empty()) {
                    return Some(collapse(&v, NAME_MAX));
                }
            }
        }
        None
    }

    fn label_of(&self, n: &Node, attr: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        let by_for = attr("id").filter(|id| !id.is_empty()).and_then(|id| {
            self.e.descendants(self.e.doc.root_node().id).into_iter().find(|&d| {
                self.node(d).and_then(|d| d.element_data()).is_some_and(|e| &*e.name.local == "label" && e.attrs().iter().any(|a| &*a.name.local == "for" && *a.value == id))
            })
        });
        let wrapping = || self.e.ancestors(n.id).into_iter().skip(1).find(|&a| self.node(a).and_then(|a| a.element_data()).is_some_and(|e| &*e.name.local == "label"));
        let label = by_for.or_else(wrapping)?;
        let text = collapse(&self.e.inner_text(label), NAME_MAX);
        (!text.is_empty()).then_some(text)
    }

    fn value(&self, id: NodeId, tag: &str, attr: &dyn Fn(&str) -> Option<String>, control: Control) -> Option<String> {
        if let Some(text) = attr("aria-valuetext").or_else(|| attr("aria-valuenow")) {
            return Some(collapse(&text, VALUE_MAX));
        }
        match control {
            Control::Editor(_) if attr("type").is_some_and(|t| t.eq_ignore_ascii_case("password")) => {
                let v = self.e.value(id);
                Some(if v.is_empty() { String::new() } else { "•••".into() })
            }
            Control::Editor(_) | Control::Value => Some(collapse(&self.e.value(id), VALUE_MAX)),
            Control::Select => {
                let index = usize::try_from(self.e.selected_index(id)).ok()?;
                let option = *self.e.options(id).get(index)?;
                Some(collapse(&self.e.inner_text(option), VALUE_MAX))
            }
            _ if matches!(tag, "progress" | "meter") => attr("value"),
            _ if attr("contenteditable").is_some_and(|v| v != "false") => Some(collapse(&self.e.inner_text(id), VALUE_MAX)),
            _ => None,
        }
    }
}
