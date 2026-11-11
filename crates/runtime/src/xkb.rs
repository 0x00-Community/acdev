use std::path::PathBuf;
use std::sync::OnceLock;

use roxmltree::{Document, Node, ParsingOptions};
use serde_json::{Value, json};

static CATALOG: OnceLock<Value> = OnceLock::new();

/// The keyboard models, layouts (with variants) and option groups of xkeyboard-config's `rules/evdev.xml`, as KDE's
/// keyboard settings list them; read once.
pub fn xkb_catalog() -> Result<Value, String> {
    if let Some(catalog) = CATALOG.get() {
        return Ok(catalog.clone());
    }
    let root = std::env::var_os("XKB_CONFIG_ROOT").filter(|v| !v.is_empty()).map_or_else(|| PathBuf::from("/usr/share/X11/xkb"), PathBuf::from);
    let path = root.join("rules").join("evdev.xml");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let catalog = parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(CATALOG.get_or_init(|| catalog).clone())
}

fn child<'a>(node: Node<'a, 'a>, name: &str) -> Option<Node<'a, 'a>> {
    node.children().find(|c| c.has_tag_name(name))
}

fn children<'a>(node: Node<'a, 'a>, name: &'a str) -> impl Iterator<Item = Node<'a, 'a>> {
    node.children().filter(move |c| c.has_tag_name(name))
}

fn field(node: Option<Node>, name: &str) -> String {
    node.and_then(|n| child(n, name)).and_then(|n| n.text()).unwrap_or_default().trim().to_owned()
}

fn item<'a>(node: Node<'a, 'a>) -> (String, String, Option<Node<'a, 'a>>) {
    let config = child(node, "configItem");
    (field(config, "name"), field(config, "description"), config)
}

fn parse(xml: &str) -> Result<Value, String> {
    let doc = Document::parse_with_options(xml, ParsingOptions { allow_dtd: true, ..ParsingOptions::default() }).map_err(|e| e.to_string())?;
    let registry = doc.root_element();
    let list = |name: &str| child(registry, name);
    let models: Vec<Value> = list("modelList")
        .into_iter()
        .flat_map(|l| children(l, "model"))
        .map(|m| {
            let (id, name, config) = item(m);
            json!({ "id": id, "name": name, "vendor": field(config, "vendor") })
        })
        .filter(|m| m["id"] != "")
        .collect();
    let mut layouts: Vec<Value> = list("layoutList")
        .into_iter()
        .flat_map(|l| children(l, "layout"))
        .map(|layout| {
            let (id, name, config) = item(layout);
            let languages: Vec<String> = config.and_then(|c| child(c, "languageList")).into_iter().flat_map(|l| children(l, "iso639Id")).filter_map(|n| n.text()).map(str::to_owned).collect();
            let variants: Vec<Value> = child(layout, "variantList")
                .into_iter()
                .flat_map(|l| children(l, "variant"))
                .map(|v| {
                    let (id, name, _) = item(v);
                    json!({ "id": id, "name": name })
                })
                .filter(|v| v["id"] != "")
                .collect();
            json!({ "id": id, "name": name, "short": field(config, "shortDescription"), "languages": languages, "variants": variants })
        })
        .filter(|l| l["id"] != "")
        .collect();
    layouts.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let options: Vec<Value> = list("optionList")
        .into_iter()
        .flat_map(|l| children(l, "group"))
        .map(|group| {
            let (id, name, _) = item(group);
            let multiple = group.attribute("allowMultipleSelection") == Some("true");
            let options: Vec<Value> = children(group, "option")
                .map(|o| {
                    let (id, name, _) = item(o);
                    json!({ "id": id, "name": name })
                })
                .filter(|o| o["id"] != "")
                .collect();
            json!({ "id": id, "name": name, "multiple": multiple, "options": options })
        })
        .filter(|g| g["id"] != "")
        .collect();
    Ok(json!({ "models": models, "layouts": layouts, "options": options }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_variants_and_option_groups() {
        let xml = r#"<?xml version="1.0"?><!DOCTYPE xkbConfigRegistry SYSTEM "xkb.dtd"><xkbConfigRegistry version="1.1">
          <modelList><model><configItem><name>pc105</name><description>Generic 105-key PC</description><vendor>Generic</vendor></configItem></model></modelList>
          <layoutList>
            <layout><configItem><name>us</name><shortDescription>en</shortDescription><description>English (US)</description>
              <languageList><iso639Id>eng</iso639Id></languageList></configItem>
              <variantList><variant><configItem><name>intl</name><description>English (US, intl., with dead keys)</description></configItem></variant></variantList></layout>
            <layout><configItem><name>cn</name><shortDescription>zh</shortDescription><description>Chinese</description></configItem></layout>
          </layoutList>
          <optionList><group allowMultipleSelection="true"><configItem><name>grp</name><description>Switching to another layout</description></configItem>
            <option><configItem><name>grp:alt_shift_toggle</name><description>Alt+Shift</description></configItem></option></group></optionList>
        </xkbConfigRegistry>"#;
        let c = parse(xml).unwrap();
        assert_eq!(c["models"][0]["id"], "pc105");
        assert_eq!(c["layouts"][0]["id"], "cn");
        assert_eq!(c["layouts"][1]["variants"][0]["id"], "intl");
        assert_eq!(c["layouts"][1]["languages"][0], "eng");
        assert_eq!(c["options"][0]["options"][0]["id"], "grp:alt_shift_toggle");
        assert_eq!(c["options"][0]["multiple"], true);
    }

    #[test]
    fn the_installed_catalog_reads() {
        if !std::path::Path::new("/usr/share/X11/xkb/rules/evdev.xml").exists() {
            return;
        }
        let c = xkb_catalog().unwrap();
        assert!(c["layouts"].as_array().is_some_and(|l| l.iter().any(|l| l["id"] == "us")));
    }
}
