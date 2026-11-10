use acde_render::{NONE, Options};
use serde_json::Value;

mod common;
use common::Doc;

fn page(html: &str) -> Doc {
    let doc = Doc::new(480, 320, 1.0, &Options::default()).unwrap();
    doc.dom.parse_document(&format!("<!doctype html><style>body {{ margin: 0; font: 16px/20px sans-serif; }}</style>{html}")).unwrap();
    doc.commit();
    doc
}

fn nodes(doc: &Doc, invisible: bool) -> Vec<Value> {
    let tree: Value = serde_json::from_str(&doc.semantics(NONE, 600, true, invisible).unwrap()).unwrap();
    let mut out = Vec::new();
    let mut stack: Vec<Value> = tree["nodes"].as_array().cloned().unwrap_or_default();
    while let Some(node) = stack.pop() {
        stack.extend(node["children"].as_array().cloned().unwrap_or_default());
        out.push(node);
    }
    out
}

fn named(doc: &Doc, name: &str, invisible: bool) -> Option<Value> {
    nodes(doc, invisible).into_iter().find(|n| n["name"] == name)
}

fn states(node: &Value) -> Vec<&str> {
    node["states"].as_array().map(|s| s.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

#[test]
fn transparent_and_invisible_elements_show_only_when_asked() {
    let doc = page(
        "<button style='opacity: 0'>Delete</button>\
         <div style='opacity: 0'><button>Edit</button></div>\
         <button style='visibility: hidden' aria-label=Hidden>Hidden</button>\
         <button style='display: none'>Gone</button>\
         <button>Plain</button>",
    );
    for name in ["Delete", "Edit", "Hidden", "Gone"] {
        assert!(named(&doc, name, false).is_none(), "{name} is left out by default");
    }
    let plain = named(&doc, "Plain", true).unwrap();
    assert!(states(&plain).is_empty(), "{plain}");
    assert_eq!(states(&named(&doc, "Delete", true).unwrap()), ["transparent"]);
    assert_eq!(states(&named(&doc, "Edit", true).unwrap()), ["transparent"], "inside a transparent element");
    assert_eq!(states(&named(&doc, "Hidden", true).unwrap()), ["invisible"]);
    assert!(named(&doc, "Gone", true).is_none(), "display: none has no box");
    assert!(nodes(&doc, true).iter().all(|n| n["role"] != "generic"), "a transparent wrapper is not listed on its own");
}
