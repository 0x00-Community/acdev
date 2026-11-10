use std::cell::RefCell;
use std::path::{Path, PathBuf};

use acde_render::{Dom, NONE};

use crate::bind;
use crate::wire::{Args, Ret, V8Args, WireArgs};
use crate::modules::Loader;

const ORIGIN: &str = "http://acde.local";

thread_local! {
    static DOC: RefCell<Option<(acde_render::Document, Dom)>> = const { RefCell::new(None) };
}

#[cfg(target_os = "linux")]
pub fn with_dom<R>(f: impl FnOnce(&Dom) -> R) -> Option<R> {
    DOC.with(|d| d.borrow().as_ref().map(|(_, dom)| f(dom)))
}

#[cfg(target_os = "linux")]
pub fn render_handle() -> Option<acde_render::RenderHandle> {
    DOC.with(|d| d.borrow().as_ref().map(|(document, _)| document.handle()))
}

#[derive(Default)]
struct Assets(Vec<acde_render::Resource>);

impl Assets {
    fn holds(&self, path: &Path) -> bool {
        let bundle = std::fs::canonicalize(crate::sys::app_dir()).ok();
        let dirs = self.0.iter().flat_map(|r| r.dirs.iter()).filter_map(|d| std::fs::canonicalize(d).ok());
        bundle.into_iter().chain(dirs).any(|dir| path.starts_with(dir))
    }

    fn file(&self, url: &str) -> Option<PathBuf> {
        let parsed = url::Url::parse(url).ok()?;
        if parsed.origin().ascii_serialization() != ORIGIN {
            return None;
        }
        let path = parsed.path();
        let (name, dirs) = self.0.iter().filter_map(|r| Some((path.strip_prefix(r.prefix.as_str())?, &r.dirs))).min_by_key(|(name, _)| name.len())?;
        let name = percent(name);
        if name.is_empty() || name.ends_with(".map") || name.split('/').any(|seg| seg.is_empty() || seg.starts_with('.')) {
            return None;
        }
        dirs.iter().map(|dir| Path::new(dir).join(&name)).find(|file| file.is_file())
    }
}

thread_local! {
    static ASSETS: RefCell<Assets> = RefCell::default();
}

fn asset_file(url: &str) -> Option<PathBuf> {
    ASSETS.with(|a| a.borrow().file(url))
}

pub fn read_asset(url: &str) -> Option<Vec<u8>> {
    std::fs::read(asset_file(url)?).ok()
}

fn percent(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(byte) = text.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Modules of a desktop or window page: its own origin's assets, and `file:` only inside the installed assets'
/// directories or acde's own bundle; nothing else on disk.
pub struct PageLoader;

impl Loader for PageLoader {
    fn resolve(&self, specifier: &str, referrer: &str) -> Result<String, String> {
        if referrer.starts_with("file:") {
            return crate::sys::FileLoader.resolve(specifier, referrer);
        }
        let base = url::Url::parse(referrer).or_else(|_| url::Url::parse(&format!("{ORIGIN}/"))).map_err(|e| e.to_string())?;
        if !(specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/') || url::Url::parse(specifier).is_ok()) {
            return Err(format!("acde: bare module specifier '{specifier}' in {referrer} (pages import URLs)"));
        }
        base.join(specifier).map(String::from).map_err(|e| format!("acde: {specifier}: {e}"))
    }

    fn load(&self, url: &str) -> Result<String, String> {
        if url.starts_with("file:") {
            let path = url::Url::parse(url).ok().and_then(|u| u.to_file_path().ok()).and_then(|p| std::fs::canonicalize(p).ok());
            if !path.as_deref().is_some_and(|p| ASSETS.with(|a| a.borrow().holds(p))) {
                return Err(format!("acde: module {url} is outside the installed packages' assets"));
            }
            return crate::sys::FileLoader.load(url);
        }
        let file = asset_file(url).ok_or_else(|| format!("acde: module {url} is not a local file"))?;
        std::fs::read_to_string(&file).map_err(|e| format!("acde: {}: {e}", file.display()))
    }
}

pub struct DocumentOptions {
    pub resources: Vec<acde_render::Resource>,
    pub default_lang: Option<String>,
    pub reduced_motion: bool,
    pub dark: bool,
}

impl DocumentOptions {
    pub fn from_json(options: &serde_json::Value) -> Self {
        let text = |v: &serde_json::Value| v.as_str().map(str::to_owned);
        let resources = options["resources"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|entry| acde_render::Resource {
                        prefix: text(&entry["prefix"]).unwrap_or_default(),
                        dirs: entry["dirs"].as_array().map(|d| d.iter().filter_map(text).collect()).unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        DocumentOptions {
            resources,
            default_lang: text(&options["defaultLang"]),
            reduced_motion: options["reducedMotion"] == serde_json::Value::Bool(true),
            dark: options["dark"] == serde_json::Value::Bool(true),
        }
    }
}

pub fn create(width: f64, height: f64, scale: f64, options: DocumentOptions, name: String) -> Result<(), String> {
    let (width, height, scale) = (width.max(1.0) as u32, height.max(1.0) as u32, scale as f32);
    ASSETS.with(|a| *a.borrow_mut() = Assets(options.resources.clone()));
    let render = acde_render::Options {
        base_url: Some(format!("{ORIGIN}/")),
        resources: Some(options.resources),
        default_lang: options.default_lang,
        reduced_motion: options.reduced_motion,
        dark: options.dark,
        name: Some(name),
        ..Default::default()
    };
    let document = acde_render::Document::new(width, height, scale, &render).map_err(|e| format!("createDocument: {e}"))?;
    let dom = document.dom();
    DOC.with(|d| *d.borrow_mut() = Some((document, dom)));
    Ok(())
}

pub fn create_document<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue) {
    let (width, height, scale) = (bind::arg_f64(scope, &args, 0), bind::arg_f64(scope, &args, 1), bind::arg_f64(scope, &args, 2));
    let options = {
        let mut a = V8Args { scope: &mut *scope, args: &args };
        a.json(3)
    };
    if let Err(e) = create(width, height, scale, DocumentOptions::from_json(&options), crate::rt::web_name()) {
        return bind::throw_error(scope, &e);
    }
    rv.set(object(scope).into());
}

pub fn with_dom_wire(name: &str, args: &mut WireArgs) -> Option<Result<Ret, String>> {
    let f = wire(name)?;
    Some(DOC.with(|d| {
        let d = d.borrow();
        let Some((_, dom)) = d.as_ref() else { return Err("InvalidStateError: no document".to_owned()) };
        f(args, dom).map_err(|e| e.to_string())
    }))
}

struct Id(u32);

impl From<Id> for Ret {
    fn from(id: Id) -> Self {
        match id.0 {
            NONE => Ret::Num(-1.0),
            id => Ret::Num(f64::from(id)),
        }
    }
}

struct Ids(Vec<u32>);

impl From<Ids> for Ret {
    fn from(ids: Ids) -> Self {
        Ret::U32s(ids.0)
    }
}

impl From<(acde_render::NodeType, acde_render::Ns, bool, String)> for Ret {
    fn from(d: (acde_render::NodeType, acde_render::Ns, bool, String)) -> Self {
        Ret::List(vec![Ret::Num(d.0 as i32 as f64), Ret::Num(d.1 as i32 as f64), Ret::Bool(d.2), Ret::Str(d.3)])
    }
}

struct Floats(Vec<f64>);

impl From<Floats> for Ret {
    fn from(f: Floats) -> Self {
        Ret::F64s(f.0)
    }
}

impl From<acde_render::Metrics> for Ret {
    fn from(m: acde_render::Metrics) -> Self {
        Ret::Obj(vec![
            ("offsetLeft", Ret::Num(m.offset_left)),
            ("offsetTop", Ret::Num(m.offset_top)),
            ("offsetWidth", Ret::Num(m.offset_width)),
            ("offsetHeight", Ret::Num(m.offset_height)),
            ("offsetParent", Id(m.offset_parent.unwrap_or(NONE)).into()),
            ("clientLeft", Ret::Num(m.client_left)),
            ("clientTop", Ret::Num(m.client_top)),
            ("clientWidth", Ret::Num(m.client_width)),
            ("clientHeight", Ret::Num(m.client_height)),
            ("scrollLeft", Ret::Num(m.scroll_left)),
            ("scrollTop", Ret::Num(m.scroll_top)),
            ("scrollWidth", Ret::Num(m.scroll_width)),
            ("scrollHeight", Ret::Num(m.scroll_height)),
        ])
    }
}

impl From<acde_render::Viewport> for Ret {
    fn from(v: acde_render::Viewport) -> Self {
        Ret::Obj(vec![("width", Ret::Num(v.width)), ("height", Ret::Num(v.height)), ("scale", Ret::Num(v.scale))])
    }
}

thread_local! {
    static PICTURE: RefCell<(u32, Option<(u32, acde_render::acgpu::Scene)>)> = const { RefCell::new((0, None)) };
}

fn keep_picture(scene: acde_render::acgpu::Scene) -> u32 {
    PICTURE.with(|p| {
        let mut p = p.borrow_mut();
        p.0 = p.0.wrapping_add(1).max(1);
        let id = p.0;
        p.1 = Some((id, scene));
        id
    })
}

#[cfg(target_os = "linux")]
pub fn take_picture(id: u32) -> Option<acde_render::acgpu::Scene> {
    PICTURE.with(|p| {
        let mut p = p.borrow_mut();
        match p.1.take() {
            Some((kept, scene)) if kept == id => Some(scene),
            other => {
                p.1 = other;
                None
            }
        }
    })
}

impl From<acde_render::Capture> for Ret {
    fn from(c: acde_render::Capture) -> Self {
        Ret::Obj(vec![
            ("x", Ret::Num(c.x)),
            ("y", Ret::Num(c.y)),
            ("width", Ret::Num(c.width)),
            ("height", Ret::Num(c.height)),
            ("pixelWidth", Ret::Num(c.pixel_width as f64)),
            ("pixelHeight", Ret::Num(c.pixel_height as f64)),
            ("scale", Ret::Num(c.scale)),
            ("picture", Ret::Num(f64::from(keep_picture(c.scene)))),
        ])
    }
}

impl From<acde_render::Timing> for Ret {
    fn from(t: acde_render::Timing) -> Self {
        Ret::Obj(vec![("count", Ret::Num(f64::from(t.count))), ("totalMs", Ret::Num(t.total_ms)), ("maxMs", Ret::Num(t.max_ms))])
    }
}

impl From<acde_render::Stats> for Ret {
    fn from(s: acde_render::Stats) -> Self {
        Ret::Obj(vec![
            ("resolve", s.resolve.into()),
            ("frame", s.frame.into()),
            ("frameLocked", s.frame_locked.into()),
            ("resolveMs", Ret::Num(s.resolve_ms)),
            ("paintMs", Ret::Num(s.paint_ms)),
            ("damageMs", Ret::Num(s.damage_ms)),
            ("layersMs", Ret::Num(s.layers_ms)),
            ("fragmentsRecorded", Ret::Num(f64::from(s.fragments_recorded))),
            ("fragmentsReused", Ret::Num(f64::from(s.fragments_reused))),
            ("animating", Ret::Bool(s.animating)),
            ("nodes", Ret::Num(f64::from(s.nodes))),
            ("images", Ret::Num(f64::from(s.images))),
            ("imageBytes", Ret::Num(s.image_bytes)),
            ("mallocBytes", Ret::Num(s.malloc_bytes)),
        ])
    }
}

impl From<acde_render::CaretPosition> for Ret {
    fn from(c: acde_render::CaretPosition) -> Self {
        Ret::Obj(vec![("node", Id(c.node).into()), ("offset", Ret::Num(c.offset as f64))])
    }
}

macro_rules! natives {
    ($($name:literal => fn $f:ident($a:ident, $dom:ident) $body:block)*) => {
        mod body {
            #[allow(unused_imports)]
            use super::*;
            $(
                #[allow(unused_variables, unused_mut, clippy::redundant_closure_call)]
                pub fn $f<A: Args>($a: &mut A, $dom: &Dom) -> Result<Ret, acde_render::Error> {
                    let result: Result<_, acde_render::Error> = (|| $body)();
                    result.map(Into::into)
                }
            )*
        }

        mod js {
            #[allow(unused_imports)]
            use super::*;
            $(
                pub fn $f<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue) {
                    let result = DOC.with(|d| {
                        let d = d.borrow();
                        let (_, dom) = d.as_ref()?;
                        let mut a = V8Args { scope: &mut *scope, args: &args };
                        Some(body::$f(&mut a, dom))
                    });
                    match result {
                        Some(Ok(value)) => rv.set(value.js(scope)),
                        Some(Err(e)) => bind::throw_error(scope, &e.to_string()),
                        None => bind::throw_error(scope, "InvalidStateError: no document"),
                    }
                }
            )*
        }

        fn object<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
            let obj = v8::Object::new(scope);
            $( bind::method(scope, obj, $name, js::$f); )*
            obj
        }

        pub type WireFn = fn(&mut WireArgs, &Dom) -> Result<Ret, acde_render::Error>;

        pub fn wire(name: &str) -> Option<WireFn> {
            match name {
                $( $name => Some(body::$f::<WireArgs>), )*
                _ => None,
            }
        }
    };
}

fn pinned(dom: &Dom, id: u32) -> Result<Id, acde_render::Error> {
    dom.pin(id)?;
    Ok(Id(id))
}

fn quads(list: Vec<[f64; 4]>) -> Floats {
    Floats(list.into_iter().flatten().collect())
}

fn ns(code: f64) -> acde_render::Ns {
    match code as i32 {
        1 => acde_render::Ns::Svg,
        2 => acde_render::Ns::MathMl,
        _ => acde_render::Ns::Html,
    }
}

natives! {
    "document" => fn document(a, dom) { Ok(Id(dom.document())) }
    "parseDocument" => fn parse_document(a, dom) { let html = a.str(0); dom.parse_document(&html) }
    "viewport" => fn viewport(a, dom) { Ok(dom.viewport()) }
    "nodeType" => fn node_type(a, dom) { let id = a.id(0); dom.node_type(id).map(|t| t as u8 as u32) }
    "parent" => fn parent(a, dom) { let id = a.id(0); dom.parent(id).map(Id) }
    "ancestors" => fn ancestors(a, dom) { let id = a.id(0); dom.ancestors(id).map(Ids) }
    "describe" => fn describe(a, dom) { let id = a.id(0); dom.describe(id) }
    "firstChild" => fn first_child(a, dom) { let id = a.id(0); dom.first_child(id).map(Id) }
    "lastChild" => fn last_child(a, dom) { let id = a.id(0); dom.last_child(id).map(Id) }
    "nextSibling" => fn next_sibling(a, dom) { let id = a.id(0); dom.next_sibling(id).map(Id) }
    "previousSibling" => fn previous_sibling(a, dom) { let id = a.id(0); dom.previous_sibling(id).map(Id) }
    "childNodes" => fn child_nodes(a, dom) { let id = a.id(0); dom.child_nodes(id).map(Ids) }
    "children" => fn children(a, dom) { let id = a.id(0); dom.children(id).map(Ids) }
    "childCount" => fn child_count(a, dom) { let id = a.id(0); dom.child_count(id) }
    "isConnected" => fn is_connected(a, dom) { let id = a.id(0); dom.is_connected(id) }
    "compareDocumentPosition" => fn compare_document_position(a, dom) {
        let (a, b) = (a.id(0), a.id(1));
        dom.compare_document_position(a, b)
    }
    "createElement" => fn create_element(a, dom) {
        let n = ns(a.f64(0)); let name = a.str(1);
        dom.create_element(n, &name).and_then(|id| pinned(dom, id))
    }
    "createText" => fn create_text(a, dom) { let data = a.str(0); dom.create_text(&data).and_then(|id| pinned(dom, id)) }
    "createComment" => fn create_comment(a, dom) { let data = a.str(0); dom.create_comment(&data).and_then(|id| pinned(dom, id)) }
    "createFragment" => fn create_fragment(a, dom) { dom.create_fragment().and_then(|id| pinned(dom, id)) }
    "createDocumentType" => fn create_document_type(a, dom) {
        let name = a.str(0); let public = a.str(1); let system = a.str(2);
        dom.create_document_type(&name, &public, &system).map(Id)
    }
    "documentType" => fn document_type(a, dom) {
        let id = a.id(0);
        dom.document_type(id).map(|(a, b, c)| vec![a, b, c])
    }
    "clone" => fn clone_node(a, dom) {
        let (id, deep) = (a.id(0), a.bool(1));
        dom.clone(id, deep).and_then(|id| pinned(dom, id))
    }
    "insertBefore" => fn insert_before(a, dom) {
        let (parent, child, reference) = (a.id(0), a.id(1), a.id(2));
        dom.insert_before(parent, child, reference)
    }
    "remove" => fn remove(a, dom) { let id = a.id(0); dom.remove(id) }
    "replaceChildren" => fn replace_children(a, dom) {
        let parent = a.id(0);
        let list: Vec<u32> = a.with_bytes(1, |bytes| bytes.as_chunks::<4>().0.iter().map(|c| u32::from_ne_bytes(*c)).collect())
            .unwrap_or_default();
        dom.replace_children(parent, &list)
    }
    "localName" => fn local_name(a, dom) { let id = a.id(0); dom.local_name(id) }
    "namespace" => fn namespace(a, dom) { let id = a.id(0); dom.namespace(id).map(|n| n as u8 as u32) }
    "getAttribute" => fn get_attribute(a, dom) {
        let id = a.id(0); let name = a.str(1);
        dom.get_attribute(id, &name)
    }
    "setAttribute" => fn set_attribute(a, dom) {
        let id = a.id(0); let name = a.str(1); let value = a.str(2);
        dom.set_attribute(id, &name, &value)
    }
    "removeAttribute" => fn remove_attribute(a, dom) {
        let id = a.id(0); let name = a.str(1);
        dom.remove_attribute(id, &name)
    }
    "hasAttribute" => fn has_attribute(a, dom) {
        let id = a.id(0); let name = a.str(1);
        dom.has_attribute(id, &name)
    }
    "attributes" => fn attributes(a, dom) { let id = a.id(0); dom.attributes(id) }
    "id" => fn element_id(a, dom) { let id = a.id(0); dom.id(id) }
    "className" => fn class_name(a, dom) { let id = a.id(0); dom.class_name(id) }
    "data" => fn data(a, dom) { let id = a.id(0); dom.data(id) }
    "setData" => fn set_data(a, dom) {
        let id = a.id(0); let data = a.str(1);
        dom.set_data(id, &data)
    }
    "textContent" => fn text_content(a, dom) { let id = a.id(0); dom.text_content(id) }
    "setTextContent" => fn set_text_content(a, dom) {
        let id = a.id(0); let text = a.str(1);
        dom.set_text_content(id, &text)
    }
    "innerText" => fn inner_text(a, dom) { let id = a.id(0); dom.inner_text(id) }
    "innerHTML" => fn inner_html(a, dom) { let id = a.id(0); dom.inner_html(id) }
    "outerHTML" => fn outer_html(a, dom) { let id = a.id(0); dom.outer_html(id) }
    "parseFragment" => fn parse_fragment(a, dom) {
        let context = a.id(0); let html = a.str(1);
        dom.parse_fragment(context, &html).map(Id)
    }
    "templateContent" => fn template_content(a, dom) { let id = a.id(0); dom.template_content(id).map(Id) }
    "parseInert" => fn parse_inert(a, dom) { let html = a.str(0); dom.parse_inert(&html).and_then(|id| pinned(dom, id)) }
    "querySelector" => fn query_selector(a, dom) {
        let root = a.id(0); let selector = a.str(1);
        dom.query_selector(root, &selector).map(Id)
    }
    "querySelectorAll" => fn query_selector_all(a, dom) {
        let root = a.id(0); let selector = a.str(1);
        dom.query_selector_all(root, &selector).map(Ids)
    }
    "matches" => fn matches(a, dom) {
        let id = a.id(0); let selector = a.str(1);
        dom.matches(id, &selector)
    }
    "closest" => fn closest(a, dom) {
        let id = a.id(0); let selector = a.str(1);
        dom.closest(id, &selector).map(Id)
    }
    "getElementById" => fn get_element_by_id(a, dom) { let name = a.str(0); Ok(Id(dom.get_element_by_id(&name))) }
    "getElementsByClassName" => fn get_elements_by_class_name(a, dom) {
        let root = a.id(0); let names = a.str(1);
        dom.get_elements_by_class_name(root, &names).map(Ids)
    }
    "getElementsByTagName" => fn get_elements_by_tag_name(a, dom) {
        let root = a.id(0); let name = a.str(1);
        dom.get_elements_by_tag_name(root, &name).map(Ids)
    }
    "value" => fn value(a, dom) { let id = a.id(0); dom.value(id) }
    "setValue" => fn set_value(a, dom) {
        let id = a.id(0); let value = a.str(1);
        dom.set_value(id, &value)
    }
    "checked" => fn checked(a, dom) { let id = a.id(0); dom.checked(id) }
    "setChecked" => fn set_checked(a, dom) {
        let (id, on) = (a.id(0), a.bool(1));
        dom.set_checked(id, on)
    }
    "selectedIndex" => fn selected_index(a, dom) { let id = a.id(0); dom.selected_index(id) }
    "setSelectedIndex" => fn set_selected_index(a, dom) {
        let (id, index) = (a.id(0), a.f64(1) as i32);
        dom.set_selected_index(id, index)
    }
    "setSelectionRange" => fn set_selection_range(a, dom) {
        let (id, start, end) = (a.id(0), a.f64(1) as u32, a.f64(2) as u32);
        dom.set_selection_range(id, start, end)
    }
    "setFocus" => fn set_focus(a, dom) {
        let (id, visible) = (a.id(0), a.bool(1));
        dom.set_focus(id, visible)
    }
    "setActive" => fn set_active(a, dom) { let id = a.id(0); dom.set_active(id) }
    "setSelection" => fn set_selection(a, dom) {
        let (a, ao, b, bo) = (a.id(0), a.f64(1) as u32, a.id(2), a.f64(3) as u32);
        dom.set_selection(a, ao, b, bo)
    }
    "rect" => fn rect(a, dom) { let id = a.id(0); dom.rect(id).map(|q| Floats(q.to_vec())) }
    "clientRects" => fn client_rects(a, dom) { let id = a.id(0); dom.client_rects(id).map(quads) }
    "metrics" => fn metrics(a, dom) { let id = a.id(0); dom.metrics(id) }
    "hitTest" => fn hit_test(a, dom) {
        let (x, y) = (a.f64(0), a.f64(1));
        Ok(dom.hit_test(x, y).map_or(-1.0, f64::from))
    }
    "hitTestAll" => fn hit_test_all(a, dom) {
        let (x, y) = (a.f64(0), a.f64(1));
        Ok(Ids(dom.hit_test_all(x, y)))
    }
    "computedStyle" => fn computed_style(a, dom) {
        let id = a.id(0); let pseudo = a.str(1); let property = a.str(2);
        dom.computed_style(id, &pseudo, &property)
    }
    "computedStyleAll" => fn computed_style_all(a, dom) {
        let id = a.id(0); let pseudo = a.str(1);
        dom.computed_style_all(id, &pseudo)
    }
    "caretRect" => fn caret_rect(a, dom) {
        let (id, offset) = (a.id(0), a.f64(1) as u32);
        dom.caret_rect(id, offset).map(|q| Floats(q.to_vec()))
    }
    "caretFromPoint" => fn caret_from_point(a, dom) {
        let (x, y) = (a.f64(0), a.f64(1));
        Ok(dom.caret_from_point(x, y))
    }
    "textRects" => fn text_rects(a, dom) {
        let (id, start, end) = (a.id(0), a.f64(1) as u32, a.f64(2) as u32);
        dom.text_rects(id, start, end).map(quads)
    }
    "matchMedia" => fn match_media(a, dom) { let query = a.str(0); Ok(dom.match_media(&query)) }
    "parseColor" => fn parse_color(a, dom) { let color = a.str(0); Ok(dom.parse_color(&color).map(|c| Floats(c.to_vec()))) }
    "sheetRuleCount" => fn sheet_rule_count(a, dom) {
        let id = a.id(0);
        dom.sheet_rule_count(id).map(|n| n.map_or(-1.0, f64::from))
    }
    "sheetRule" => fn sheet_rule(a, dom) {
        let (id, index) = (a.id(0), a.f64(1) as u32);
        dom.sheet_rule(id, index)
    }
    "sheetInsertRule" => fn sheet_insert_rule(a, dom) {
        let id = a.id(0); let rule = a.str(1); let index = a.f64(2) as u32;
        dom.sheet_insert_rule(id, &rule, index)
    }
    "sheetDeleteRule" => fn sheet_delete_rule(a, dom) {
        let (id, index) = (a.id(0), a.f64(1) as u32);
        dom.sheet_delete_rule(id, index)
    }
    "scrollTo" => fn scroll_to(a, dom) {
        let (id, left, top, smooth) = (a.id(0), a.f64(1), a.f64(2), a.bool(3));
        dom.scroll_to(id, left, top, smooth)
    }
    "takeScrolled" => fn take_scrolled(a, dom) { Ok(Ids(dom.take_scrolled())) }
    "imageState" => fn image_state(a, dom) { let id = a.id(0); dom.image_state(id).map(|s| Floats(s.to_vec())) }
    "takeLoaded" => fn take_loaded(a, dom) { Ok(Ids(dom.take_loaded())) }
    "canvas" => fn canvas(a, dom) {
        let id = a.id(0);
        a.with_bytes(1, |commands| dom.canvas(id, commands)).unwrap_or_else(|| dom.canvas(id, &[]))
    }
    "measureText" => fn measure_text(a, dom) {
        let id = a.id(0); let font = a.str(1); let text = a.str(2);
        dom.measure_text(id, &font, &text).map(|m| Floats(vec![
            m.width,
            m.actual_bounding_box_left,
            m.actual_bounding_box_right,
            m.actual_bounding_box_ascent,
            m.actual_bounding_box_descent,
            m.font_bounding_box_ascent,
            m.font_bounding_box_descent,
        ]))
    }
    "toDataURL" => fn to_data_url(a, dom) {
        let id = a.id(0); let kind = a.str(1);
        dom.to_data_url(id, &kind)
    }
    "getImageData" => fn get_image_data(a, dom) {
        let (id, x, y, w, h) = (a.id(0), a.f64(1), a.f64(2), a.f64(3), a.f64(4));
        dom.get_image_data(id, x, y, w, h)
    }
    "capture" => fn capture(a, dom) {
        let id = a.id(0);
        let scale = a.f64(1);
        dom.capture(id, if scale.is_finite() && scale > 0.0 { scale } else { 1.0 })
    }
    "setPanel" => fn set_panel(a, dom) {
        let (id, x, y, w, h) = (a.id(0), a.f64(1), a.f64(2), a.f64(3), a.f64(4));
        dom.set_panel(id, (w > 0.0 && h > 0.0).then_some([x, y, w, h]))
    }
    "unpin" => fn unpin(a, dom) { let id = a.id(0); dom.unpin(id) }
    "pinnedIn" => fn pinned_in(a, dom) { let id = a.id(0); dom.pinned_in(id).map(Ids) }
    "commit" => fn commit(a, dom) { dom.commit(); Ok(()) }
    "semantics" => fn semantics(a, dom) {
        let (id, limit) = (a.id(0), a.f64(1));
        dom.semantics(id, if limit.is_finite() && limit >= 1.0 { limit as u32 } else { 600 })
    }
    "stats" => fn stats(a, dom) {
        let stats = dom.stats();
        if a.bool(0) {
            dom.reset_timings();
        }
        Ok(stats)
    }
    "resize" => fn resize(a, dom) {
        let (w, h, scale) = (a.f64(0) as u32, a.f64(1) as u32, a.f64(2) as f32);
        dom.resize(w, h, scale);
        Ok(())
    }
    "setReducedMotion" => fn set_reduced_motion(a, dom) {
        dom.set_reduced_motion(a.bool(0));
        Ok(())
    }
    "setDark" => fn set_dark(a, dom) {
        dom.set_dark(a.bool(0));
        Ok(())
    }
}
