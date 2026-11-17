use std::collections::HashMap;

use blitz_dom::{Attribute, DocumentMutator, LocalName, Namespace, NodeId, Prefix, QualName, ns};

use crate::render::parse::Parsed;
use crate::render::tree::Doctype;

pub(crate) const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
pub(crate) const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
pub(crate) const PARSERERROR_NS: &str = "http://www.mozilla.org/newlayout/xml/parsererror.xml";

const MAX_DEPTH: usize = 4096;
const MAX_ENTITY_DEPTH: usize = 32;
const MAX_EXPANSION: usize = 16 << 20;

const XHTML_PUBLIC_IDS: &[&str] = &[
    "-//W3C//DTD XHTML 1.0 Transitional//EN",
    "-//W3C//DTD XHTML 1.1//EN",
    "-//W3C//DTD XHTML 1.0 Strict//EN",
    "-//W3C//DTD XHTML 1.0 Frameset//EN",
    "-//W3C//DTD XHTML Basic 1.0//EN",
    "-//W3C//DTD XHTML 1.1 plus MathML 2.0//EN",
    "-//W3C//DTD XHTML 1.1 plus MathML 2.0 plus SVG 1.1//EN",
    "-//W3C//DTD MathML 2.0//EN",
    "-//WAPFORUM//DTD XHTML Mobile 1.0//EN",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct XmlError {
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) message: String,
}

impl std::fmt::Display for XmlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "error on line {} at column {}: {}", self.line, self.column, self.message)
    }
}

#[derive(Clone)]
enum Entity {
    Internal(String),
    External,
    Unparsed,
}

struct Raw {
    name: String,
    value: String,
    at: usize,
}

struct Open {
    node: NodeId,
    name: String,
    scope: usize,
}

struct Parser<'a, 'd> {
    m: &'a mut DocumentMutator<'d>,
    holder: NodeId,
    out: Parsed,
    entities: HashMap<String, Entity>,
    html_entities: bool,
    skip_undeclared: bool,
    bindings: Vec<(String, String)>,
    open: Vec<Open>,
    text: String,
    expanding: Vec<String>,
    expanded: usize,
    root_seen: bool,
    standalone: bool,
    origin: Option<usize>,
}

struct Cursor<'s> {
    s: &'s str,
    pos: usize,
}

impl<'s> Cursor<'s> {
    fn rest(&self) -> &'s str {
        &self.s[self.pos..]
    }

    fn eof(&self) -> bool {
        self.pos >= self.s.len()
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn starts(&self, t: &str) -> bool {
        self.rest().starts_with(t)
    }

    fn eat(&mut self, t: &str) -> bool {
        let ok = self.starts(t);
        if ok {
            self.pos += t.len();
        }
        ok
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn space(&mut self) -> bool {
        let start = self.pos;
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
        self.pos > start
    }
}

pub(crate) fn is_name_start(c: char) -> bool {
    matches!(c, ':' | 'A'..='Z' | '_' | 'a'..='z' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2FF}' | '\u{370}'..='\u{37D}'
        | '\u{37F}'..='\u{1FFF}' | '\u{200C}'..='\u{200D}' | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}'
        | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}' | '\u{10000}'..='\u{EFFFF}')
}

pub(crate) fn is_name_char(c: char) -> bool {
    is_name_start(c) || matches!(c, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}')
}

pub(crate) fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(is_name_start) && chars.all(is_name_char)
}

fn is_ncname(s: &str) -> bool {
    is_name(s) && !s.contains(':')
}

pub(crate) fn is_qname(s: &str) -> bool {
    match s.split_once(':') {
        Some((p, l)) => is_ncname(p) && is_ncname(l),
        None => is_ncname(s),
    }
}

fn is_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
}

fn is_pubid_char(c: char) -> bool {
    matches!(c, ' ' | '\r' | '\n' | 'a'..='z' | 'A'..='Z' | '0'..='9') || "-'()+,./:=?;!*#@$_%".contains(c)
}

fn normalize_newlines(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains('\r') {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    std::borrow::Cow::Owned(out)
}

fn position(text: &str, at: usize) -> (usize, usize) {
    let before = &text[..at.min(text.len())];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    (line, column)
}

type Step<T> = std::result::Result<T, (usize, String)>;

fn err<T>(at: usize, message: impl Into<String>) -> Step<T> {
    Err((at, message.into()))
}

pub(crate) fn document(m: &mut DocumentMutator<'_>, holder: NodeId, text: &str) -> std::result::Result<Parsed, XmlError> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let text = normalize_newlines(text);
    if let Some((at, c)) = text.char_indices().find(|&(_, c)| !is_char(c)) {
        let (line, column) = position(&text, at);
        return Err(XmlError { line, column, message: format!("invalid character U+{:04X}", c as u32) });
    }
    let mut parser = Parser {
        m,
        holder,
        out: Parsed::default(),
        entities: HashMap::new(),
        html_entities: false,
        skip_undeclared: false,
        bindings: vec![("xml".into(), XML_NS.into()), ("xmlns".into(), XMLNS_NS.into())],
        open: Vec::new(),
        text: String::new(),
        expanding: Vec::new(),
        expanded: 0,
        root_seen: false,
        standalone: false,
        origin: None,
    };
    let mut c = Cursor { s: &text, pos: 0 };
    match parser.run(&mut c) {
        Ok(()) => Ok(parser.out),
        Err((at, message)) => {
            let (line, column) = position(&text, at);
            Err(XmlError { line, column, message })
        }
    }
}

impl Parser<'_, '_> {
    fn run(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        self.declaration(c)?;
        self.misc(c, true)?;
        if c.eof() {
            return err(c.pos, "document has no root element");
        }
        if !c.starts("<") || c.starts("</") {
            return err(c.pos, "content is not allowed before the root element");
        }
        self.content(c, 0)?;
        self.misc(c, false)?;
        if !c.eof() {
            return err(c.pos, "extra content at the end of the document");
        }
        Ok(())
    }

    fn declaration(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        if !c.starts("<?xml") || !c.rest()[5..].starts_with([' ', '\t', '\n', '\r', '?']) {
            return Ok(());
        }
        let start = c.pos;
        c.pos += 5;
        let end = c.rest().find("?>").map(|i| c.pos + i).ok_or((start, "unterminated XML declaration".to_string()))?;
        let body = &c.s[c.pos..end];
        let mut attrs = Cursor { s: body, pos: 0 };
        let mut seen = Vec::new();
        loop {
            let spaced = attrs.space();
            if attrs.eof() {
                break;
            }
            if !spaced {
                return err(start, "malformed XML declaration");
            }
            let name_start = attrs.pos;
            while attrs.peek().is_some_and(|ch| ch.is_ascii_alphanumeric()) {
                attrs.bump();
            }
            let name = &body[name_start..attrs.pos];
            attrs.space();
            if !attrs.eat("=") {
                return err(start, "malformed XML declaration");
            }
            attrs.space();
            let Some(quote) = attrs.bump().filter(|q| *q == '"' || *q == '\'') else { return err(start, "malformed XML declaration") };
            let value_start = attrs.pos;
            let Some(len) = attrs.rest().find(quote) else { return err(start, "malformed XML declaration") };
            let value = &body[value_start..value_start + len];
            attrs.pos = value_start + len + 1;
            let ok = match (name, seen.as_slice()) {
                ("version", []) => value.len() > 2 && value.starts_with("1.") && value[2..].bytes().all(|b| b.is_ascii_digit()),
                ("encoding", ["version"]) => {
                    value.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) && value.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch))
                }
                ("standalone", ["version"] | ["version", "encoding"]) => {
                    self.standalone = value == "yes";
                    value == "yes" || value == "no"
                }
                _ => false,
            };
            if !ok {
                return err(start, format!("malformed XML declaration: unexpected '{name}'"));
            }
            seen.push(name);
        }
        if seen.first() != Some(&"version") {
            return err(start, "the XML declaration needs a version");
        }
        c.pos = end + 2;
        Ok(())
    }

    fn misc(&mut self, c: &mut Cursor<'_>, prolog: bool) -> Step<()> {
        let mut doctype_seen = false;
        loop {
            c.space();
            if c.starts("<!--") {
                let data = self.comment(c)?;
                let node = self.m.create_comment_node(&data);
                self.m.append_children(self.holder, &[node]);
            } else if c.starts("<?") {
                self.pi(c)?;
            } else if prolog && c.starts("<!DOCTYPE") {
                if doctype_seen || self.root_seen {
                    return err(c.pos, "unexpected DOCTYPE");
                }
                doctype_seen = true;
                self.doctype(c)?;
            } else {
                return Ok(());
            }
        }
    }

    fn comment(&mut self, c: &mut Cursor<'_>) -> Step<String> {
        let start = c.pos;
        c.pos += 4;
        let Some(end) = c.rest().find("--") else { return err(start, "unterminated comment") };
        let data = c.rest()[..end].to_string();
        c.pos += end;
        if !c.eat("-->") {
            return err(c.pos, "'--' is not allowed in a comment");
        }
        Ok(data)
    }

    fn pi(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        let start = c.pos;
        c.pos += 2;
        let name_start = c.pos;
        while c.peek().is_some_and(is_name_char) {
            c.bump();
        }
        let target = c.s[name_start..c.pos].to_string();
        if !is_name(&target) {
            return err(name_start, "a processing instruction needs a target");
        }
        if target.eq_ignore_ascii_case("xml") {
            return err(start, "the XML declaration is only allowed at the start of the document");
        }
        if target.contains(':') {
            return err(name_start, "a processing instruction target cannot contain ':'");
        }
        let data = if c.eat("?>") {
            String::new()
        } else {
            if !c.space() {
                return err(c.pos, "malformed processing instruction");
            }
            let Some(end) = c.rest().find("?>") else { return err(start, "unterminated processing instruction") };
            let data = c.rest()[..end].to_string();
            c.pos += end + 2;
            data
        };
        self.flush();
        let node = self.m.create_comment_node(&data);
        self.append(node);
        self.out.pis.push((node, target));
        Ok(())
    }

    fn quoted(c: &mut Cursor<'_>, what: &str) -> Step<String> {
        let at = c.pos;
        let Some(quote) = c.bump().filter(|q| *q == '"' || *q == '\'') else { return err(at, format!("{what} must be quoted")) };
        let Some(len) = c.rest().find(quote) else { return err(at, format!("unterminated {what}")) };
        let value = c.rest()[..len].to_string();
        c.pos += len + 1;
        Ok(value)
    }

    fn external_id(c: &mut Cursor<'_>) -> Step<Option<(String, String)>> {
        let at = c.pos;
        if c.eat("SYSTEM") {
            if !c.space() {
                return err(c.pos, "expected whitespace after SYSTEM");
            }
            return Ok(Some((String::new(), Self::quoted(c, "system literal")?)));
        }
        if c.eat("PUBLIC") {
            if !c.space() {
                return err(c.pos, "expected whitespace after PUBLIC");
            }
            let public = Self::quoted(c, "public identifier")?;
            if let Some(bad) = public.chars().find(|&ch| !is_pubid_char(ch)) {
                return err(at, format!("'{bad}' is not allowed in a public identifier"));
            }
            if !c.space() {
                return err(c.pos, "expected whitespace before the system literal");
            }
            return Ok(Some((public, Self::quoted(c, "system literal")?)));
        }
        Ok(None)
    }

    fn doctype(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        c.pos += "<!DOCTYPE".len();
        if !c.space() {
            return err(c.pos, "expected whitespace after DOCTYPE");
        }
        let name = self.name(c)?;
        if !is_qname(&name) {
            return err(c.pos, format!("'{name}' is not a valid qualified name"));
        }
        let mut doctype = Doctype { name, ..Doctype::default() };
        let spaced = c.space();
        let external = match spaced {
            true => Self::external_id(c)?,
            false => None,
        };
        if let Some((public, system)) = external {
            self.html_entities = XHTML_PUBLIC_IDS.contains(&public.as_str());
            self.skip_undeclared = !self.html_entities && !self.standalone;
            doctype.public_id = public;
            doctype.system_id = system;
            c.space();
        }
        if c.eat("[") {
            self.internal_subset(c)?;
            c.space();
        }
        if !c.eat(">") {
            return err(c.pos, "malformed DOCTYPE");
        }
        let node = self.m.create_comment_node("");
        self.m.append_children(self.holder, &[node]);
        self.out.doctypes.push((node, doctype));
        Ok(())
    }

    fn internal_subset(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        let mut parameter_refs = false;
        loop {
            c.space();
            if c.eat("]") {
                if parameter_refs && !self.standalone {
                    self.skip_undeclared = true;
                }
                return Ok(());
            }
            if c.eof() {
                return err(c.pos, "unterminated DOCTYPE");
            }
            if c.starts("<!--") {
                self.comment(c)?;
            } else if c.starts("<?") {
                let at = c.pos;
                let Some(end) = c.rest().find("?>") else { return err(at, "unterminated processing instruction") };
                c.pos += end + 2;
            } else if c.eat("%") {
                let name = self.name(c)?;
                if !c.eat(";") || name.contains(':') {
                    return err(c.pos, "malformed parameter entity reference");
                }
                parameter_refs = true;
            } else if c.starts("<!ENTITY") {
                if parameter_refs {
                    self.skip_declaration(c)?;
                } else {
                    self.entity_declaration(c)?;
                }
            } else if c.starts("<!ELEMENT") || c.starts("<!ATTLIST") || c.starts("<!NOTATION") {
                self.skip_declaration(c)?;
            } else {
                return err(c.pos, "malformed DOCTYPE internal subset");
            }
        }
    }

    fn skip_declaration(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        let at = c.pos;
        while let Some(ch) = c.bump() {
            match ch {
                '"' | '\'' => {
                    let Some(len) = c.rest().find(ch) else { return err(at, "unterminated markup declaration") };
                    c.pos += len + 1;
                }
                '>' => return Ok(()),
                _ => {}
            }
        }
        err(at, "unterminated markup declaration")
    }

    fn entity_declaration(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        let at = c.pos;
        c.pos += "<!ENTITY".len();
        if !c.space() {
            return err(c.pos, "expected whitespace in an entity declaration");
        }
        let parameter = c.eat("%");
        if parameter && !c.space() {
            return err(c.pos, "expected whitespace in an entity declaration");
        }
        let name = self.name(c)?;
        if name.contains(':') {
            return err(at, "an entity name cannot contain ':'");
        }
        if !c.space() {
            return err(c.pos, "expected whitespace in an entity declaration");
        }
        let entity = if matches!(c.peek(), Some('"' | '\'')) {
            let raw = Self::quoted(c, "entity value")?;
            if raw.contains('%') {
                return err(at, "parameter entity references are not allowed in the internal subset's markup declarations");
            }
            Entity::Internal(self.entity_value(&raw, at)?)
        } else {
            let Some(_) = Self::external_id(c)? else { return err(c.pos, "malformed entity declaration") };
            let spaced = c.space();
            if spaced && c.eat("NDATA") {
                if parameter || !c.space() {
                    return err(c.pos, "malformed entity declaration");
                }
                self.name(c)?;
                Entity::Unparsed
            } else {
                Entity::External
            }
        };
        c.space();
        if !c.eat(">") {
            return err(c.pos, "malformed entity declaration");
        }
        if !parameter {
            self.entities.entry(name).or_insert(entity);
        }
        Ok(())
    }

    fn entity_value(&mut self, raw: &str, at: usize) -> Step<String> {
        let mut out = String::with_capacity(raw.len());
        let mut c = Cursor { s: raw, pos: 0 };
        while let Some(ch) = c.peek() {
            if ch == '&' && c.starts("&#") {
                c.pos += 1;
                out.push(self.char_ref(&mut c).map_err(|(_, m)| (at, m))?);
            } else if ch == '&' {
                let start = c.pos;
                c.pos += 1;
                let name = self.name(&mut c).map_err(|(_, m)| (at, m))?;
                if !c.eat(";") {
                    return err(at, format!("malformed reference to '{name}'"));
                }
                out.push_str(&raw[start..c.pos]);
            } else {
                out.push(ch);
                c.pos += ch.len_utf8();
            }
        }
        Ok(out)
    }

    fn name(&mut self, c: &mut Cursor<'_>) -> Step<String> {
        let start = c.pos;
        match c.peek() {
            Some(ch) if is_name_start(ch) => {
                c.bump();
            }
            _ => return err(start, "expected a name"),
        }
        while c.peek().is_some_and(is_name_char) {
            c.bump();
        }
        Ok(c.s[start..c.pos].to_string())
    }

    fn char_ref(&mut self, c: &mut Cursor<'_>) -> Step<char> {
        let at = c.pos;
        c.pos += 1;
        let hex = c.eat("x");
        let start = c.pos;
        while c.peek().is_some_and(|ch| if hex { ch.is_ascii_hexdigit() } else { ch.is_ascii_digit() }) {
            c.bump();
        }
        let digits = &c.s[start..c.pos];
        if digits.is_empty() || !c.eat(";") {
            return err(at, "malformed character reference");
        }
        u32::from_str_radix(digits, if hex { 16 } else { 10 })
            .ok()
            .and_then(char::from_u32)
            .filter(|&ch| is_char(ch))
            .ok_or((at, format!("&#{}{digits}; is not a valid character", if hex { "x" } else { "" })))
    }

    fn origin(&self, at: usize) -> usize {
        self.origin.unwrap_or(at)
    }

    fn reference(&mut self, c: &mut Cursor<'_>, attribute: bool) -> Step<Option<String>> {
        let at = c.pos;
        c.pos += 1;
        if c.starts("#") {
            let ch = self.char_ref(c).map_err(|(p, m)| (self.origin(p), m))?;
            return Ok(Some(ch.to_string()));
        }
        let name = self.name(c).map_err(|(p, m)| (self.origin(p), m))?;
        if !c.eat(";") {
            return err(self.origin(at), format!("malformed reference to entity '{name}'"));
        }
        let predefined = match name.as_str() {
            "lt" => Some("<"),
            "gt" => Some(">"),
            "amp" => Some("&"),
            "apos" => Some("'"),
            "quot" => Some("\""),
            _ => None,
        };
        if let Some(p) = predefined {
            return Ok(Some(p.to_string()));
        }
        match self.entities.get(&name).cloned() {
            Some(Entity::Internal(value)) => {
                if self.expanding.contains(&name) {
                    return err(self.origin(at), format!("entity '{name}' refers to itself"));
                }
                self.expanded += value.len();
                if self.expanded > MAX_EXPANSION || self.expanding.len() >= MAX_ENTITY_DEPTH {
                    return err(self.origin(at), "too much entity expansion");
                }
                if attribute {
                    if value.contains('<') {
                        return err(self.origin(at), format!("entity '{name}' puts '<' in an attribute value"));
                    }
                    self.expanding.push(name);
                    let origin = self.origin.replace(self.origin(at));
                    let result = self.attribute_text(&value);
                    self.origin = origin;
                    self.expanding.pop();
                    return result.map(Some);
                }
                self.expanding.push(name.clone());
                let origin = self.origin.replace(self.origin(at));
                let depth = self.open.len();
                let mut inner = Cursor { s: &value, pos: 0 };
                let result = self.content(&mut inner, depth);
                self.origin = origin;
                self.expanding.pop();
                result?;
                if self.open.len() != depth {
                    return err(self.origin(at), format!("entity '{name}' is not well-balanced"));
                }
                Ok(None)
            }
            Some(Entity::External) if attribute => err(self.origin(at), format!("external entity '{name}' in an attribute value")),
            Some(Entity::External) => Ok(None),
            Some(Entity::Unparsed) => err(self.origin(at), format!("unparsed entity '{name}' cannot be referenced")),
            None => {
                if self.html_entities
                    && let Some(&(a, b)) = html5ever::data::NAMED_ENTITIES.get(format!("{name};").as_str())
                    && a != 0
                {
                    let mut s = String::new();
                    s.extend(char::from_u32(a));
                    if b != 0 {
                        s.extend(char::from_u32(b));
                    }
                    return Ok(Some(s));
                }
                match self.skip_undeclared {
                    true => Ok(None),
                    false => err(self.origin(at), format!("entity '{name}' is not defined")),
                }
            }
        }
    }

    fn attribute_text(&mut self, raw: &str) -> Step<String> {
        let mut out = String::with_capacity(raw.len());
        let mut c = Cursor { s: raw, pos: 0 };
        while let Some(ch) = c.peek() {
            match ch {
                '&' => {
                    if let Some(text) = self.reference(&mut c, true)? {
                        out.push_str(&text);
                    }
                }
                '<' => return err(self.origin(c.pos), "'<' is not allowed in an attribute value"),
                '\t' | '\n' | '\r' => {
                    out.push(' ');
                    c.pos += 1;
                }
                _ => {
                    out.push(ch);
                    c.pos += ch.len_utf8();
                }
            }
        }
        Ok(out)
    }

    fn flush(&mut self) {
        if self.text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.text);
        if self.open.is_empty() {
            return;
        }
        let node = self.m.create_text_node(&text);
        self.append(node);
    }

    fn parent(&mut self) -> NodeId {
        match self.open.last() {
            Some(open) => {
                let node = open.node;
                let template = self.m.doc.get_node(node).and_then(|n| n.element_data()).is_some_and(|e| e.name.ns == ns!(html) && &*e.name.local == "template");
                match template {
                    true => {
                        let content = self.m.template_contents(node);
                        if !self.out.templates.iter().any(|&(c, _)| c == content) {
                            self.out.templates.push((content, node));
                        }
                        content
                    }
                    false => node,
                }
            }
            None => self.holder,
        }
    }

    fn append(&mut self, node: NodeId) {
        let parent = self.parent();
        self.m.append_children(parent, &[node]);
    }

    fn content(&mut self, c: &mut Cursor<'_>, floor: usize) -> Step<()> {
        loop {
            if c.eof() {
                if floor == 0 {
                    self.flush();
                }
                if self.open.len() > floor {
                    let name = &self.open.last().map(|o| o.name.clone()).unwrap_or_default();
                    return err(self.origin(c.pos), format!("the element '{name}' is not closed"));
                }
                return Ok(());
            }
            if c.starts("<") {
                if c.starts("</") {
                    if self.open.len() <= floor {
                        return err(self.origin(c.pos), "unexpected end tag");
                    }
                    self.end_tag(c)?;
                    if self.open.len() == floor && floor == 0 {
                        return Ok(());
                    }
                } else if c.starts("<!--") {
                    self.flush();
                    let data = self.comment(c).map_err(|(p, m)| (self.origin(p), m))?;
                    let node = self.m.create_comment_node(&data);
                    self.append(node);
                } else if c.starts("<![CDATA[") {
                    let at = c.pos;
                    c.pos += "<![CDATA[".len();
                    let Some(end) = c.rest().find("]]>") else { return err(self.origin(at), "unterminated CDATA section") };
                    let data = c.rest()[..end].to_string();
                    c.pos += end + 3;
                    self.flush();
                    let node = self.m.create_text_node(&data);
                    self.append(node);
                    self.out.cdata.push(node);
                } else if c.starts("<?") {
                    self.pi(c).map_err(|(p, m)| (self.origin(p), m))?;
                } else if c.starts("<!") {
                    return err(self.origin(c.pos), "unexpected markup declaration");
                } else {
                    let empty = self.start_tag(c)?;
                    if empty && self.open.len() == floor && floor == 0 {
                        return Ok(());
                    }
                }
            } else if c.starts("&") {
                if self.open.len() <= floor && floor == 0 {
                    return err(self.origin(c.pos), "content is not allowed outside the root element");
                }
                if let Some(text) = self.reference(c, false)? {
                    self.text.push_str(&text);
                }
            } else {
                let start = c.pos;
                let end = c.rest().find(['<', '&']).map_or(c.s.len(), |i| start + i);
                let chunk = &c.s[start..end];
                if let Some(i) = chunk.find("]]>") {
                    return err(self.origin(start + i), "']]>' is not allowed in text");
                }
                if self.open.len() <= floor && floor == 0 && !chunk.chars().all(|ch| matches!(ch, ' ' | '\t' | '\n' | '\r')) {
                    return err(self.origin(start), "content is not allowed outside the root element");
                }
                self.text.push_str(chunk);
                c.pos = end;
            }
        }
    }

    fn start_tag(&mut self, c: &mut Cursor<'_>) -> Step<bool> {
        let at = c.pos;
        if self.open.is_empty() && self.root_seen && self.expanding.is_empty() {
            return err(self.origin(at), "only one root element is allowed");
        }
        if self.open.len() >= MAX_DEPTH {
            return err(self.origin(at), "elements are nested too deeply");
        }
        c.pos += 1;
        let name = self.name(c).map_err(|(p, m)| (self.origin(p), m))?;
        let mut raws: Vec<Raw> = Vec::new();
        let empty = loop {
            let spaced = c.space();
            if c.eat("/>") {
                break true;
            }
            if c.eat(">") {
                break false;
            }
            if c.eof() {
                return err(self.origin(at), format!("unterminated start tag '{name}'"));
            }
            if !spaced {
                return err(self.origin(c.pos), format!("expected whitespace between attributes of '{name}'"));
            }
            let attr_at = c.pos;
            let attr = self.name(c).map_err(|(p, m)| (self.origin(p), m))?;
            c.space();
            if !c.eat("=") {
                return err(self.origin(c.pos), format!("attribute '{attr}' has no value"));
            }
            c.space();
            let quote_at = c.pos;
            let Some(quote) = c.bump().filter(|q| *q == '"' || *q == '\'') else {
                return err(self.origin(quote_at), format!("the value of '{attr}' must be quoted"));
            };
            let Some(len) = c.rest().find(quote) else { return err(self.origin(quote_at), format!("unterminated value of '{attr}'")) };
            let raw = c.rest()[..len].to_string();
            c.pos += len + 1;
            if raws.iter().any(|r| r.name == attr) {
                return err(self.origin(attr_at), format!("attribute '{attr}' is repeated"));
            }
            let value = self.attribute_text(&raw).map_err(|(p, m)| (if self.origin.is_some() { p } else { quote_at }, m))?;
            raws.push(Raw { name: attr, value, at: attr_at });
        };
        self.flush();
        let scope = self.bindings.len();
        for raw in &raws {
            let (prefix, declared) = match raw.name.as_str() {
                "xmlns" => (None, true),
                n => match n.strip_prefix("xmlns:") {
                    Some(p) => (Some(p.to_string()), true),
                    None => (None, false),
                },
            };
            if !declared {
                continue;
            }
            let at = self.origin(raw.at);
            if !is_qname(&raw.name) {
                return err(at, format!("'{}' is not a valid qualified name", raw.name));
            }
            match prefix.as_deref() {
                Some("xmlns") => return err(at, "the 'xmlns' prefix cannot be declared"),
                Some("xml") if raw.value != XML_NS => return err(at, "the 'xml' prefix is bound to the XML namespace"),
                Some(p) if p != "xml" && raw.value == XML_NS => return err(at, format!("'{p}' cannot be bound to the XML namespace")),
                _ if raw.value == XMLNS_NS => return err(at, "the xmlns namespace cannot be declared"),
                None if raw.value == XML_NS => return err(at, "the XML namespace cannot be the default namespace"),
                Some(p) if raw.value.is_empty() => return err(at, format!("the prefix '{p}' cannot be undeclared")),
                _ => {}
            }
            self.bindings.push((prefix.unwrap_or_default(), raw.value.clone()));
        }
        if !is_qname(&name) {
            return err(self.origin(at), format!("'{name}' is not a valid qualified name"));
        }
        let qual = self.resolve(&name, true).ok_or((self.origin(at), format!("the prefix of '{name}' is not declared")))?;
        let mut attrs: Vec<Attribute> = Vec::with_capacity(raws.len());
        for raw in raws {
            if !is_qname(&raw.name) {
                return err(self.origin(raw.at), format!("'{}' is not a valid qualified name", raw.name));
            }
            let name = match raw.name.as_str() {
                "xmlns" => QualName::new(None, Namespace::from(XMLNS_NS), LocalName::from("xmlns")),
                n => self.resolve(n, false).ok_or((self.origin(raw.at), format!("the prefix of '{n}' is not declared")))?,
            };
            if attrs.iter().any(|a| a.name.ns == name.ns && a.name.local == name.local) {
                return err(self.origin(raw.at), format!("attribute '{}' is repeated", raw.name));
            }
            attrs.push(Attribute { name, value: raw.value });
        }
        let node = self.m.create_element(qual, attrs);
        self.append(node);
        if self.open.is_empty() {
            self.root_seen = true;
        }
        match empty {
            true => self.bindings.truncate(scope),
            false => self.open.push(Open { node, name, scope }),
        }
        Ok(empty)
    }

    fn resolve(&self, name: &str, element: bool) -> Option<QualName> {
        let (prefix, local) = match name.split_once(':') {
            Some((p, l)) => (Some(p), l),
            None => (None, name),
        };
        let uri = match prefix {
            None if !element => String::new(),
            p => {
                let key = p.unwrap_or("");
                match self.bindings.iter().rev().find(|(k, _)| k == key) {
                    Some((_, uri)) => uri.clone(),
                    None if key.is_empty() => String::new(),
                    None => return None,
                }
            }
        };
        Some(QualName::new(prefix.map(Prefix::from), Namespace::from(uri), LocalName::from(local)))
    }

    fn end_tag(&mut self, c: &mut Cursor<'_>) -> Step<()> {
        let at = c.pos;
        c.pos += 2;
        let name = self.name(c).map_err(|(p, m)| (self.origin(p), m))?;
        c.space();
        if !c.eat(">") {
            return err(self.origin(c.pos), format!("malformed end tag '{name}'"));
        }
        let open = self.open.last().map(|o| o.name.as_str()).unwrap_or("");
        if open != name {
            return err(self.origin(at), format!("end tag '{name}' does not match start tag '{open}'"));
        }
        self.flush();
        let open = self.open.pop().expect("an open element");
        self.bindings.truncate(open.scope);
        Ok(())
    }
}

pub(crate) fn fragment(m: &mut DocumentMutator<'_>, holder: NodeId, text: &str, scope: Vec<(String, String)>) -> std::result::Result<Parsed, XmlError> {
    let text = normalize_newlines(text);
    if let Some((at, c)) = text.char_indices().find(|&(_, c)| !is_char(c)) {
        let (line, column) = position(&text, at);
        return Err(XmlError { line, column, message: format!("invalid character U+{:04X}", c as u32) });
    }
    let mut bindings: Vec<(String, String)> = vec![("xml".into(), XML_NS.into()), ("xmlns".into(), XMLNS_NS.into())];
    bindings.extend(scope);
    let depth = bindings.len();
    let mut parser = Parser {
        m,
        holder,
        out: Parsed::default(),
        entities: HashMap::new(),
        html_entities: false,
        skip_undeclared: false,
        bindings,
        open: vec![Open { node: holder, name: String::new(), scope: depth }],
        text: String::new(),
        expanding: Vec::new(),
        expanded: 0,
        root_seen: true,
        standalone: false,
        origin: None,
    };
    let mut c = Cursor { s: &text, pos: 0 };
    let result = parser.content(&mut c, 1);
    parser.flush();
    match result {
        Ok(()) => Ok(parser.out),
        Err((at, message)) => {
            let (line, column) = position(&text, at);
            Err(XmlError { line, column, message })
        }
    }
}

pub(crate) fn parsererror(m: &mut DocumentMutator<'_>, holder: NodeId, error: &XmlError) -> NodeId {
    let name = QualName::new(None, Namespace::from(PARSERERROR_NS), LocalName::from("parsererror"));
    let root = m.create_element(name, Vec::new());
    let text = m.create_text_node(&format!("XML Parsing Error: {}\nLine Number {}, Column {}", error.message, error.line, error.column));
    m.append_children(root, &[text]);
    m.append_children(holder, &[root]);
    root
}
