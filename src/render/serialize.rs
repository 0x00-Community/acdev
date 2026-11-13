use blitz_dom::{BaseDocument, Node, NodeData, NodeId, ns};

use crate::render::tree::Ids;

const VOID: &[&str] =
    &["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"];

const RAW_TEXT: &[&str] = &["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"];

pub(crate) struct Serializer<'a> {
    pub(crate) doc: &'a BaseDocument,
    pub(crate) ids: &'a Ids,
}

impl Serializer<'_> {
    pub(crate) fn outer(&self, node: NodeId) -> String {
        let mut out = String::new();
        if let Some(n) = self.doc.get_node(node) {
            match crate::render::dom::is_fragment(n) || matches!(n.data, NodeData::Document(_)) {
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
        let raw = n.element_data().is_some_and(|e| e.name.ns == ns!(html) && RAW_TEXT.contains(&&*e.name.local));
        for &child in &n.children {
            if let Some(c) = self.doc.get_node(child) {
                self.node(c, Some(raw), out);
            }
        }
    }

    fn node(&self, n: &Node, raw: Option<bool>, out: &mut String) {
        match &n.data {
            NodeData::Element(e) => {
                if crate::render::dom::is_fragment(n) {
                    return self.children(n, out);
                }
                let known = matches!(e.name.ns, ns!(html) | ns!(svg) | ns!(mathml));
                let qualified = match (&e.name.prefix, known) {
                    (Some(prefix), false) => format!("{prefix}:{}", e.name.local),
                    _ => e.name.local.to_string(),
                };
                let name = qualified.as_str();
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
                if e.name.ns == ns!(html) && VOID.contains(&&*e.name.local) {
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
                None if self.ids.pis.contains_key(&n.id) => {
                    out.push_str("<?");
                    out.push_str(&self.ids.pis[&n.id]);
                    out.push(' ');
                    out.push_str(contents);
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
        n.parent.and_then(|p| self.doc.get_node(p)).and_then(|p| p.element_data()).is_some_and(|e| e.name.ns == ns!(html) && RAW_TEXT.contains(&&*e.name.local))
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

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

type Map = Vec<(String, Vec<String>)>;

fn prefixes<'m>(map: &'m Map, ns: &str) -> Option<&'m Vec<String>> {
    map.iter().find(|(k, _)| k == ns).map(|(_, v)| v)
}

fn add(map: &mut Map, ns: &str, prefix: &str) {
    match map.iter_mut().find(|(k, _)| k == ns) {
        Some((_, list)) => list.push(prefix.to_owned()),
        None => map.push((ns.to_owned(), vec![prefix.to_owned()])),
    }
}

fn preferred(map: &Map, ns: &str, preferred: Option<&str>) -> Option<String> {
    let list = prefixes(map, ns)?;
    match preferred.filter(|p| list.iter().any(|x| x == p)) {
        Some(p) => Some(p.to_owned()),
        None => list.last().cloned(),
    }
}

fn found(map: &Map, ns: &str, prefix: &str) -> bool {
    prefixes(map, ns).is_some_and(|l| l.iter().any(|p| p == prefix))
}

fn valid_chars(text: &str) -> bool {
    text.chars().all(|c| matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}'))
}

fn not_well_formed<T>(what: &str) -> Result<T, String> {
    Err(format!("the node is not well-formed XML: {what}"))
}

pub(crate) struct XmlSerializer<'a> {
    pub(crate) doc: &'a BaseDocument,
    pub(crate) ids: &'a Ids,
    pub(crate) well_formed: bool,
    pub(crate) documents: &'a dyn Fn(NodeId) -> bool,
}

impl XmlSerializer<'_> {
    pub(crate) fn outer(&self, node: NodeId) -> Result<String, String> {
        let mut out = String::new();
        let mut map: Map = vec![(XML_NS.to_owned(), vec!["xml".to_owned()])];
        let mut index = 1;
        if let Some(n) = self.doc.get_node(node) {
            self.node(n, None, &mut map, &mut index, &mut out)?;
        }
        Ok(out)
    }

    pub(crate) fn inner(&self, node: NodeId) -> Result<String, String> {
        let mut out = String::new();
        let Some(n) = self.doc.get_node(node) else { return Ok(out) };
        let n = match n.element_data().and_then(|e| e.template_contents) {
            Some(content) => match self.doc.get_node(content) {
                Some(c) => c,
                None => return Ok(out),
            },
            None => n,
        };
        for &child in &n.children {
            let mut map: Map = vec![(XML_NS.to_owned(), vec!["xml".to_owned()])];
            let mut index = 1;
            if let Some(c) = self.doc.get_node(child) {
                self.node(c, None, &mut map, &mut index, &mut out)?;
            }
        }
        Ok(out)
    }

    fn children(&self, n: &Node, ns: Option<&str>, map: &mut Map, index: &mut u32, out: &mut String) -> Result<(), String> {
        for &child in &n.children {
            if let Some(c) = self.doc.get_node(child) {
                self.node(c, ns, map, index, out)?;
            }
        }
        Ok(())
    }

    fn node(&self, n: &Node, ns: Option<&str>, map: &mut Map, index: &mut u32, out: &mut String) -> Result<(), String> {
        match &n.data {
            NodeData::Element(_) if crate::render::dom::is_fragment(n) => {
                if self.well_formed && (self.documents)(n.id) && !n.children.iter().any(|&c| self.doc.get_node(c).is_some_and(|c| c.is_element())) {
                    return not_well_formed("a document needs a document element");
                }
                self.children(n, ns, map, index, out)
            }
            NodeData::Document(_) => self.children(n, ns, map, index, out),
            NodeData::Element(_) => self.element(n, ns, map, index, out),
            NodeData::Text(t) if self.ids.cdata.contains(&n.id) => {
                out.push_str("<![CDATA[");
                out.push_str(&t.content);
                out.push_str("]]>");
                Ok(())
            }
            NodeData::Text(t) => {
                if self.well_formed && !valid_chars(&t.content) {
                    return not_well_formed("text has characters XML does not allow");
                }
                for c in t.content.chars() {
                    match c {
                        '&' => out.push_str("&amp;"),
                        '<' => out.push_str("&lt;"),
                        '>' => out.push_str("&gt;"),
                        c => out.push(c),
                    }
                }
                Ok(())
            }
            NodeData::Comment { contents } => {
                if let Some(d) = self.ids.doctypes.get(&n.id) {
                    if self.well_formed
                        && d.public_id
                            .chars()
                            .any(|c| !(matches!(c, ' ' | '\r' | '\n' | 'a'..='z' | 'A'..='Z' | '0'..='9') || "-'()+,./:=?;!*#@$_%".contains(c)))
                    {
                        return not_well_formed("the doctype's public id has characters a PubidLiteral does not allow");
                    }
                    if self.well_formed && d.system_id.contains('"') && d.system_id.contains('\'') {
                        return not_well_formed("the doctype's system id has both kinds of quotes");
                    }
                    out.push_str("<!DOCTYPE ");
                    out.push_str(&d.name);
                    if !d.public_id.is_empty() {
                        out.push_str(" PUBLIC \"");
                        out.push_str(&d.public_id);
                        out.push('"');
                    } else if !d.system_id.is_empty() {
                        out.push_str(" SYSTEM");
                    }
                    if !d.system_id.is_empty() {
                        out.push_str(" \"");
                        out.push_str(&d.system_id);
                        out.push('"');
                    }
                    out.push('>');
                    return Ok(());
                }
                if let Some(target) = self.ids.pis.get(&n.id) {
                    if self.well_formed && (target.contains(':') || target.eq_ignore_ascii_case("xml")) {
                        return not_well_formed("a processing instruction target cannot contain ':' or be 'xml'");
                    }
                    if self.well_formed && (!valid_chars(contents) || contents.contains("?>")) {
                        return not_well_formed("a processing instruction's data cannot contain '?>'");
                    }
                    out.push_str("<?");
                    out.push_str(target);
                    out.push(' ');
                    out.push_str(contents);
                    out.push_str("?>");
                    return Ok(());
                }
                if self.well_formed && (!valid_chars(contents) || contents.contains("--") || contents.ends_with('-')) {
                    return not_well_formed("a comment cannot contain '--' or end with '-'");
                }
                out.push_str("<!--");
                out.push_str(contents);
                out.push_str("-->");
                Ok(())
            }
            NodeData::AnonymousBlock(_) => Ok(()),
        }
    }

    fn element(&self, n: &Node, inherited: Option<&str>, parent_map: &mut Map, index: &mut u32, out: &mut String) -> Result<(), String> {
        let e = n.element_data().expect("an element");
        let local = &*e.name.local;
        if self.well_formed && (local.contains(':') || !crate::render::xml::is_name(local)) {
            return not_well_formed("an element's local name is not an XML name");
        }
        let mut map = parent_map.clone();
        let mut locals: Vec<(String, String)> = Vec::new();
        let mut default: Option<String> = None;
        for a in e.attrs.iter() {
            if *a.name.ns != *XMLNS_NS {
                continue;
            }
            match &a.name.prefix {
                None => default = Some(a.value.clone()),
                Some(_) => {
                    let prefix = a.name.local.to_string();
                    let definition = a.value.as_str();
                    if definition == XML_NS || found(&map, definition, &prefix) {
                        continue;
                    }
                    add(&mut map, definition, &prefix);
                    locals.push((prefix, definition.to_owned()));
                }
            }
        }
        let mut inherited = inherited.map(str::to_owned);
        let ns = (!e.name.ns.is_empty()).then(|| e.name.ns.to_string());
        let mut ignore_default = false;
        let qualified;
        out.push('<');
        if inherited == ns {
            if default.as_deref().is_some_and(|d| !d.is_empty()) {
                ignore_default = true;
            }
            qualified = match ns.as_deref() == Some(XML_NS) {
                true => format!("xml:{local}"),
                false => local.to_owned(),
            };
            out.push_str(&qualified);
        } else {
            let mut prefix = e.name.prefix.as_ref().map(|p| p.to_string());
            let ns_key = ns.clone().unwrap_or_default();
            let mut candidate = preferred(&map, &ns_key, prefix.as_deref());
            if prefix.as_deref() == Some("xmlns") {
                if self.well_formed {
                    return not_well_formed("an element cannot have the prefix 'xmlns'");
                }
                candidate = prefix.clone();
            }
            if let Some(candidate) = candidate {
                qualified = format!("{candidate}:{local}");
                if let Some(d) = default.as_deref().filter(|d| *d != XML_NS) {
                    inherited = (!d.is_empty()).then(|| d.to_owned());
                }
                out.push_str(&qualified);
            } else if let Some(p) = prefix.as_mut() {
                if locals.iter().any(|(k, _)| k == p) {
                    *p = format!("ns{index}");
                    *index += 1;
                }
                add(&mut map, &ns_key, p);
                qualified = format!("{p}:{local}");
                out.push_str(&qualified);
                out.push_str(" xmlns:");
                out.push_str(p);
                out.push_str("=\"");
                self.attribute_value(&ns_key, out)?;
                out.push('"');
                if let Some(d) = default.as_deref() {
                    inherited = (!d.is_empty()).then(|| d.to_owned());
                }
            } else if default.is_none() || default.as_deref() != ns.as_deref() {
                ignore_default = true;
                qualified = local.to_owned();
                inherited = ns.clone();
                out.push_str(&qualified);
                out.push_str(" xmlns=\"");
                self.attribute_value(&ns_key, out)?;
                out.push('"');
            } else {
                qualified = local.to_owned();
                inherited = ns.clone();
                out.push_str(&qualified);
            }
        }
        self.attributes(e, &mut map, &mut locals, ignore_default, index, out)?;
        let html = ns.as_deref() == Some(HTML_NS);
        let empty = n.children.is_empty();
        if html && empty && VOID.contains(&local) {
            out.push_str(" />");
            return Ok(());
        }
        if !html && empty {
            out.push_str("/>");
            return Ok(());
        }
        out.push('>');
        let source = match e.template_contents.filter(|_| html && local == "template") {
            Some(content) => self.doc.get_node(content).unwrap_or(n),
            None => n,
        };
        self.children(source, inherited.as_deref(), &mut map, index, out)?;
        out.push_str("</");
        out.push_str(&qualified);
        out.push('>');
        Ok(())
    }

    fn attributes(
        &self,
        e: &blitz_dom::ElementData,
        map: &mut Map,
        locals: &mut Vec<(String, String)>,
        ignore_default: bool,
        index: &mut u32,
        out: &mut String,
    ) -> Result<(), String> {
        let mut seen: Vec<(String, String)> = Vec::new();
        for a in e.attrs.iter() {
            let ns = a.name.ns.to_string();
            let local = a.name.local.to_string();
            if self.well_formed && seen.iter().any(|(n, l)| *n == ns && *l == local) {
                return not_well_formed("an element has two attributes with the same namespace and local name");
            }
            seen.push((ns.clone(), local.clone()));
            let attr_prefix = a.name.prefix.as_ref().map(|p| p.to_string());
            let mut candidate = None;
            if !ns.is_empty() {
                candidate = preferred(map, &ns, attr_prefix.as_deref());
                if ns == XMLNS_NS {
                    let redefined = attr_prefix.is_some() && !locals.iter().any(|(k, v)| *k == local && *v == a.value) && found(map, &a.value, &local);
                    if a.value == XML_NS || (attr_prefix.is_none() && ignore_default) || redefined {
                        continue;
                    }
                    if self.well_formed && a.value == XMLNS_NS {
                        return not_well_formed("the xmlns namespace cannot be declared");
                    }
                    if self.well_formed && a.value.is_empty() {
                        return not_well_formed("a namespace prefix cannot be undeclared");
                    }
                    if attr_prefix.as_deref() == Some("xmlns") {
                        candidate = Some("xmlns".to_owned());
                    }
                } else if candidate.is_none() {
                    let chosen = format!("ns{index}");
                    *index += 1;
                    add(map, &ns, &chosen);
                    locals.push((chosen.clone(), ns.clone()));
                    out.push_str(" xmlns:");
                    out.push_str(&chosen);
                    out.push_str("=\"");
                    self.attribute_value(&ns, out)?;
                    out.push('"');
                    candidate = Some(chosen);
                }
            }
            if ns.is_empty() && local == "xmlns" {
                if self.well_formed {
                    return not_well_formed("an attribute named 'xmlns' needs the xmlns namespace");
                }
                continue;
            }
            out.push(' ');
            if let Some(c) = &candidate {
                out.push_str(c);
                out.push(':');
            }
            if self.well_formed && (local.contains(':') || !crate::render::xml::is_name(&local) || (local == "xmlns" && ns.is_empty())) {
                return not_well_formed("an attribute's local name is not an XML name");
            }
            out.push_str(&local);
            out.push_str("=\"");
            self.attribute_value(&a.value, out)?;
            out.push('"');
        }
        Ok(())
    }

    fn attribute_value(&self, value: &str, out: &mut String) -> Result<(), String> {
        if self.well_formed && !valid_chars(value) {
            return not_well_formed("an attribute value has characters XML does not allow");
        }
        for c in value.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '"' => out.push_str("&quot;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '\t' => out.push_str("&#9;"),
                '\n' => out.push_str("&#xA;"),
                '\r' => out.push_str("&#xD;"),
                c => out.push(c),
            }
        }
        Ok(())
    }
}
