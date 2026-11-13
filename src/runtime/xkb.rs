use std::path::PathBuf;

use roxmltree::{Document, Node, ParsingOptions};
use serde_json::{Value, json};

const ROOT: &str = "/usr/share/X11/xkb";
const ROOT_VAR: &str = "XKB_CONFIG_ROOT";
const RULES: &str = "rules/evdev.xml";

#[derive(Clone, Copy)]
struct Item<'a> {
    node: Node<'a, 'a>,
}

impl<'a> Item<'a> {
    fn child(self, name: &str) -> Option<Item<'a>> {
        self.node.children().find(|c| c.has_tag_name(name)).map(|node| Item { node })
    }

    fn children(self, name: &'a str) -> impl Iterator<Item = Item<'a>> {
        self.node.children().filter(move |c| c.has_tag_name(name)).map(|node| Item { node })
    }

    fn list(list: Option<Item<'a>>, name: &'a str) -> impl Iterator<Item = Item<'a>> {
        list.into_iter().flat_map(move |l| l.children(name))
    }

    fn text(self) -> String {
        self.node.text().unwrap_or_default().trim().to_owned()
    }

    fn config(self) -> Option<Item<'a>> {
        self.child("configItem")
    }

    fn field(config: Option<Item<'a>>, name: &str) -> String {
        config.and_then(|c| c.child(name)).map(Item::text).unwrap_or_default()
    }

    fn named(self) -> (String, String) {
        let config = self.config();
        (Self::field(config, "name"), Self::field(config, "description"))
    }

    fn entry(self) -> Option<Value> {
        let (id, name) = self.named();
        (!id.is_empty()).then(|| json!({ "id": id, "name": name }))
    }
}

pub struct XkbCatalog;

impl XkbCatalog {
    pub fn read() -> Result<Value, String> {
        let root = std::env::var_os(ROOT_VAR).filter(|v| !v.is_empty()).map_or_else(|| PathBuf::from(ROOT), PathBuf::from);
        let path = root.join(RULES);
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn parse(xml: &str) -> Result<Value, String> {
        let doc = Document::parse_with_options(xml, ParsingOptions { allow_dtd: true, ..ParsingOptions::default() }).map_err(|e| e.to_string())?;
        let registry = Item { node: doc.root_element() };
        let models: Vec<Value> = Item::list(registry.child("modelList"), "model")
            .filter_map(|m| {
                let (id, name) = m.named();
                (!id.is_empty()).then(|| json!({ "id": id, "name": name, "vendor": Item::field(m.config(), "vendor") }))
            })
            .collect();
        let mut layouts: Vec<Value> = Item::list(registry.child("layoutList"), "layout")
            .filter_map(|layout| {
                let (id, name) = layout.named();
                let config = layout.config();
                let languages: Vec<String> = Item::list(config.and_then(|c| c.child("languageList")), "iso639Id").map(Item::text).collect();
                let variants: Vec<Value> = Item::list(layout.child("variantList"), "variant").filter_map(Item::entry).collect();
                (!id.is_empty())
                    .then(|| json!({ "id": id, "name": name, "short": Item::field(config, "shortDescription"), "languages": languages, "variants": variants }))
            })
            .collect();
        layouts.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let options: Vec<Value> = Item::list(registry.child("optionList"), "group")
            .filter_map(|group| {
                let (id, name) = group.named();
                let multiple = group.node.attribute("allowMultipleSelection") == Some("true");
                let options: Vec<Value> = group.children("option").filter_map(Item::entry).collect();
                (!id.is_empty()).then(|| json!({ "id": id, "name": name, "multiple": multiple, "options": options }))
            })
            .collect();
        Ok(json!({ "models": models, "layouts": layouts, "options": options }))
    }
}
