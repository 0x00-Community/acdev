use blitz_dom::{BaseDocument, Node, NodeData, NodeId, ns};

use crate::tree::Ids;

const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link",
    "meta", "param", "source", "track", "wbr",
];

const RAW_TEXT: &[&str] = &[
    "style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript",
];

pub(crate) struct Serializer<'a> {
    pub(crate) doc: &'a BaseDocument,
    pub(crate) ids: &'a Ids,
}

impl Serializer<'_> {
    pub(crate) fn outer(&self, node: NodeId) -> String {
        let mut out = String::new();
        if let Some(n) = self.doc.get_node(node) {
            match crate::dom::is_fragment(n) || matches!(n.data, NodeData::Document(_)) {
                true => self.children(n, &mut out),
                false => self.node(n, None, &mut out),
            }
        }
        out
    }

    pub(crate) fn inner(&self, node: NodeId) -> String {
        let mut out = String::new();
        if let Some(n) = self.doc.get_node(node) {
            self.children(n, &mut out);
        }
        out
    }

    fn children(&self, n: &Node, out: &mut String) {
        let n = match n.element_data().and_then(|e| e.template_contents) {
            Some(content) => match self.doc.get_node(content) {
                Some(c) => c,
                None => return,
            },
            None => n,
        };
        let raw = n
            .element_data()
            .is_some_and(|e| e.name.ns == ns!(html) && RAW_TEXT.contains(&&*e.name.local));
        for &child in &n.children {
            if let Some(c) = self.doc.get_node(child) {
                self.node(c, Some(raw), out);
            }
        }
    }

    fn node(&self, n: &Node, raw: Option<bool>, out: &mut String) {
        match &n.data {
            NodeData::Element(e) => {
                if crate::dom::is_fragment(n) {
                    return self.children(n, out);
                }
                let name = &*e.name.local;
                out.push('<');
                out.push_str(name);
                for attr in e.attrs.iter() {
                    out.push(' ');
                    let q = &attr.name;
                    match q.ns {
                        ns!() | ns!(html) => {}
                        ns!(xml) => out.push_str("xml:"),
                        ns!(xmlns) if &*q.local == "xmlns" => {}
                        ns!(xmlns) => out.push_str("xmlns:"),
                        ns!(xlink) => out.push_str("xlink:"),
                        _ => {
                            if let Some(prefix) = &q.prefix {
                                out.push_str(prefix);
                                out.push(':');
                            }
                        }
                    }
                    out.push_str(&q.local);
                    out.push_str("=\"");
                    escape(&attr.value, true, out);
                    out.push('"');
                }
                out.push('>');
                if e.name.ns == ns!(html) && VOID.contains(&name) {
                    return;
                }
                self.children(n, out);
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
            NodeData::Text(t) => match raw.unwrap_or_else(|| self.parent_raw(n)) {
                true => out.push_str(&t.content),
                false => escape(&t.content, false, out),
            },
            NodeData::Comment { contents } => match self.ids.doctypes.get(&n.id) {
                Some(d) => {
                    out.push_str("<!DOCTYPE ");
                    out.push_str(&d.name);
                    out.push('>');
                }
                None => {
                    out.push_str("<!--");
                    out.push_str(contents);
                    out.push_str("-->");
                }
            },
            NodeData::Document(_) => self.children(n, out),
            NodeData::AnonymousBlock(_) => {}
        }
    }

    fn parent_raw(&self, n: &Node) -> bool {
        n.parent
            .and_then(|p| self.doc.get_node(p))
            .and_then(|p| p.element_data())
            .is_some_and(|e| e.name.ns == ns!(html) && RAW_TEXT.contains(&&*e.name.local))
    }
}

fn escape(text: &str, attribute: bool, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}
