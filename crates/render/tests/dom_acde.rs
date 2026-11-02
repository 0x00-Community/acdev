use acde_render::{Document, Dom, NONE, NodeType, Ns, Options};

fn page(html: &str) -> (Document, Dom) {
    let doc = Document::new(800, 600, 1.0, &Options::default()).unwrap();
    let dom = doc.dom();
    dom.parse_document(html).unwrap();
    (doc, dom)
}

fn by_id(dom: &Dom, id: &str) -> u32 {
    let found = dom.get_element_by_id(id);
    assert_ne!(found, NONE, "#{id}");
    found
}

#[test]
fn describe_is_type_namespace_connectedness_and_name() {
    let (_doc, dom) = page("<!doctype html><html><body><p id=p>x</p><svg id=s><linearGradient/></svg></body></html>");
    let p = by_id(&dom, "p");
    assert_eq!(dom.describe(p).unwrap(), (NodeType::Element, Ns::Html, true, "p".to_owned()));
    let gradient = dom.first_child(by_id(&dom, "s")).unwrap();
    assert_eq!(dom.describe(gradient).unwrap(), (NodeType::Element, Ns::Svg, true, "linearGradient".to_owned()));
    let text = dom.first_child(p).unwrap();
    assert_eq!(dom.describe(text).unwrap(), (NodeType::Text, Ns::Html, true, String::new()));
    let fragment = dom.create_fragment().unwrap();
    assert_eq!(dom.describe(fragment).unwrap(), (NodeType::DocumentFragment, Ns::Html, false, String::new()));
    dom.commit();
    assert!(dom.node_type(fragment).is_ok());
}

#[test]
fn parse_inert_is_a_whole_detached_page() {
    let (_doc, dom) = page("<!doctype html><html><body></body></html>");
    let root = dom.parse_inert("<!doctype html><html lang=fr><head><title>T</title></head><body><p>a</p><!-- </body> --><p>b</p></body></html>").unwrap();
    assert_eq!(dom.node_type(root).unwrap(), NodeType::DocumentFragment);
    assert!(!dom.is_connected(root).unwrap());
    let kids = dom.child_nodes(root).unwrap();
    assert_eq!(kids.len(), 2);
    assert_eq!(dom.node_type(kids[0]).unwrap(), NodeType::DocumentType);
    let html = kids[1];
    assert_eq!(dom.get_attribute(html, "lang").unwrap().as_deref(), Some("fr"));
    let parts = dom.children(html).unwrap();
    assert_eq!(dom.inner_html(parts[0]).unwrap(), "<title>T</title>");
    assert_eq!(dom.inner_html(parts[1]).unwrap(), "<p>a</p><!-- </body> --><p>b</p>");
    assert_eq!(dom.query_selector_all(dom.document(), "p").unwrap().len(), 0);
}

#[test]
fn parse_color_knows_every_css_colour() {
    let (_doc, dom) = page("<!doctype html><html><body></body></html>");
    let rgba = |text: &str| dom.parse_color(text).map(|c| c.map(|v| (v * 255.0).round() as u8));
    assert_eq!(rgba("darkblue"), Some([0, 0, 139, 255]));
    assert_eq!(rgba("RebeccaPurple"), Some([102, 51, 153, 255]));
    assert_eq!(rgba("#0f08"), Some([0, 255, 0, 136]));
    assert_eq!(rgba("hsl(120 100% 25% / 50%)"), Some([0, 128, 0, 128]));
    assert_eq!(rgba("oklch(0.628 0.2577 29.23)"), Some([255, 0, 0, 255]));
    assert_eq!(rgba("transparent"), Some([0, 0, 0, 0]));
    assert_eq!(rgba("currentcolor"), Some([0, 0, 0, 255]));
    assert_eq!(rgba("not-a-colour"), None);
    assert_eq!(rgba("red blue"), None);
}

#[test]
fn style_sheet_rules_style_the_page() {
    let (_doc, dom) = page("<!doctype html><html><head><style id=s></style></head><body><p id=p>x</p></body></html>");
    let style = by_id(&dom, "s");
    let p = by_id(&dom, "p");
    assert_eq!(dom.sheet_rule_count(style).unwrap(), Some(0));
    assert_eq!(dom.sheet_insert_rule(style, "p { color: rgb(0, 128, 0) }", 0).unwrap(), 0);
    assert_eq!(dom.sheet_insert_rule(style, ".x { color: blue }", 1).unwrap(), 1);
    assert_eq!(dom.sheet_rule_count(style).unwrap(), Some(2));
    assert_eq!(dom.sheet_rule(style, 0).unwrap(), "p { color: rgb(0, 128, 0); }");
    assert_eq!(dom.computed_style(p, "", "color").unwrap(), "rgb(0, 128, 0)");
    assert_eq!(dom.text_content(style).unwrap(), "", "the element's text stays as it was");
    let name = |e: acde_render::Error| e.0.split(':').next().unwrap().to_owned();
    assert_eq!(dom.sheet_insert_rule(style, "p", 0).map_err(name), Err("SyntaxError".to_owned()));
    assert_eq!(dom.sheet_insert_rule(style, "p {}", 9).map_err(name), Err("IndexSizeError".to_owned()));
    dom.sheet_delete_rule(style, 0).unwrap();
    assert_eq!(dom.computed_style(p, "", "color").unwrap(), "rgb(0, 0, 0)");
    let detached = dom.create_element(Ns::Html, "style").unwrap();
    assert_eq!(dom.sheet_rule_count(detached).unwrap(), None);
}
