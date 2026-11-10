use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;

use blitz_dom::node::{ImageData, SpecialElementData, TextInputData};
use blitz_dom::{BaseDocument, Node, NodeData, NodeId, QualName, ns};
use style_dom::ElementState;

use crate::canvas::Canvas;
use crate::caret::{Caret, utf16_to_byte};
use crate::engine::Engine;
use crate::geometry::Geometry;
use crate::serialize::Serializer;
use crate::tree::{Doctype, Tree};
use crate::{Capture, CaretPosition, Error, Metrics, Result, Shared, Stats, TextMetrics};

mod select;
mod semantics;

const INPUT_TTL_MS: f64 = 1000.0;

pub const NONE: u32 = u32::MAX;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeType {
    Element = 1,
    Text = 3,
    Comment = 8,
    Document = 9,
    DocumentType = 10,
    DocumentFragment = 11,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ns {
    Html = 0,
    Svg = 1,
    MathMl = 2,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

pub type Quad = [f64; 4];

const FRAGMENT: &str = "#document-fragment";

const LOADING: u8 = 0;
const LOADED: u8 = 1;
const FAILED: u8 = 2;
const NO_SRC: u8 = 3;

pub(crate) fn is_fragment(n: &Node) -> bool {
    n.element_data().is_some_and(|e| is_fragment_name(&e.name))
}

fn fail(name: &str, message: impl std::fmt::Display) -> Error {
    Error::new(format!("{name}: {message}"))
}

#[derive(Clone)]
pub struct Dom {
    pub(crate) shared: Arc<Shared>,
    pub(crate) wake: Sender<()>,
}

impl Dom {
    fn read<T>(&self, f: impl FnOnce(&mut Engine) -> Result<T>) -> Result<T> {
        self.shared.call(&self.wake, f)
    }

    fn on<T>(&self, id: u32, f: impl FnOnce(&mut Engine, NodeId) -> T) -> Result<T> {
        self.read(|e| e.n(id).map(|node| f(e, node)))
    }

    fn write<T>(&self, f: impl FnOnce(&mut Engine) -> Result<T>) -> Result<T> {
        self.write_if(None, f, |_| true)
    }

    fn update(&self, f: impl FnOnce(&mut Engine)) -> Result<()> {
        self.write(|e| {
            f(e);
            Ok(())
        })
    }

    fn write_at<T>(&self, targets: &[u32], f: impl FnOnce(&mut Engine) -> Result<T>) -> Result<T> {
        self.write_if(Some(targets), f, |_| true)
    }

    fn edit<T>(&self, id: u32, f: impl FnOnce(&mut Engine, NodeId) -> T) -> Result<T> {
        self.write_at(&[id], |e| e.n(id).map(|node| f(e, node)))
    }

    fn create(&self, f: impl FnOnce(&mut Engine) -> Result<NodeId>) -> Result<u32> {
        self.write_at(&[], |e| {
            let node = f(e)?;
            Ok(e.fresh(node))
        })
    }

    fn write_changed(&self, targets: &[u32], f: impl FnOnce(&mut Engine) -> Result<bool>) -> Result<bool> {
        self.write_if(Some(targets), f, |r| !matches!(r, Ok(false)))
    }

    fn touched(&self) {
        self.shared.touched.store(true, Ordering::Relaxed);
    }

    fn write_if<T>(&self, targets: Option<&[u32]>, f: impl FnOnce(&mut Engine) -> Result<T>, changed: fn(&Result<T>) -> bool) -> Result<T> {
        self.touched();
        self.shared.call(&self.wake, |engine| {
            let marks = (engine.uncommitted, engine.stale, engine.dirty);
            let shown = |e: &Engine| targets.is_none_or(|t| t.iter().any(|&id| e.ids.node(id).is_ok_and(|n| e.connected(n))));
            let before = shown(engine);
            let result = f(engine);
            match changed(&result) {
                false => (engine.uncommitted, engine.stale, engine.dirty) = marks,
                true if before || shown(engine) => {
                    engine.uncommitted = true;
                    engine.touch();
                }
                true => {
                    engine.uncommitted = true;
                    (engine.stale, engine.dirty) = (marks.1, marks.2);
                }
            }
            result
        })
    }

    fn write_paint<T>(&self, id: u32, f: impl FnOnce(&mut Engine) -> Result<T>) -> Result<T> {
        self.touched();
        self.shared.call(&self.wake, |engine| {
            engine.uncommitted = true;
            let (stale, dirty) = (engine.stale, engine.dirty);
            let result = f(engine);
            engine.stale = stale;
            engine.dirty = dirty || engine.ids.node(id).is_ok_and(|n| engine.connected(n));
            result
        })
    }

    pub fn document(&self) -> u32 {
        self.read(|e| {
            let document = e.doc.root_node().id;
            Ok(e.ids.id_of(document))
        })
        .unwrap_or(NONE)
    }

    pub fn parse_document(&self, html: &str) -> Result<()> {
        self.update(|e| e.parse_document(html))
    }

    pub fn viewport(&self) -> Viewport {
        self.read(|e| {
            let v = e.doc.viewport();
            let scale = v.scale_f64();
            Ok(Viewport { width: f64::from(v.window_size.0) / scale, height: f64::from(v.window_size.1) / scale, scale })
        })
        .unwrap_or(Viewport { width: 0.0, height: 0.0, scale: 1.0 })
    }

    pub fn resize(&self, width: u32, height: u32, scale: f32) {
        _ = self.update(|e| e.resize(width, height, scale));
    }

    pub fn set_dark(&self, on: bool) {
        _ = self.update(|e| e.set_dark(on));
    }

    pub fn set_reduced_motion(&self, on: bool) {
        _ = self.update(|e| e.set_reduced_motion(on));
    }

    pub fn node_type(&self, id: u32) -> Result<NodeType> {
        self.on(id, |e, n| e.kind(n))
    }

    pub fn parent(&self, id: u32) -> Result<u32> {
        self.read(|e| Ok(e.out(e.node(id)?.parent)))
    }

    pub fn ancestors(&self, id: u32) -> Result<Vec<u32>> {
        self.on(id, |e, n| e.outs(e.ancestors(n).into_iter().skip(1)))
    }

    pub fn first_child(&self, id: u32) -> Result<u32> {
        self.read(|e| Ok(e.out(e.node(id)?.children.first().copied())))
    }

    pub fn last_child(&self, id: u32) -> Result<u32> {
        self.read(|e| Ok(e.out(e.node(id)?.children.last().copied())))
    }

    pub fn next_sibling(&self, id: u32) -> Result<u32> {
        self.read(|e| Ok(e.out(e.sibling(e.n(id)?, 1))))
    }

    pub fn previous_sibling(&self, id: u32) -> Result<u32> {
        self.read(|e| Ok(e.out(e.sibling(e.n(id)?, -1))))
    }

    pub fn child_nodes(&self, id: u32) -> Result<Vec<u32>> {
        self.read(|e| Ok(e.outs(e.node(id)?.children.to_vec())))
    }

    pub fn children(&self, id: u32) -> Result<Vec<u32>> {
        self.read(|e| Ok(e.outs(e.node(id)?.children.iter().copied().filter(|&c| e.kind(c) == NodeType::Element).collect::<Vec<_>>())))
    }

    pub fn child_count(&self, id: u32) -> Result<u32> {
        self.read(|e| Ok(e.node(id)?.children.len() as u32))
    }

    pub fn is_connected(&self, id: u32) -> Result<bool> {
        self.on(id, |e, n| e.connected(n))
    }

    pub fn compare_document_position(&self, a: u32, b: u32) -> Result<u16> {
        self.read(|e| Ok(e.compare(e.n(a)?, e.n(b)?)))
    }

    pub fn create_element(&self, ns: Ns, local_name: &str) -> Result<u32> {
        if !valid_element_name(local_name) {
            return Err(fail("InvalidCharacterError", format!("'{local_name}' is not a valid element name")));
        }
        self.create(|e| Ok(e.tree().create_element(namespace(ns), local_name)))
    }

    pub fn create_text(&self, data: &str) -> Result<u32> {
        self.create(|e| Ok(e.tree().m.create_text_node(data)))
    }

    pub fn create_comment(&self, data: &str) -> Result<u32> {
        self.create(|e| Ok(e.tree().m.create_comment_node(data)))
    }

    pub fn create_fragment(&self) -> Result<u32> {
        self.create(|e| Ok(e.new_fragment()))
    }

    pub fn create_document_type(&self, name: &str, public_id: &str, system_id: &str) -> Result<u32> {
        self.create(|e| {
            let node = e.tree().m.create_comment_node("");
            e.ids.doctypes.insert(node, Doctype { name: name.into(), public_id: public_id.into(), system_id: system_id.into() });
            Ok(node)
        })
    }

    pub fn clone(&self, id: u32, deep: bool) -> Result<u32> {
        self.create(|e| e.clone_node(e.n(id)?, deep))
    }

    pub fn insert_before(&self, parent: u32, child: u32, reference: u32) -> Result<()> {
        self.write_at(&[parent, child], |e| {
            let (parent, child, reference) = (e.n(parent)?, e.n(child)?, e.maybe(reference)?);
            e.insert(parent, child, reference)
        })
    }

    pub fn remove(&self, child: u32) -> Result<()> {
        self.edit(child, |e, node| {
            if let Some(parent) = e.doc.get_node(node).and_then(|n| n.parent) {
                let owner = e.list_owner(parent);
                e.tree().m.remove_node(node);
                e.collect(&[node]);
                if let Some(select) = owner {
                    e.settle_select(select, None);
                }
            }
        })
    }

    pub fn replace_children(&self, parent: u32, ids: &[u32]) -> Result<()> {
        let targets: Vec<u32> = std::iter::once(parent).chain(ids.iter().copied()).collect();
        self.write_at(&targets, |e| {
            let parent = e.n(parent)?;
            let nodes = ids.iter().map(|&id| e.n(id)).collect::<Result<Vec<_>>>()?;
            e.replace_children(parent, &nodes)
        })
    }

    pub fn local_name(&self, id: u32) -> Result<String> {
        self.read(|e| Ok(e.element(id)?.name.local.to_string()))
    }

    pub fn namespace(&self, id: u32) -> Result<Ns> {
        self.read(|e| Ok(ns_of(&e.element(id)?.name)))
    }

    pub fn get_attribute(&self, id: u32, name: &str) -> Result<Option<String>> {
        self.read(|e| Ok(e.find_attribute(e.n(id)?, name)?.map(|(_, v)| v)))
    }

    pub fn set_attribute(&self, id: u32, name: &str, value: &str) -> Result<bool> {
        if !valid_attribute_name(name) {
            return Err(fail("InvalidCharacterError", format!("'{name}' is not a valid attribute name")));
        }
        self.write_changed(&[id], |e| e.set_attribute_dom(id, name, Some(value)))
    }

    pub fn remove_attribute(&self, id: u32, name: &str) -> Result<bool> {
        self.write_changed(&[id], |e| e.set_attribute_dom(id, name, None))
    }

    pub fn has_attribute(&self, id: u32, name: &str) -> Result<bool> {
        self.read(|e| Ok(e.find_attribute(e.n(id)?, name)?.is_some()))
    }

    pub fn attributes(&self, id: u32) -> Result<Vec<String>> {
        self.read(|e| Ok(e.element(id)?.attrs().iter().flat_map(|a| [qualified(&a.name), a.value.clone()]).collect()))
    }

    pub fn id(&self, id: u32) -> Result<String> {
        self.read(|e| Ok(e.element(id)?.attr(blitz_dom::local_name!("id")).unwrap_or_default().to_owned()))
    }

    pub fn class_name(&self, id: u32) -> Result<String> {
        self.read(|e| Ok(e.element(id)?.attr(blitz_dom::local_name!("class")).unwrap_or_default().to_owned()))
    }

    pub fn document_type(&self, id: u32) -> Result<(String, String, String)> {
        self.read(|e| {
            let d = e.ids.doctypes.get(&e.n(id)?).ok_or_else(|| fail("InvalidNodeTypeError", "not a doctype"))?;
            Ok((d.name.clone(), d.public_id.clone(), d.system_id.clone()))
        })
    }

    pub fn data(&self, id: u32) -> Result<String> {
        self.read(|e| {
            let n = e.node(id)?;
            Ok(match &n.data {
                NodeData::Text(t) => t.content.clone(),
                NodeData::Comment { contents } if !e.ids.doctypes.contains_key(&n.id) => contents.clone(),
                _ => String::new(),
            })
        })
    }

    pub fn set_data(&self, id: u32, data: &str) -> Result<()> {
        self.edit(id, |e, n| e.set_data(n, data))
    }

    pub fn text_content(&self, id: u32) -> Result<String> {
        self.read(|e| {
            let n = e.node(id)?;
            Ok(match &n.data {
                NodeData::Document(_) => String::new(),
                NodeData::Comment { contents } if !e.ids.doctypes.contains_key(&n.id) => contents.clone(),
                NodeData::Comment { .. } => String::new(),
                _ => n.text_content(),
            })
        })
    }

    pub fn set_text_content(&self, id: u32, text: &str) -> Result<()> {
        self.edit(id, |e, node| match e.kind(node) {
            NodeType::Element | NodeType::DocumentFragment => {
                let text = (!text.is_empty()).then(|| e.tree().m.create_text_node(text));
                let nodes: Vec<NodeId> = text.into_iter().collect();
                e.replace_children(node, &nodes)
            }
            NodeType::Text | NodeType::Comment => {
                e.set_data(node, text);
                Ok(())
            }
            NodeType::Document | NodeType::DocumentType => Ok(()),
        })
        .flatten()
    }

    pub fn inner_text(&self, id: u32) -> Result<String> {
        self.on(id, |e, n| {
            e.resolved();
            e.inner_text(n)
        })
    }

    pub fn inner_html(&self, id: u32) -> Result<String> {
        self.on(id, |e, n| Serializer { doc: &e.doc, ids: &e.ids }.inner(n))
    }

    pub fn outer_html(&self, id: u32) -> Result<String> {
        self.on(id, |e, n| Serializer { doc: &e.doc, ids: &e.ids }.outer(n))
    }

    pub fn parse_fragment(&self, context: u32, html: &str) -> Result<u32> {
        self.create(|e| Ok(e.parse_fragment(e.n(context)?, html)))
    }

    pub fn template_content(&self, id: u32) -> Result<u32> {
        self.edit(id, |e, node| {
            e.element(id)?;
            let content = e.tree().m.template_contents(node);
            e.ids.templates.insert(content, node);
            Ok(e.ids.id_of(content))
        })
        .flatten()
    }

    pub fn query_selector(&self, root: u32, selector: &str) -> Result<u32> {
        self.read(|e| {
            let found = e.doc.query_selector_in(e.n(root)?, selector).map_err(|_| bad_selector(selector))?;
            Ok(e.out(found))
        })
    }

    pub fn query_selector_all(&self, root: u32, selector: &str) -> Result<Vec<u32>> {
        self.read(|e| {
            let found = e.doc.query_selector_all_in(e.n(root)?, selector).map_err(|_| bad_selector(selector))?;
            Ok(e.outs(found))
        })
    }

    pub fn matches(&self, id: u32, selector: &str) -> Result<bool> {
        self.read(|e| e.doc.matches_selector(e.n(id)?, selector).map_err(|_| bad_selector(selector)))
    }

    pub fn closest(&self, id: u32, selector: &str) -> Result<u32> {
        self.read(|e| {
            let found = e.doc.closest(e.n(id)?, selector).map_err(|_| bad_selector(selector))?;
            Ok(e.out(found))
        })
    }

    pub fn get_element_by_id(&self, id: &str) -> u32 {
        self.read(|e| Ok(e.out(e.doc.get_element_by_id(id)))).unwrap_or(NONE)
    }

    pub fn get_elements_by_class_name(&self, root: u32, class_names: &str) -> Result<Vec<u32>> {
        let wanted: Vec<&str> = class_names.split_ascii_whitespace().collect();
        self.elements(root, |el| !wanted.is_empty() && wanted.iter().all(|w| el.classes.iter().any(|c| &**c == *w)))
    }

    pub fn get_elements_by_tag_name(&self, root: u32, qualified_name: &str) -> Result<Vec<u32>> {
        let lower = qualified_name.to_ascii_lowercase();
        self.elements(root, |el| qualified_name == "*" || qualified(&el.name) == if el.name.ns == ns!(html) { lower.as_str() } else { qualified_name })
    }

    fn elements(&self, root: u32, keep: impl Fn(&blitz_dom::ElementData) -> bool) -> Result<Vec<u32>> {
        self.on(root, |e, root| {
            let found: Vec<NodeId> = e
                .descendants(root)
                .into_iter()
                .filter(|&d| e.doc.get_node(d).and_then(|n| n.element_data()).is_some_and(|el| !is_fragment_name(&el.name) && keep(el)))
                .collect();
            e.outs(found)
        })
    }

    pub fn value(&self, id: u32) -> Result<String> {
        self.on(id, |e, n| e.value(n))
    }

    pub fn set_value(&self, id: u32, value: &str) -> Result<()> {
        self.edit(id, |e, n| e.set_value(id, n, value)).flatten()
    }

    pub fn checked(&self, id: u32) -> Result<bool> {
        self.on(id, |e, n| e.checked(n))
    }

    pub fn set_checked(&self, id: u32, checked: bool) -> Result<()> {
        self.edit(id, |e, n| e.set_checked(n, checked))
    }

    pub fn selected_index(&self, id: u32) -> Result<i32> {
        self.on(id, |e, n| e.selected_index(n))
    }

    pub fn set_selected_index(&self, id: u32, index: i32) -> Result<()> {
        self.edit(id, |e, node| e.set_selected_index(node, index))
    }

    pub fn options(&self, id: u32) -> Result<Vec<u32>> {
        self.read(|e| {
            let node = e.n(id)?;
            let options = e.options(node);
            Ok(e.outs(options))
        })
    }

    pub fn option_selected(&self, id: u32) -> Result<bool> {
        self.on(id, |e, n| e.selectedness(n))
    }

    pub fn set_option_selected(&self, id: u32, selected: bool) -> Result<()> {
        self.edit(id, |e, n| e.set_option_selected(n, selected))
    }

    pub fn reset_select(&self, id: u32) -> Result<()> {
        self.edit(id, |e, n| e.reset_select(n))
    }

    pub fn list_box_option_at(&self, id: u32, x: f64, y: f64) -> Result<i32> {
        self.on(id, |e, n| e.list_box_option_at(n, x, y))
    }

    pub fn open_picker(&self, id: u32) -> Result<bool> {
        self.write(|e| {
            let node = e.n(id)?;
            Ok(e.open_picker(node))
        })
    }

    pub fn close_picker(&self) {
        let _ = self.update(|e| e.close_picker());
    }

    pub fn picker_state(&self) -> [f64; 3] {
        self.read(|e| Ok(e.picker_state())).unwrap_or([-1.0, -1.0, 0.0])
    }

    pub fn picker_option_at(&self, x: f64, y: f64) -> i32 {
        self.read(|e| Ok(e.picker_option_at(x, y))).unwrap_or(-2)
    }

    pub fn picker_option_rect(&self, id: u32) -> Result<Option<Quad>> {
        self.on(id, |e, option| {
            let select = e.owner_select(option)?;
            e.picker_rects(select).into_iter().find(|(o, _)| *o == option).map(|(_, r)| quad(r))
        })
    }

    pub fn set_picker_active(&self, option: i32) {
        let _ = self.update(|e| e.set_picker_active(option));
    }

    pub fn set_selection_range(&self, id: u32, start: u32, end: u32) -> Result<()> {
        self.edit(id, |e, n| e.set_selection_range(n, start, end))
    }

    pub fn set_focus(&self, id: u32, visible: bool) -> Result<()> {
        self.write(|e| e.maybe(id).map(|n| e.set_focus(n, visible)))
    }

    pub fn set_active(&self, id: u32) -> Result<()> {
        self.write(|e| e.maybe(id).map(|n| e.set_active(n)))
    }

    pub fn set_selection(&self, anchor: u32, anchor_offset: u32, focus: u32, focus_offset: u32) -> Result<()> {
        self.write(|e| {
            if anchor == NONE || focus == NONE {
                e.doc.clear_text_selection();
                return Ok(());
            }
            let (anchor, focus) = (e.n(anchor)?, e.n(focus)?);
            e.set_selection(anchor, anchor_offset, focus, focus_offset);
            Ok(())
        })
    }

    pub fn rect(&self, id: u32) -> Result<Quad> {
        self.on(id, |e, n| {
            let rect = Geometry { doc: e.resolved() }.client_rect(n);
            e.option_row(n).or(rect).map_or([0.0; 4], quad)
        })
    }

    pub fn client_rects(&self, id: u32) -> Result<Vec<Quad>> {
        self.on(id, |e, node| {
            e.resolved();
            if let Some(row) = e.option_row(node) {
                return vec![quad(row)];
            }
            let Some(geometry) = shown(&e.doc, node) else { return Vec::new() };
            geometry.doc.node_client_rects(node).into_iter().map(|r| quad(geometry.map(node, r.into()))).collect()
        })
    }

    pub fn metrics(&self, id: u32) -> Result<Option<Metrics>> {
        self.on(id, Engine::dom_metrics)
    }

    pub fn hit_test(&self, x: f64, y: f64) -> Option<u32> {
        self.read(|e| {
            let hit = e.resolved().element_from_point(x as f32, y as f32);
            Ok(hit.and_then(|n| e.element_of(n)).map(|node| e.hit_option(node, x, y)).map(|node| e.ids.id_of(node)))
        })
        .ok()
        .flatten()
    }

    pub fn hit_test_all(&self, x: f64, y: f64) -> Vec<u32> {
        self.read(|e| {
            let hits = e.resolved().elements_from_point(x as f32, y as f32);
            let mut nodes: Vec<NodeId> = Vec::new();
            for hit in hits {
                if let Some(node) = e.element_of(hit)
                    && !nodes.contains(&node)
                {
                    let option = e.hit_option(node, x, y);
                    if option != node {
                        nodes.push(option);
                    }
                    nodes.push(node);
                }
            }
            Ok(e.outs(nodes))
        })
        .unwrap_or_default()
    }

    pub fn computed_style(&self, id: u32, pseudo: &str, property: &str) -> Result<String> {
        self.on(id, |e, node| {
            e.resolved();
            e.styled(node, pseudo).map(|n| e.doc.resolved_style_value(n, property)).unwrap_or_default()
        })
    }

    pub fn css_supports(&self, condition: &str) -> Result<bool> {
        self.read(|e| Ok(e.doc.css_supports_condition(condition)))
    }

    pub fn css_supports_declaration(&self, property: &str, value: &str) -> Result<bool> {
        self.read(|e| Ok(e.doc.css_supports_declaration(property, value)))
    }

    pub fn computed_style_all(&self, id: u32, pseudo: &str) -> Result<Vec<String>> {
        self.on(id, |e, node| {
            e.resolved();
            let Some(target) = e.styled(node, pseudo) else { return Vec::new() };
            blitz_dom::resolved_style_property_names().iter().flat_map(|&name| [name.to_owned(), e.doc.resolved_style_value(target, name)]).collect()
        })
    }

    pub fn caret_rect(&self, id: u32, offset: u32) -> Result<Quad> {
        self.on(id, |e, n| Caret { doc: e.resolved() }.rect(n, offset).map_or([0.0; 4], quad))
    }

    pub fn caret_from_point(&self, x: f64, y: f64) -> Option<CaretPosition> {
        self.read(|e| {
            let found = Caret { doc: e.resolved() }.position_at(x as f32, y as f32);
            Ok(found.map(|(node, offset)| CaretPosition { node: e.ids.id_of(node), offset }))
        })
        .ok()
        .flatten()
    }

    pub fn text_rects(&self, id: u32, start: u32, end: u32) -> Result<Vec<Quad>> {
        self.on(id, |e, n| Caret { doc: e.resolved() }.text_rects(n, start, end).map(|rects| rects.into_iter().map(quad).collect()).unwrap_or_default())
    }

    pub fn match_media(&self, query: &str) -> bool {
        self.read(|e| Ok(e.match_media(query))).unwrap_or(false)
    }

    pub fn scroll_to(&self, id: u32, left: f64, top: f64, smooth: bool) -> Result<()> {
        self.write(|e| e.n(id).map(|n| e.scroll_to(n, left, top, smooth)))
    }

    pub fn take_scrolled(&self) -> Vec<u32> {
        self.read(|e| Ok(e.take_scrolled())).unwrap_or_default()
    }

    pub fn image_state(&self, id: u32) -> Result<[f64; 3]> {
        self.on(id, |e, node| {
            e.doc.handle_messages();
            let (width, height, state, _) = Engine::image(&e.doc, node);
            let state = if state == NO_SRC { FAILED } else { state };
            [width, height, f64::from(state)]
        })
    }

    pub fn take_loaded(&self) -> Vec<u32> {
        self.read(|e| Ok(e.take_loaded())).unwrap_or_default()
    }

    pub fn canvas(&self, id: u32, commands: &[u8]) -> Result<()> {
        self.write_paint(id, |e| {
            e.n(id)?;
            e.tree().canvas(id, commands).map_err(|err| fail("InvalidStateError", err))
        })
    }

    pub fn canvas_image(&self, id: u32, image: Option<peniko::ImageData>) -> Result<()> {
        self.write_paint(id, |e| {
            e.n(id)?;
            e.tree().canvas_image(id, image).map_err(|err| fail("InvalidStateError", err))
        })
    }

    pub fn video_image(&self, id: u32, image: Option<peniko::ImageData>) -> Result<()> {
        self.touched();
        self.shared.call(&self.wake, |engine| {
            engine.uncommitted = true;
            let (stale, dirty) = (engine.stale, engine.dirty);
            let resized = engine.n(id).and_then(|_| engine.tree().video_image(id, image).map_err(|err| fail("InvalidStateError", err)));
            let shown = engine.ids.node(id).is_ok_and(|n| engine.connected(n));
            engine.stale = stale || (shown && matches!(resized, Ok(true)));
            engine.dirty = dirty || shown;
            resized.map(|_| ())
        })
    }

    pub fn measure_text(&self, id: u32, font: &str, text: &str) -> Result<TextMetrics> {
        self.on(id, |e, _| Canvas::measure(&mut e.doc, font, text))
    }

    pub fn to_data_url(&self, id: u32, _type: &str) -> Result<String> {
        self.on(id, |e, node| e.with_canvas(id, node, |c| c.data_url().unwrap_or_else(|| "data:,".into())))
    }

    pub fn get_image_data(&self, id: u32, x: f64, y: f64, width: f64, height: f64) -> Result<Vec<u8>> {
        self.on(id, |e, node| {
            if ![x, y, width, height].iter().all(|v| v.is_finite()) || (width * height).abs() > f64::from(crate::canvas::MAX_SIDE).powi(2) {
                return Err(fail("IndexSizeError", "getImageData: bad rectangle"));
            }
            Ok(e.with_canvas(id, node, |c| c.image_data(kurbo::Rect::new(x, y, x + width, y + height))))
        })
        .flatten()
    }

    pub fn capture(&self, id: u32, scale: f64) -> Result<Option<Capture>> {
        self.on(id, |e, n| Capture::of(e.resolved(), n, scale))
    }

    pub fn set_panel(&self, id: u32, rect: Option<[f64; 4]>) -> Result<()> {
        self.write(|e| e.n(id).map(|n| e.set_panel(n, id, rect)))
    }

    pub fn pin(&self, id: u32) -> Result<()> {
        self.on(id, |e, n| e.ids.pin(n, true))
    }

    pub fn unpin(&self, id: u32) -> Result<()> {
        self.touched();
        self.on(id, |e, n| {
            e.ids.pin(n, false);
            e.ids.unpinned.push(n);
        })
    }

    pub fn pinned_in(&self, root: u32) -> Result<Vec<u32>> {
        self.on(root, |e, root| e.subtree(root).into_iter().filter(|&n| e.ids.pinned(n)).filter_map(|n| e.ids.handle(n)).collect())
    }

    pub fn input(&self, trace: acde_log::Trace) {
        _ = self.read(|e| {
            e.input = acde_log::Trace::earliest(e.input, Some(trace));
            Ok(())
        });
    }

    pub fn commit(&self) {
        if !self.shared.touched.swap(false, Ordering::Relaxed) && self.shared.commits.load(Ordering::Relaxed) != 0 {
            return;
        }
        let committed = self.read(|e| {
            let mut candidates = std::mem::take(&mut e.ids.fresh);
            candidates.append(&mut e.ids.unpinned);
            e.collect(&candidates);
            let changed = std::mem::take(&mut e.uncommitted);
            self.shared.requeue(std::mem::take(&mut e.held), &self.wake);
            let now = acde_log::now_ms();
            if !changed && e.committed != 0 {
                e.input = e.input.filter(|t| now - t.input < INPUT_TTL_MS);
                return Ok(false);
            }
            let seq = self.shared.commits.fetch_add(1, Ordering::Relaxed) + 1;
            e.committed = e.committed.max(seq);
            e.trace =
                acde_log::Trace::earliest(e.trace, e.input.take().filter(|t| now - t.input < INPUT_TTL_MS).map(|t| acde_log::Trace { committed: now, ..t }));
            e.want_present = true;
            Ok(true)
        });
        if committed.unwrap_or(false) {
            _ = self.wake.send(());
        }
    }

    pub fn stats(&self) -> Stats {
        self.read(|e| Ok(e.stats())).unwrap_or_default()
    }

    pub fn reset_timings(&self) {
        _ = self.read(|e| {
            e.reset_timings();
            Ok(())
        });
    }

    pub fn describe(&self, id: u32) -> Result<(NodeType, Ns, bool, String)> {
        self.on(id, |e, node| {
            let node_type = e.kind(node);
            let (namespace, local_name) = match node_type {
                NodeType::Element => match e.doc.get_node(node).and_then(|n| n.element_data()) {
                    Some(data) => (ns_of(&data.name), data.name.local.to_string()),
                    None => (Ns::Html, String::new()),
                },
                _ => (Ns::Html, String::new()),
            };
            let connected = e.connected(node);
            e.ids.pin(node, true);
            (node_type, namespace, connected, local_name)
        })
    }

    pub fn parse_inert(&self, html: &str) -> Result<u32> {
        self.create(|e| {
            let holder = e.new_fragment();
            let parsed = {
                let mut tree = e.tree();
                crate::parse::document(&mut tree.m, holder, html)
            };
            e.adopt(parsed);
            e.register(holder);
            Ok(holder)
        })
    }

    pub fn parse_color(&self, color: &str) -> Option<[f64; 4]> {
        self.read(|e| Ok(e.parse_color(color))).ok().flatten()
    }

    pub fn sheet_rule_count(&self, id: u32) -> Result<Option<u32>> {
        self.on(id, |e, node| e.connected(node).then(|| e.doc.stylesheet_rule_count(node, &[])).flatten().map(|n| n as u32))
    }

    pub fn sheet_rule(&self, id: u32, index: u32) -> Result<String> {
        self.read(|e| {
            e.doc.stylesheet_rule_info(e.n(id)?, &[index as usize]).map(|info| info.css_text).ok_or_else(|| fail("IndexSizeError", format!("no rule {index}")))
        })
    }

    pub fn sheet_insert_rule(&self, id: u32, rule: &str, index: u32) -> Result<u32> {
        self.write(|e| {
            e.doc
                .stylesheet_insert_rule(e.n(id)?, &[], rule, index as usize)
                .map(|at| at as u32)
                .map_err(|err| fail(err.dom_exception_name(), format!("cannot insert '{rule}' at {index}")))
        })
    }

    pub fn sheet_delete_rule(&self, id: u32, index: u32) -> Result<()> {
        self.write(|e| {
            e.doc.stylesheet_delete_rule(e.n(id)?, &[], index as usize).map_err(|err| fail(err.dom_exception_name(), format!("cannot delete rule {index}")))
        })
    }
}

fn bad_selector(selector: &str) -> Error {
    fail("SyntaxError", format!("'{selector}' is not a valid selector"))
}

fn shown(doc: &BaseDocument, node: NodeId) -> Option<Geometry<'_>> {
    let geometry = Geometry { doc };
    doc.get_node(node).filter(|n| n.is_element() && n.flags.is_in_document() && !geometry.hidden(n)).map(|_| geometry)
}

fn quad(r: crate::Rect) -> Quad {
    [r.x, r.y, r.width, r.height]
}

fn qualified(name: &QualName) -> String {
    match &name.prefix {
        Some(prefix) => format!("{prefix}:{}", name.local),
        None => name.local.to_string(),
    }
}

fn is_fragment_name(name: &QualName) -> bool {
    name.ns == ns!(html) && &*name.local == FRAGMENT
}

fn valid_element_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return false };
    match first.is_ascii_alphabetic() {
        true => !name.contains(|c: char| c.is_ascii_whitespace() || matches!(c, '\0' | '/' | '>')),
        false => {
            matches!(first, ':' | '_')
                || !first.is_ascii() && { chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_') || !c.is_ascii()) }
        }
    }
}

fn valid_attribute_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(|c: char| c.is_ascii_whitespace() || matches!(c, '\0' | '/' | '>' | '='))
}

impl Engine {
    pub(crate) fn n(&self, id: u32) -> Result<NodeId> {
        let node = self.ids.node(id).map_err(|e| fail("NotFoundError", e))?;
        match self.doc.get_node(node) {
            Some(_) => Ok(node),
            None => Err(fail("NotFoundError", format!("node {id} is gone"))),
        }
    }

    fn node(&self, id: u32) -> Result<&Node> {
        let node = self.n(id)?;
        Ok(&self.doc.tree()[node])
    }

    fn element(&self, id: u32) -> Result<&blitz_dom::ElementData> {
        let n = self.node(id)?;
        match n.element_data() {
            Some(e) if !is_fragment(n) && n.is_element() => Ok(e),
            _ => Err(fail("InvalidNodeTypeError", format!("node {id} is not an element"))),
        }
    }

    fn fresh(&mut self, node: NodeId) -> u32 {
        self.ids.fresh.push(node);
        self.ids.id_of(node)
    }

    fn maybe(&self, id: u32) -> Result<Option<NodeId>> {
        match id {
            NONE => Ok(None),
            id => self.n(id).map(Some),
        }
    }

    fn out(&mut self, node: Option<NodeId>) -> u32 {
        node.map_or(NONE, |n| self.ids.id_of(n))
    }

    fn outs(&mut self, nodes: impl IntoIterator<Item = NodeId>) -> Vec<u32> {
        nodes.into_iter().map(|n| self.ids.id_of(n)).collect()
    }

    pub(crate) fn kind(&self, node: NodeId) -> NodeType {
        let Some(n) = self.doc.get_node(node) else { return NodeType::Comment };
        match &n.data {
            NodeData::Document(_) => NodeType::Document,
            NodeData::Element(_) if is_fragment(n) => NodeType::DocumentFragment,
            NodeData::Element(_) | NodeData::AnonymousBlock(_) => NodeType::Element,
            NodeData::Text(_) => NodeType::Text,
            NodeData::Comment { .. } => match self.ids.doctypes.contains_key(&node) {
                true => NodeType::DocumentType,
                false => NodeType::Comment,
            },
        }
    }

    fn sibling(&self, node: NodeId, step: isize) -> Option<NodeId> {
        let n = self.doc.get_node(node)?;
        let parent = self.doc.get_node(n.parent?)?;
        let index = parent.index_of_child(node)?.checked_add_signed(step)?;
        parent.children.get(index).copied()
    }

    fn connected(&self, node: NodeId) -> bool {
        let document = self.doc.root_node().id;
        let mut current = Some(node);
        while let Some(c) = current {
            if c == document {
                return true;
            }
            current = self.doc.get_node(c).and_then(|n| n.parent);
        }
        false
    }

    fn tree_root(&self, node: NodeId) -> NodeId {
        let mut node = node;
        loop {
            match self.doc.get_node(node).and_then(|n| n.parent) {
                Some(parent) => node = parent,
                None => match self.ids.templates.get(&node) {
                    Some(&template) if self.doc.get_node(template).is_some() => node = template,
                    _ => return node,
                },
            }
        }
    }

    fn subtree(&self, root: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(n) = self.doc.get_node(id) else { continue };
            out.push(id);
            if let Some(content) = n.element_data().and_then(|e| e.template_contents) {
                stack.push(content);
            }
            stack.extend(n.children.iter().rev().copied());
        }
        out
    }

    fn descendants(&self, root: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let Some(r) = self.doc.get_node(root) else { return out };
        let mut stack: Vec<NodeId> = r.children.iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            let Some(n) = self.doc.get_node(id) else { continue };
            out.push(id);
            stack.extend(n.children.iter().rev().copied());
        }
        out
    }

    fn ancestors(&self, node: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut current = Some(node);
        while let Some(c) = current {
            out.push(c);
            current = self.doc.get_node(c).and_then(|n| n.parent);
        }
        out
    }

    fn compare(&self, a: NodeId, b: NodeId) -> u16 {
        const DISCONNECTED: u16 = 1;
        const PRECEDING: u16 = 2;
        const FOLLOWING: u16 = 4;
        const CONTAINS: u16 = 8;
        const CONTAINED_BY: u16 = 16;
        const IMPLEMENTATION_SPECIFIC: u16 = 32;
        if a == b {
            return 0;
        }
        let (chain_a, chain_b) = (self.ancestors(a), self.ancestors(b));
        if chain_a.last() != chain_b.last() {
            let order = if a < b { FOLLOWING } else { PRECEDING };
            return DISCONNECTED | IMPLEMENTATION_SPECIFIC | order;
        }
        if chain_b.contains(&a) {
            return CONTAINED_BY | FOLLOWING;
        }
        if chain_a.contains(&b) {
            return CONTAINS | PRECEDING;
        }
        let (mut ia, mut ib) = (chain_a.len(), chain_b.len());
        while ia > 0 && ib > 0 && chain_a[ia - 1] == chain_b[ib - 1] {
            ia -= 1;
            ib -= 1;
        }
        let common = chain_a[ia];
        let (branch_a, branch_b) = (chain_a[ia - 1], chain_b[ib - 1]);
        let parent = &self.doc.tree()[common];
        match parent.index_of_child(branch_a) < parent.index_of_child(branch_b) {
            true => FOLLOWING,
            false => PRECEDING,
        }
    }

    fn element_of(&self, hit: NodeId) -> Option<NodeId> {
        let mut node = self.doc.nearest_non_anonymous_ancestor(hit)?;
        loop {
            let n = self.doc.get_node(node)?;
            if n.is_element() {
                return Some(node);
            }
            node = n.parent?;
        }
    }

    fn new_fragment(&mut self) -> NodeId {
        self.tree().m.create_element(QualName::new(None, ns!(html), FRAGMENT.into()), Vec::new())
    }

    fn check_insert(&self, parent: NodeId, node: NodeId, child: Option<NodeId>) -> Result<()> {
        let hierarchy = |why: &str| Err(fail("HierarchyRequestError", why));
        let parent_kind = self.kind(parent);
        if !matches!(parent_kind, NodeType::Document | NodeType::DocumentFragment | NodeType::Element) {
            return hierarchy("this node type cannot have children");
        }
        let mut current = Some(parent);
        while let Some(c) = current {
            if c == node {
                return hierarchy("the new child is an ancestor of the parent");
            }
            current = self.doc.get_node(c).and_then(|n| n.parent).or_else(|| self.ids.templates.get(&c).copied());
        }
        if let Some(child) = child
            && self.doc.get_node(child).and_then(|n| n.parent) != Some(parent)
        {
            return Err(fail("NotFoundError", "the reference node is not a child of this node"));
        }
        let kind = self.kind(node);
        match kind {
            NodeType::Document => return hierarchy("a document cannot be inserted"),
            NodeType::Text if parent_kind == NodeType::Document => return hierarchy("text cannot be a child of the document"),
            NodeType::DocumentType if parent_kind != NodeType::Document => {
                return hierarchy("a doctype can only be a child of the document");
            }
            _ => {}
        }
        if parent_kind != NodeType::Document {
            return Ok(());
        }
        let children = &self.doc.tree()[parent].children;
        let kind_of = |c: NodeId| self.kind(c);
        let has_element = children.iter().any(|&c| c != node && kind_of(c) == NodeType::Element);
        let has_doctype = children.iter().any(|&c| c != node && kind_of(c) == NodeType::DocumentType);
        let position = |c: NodeId| children.iter().position(|&x| x == c);
        let doctype_after = |c: NodeId| {
            let at = position(c).unwrap_or(children.len());
            children[at..].iter().any(|&x| kind_of(x) == NodeType::DocumentType)
        };
        let element_before = |c: NodeId| {
            let at = position(c).unwrap_or(0);
            children[..at].iter().any(|&x| kind_of(x) == NodeType::Element)
        };
        let child_is_doctype = child.is_some_and(|c| kind_of(c) == NodeType::DocumentType);
        match kind {
            NodeType::DocumentFragment => {
                let inner = &self.doc.tree()[node].children;
                let elements = inner.iter().filter(|&&c| kind_of(c) == NodeType::Element).count();
                if elements > 1 || inner.iter().any(|&c| kind_of(c) == NodeType::Text) {
                    return hierarchy("a document has at most one element child and no text");
                }
                if elements == 1 && (has_element || child_is_doctype || child.is_some_and(doctype_after)) {
                    return hierarchy("a document has at most one element child, after the doctype");
                }
                Ok(())
            }
            NodeType::Element if has_element || child_is_doctype || child.is_some_and(doctype_after) => {
                hierarchy("a document has at most one element child, after the doctype")
            }
            NodeType::DocumentType if has_doctype || child.is_some_and(element_before) || (child.is_none() && has_element) => {
                hierarchy("a document has at most one doctype, before the element")
            }
            _ => Ok(()),
        }
    }

    fn expand(&self, node: NodeId) -> Vec<NodeId> {
        match self.kind(node) {
            NodeType::DocumentFragment => self.doc.tree()[node].children.to_vec(),
            _ => vec![node],
        }
    }

    fn insert(&mut self, parent: NodeId, child: NodeId, reference: Option<NodeId>) -> Result<()> {
        self.check_insert(parent, child, reference)?;
        let reference = match reference == Some(child) {
            true => self.sibling(child, 1),
            false => reference,
        };
        let nodes = self.expand(child);
        if nodes.is_empty() {
            return Ok(());
        }
        let left = self.lists_left(&nodes);
        {
            let mut tree = self.tree();
            match reference {
                Some(reference) => tree.m.insert_nodes_before(reference, &nodes),
                None => tree.m.append_children(parent, &nodes),
            }
        }
        self.lists_changed(parent, &nodes, left);
        Ok(())
    }

    fn replace_children(&mut self, parent: NodeId, nodes: &[NodeId]) -> Result<()> {
        for &node in nodes {
            self.check_insert(parent, node, None).or_else(|e| {
                match self.kind(parent) == NodeType::Document && e.0.starts_with("HierarchyRequestError: a document has") {
                    true => Ok(()),
                    false => Err(e),
                }
            })?;
        }
        let new: Vec<NodeId> = nodes.iter().flat_map(|&n| self.expand(n)).collect();
        if self.kind(parent) == NodeType::Document {
            let count = |k: NodeType| new.iter().filter(|&&n| self.kind(n) == k).count();
            if count(NodeType::Element) > 1 || count(NodeType::DocumentType) > 1 || count(NodeType::Text) > 0 {
                return Err(fail("HierarchyRequestError", "a document has at most one element and one doctype child"));
            }
        }
        let kept: std::collections::HashSet<NodeId> = new.iter().copied().collect();
        let old: Vec<NodeId> = self.doc.tree()[parent].children.iter().copied().filter(|c| !kept.contains(c)).collect();
        let left = self.lists_left(&new);
        {
            let mut tree = self.tree();
            for &c in &old {
                tree.m.remove_node(c);
            }
            if !new.is_empty() {
                tree.m.append_children(parent, &new);
            }
        }
        self.collect(&old);
        self.lists_changed(parent, &new, left);
        Ok(())
    }

    fn set_data(&mut self, node: NodeId, data: &str) {
        let is_text = self.doc.get_node(node).is_some_and(|n| n.is_text_node());
        if is_text {
            self.tree().m.set_node_text(node, data);
        } else if !self.ids.doctypes.contains_key(&node)
            && let Some(NodeData::Comment { contents }) = self.doc.get_node_mut(node).map(|n| &mut n.data)
        {
            *contents = data.to_owned();
        }
    }

    fn register(&mut self, root: NodeId) {
        for node in self.subtree(root) {
            let Some(e) = self.doc.get_node(node).and_then(|n| n.element_data()) else { continue };
            let html = e.name.ns == ns!(html);
            if !(html && &*e.name.local == "img") {
                continue;
            }
            let id = self.ids.id_of(node);
            self.ids.images.entry(id).or_insert((String::new(), u8::MAX));
        }
        self.settle_selects_in(root);
    }

    fn adopt(&mut self, parsed: crate::parse::Parsed) {
        self.ids.doctypes.extend(parsed.doctypes);
        self.ids.templates.extend(parsed.templates);
    }

    fn parse_document(&mut self, html: &str) {
        let document = self.doc.root_node().id;
        let old = self.doc.root_node().children.to_vec();
        let parsed = {
            let mut tree = self.tree();
            for &c in &old {
                tree.m.remove_node(c);
            }
            crate::parse::document(&mut tree.m, document, html)
        };
        self.adopt(parsed);
        self.register(document);
        self.collect(&old);
    }

    fn parse_fragment(&mut self, context: NodeId, html: &str) -> NodeId {
        let holder = self.new_fragment();
        let element = self.doc.get_node(context).is_some_and(|n| n.is_element() && !is_fragment(n));
        let parsed = {
            let mut tree = self.tree();
            let body = (!element).then(|| tree.m.create_element(QualName::new(None, ns!(html), "body".into()), Vec::new()));
            let parsed = crate::parse::fragment(&mut tree.m, holder, body.unwrap_or(context), html);
            if let Some(body) = body {
                tree.m.remove_and_drop_node(body);
            }
            parsed
        };
        self.adopt(parsed);
        self.register(holder);
        holder
    }

    fn clone_node(&mut self, node: NodeId, deep: bool) -> Result<NodeId> {
        let copy = {
            let mut tree = self.tree();
            Self::clone_into(&mut tree, node, deep)?
        };
        self.register(copy);
        for n in self.subtree(copy) {
            self.show_form_state(n);
        }
        Ok(copy)
    }

    fn clone_into(tree: &mut Tree<'_>, node: NodeId, deep: bool) -> Result<NodeId> {
        enum What {
            Element(QualName, Vec<blitz_dom::Attribute>, Option<NodeId>),
            Text(String),
            Comment(String),
        }
        let n = tree.m.doc.get_node(node).ok_or_else(|| fail("NotFoundError", "node is gone"))?;
        let what = match &n.data {
            NodeData::Element(e) => What::Element(e.name.clone(), e.attrs().to_vec(), e.template_contents),
            NodeData::Text(t) => What::Text(t.content.clone()),
            NodeData::Comment { contents } => What::Comment(contents.clone()),
            NodeData::Document(_) | NodeData::AnonymousBlock(_) => {
                return Err(fail("NotSupportedError", "this node cannot be cloned"));
            }
        };
        let children = n.children.to_vec();
        let (copy, content) = match what {
            What::Element(name, attrs, content) => (tree.m.create_element(name, attrs), content),
            What::Text(text) => (tree.m.create_text_node(&text), None),
            What::Comment(text) => {
                let copy = tree.m.create_comment_node(&text);
                if let Some(d) = tree.ids.doctypes.get(&node).cloned() {
                    tree.ids.doctypes.insert(copy, d);
                }
                (copy, None)
            }
        };
        if let Some(form) = tree.ids.forms.get(&node).cloned() {
            tree.ids.forms.insert(copy, form);
        }
        if deep {
            for child in children {
                let c = Self::clone_into(tree, child, true)?;
                tree.m.append_children(copy, &[c]);
            }
            if let Some(content) = content {
                let target = tree.m.template_contents(copy);
                tree.ids.templates.insert(target, copy);
                let inner = tree.m.doc.get_node(content).map(|c| c.children.to_vec()).unwrap_or_default();
                for child in inner {
                    let c = Self::clone_into(tree, child, true)?;
                    tree.m.append_children(target, &[c]);
                }
            }
        }
        Ok(copy)
    }

    pub(crate) fn collect(&mut self, candidates: &[NodeId]) {
        let document = self.doc.root_node().id;
        let mut seen = std::collections::HashSet::new();
        let mut roots: Vec<NodeId> = Vec::new();
        for &c in candidates {
            if self.doc.get_node(c).is_none() {
                continue;
            }
            let root = self.tree_root(c);
            if root != document && seen.insert(root) && !self.holds_pin(root) {
                roots.push(root);
            }
        }
        for root in roots {
            self.free(root);
        }
    }

    fn holds_pin(&self, root: NodeId) -> bool {
        self.subtree(root).into_iter().any(|n| self.ids.pinned(n))
    }

    fn free(&mut self, root: NodeId) {
        let contents: Vec<NodeId> = self.subtree(root).into_iter().filter(|&n| self.ids.templates.contains_key(&n)).collect();
        if self.active.is_some_and(|a| self.tree_root(a) == root) {
            self.active = None;
        }
        let mut m = self.doc.mutate();
        let ids = &mut self.ids;
        for node in std::iter::once(root).chain(contents) {
            if m.doc.get_node(node).is_some() {
                m.remove_and_drop_node_with(node, &mut |dropped| ids.forget(dropped));
            }
        }
    }

    fn find_attribute(&self, node: NodeId, name: &str) -> Result<Option<(QualName, String)>> {
        let n = &self.doc.tree()[node];
        let e = n.element_data().filter(|_| n.is_element() && !is_fragment(n)).ok_or_else(|| fail("InvalidNodeTypeError", "not an element"))?;
        let name = match e.name.ns == ns!(html) {
            true => std::borrow::Cow::Owned(name.to_ascii_lowercase()),
            false => std::borrow::Cow::Borrowed(name),
        };
        Ok(e.attrs()
            .iter()
            .find(|a| match &a.name.prefix {
                Some(prefix) => name.strip_prefix(&**prefix).and_then(|r| r.strip_prefix(':')) == Some(&*a.name.local),
                None => *a.name.local == *name,
            })
            .map(|a| (a.name.clone(), a.value.clone())))
    }

    fn set_attribute_dom(&mut self, id: u32, name: &str, value: Option<&str>) -> Result<bool> {
        let node = self.n(id)?;
        let existing = self.find_attribute(node, name)?;
        let element = self.doc.tree()[node].element_data();
        let html = element.is_some_and(|e| e.name.ns == ns!(html));
        let canvas = html && element.is_some_and(|e| &*e.name.local == "canvas");
        let qual = match existing {
            Some((qual, old))
                if value == Some(&*old) && !matches!(&*qual.local, "value" | "style") && !(canvas && matches!(&*qual.local, "width" | "height")) =>
            {
                return Ok(false);
            }
            Some((qual, _)) => qual,
            None if value.is_none() => return Ok(false),
            None => QualName::new(
                None,
                ns!(),
                match html {
                    true => name.to_ascii_lowercase().into(),
                    false => name.into(),
                },
            ),
        };
        let local = qual.local.clone();
        self.tree().set_attribute(id, node, qual, value);
        match &*local {
            "value" | "checked" => self.show_form_state(node),
            "src" => self.register(node),
            _ => {}
        }
        if html {
            self.select_attribute_changed(node, &local);
        }
        Ok(true)
    }

    fn control(&self, node: NodeId) -> Control {
        let Some(e) = self.doc.get_node(node).and_then(|n| n.element_data()) else { return Control::None };
        if e.name.ns != ns!(html) {
            return Control::None;
        }
        match &*e.name.local {
            "textarea" => Control::Editor(true),
            "select" => Control::Select,
            "input" => {
                let kind = e.attr(blitz_dom::local_name!("type")).map(str::to_ascii_lowercase);
                match kind.as_deref() {
                    None | Some("text" | "password" | "email" | "number" | "search" | "tel" | "url") => Control::Editor(false),
                    Some("checkbox" | "radio") => Control::Checkable,
                    Some("hidden" | "submit" | "reset" | "button" | "image") => Control::Default,
                    Some(_) => Control::Value,
                }
            }
            "option" | "button" => Control::Default,
            _ => Control::None,
        }
    }

    fn value(&self, node: NodeId) -> String {
        let n = &self.doc.tree()[node];
        let attr = |name| n.attr(name).map(str::to_owned);
        let dirty = self.ids.forms.get(&node).and_then(|f| f.value.clone());
        match self.control(node) {
            Control::Editor(true) => dirty.unwrap_or_else(|| n.text_content()),
            Control::Editor(false) | Control::Value => dirty.or_else(|| attr(blitz_dom::local_name!("value"))).unwrap_or_default(),
            Control::Checkable => attr(blitz_dom::local_name!("value")).unwrap_or_else(|| "on".into()),
            Control::Select => self.options(node).into_iter().find(|&o| self.selectedness(o)).map(|o| self.value(o)).unwrap_or_default(),
            Control::Default if n.data.is_element_with_tag_name(&blitz_dom::local_name!("option")) => {
                attr(blitz_dom::local_name!("value")).unwrap_or_else(|| collapse_whitespace(&n.text_content()))
            }
            Control::Default | Control::None => attr(blitz_dom::local_name!("value")).unwrap_or_default(),
        }
    }

    fn set_value(&mut self, id: u32, node: NodeId, value: &str) -> Result<()> {
        match self.control(node) {
            Control::Editor(multiline) => {
                let value = match multiline {
                    true => value.to_owned(),
                    false => value.replace(['\r', '\n'], ""),
                };
                self.ids.forms.entry(node).or_default().value = Some(value);
                self.show_form_state(node);
            }
            Control::Value => self.ids.forms.entry(node).or_default().value = Some(value.to_owned()),
            Control::Select => {
                let index = self.options(node).iter().position(|&o| self.value(o) == value).map_or(-1, |i| i as i32);
                self.set_selected_index(node, index);
            }
            Control::Checkable | Control::Default | Control::None => {
                self.set_attribute_dom(id, "value", Some(value))?;
            }
        }
        Ok(())
    }

    fn checked(&self, node: NodeId) -> bool {
        match self.ids.forms.get(&node).and_then(|f| f.checked) {
            Some(checked) => checked,
            None => self.doc.tree()[node].attr(blitz_dom::local_name!("checked")).is_some(),
        }
    }

    fn set_checked(&mut self, node: NodeId, checked: bool) {
        self.ids.forms.entry(node).or_default().checked = Some(checked);
        self.show_form_state(node);
        let n = &self.doc.tree()[node];
        let radio = n.attr(blitz_dom::local_name!("type")).is_some_and(|t| t.eq_ignore_ascii_case("radio"));
        let name = n.attr(blitz_dom::local_name!("name")).unwrap_or_default().to_owned();
        if !(checked && radio && !name.is_empty()) {
            return;
        }
        let form = self.form_of(node);
        let root = self.tree_root(node);
        let group: Vec<NodeId> = self
            .subtree(root)
            .into_iter()
            .filter(|&other| {
                other != node
                    && self.doc.get_node(other).is_some_and(|o| {
                        o.data.is_element_with_tag_name(&blitz_dom::local_name!("input"))
                            && o.attr(blitz_dom::local_name!("type")).is_some_and(|t| t.eq_ignore_ascii_case("radio"))
                            && o.attr(blitz_dom::local_name!("name")) == Some(&*name)
                    })
                    && self.form_of(other) == form
            })
            .collect();
        for other in group {
            if self.checked(other) {
                self.ids.forms.entry(other).or_default().checked = Some(false);
                self.show_form_state(other);
            }
        }
    }

    fn form_of(&self, node: NodeId) -> Option<NodeId> {
        self.ancestors(node)
            .into_iter()
            .skip(1)
            .find(|&a| self.doc.get_node(a).is_some_and(|n| n.data.is_element_with_tag_name(&blitz_dom::local_name!("form"))))
    }

    fn show_form_state(&mut self, node: NodeId) {
        match self.control(node) {
            Control::Editor(multiline) => {
                let Some(value) = self.ids.forms.get(&node).and_then(|f| f.value.clone()) else { return };
                let Some(e) = self.doc.get_node_mut(node).and_then(|n| n.element_data_mut()) else { return };
                if !matches!(e.special_data, SpecialElementData::TextInput(_)) {
                    e.special_data = SpecialElementData::TextInput(TextInputData::new(multiline));
                }
                if let Some(input) = e.text_input_data_mut()
                    && input.editor.raw_text() != value
                {
                    input.editor.set_text(&value);
                    e.repaint();
                    self.doc.with_text_input(node, |mut driver| driver.refresh_layout());
                }
            }
            Control::Checkable => {
                let checked = self.checked(node);
                self.doc.snapshot_node_and(node, ElementState::CHECKED, |n| {
                    if let Some(e) = n.element_data_mut() {
                        if !matches!(e.special_data, SpecialElementData::CheckboxInput(_)) {
                            e.special_data = SpecialElementData::CheckboxInput(checked);
                        }
                        e.set_checkbox_input_checked(checked);
                    }
                    n.mark_ancestors_dirty();
                });
            }
            _ => {}
        }
    }

    fn set_selection_range(&mut self, node: NodeId, start: u32, end: u32) {
        let Some(text) = self.doc.get_node(node).and_then(|n| n.element_data()?.text_input_data()).map(|t| t.editor.raw_text().to_owned()) else {
            return;
        };
        let (start, end) = (utf16_to_byte(&text, start), utf16_to_byte(&text, end));
        let (start, end) = (start.min(end), end.max(start));
        self.doc.with_text_input(node, |mut driver| driver.select_byte_range(start, end));
        if let Some(e) = self.doc.get_node_mut(node).and_then(|n| n.element_data_mut()) {
            e.repaint();
        }
    }

    fn set_focus(&mut self, node: Option<NodeId>, visible: bool) {
        let Some(node) = node else {
            self.doc.clear_focus();
            return;
        };
        self.doc.set_focus_to(node);
        let Some(focused) = self.doc.get_focussed_node_id() else { return };
        self.doc.snapshot_node_and(focused, ElementState::FOCUSRING, |n| {
            if let Some(e) = n.element_data_mut() {
                e.element_state.set(ElementState::FOCUSRING, visible);
            }
            n.mark_ancestors_dirty();
        });
    }

    fn set_active(&mut self, node: Option<NodeId>) {
        let elements = |e: &Engine, n: Option<NodeId>| -> Vec<NodeId> {
            n.filter(|&n| e.doc.get_node(n).is_some())
                .map(|n| e.ancestors(n))
                .unwrap_or_default()
                .into_iter()
                .filter(|&a| e.doc.get_node(a).is_some_and(|a| a.is_element()))
                .collect()
        };
        let old = elements(self, self.active);
        let new = elements(self, node);
        for &a in old.iter().filter(|a| !new.contains(a)) {
            self.doc.snapshot_node_and(a, ElementState::ACTIVE, |n| n.unactive());
        }
        for &a in new.iter().filter(|a| !old.contains(a)) {
            self.doc.snapshot_node_and(a, ElementState::ACTIVE, |n| n.active());
        }
        self.active = node;
    }

    fn set_selection(&mut self, anchor: NodeId, anchor_offset: u32, focus: NodeId, focus_offset: u32) {
        self.resolved();
        let a = self.selection_point(anchor, anchor_offset);
        let f = self.selection_point(focus, focus_offset);
        match (a, f) {
            (Some((ar, ab)), Some((fr, fb))) => self.doc.set_text_selection(ar, ab, fr, fb),
            _ => self.doc.clear_text_selection(),
        }
    }

    fn selection_point(&self, node: NodeId, offset: u32) -> Option<(NodeId, usize)> {
        let caret = Caret { doc: &self.doc };
        let n = self.doc.get_node(node)?;
        if n.is_text_node() {
            return caret.layout_position(node, offset);
        }
        let texts = |from: &[NodeId]| -> Vec<NodeId> {
            from.iter().flat_map(|&c| self.subtree(c)).filter(|&d| self.doc.get_node(d).is_some_and(|d| d.is_text_node())).collect()
        };
        let split = (offset as usize).min(n.children.len());
        if let Some(&first) = texts(&n.children[split..]).first() {
            return caret.layout_position(first, 0);
        }
        let last = *texts(&n.children[..split]).last()?;
        let len = self.doc.get_node(last)?.text_data()?.content.encode_utf16().count() as u32;
        caret.layout_position(last, len)
    }

    fn dom_metrics(&mut self, node: NodeId) -> Option<Metrics> {
        let geometry = shown(self.resolved(), node)?;
        let doc = geometry.doc;
        let mut m = geometry.metrics(node)?;
        let parent = geometry.offset_parent(node);
        if let Some(root) = doc.try_root_element().filter(|r| r.id == node) {
            let scroll = doc.viewport_scroll();
            m.scroll_left = scroll.x;
            m.scroll_top = scroll.y;
            let viewport = doc.viewport();
            let scale = viewport.scale_f64();
            let (width, height) = (f64::from(viewport.window_size.0) / scale, f64::from(viewport.window_size.1) / scale);
            let layout = root.final_layout();
            m.client_width = width;
            m.client_height = height;
            m.scroll_width = width.max(f64::from(layout.size.width.max(layout.scrollable_overflow_rect.right)));
            m.scroll_height = height.max(f64::from(layout.size.height.max(layout.scrollable_overflow_rect.bottom)));
        }
        m.offset_parent = parent.map(|p| self.ids.id_of(p));
        Some(m)
    }

    fn styled(&self, node: NodeId, pseudo: &str) -> Option<NodeId> {
        let n = self.doc.get_node(node)?;
        match pseudo {
            "" => Some(node),
            "::before" | ":before" => n.before(),
            "::after" | ":after" => n.after(),
            _ => None,
        }
    }

    fn match_media(&mut self, query: &str) -> bool {
        use style::media_queries::MediaList;
        use style::stylesheets::{CssRuleType, CustomMediaEvaluator, UrlExtraData};
        let url = UrlExtraData::from(self.doc.url().clone());
        let mut context = css_context(&url, CssRuleType::Media);
        let mut parser = cssparser::Parser::new(query);
        let list = MediaList::parse(&mut context, &mut parser);
        let device = self.doc.stylist_device();
        list.evaluate(device, style::context::QuirksMode::NoQuirks, &mut CustomMediaEvaluator::none())
    }

    fn scroll_to(&mut self, node: NodeId, left: f64, top: f64, smooth: bool) {
        self.resolved();
        let document = self.doc.root_node().id;
        let target = match node == document {
            true => match self.doc.try_root_element() {
                Some(root) => root.id,
                None => return,
            },
            false => node,
        };
        let viewport = self.doc.try_root_element().is_some_and(|r| r.id == target);
        let before = self.scroll_offset(node, viewport);
        let behavior = match smooth {
            true => blitz_dom::ScrollBehavior::Smooth,
            false => blitz_dom::ScrollBehavior::Instant,
        };
        self.doc.scroll_to(target, left, top, behavior);
        let key = if viewport { document } else { node };
        self.ids.scrolls.entry(key).or_insert(before);
        self.touch();
    }

    fn scroll_offset(&self, node: NodeId, viewport: bool) -> (f64, f64) {
        if viewport || node == self.doc.root_node().id {
            let s = self.doc.viewport_scroll();
            return (s.x, s.y);
        }
        self.doc.get_node(node).map_or((0.0, 0.0), |n| (n.scroll_offset().x, n.scroll_offset().y))
    }

    fn take_scrolled(&mut self) -> Vec<u32> {
        let document = self.doc.root_node().id;
        let mut changed = Vec::new();
        let nodes: Vec<NodeId> = self.ids.scrolls.keys().copied().collect();
        for node in nodes {
            if self.doc.get_node(node).is_none() {
                self.ids.scrolls.remove(&node);
                continue;
            }
            let now = self.scroll_offset(node, node == document);
            let last = self.ids.scrolls.insert(node, now);
            if last != Some(now) {
                changed.push(node);
            }
        }
        changed.sort();
        self.outs(changed)
    }

    fn image(doc: &BaseDocument, node: NodeId) -> (f64, f64, u8, &str) {
        let Some(n) = doc.get_node(node) else { return (0.0, 0.0, FAILED, "") };
        let Some(e) = n.element_data() else { return (0.0, 0.0, FAILED, "") };
        let src = e.attr(blitz_dom::local_name!("src")).unwrap_or_default();
        match e.image_data() {
            Some(ImageData::Raster(r)) => (f64::from(r.width), f64::from(r.height), LOADED, src),
            Some(ImageData::Svg(svg)) => {
                let size = svg.tree.size();
                (f64::from(size.width()), f64::from(size.height()), LOADED, src)
            }
            _ if src.is_empty() => (0.0, 0.0, NO_SRC, src),
            _ if !n.flags.is_in_document() || doc.is_image_pending(node) => (0.0, 0.0, LOADING, src),
            _ => (0.0, 0.0, FAILED, src),
        }
    }

    fn take_loaded(&mut self) -> Vec<u32> {
        self.doc.handle_messages();
        let mut changed = Vec::new();
        let ids: Vec<u32> = self.ids.images.keys().copied().collect();
        for id in ids {
            let Ok(node) = self.ids.node(id) else { continue };
            let (_, _, state, src) = Self::image(&self.doc, node);
            let Some(last) = self.ids.images.get_mut(&id) else { continue };
            // a newly pending image is reported too, so the page keeps asking until its answer comes from the loader
            let report = matches!(state, LOADED | FAILED | LOADING) && (last.1 != state || last.0 != src);
            if report || state != last.1 {
                if last.0 != src {
                    last.0 = src.to_owned();
                }
                last.1 = state;
            }
            if report {
                changed.push(id);
            }
        }
        changed.sort_unstable();
        changed
    }

    fn inner_text(&self, node: NodeId) -> String {
        let Some(n) = self.doc.get_node(node) else { return String::new() };
        if !n.is_element() || n.primary_styles().is_none() {
            return n.text_content();
        }
        let mut pieces = Vec::new();
        self.inner_text_walk(n, &mut pieces);
        let mut out = String::new();
        let mut breaks = 0;
        for piece in pieces {
            match piece {
                Piece::Break(k) => breaks = breaks.max(k),
                Piece::Text(t) if t.is_empty() => {}
                Piece::Text(t) => {
                    let mut t = t.as_str();
                    if !out.is_empty() && breaks > 0 {
                        while out.ends_with(' ') {
                            out.pop();
                        }
                        out.extend(std::iter::repeat_n('\n', breaks));
                    }
                    if (out.is_empty() || out.ends_with(['\n', ' '])) && !t.starts_with('\n') {
                        t = t.trim_start_matches(' ');
                    }
                    breaks = 0;
                    out.push_str(t);
                }
            }
        }
        out.truncate(out.trim_end_matches(' ').len());
        out
    }

    fn inner_text_walk(&self, n: &Node, out: &mut Vec<Piece>) {
        use style::computed_values::visibility::T as Visibility;
        use style::values::specified::box_::DisplayOutside;
        for &child in &n.children {
            let Some(c) = self.doc.get_node(child) else { continue };
            match &c.data {
                NodeData::Text(t) => {
                    let visible = n.primary_styles().is_some_and(|s| s.clone_visibility() == Visibility::Visible);
                    if !visible {
                        continue;
                    }
                    let collapse = self.doc.resolved_style_value(n.id, "white-space-collapse");
                    out.push(Piece::Text(match collapse.as_str() {
                        "collapse" | "" => {
                            let mut s = String::with_capacity(t.content.len());
                            for c in t.content.chars() {
                                let c = if c.is_ascii_whitespace() { ' ' } else { c };
                                if !(c == ' ' && s.ends_with(' ')) {
                                    s.push(c);
                                }
                            }
                            s
                        }
                        _ => t.content.clone(),
                    }));
                }
                NodeData::Element(e) => {
                    let Some(style) = c.primary_styles() else { continue };
                    let display = style.get_box().display;
                    if display.is_none() {
                        continue;
                    }
                    let tag = &*e.name.local;
                    if tag == "br" {
                        out.push(Piece::Text("\n".into()));
                        continue;
                    }
                    let block = display.outside() == DisplayOutside::Block || display.is_list_item();
                    let gap = match tag {
                        "p" => 2,
                        _ if block => 1,
                        _ => 0,
                    };
                    out.push(Piece::Break(gap));
                    self.inner_text_walk(c, out);
                    out.push(Piece::Break(gap));
                    let css = self.doc.resolved_style_value(c.id, "display");
                    match css.as_str() {
                        "table-cell" if c.forward(1).is_some() => out.push(Piece::Text("\t".into())),
                        "table-row" => out.push(Piece::Break(1)),
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    fn parse_color(&mut self, text: &str) -> Option<[f64; 4]> {
        use style::color::{AbsoluteColor, ColorSpace};
        use style::stylesheets::{CssRuleType, UrlExtraData};
        let url = UrlExtraData::from(self.doc.url().clone());
        let context = css_context(&url, CssRuleType::Style);
        let mut parser = cssparser::Parser::new(text);
        let device = self.doc.stylist_device();
        let computed = style::values::specified::Color::parse_and_compute(&context, &mut parser, Some(device)).ok()?;
        let color = computed.resolve_to_absolute(&AbsoluteColor::BLACK).to_color_space(ColorSpace::Srgb);
        let [r, g, b, _] = *color.raw_components();
        let channel = |v: f32| if v.is_finite() { f64::from(v).clamp(0.0, 1.0) } else { 0.0 };
        Some([channel(r), channel(g), channel(b), channel(color.alpha().unwrap_or(0.0))])
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Control {
    Editor(bool),
    Value,
    Checkable,
    Select,
    Default,
    None,
}

fn collapse_whitespace(text: &str) -> String {
    text.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}

enum Piece {
    Text(String),
    Break(usize),
}

fn namespace(ns: Ns) -> blitz_dom::Namespace {
    match ns {
        Ns::Html => ns!(html),
        Ns::Svg => ns!(svg),
        Ns::MathMl => ns!(mathml),
    }
}

fn ns_of(name: &QualName) -> Ns {
    match name.ns {
        ns!(svg) => Ns::Svg,
        ns!(mathml) => Ns::MathMl,
        _ => Ns::Html,
    }
}

fn css_context(url: &style::stylesheets::UrlExtraData, rule: style::stylesheets::CssRuleType) -> style::parser::ParserContext<'_> {
    style::parser::ParserContext::new(
        style::stylesheets::Origin::Author,
        url,
        Some(rule),
        style_traits::ParsingMode::DEFAULT,
        style::context::QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    )
}
