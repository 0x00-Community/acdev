use acdert::render::{MenuList, MenuPlace, MenuRow};
use serde_json::{Value, json};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub label: String,
    pub shortcut: Option<String>,
    pub checked: bool,
    pub disabled: bool,
    pub separator: bool,
}

impl Item {
    pub fn usable(&self) -> bool {
        !self.separator && !self.disabled
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Menu {
    pub id: String,
    pub label: String,
    pub items: Vec<Item>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Open {
    pub index: usize,
    pub hover: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    Left,
    Right,
    Enter,
    Escape,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Stay(Open),
    Close,
    Select(usize, usize),
}

pub fn parse(text: &str) -> Result<Vec<Menu>, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("setMenus: {e}"))?;
    let string = |v: &Value, name: &str| v.get(name).and_then(Value::as_str).map(str::to_owned);
    let flag = |v: &Value, name: &str| v.get(name).and_then(Value::as_bool).unwrap_or(false);
    let menus = value.as_array().ok_or("setMenus: not a list of menus")?;
    menus
        .iter()
        .map(|m| {
            let items = m.get("items").and_then(Value::as_array).ok_or("setMenus: a menu has no items")?;
            Ok(Menu {
                id: string(m, "id").ok_or("setMenus: a menu has no id")?,
                label: string(m, "label").unwrap_or_default(),
                items: items
                    .iter()
                    .map(|i| match i.get("type").and_then(Value::as_str) {
                        Some("separator") => Item { separator: true, ..Item::default() },
                        _ => Item {
                            id: string(i, "id").unwrap_or_default(),
                            label: string(i, "label").unwrap_or_default(),
                            shortcut: string(i, "shortcut").filter(|s| !s.is_empty()),
                            checked: flag(i, "checked"),
                            disabled: flag(i, "disabled") || !flag(i, "action"),
                            separator: false,
                        },
                    })
                    .collect(),
            })
        })
        .collect()
}

pub fn list(menu: &Menu, hover: Option<usize>) -> MenuList {
    MenuList {
        rows: menu
            .items
            .iter()
            .map(|i| MenuRow { label: i.label.clone(), shortcut: i.shortcut.clone(), checked: i.checked, disabled: i.disabled, separator: i.separator })
            .collect(),
        hover,
    }
}

pub fn key_of(code: u32) -> Key {
    let named = |name: &str| crate::keys::by_name(name) == Some(code);
    match () {
        _ if named("up") => Key::Up,
        _ if named("down") => Key::Down,
        _ if named("left") => Key::Left,
        _ if named("right") => Key::Right,
        _ if named("return") || named("space") || named("kpenter") => Key::Enter,
        _ if named("escape") => Key::Escape,
        _ => Key::Other,
    }
}

fn next(items: &[Item], from: Option<usize>, forward: bool) -> Option<usize> {
    let n = items.len();
    (1..=n)
        .map(|k| match (from, forward) {
            (None, true) => k - 1,
            (None, false) => n - k,
            (Some(at), true) => (at + k) % n,
            (Some(at), false) => (at + n - k % n) % n,
        })
        .find(|&i| items[i].usable())
}

pub fn key(menus: &[Menu], open: Open, key: Key) -> Step {
    let Some(menu) = menus.get(open.index) else { return Step::Close };
    let switch = |index: usize| Step::Stay(Open { index, hover: next(&menus[index].items, None, true) });
    match key {
        Key::Escape => Step::Close,
        Key::Up | Key::Down => Step::Stay(Open { hover: next(&menu.items, open.hover, key == Key::Down).or(open.hover), ..open }),
        Key::Left => switch((open.index + menus.len() - 1) % menus.len()),
        Key::Right => switch((open.index + 1) % menus.len()),
        Key::Enter => match open.hover.filter(|&i| menu.items.get(i).is_some_and(Item::usable)) {
            Some(item) => Step::Select(open.index, item),
            None => Step::Close,
        },
        Key::Other => Step::Stay(open),
    }
}

pub fn at(rects: &[[f64; 4]], x: f64, y: f64) -> Option<usize> {
    rects.iter().position(|&[rx, ry, w, h]| x >= rx && y >= ry && x < rx + w && y < ry + h)
}

pub fn geometry(menus: &[Menu], labels: &[[f64; 4]], open: Option<Open>, place: Option<&MenuPlace>) -> Value {
    let open = open.and_then(|o| Some((o, menus.get(o.index)?, place?)));
    json!({
        "menus": menus.iter().zip(labels).map(|(m, rect)| json!({ "id": m.id, "label": m.label, "rect": rect })).collect::<Vec<_>>(),
        "open": open.map(|(o, menu, place)| json!({
            "index": o.index,
            "hover": o.hover,
            "rect": place.rect,
            "items": menu.items.iter().zip(&place.rows).map(|(i, rect)| json!({
                "id": i.id,
                "label": i.label,
                "shortcut": i.shortcut,
                "checked": i.checked,
                "disabled": i.disabled,
                "separator": i.separator,
                "rect": rect,
            })).collect::<Vec<_>>(),
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIRE: &str = r#"[
        {"id":"file","label":"File","items":[
            {"id":"new","label":"New","shortcut":"ctrl+n","action":true},
            {"type":"separator"},
            {"id":"print","label":"Print","disabled":true,"action":true},
            {"id":"about","label":"About","action":false},
            {"id":"quit","label":"Quit","action":true}]},
        {"id":"view","label":"View","items":[{"id":"dark","label":"Dark","checked":true,"action":true}]}
    ]"#;

    #[test]
    fn the_wire_menus_parse_and_items_without_an_action_are_disabled() {
        let menus = parse(WIRE).unwrap();
        assert_eq!(menus.len(), 2);
        assert_eq!(menus[0].items[0].shortcut.as_deref(), Some("ctrl+n"));
        assert!(menus[0].items[1].separator);
        assert!(menus[0].items[3].disabled, "nothing runs it");
        assert!(menus[1].items[0].checked);
        assert!(parse("{}").is_err());
    }

    #[test]
    fn arrow_keys_skip_separators_and_disabled_items_and_wrap() {
        let menus = parse(WIRE).unwrap();
        let open = |hover| Open { index: 0, hover };
        assert_eq!(key(&menus, open(None), Key::Down), Step::Stay(open(Some(0))));
        assert_eq!(key(&menus, open(Some(0)), Key::Down), Step::Stay(open(Some(4))));
        assert_eq!(key(&menus, open(Some(4)), Key::Down), Step::Stay(open(Some(0))));
        assert_eq!(key(&menus, open(Some(0)), Key::Up), Step::Stay(open(Some(4))));
        assert_eq!(key(&menus, open(None), Key::Up), Step::Stay(open(Some(4))));
        assert_eq!(key(&menus, open(Some(4)), Key::Enter), Step::Select(0, 4));
        assert_eq!(key(&menus, open(None), Key::Enter), Step::Close);
        assert_eq!(key(&menus, open(Some(0)), Key::Right), Step::Stay(Open { index: 1, hover: Some(0) }));
        assert_eq!(key(&menus, open(Some(0)), Key::Left), Step::Stay(Open { index: 1, hover: Some(0) }));
        assert_eq!(key(&menus, open(Some(0)), Key::Escape), Step::Close);
    }

    #[test]
    fn geometry_lists_the_menus_and_the_open_list() {
        let menus = parse(WIRE).unwrap();
        let labels = [[80.0, 0.0, 40.0, 32.0], [120.0, 0.0, 44.0, 32.0]];
        let place = MenuPlace { rect: [80.0, 32.0, 180.0, 100.0], rows: (0..5).map(|i| [85.0, 37.0 + 24.0 * f64::from(i), 170.0, 24.0]).collect() };
        let closed = geometry(&menus, &labels, None, Some(&place));
        assert_eq!(closed["menus"][1]["label"], "View");
        assert!(closed["open"].is_null());
        let open = geometry(&menus, &labels, Some(Open { index: 0, hover: Some(4) }), Some(&place));
        assert_eq!(open["open"]["items"][4]["id"], "quit");
        assert_eq!(open["open"]["items"][4]["rect"][1], 133.0);
        assert_eq!(at(&place.rows, 90.0, 40.0), Some(0));
        assert_eq!(at(&labels, 130.0, 10.0), Some(1));
    }
}
