use std::borrow::Cow;
use std::cell::{Ref, RefCell};

use blitz_dom::{Attribute, DocumentMutator, NodeId, QualName};
use html5ever::ParseOpts;
use html5ever::interface::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tokenizer::TokenizerOpts;
use html5ever::tree_builder::TreeBuilderOpts;

use crate::tree::Doctype;

#[derive(Default)]
pub(crate) struct Parsed {
    pub(crate) doctypes: Vec<(NodeId, Doctype)>,
    pub(crate) templates: Vec<(NodeId, NodeId)>,
}

struct Sink<'a, 'd> {
    m: RefCell<&'a mut DocumentMutator<'d>>,
    document: NodeId,
    out: RefCell<Parsed>,
}

fn opts() -> ParseOpts {
    ParseOpts {
        tokenizer: TokenizerOpts::default(),
        tree_builder: TreeBuilderOpts {
            exact_errors: false,
            scripting_enabled: true,
            iframe_srcdoc: false,
            drop_doctype: false,
            quirks_mode: QuirksMode::NoQuirks,
        },
    }
}

pub(crate) fn document(m: &mut DocumentMutator<'_>, document: NodeId, html: &str) -> Parsed {
    let sink = Sink::new(m, document);
    html5ever::parse_document(sink, opts()).one(html)
}

pub(crate) fn fragment(m: &mut DocumentMutator<'_>, holder: NodeId, context: NodeId, html: &str) -> Parsed {
    let parsed = {
        let sink = Sink::new(m, holder);
        html5ever::driver::parse_fragment_for_element(sink, opts(), context, false, None).one(html)
    };
    if let Some(root) = m.last_child_id(holder) {
        let children = m.child_ids(root);
        m.append_children(holder, &children);
        m.remove_and_drop_node(root);
    }
    parsed
}

impl<'a, 'd> Sink<'a, 'd> {
    fn new(m: &'a mut DocumentMutator<'d>, document: NodeId) -> Self {
        Self { m: RefCell::new(m), document, out: RefCell::default() }
    }

    fn m(&self) -> std::cell::RefMut<'_, &'a mut DocumentMutator<'d>> {
        self.m.borrow_mut()
    }

    fn attrs(attrs: Vec<html5ever::Attribute>) -> Vec<Attribute> {
        attrs.into_iter().map(|a| Attribute { name: a.name, value: a.value.to_string() }).collect()
    }
}

impl<'a, 'd> TreeSink for Sink<'a, 'd> {
    type Output = Parsed;
    type Handle = NodeId;
    type ElemName<'e>
        = Ref<'e, QualName>
    where
        Self: 'e;

    fn finish(self) -> Parsed {
        self.out.into_inner()
    }

    fn parse_error(&self, _msg: Cow<'static, str>) {}

    fn get_document(&self) -> NodeId {
        self.document
    }

    fn elem_name<'e>(&'e self, target: &'e NodeId) -> Ref<'e, QualName> {
        Ref::map(self.m.borrow(), |m| m.element_name(*target).expect("TreeSink::elem_name called on a node which is not an element"))
    }

    fn create_element(&self, name: QualName, attrs: Vec<html5ever::Attribute>, _flags: ElementFlags) -> NodeId {
        self.m().create_element(name, Self::attrs(attrs))
    }

    fn create_comment(&self, text: StrTendril) -> NodeId {
        self.m().create_comment_node(&text)
    }

    fn create_pi(&self, _target: StrTendril, _data: StrTendril) -> NodeId {
        self.m().create_comment_node("")
    }

    fn append(&self, parent: &NodeId, child: NodeOrText<NodeId>) {
        let mut m = self.m();
        match child {
            NodeOrText::AppendNode(id) => m.append_children(*parent, &[id]),
            NodeOrText::AppendText(text) => {
                let merged = m
                    .last_child_id(*parent)
                    .is_some_and(|last| m.doc.get_node(last).is_some_and(|n| n.is_text_node()) && m.append_text_to_node(last, &text).is_ok());
                if !merged {
                    let id = m.create_text_node(&text);
                    m.append_children(*parent, &[id]);
                }
            }
        }
    }

    fn append_before_sibling(&self, sibling: &NodeId, child: NodeOrText<NodeId>) {
        let mut m = self.m();
        match child {
            NodeOrText::AppendNode(id) => m.insert_nodes_before(*sibling, &[id]),
            NodeOrText::AppendText(text) => {
                let merged = m
                    .previous_sibling_id(*sibling)
                    .is_some_and(|prev| m.doc.get_node(prev).is_some_and(|n| n.is_text_node()) && m.append_text_to_node(prev, &text).is_ok());
                if !merged {
                    let id = m.create_text_node(&text);
                    m.insert_nodes_before(*sibling, &[id]);
                }
            }
        }
    }

    fn append_based_on_parent_node(&self, element: &NodeId, prev_element: &NodeId, child: NodeOrText<NodeId>) {
        let has_parent = self.m().node_has_parent(*element);
        match has_parent {
            true => self.append_before_sibling(element, child),
            false => self.append(prev_element, child),
        }
    }

    fn append_doctype_to_document(&self, name: StrTendril, public_id: StrTendril, system_id: StrTendril) {
        let mut m = self.m();
        let node = m.create_comment_node("");
        m.append_children(self.document, &[node]);
        self.out.borrow_mut().doctypes.push((node, Doctype { name: name.to_string(), public_id: public_id.to_string(), system_id: system_id.to_string() }));
    }

    fn get_template_contents(&self, target: &NodeId) -> NodeId {
        let content = self.m().template_contents(*target);
        self.out.borrow_mut().templates.push((content, *target));
        content
    }

    fn same_node(&self, x: &NodeId, y: &NodeId) -> bool {
        x == y
    }

    fn set_quirks_mode(&self, _mode: QuirksMode) {}

    fn add_attrs_if_missing(&self, target: &NodeId, attrs: Vec<html5ever::Attribute>) {
        self.m().add_attrs_if_missing(*target, Self::attrs(attrs));
    }

    fn remove_from_parent(&self, target: &NodeId) {
        self.m().remove_node(*target);
    }

    fn reparent_children(&self, node: &NodeId, new_parent: &NodeId) {
        self.m().reparent_children(*node, *new_parent);
    }
}
