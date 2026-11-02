use std::collections::HashMap;

use crate::error::{Error, Result};
use blitz_dom::{DocumentMutator, LocalName, Namespace, NodeId, QualName, ns};

#[derive(Default)]
pub(crate) struct Ids {
    nodes: Vec<NodeId>,
    slots: Vec<Slot>,
    live: u32,
    pub(crate) canvases: HashMap<u32, crate::canvas::Canvas>,
    pub(crate) gpu_canvases: std::collections::HashSet<u32>,
    pub(crate) images: HashMap<u32, (String, u8)>,
    pub(crate) templates: HashMap<NodeId, NodeId>,
    pub(crate) doctypes: HashMap<NodeId, Doctype>,
    pub(crate) forms: HashMap<NodeId, Form>,
    pub(crate) scrolls: HashMap<NodeId, (f64, f64)>,
    pub(crate) fresh: Vec<NodeId>,
    pub(crate) unpinned: Vec<NodeId>,
}

#[derive(Clone, Copy)]
struct Slot {
    node: NodeId,
    id: u32,
    pinned: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Doctype {
    pub(crate) name: String,
    pub(crate) public_id: String,
    pub(crate) system_id: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Form {
    pub(crate) value: Option<String>,
    pub(crate) checked: Option<bool>,
    pub(crate) selected: Option<i32>,
}

const NO_ID: u32 = u32::MAX;

impl Ids {
    fn track(&mut self, node: NodeId) -> u32 {
        let id = self.nodes.len() as u32;
        self.nodes.push(node);
        let index = node.as_u64() as u32 as usize;
        if self.slots.len() <= index {
            self.slots.resize(index + 1, Slot { node: NodeId::default(), id: NO_ID, pinned: false });
        }
        self.slots[index] = Slot { node, id, pinned: false };
        self.live += 1;
        id
    }

    pub(crate) fn id_of(&mut self, node: NodeId) -> u32 {
        match self.handle(node) {
            Some(id) => id,
            None => self.track(node),
        }
    }

    pub(crate) fn next(&self) -> u32 {
        self.nodes.len() as u32
    }

    pub(crate) fn node(&self, id: u32) -> Result<NodeId> {
        match self.nodes.get(id as usize) {
            Some(&node) if node != NodeId::default() => Ok(node),
            Some(_) => Err(Error::new(format!("node {id} was released"))),
            None => Err(Error::new(format!("unknown node {id}"))),
        }
    }

    fn slot(&self, node: NodeId) -> Option<&Slot> {
        self.slots
            .get(node.as_u64() as u32 as usize)
            .filter(|s| s.node == node && s.id != NO_ID)
    }

    pub(crate) fn forget(&mut self, node: NodeId) {
        self.templates.remove(&node);
        self.doctypes.remove(&node);
        self.forms.remove(&node);
        self.scrolls.remove(&node);
        let Some(id) = self.handle(node) else { return };
        self.slots[node.as_u64() as u32 as usize] = Slot { node: NodeId::default(), id: NO_ID, pinned: false };
        self.live -= 1;
        self.nodes[id as usize] = NodeId::default();
        self.canvases.remove(&id);
        self.gpu_canvases.remove(&id);
        self.images.remove(&id);
    }

    pub(crate) fn live(&self) -> u32 {
        self.live
    }

    pub(crate) fn handle(&self, node: NodeId) -> Option<u32> {
        self.slot(node).map(|s| s.id)
    }

    pub(crate) fn pin(&mut self, node: NodeId, pinned: bool) {
        let index = node.as_u64() as u32 as usize;
        if let Some(slot) = self.slots.get_mut(index).filter(|s| s.node == node && s.id != NO_ID) {
            slot.pinned = pinned;
        }
    }

    pub(crate) fn pinned(&self, node: NodeId) -> bool {
        self.slot(node).is_some_and(|s| s.pinned)
    }
}

pub(crate) struct Tree<'d> {
    pub(crate) m: DocumentMutator<'d>,
    pub(crate) ids: &'d mut Ids,
}

impl Tree<'_> {
    fn element(&mut self, ns: Namespace, tag: &str) -> NodeId {
        self.m
            .create_element(QualName::new(None, ns, tag.into()), Vec::new())
    }

    pub(crate) fn namespace(code: u8) -> Result<Namespace> {
        match code {
            0 => Ok(ns!(html)),
            1 => Ok(ns!(svg)),
            2 => Ok(ns!(mathml)),
            _ => Err(Error::new(format!("unknown namespace {code}"))),
        }
    }

    pub(crate) fn create_element_ns(&mut self, ns: Namespace, tag: &str) -> u32 {
        let html = ns == ns!(html);
        let tag = match html {
            true => tag.to_ascii_lowercase(),
            false => tag.to_owned(),
        };
        let node = self.element(ns, &tag);
        let id = self.ids.track(node);
        if html && tag == "img" {
            self.ids.images.insert(id, (String::new(), u8::MAX));
        }
        id
    }

    pub(crate) fn create_text(&mut self, text: &str) -> u32 {
        let node = self.m.create_text_node(text);
        self.ids.track(node)
    }

    pub(crate) fn set_attribute_qual(&mut self, id: u32, node: NodeId, name: QualName, value: &str) {
        self.reset_canvas(id, node, &name.local);
        self.m.set_attribute(node, name, value);
    }

    pub(crate) fn remove_attribute_qual(&mut self, id: u32, node: NodeId, name: QualName) {
        self.reset_canvas(id, node, &name.local);
        self.m.clear_attribute(node, name);
    }

    fn reset_canvas(&mut self, id: u32, node: NodeId, name: &LocalName) {
        if matches!(&**name, "width" | "height") && (self.ids.canvases.remove(&id).is_some() | self.ids.gpu_canvases.remove(&id)) {
            self.m.doc.set_canvas_picture(node, None);
        }
    }

    pub(crate) fn canvas_image(&mut self, id: u32, image: Option<peniko::ImageData>) -> Result<()> {
        use anyrender::PaintScene;
        let node = self.ids.node(id)?;
        if !self.m.doc.get_node(node).and_then(|n| n.element_data()).is_some_and(|e| &*e.name.local == "canvas") {
            return Err(Error::new(format!("node {id} is not a <canvas>")));
        }
        self.ids.canvases.remove(&id);
        let Some(image) = image.filter(|i| i.width > 0 && i.height > 0) else {
            self.ids.gpu_canvases.remove(&id);
            self.m.doc.set_canvas_picture(node, None);
            return Ok(());
        };
        let (width, height) = crate::canvas::Canvas::size_of(self.m.doc, node);
        let fit = kurbo::Affine::scale_non_uniform(width / f64::from(image.width), height / f64::from(image.height));
        let mut picture = anyrender::Scene::new();
        let brush = peniko::ImageBrush { image, sampler: peniko::ImageSampler::default() };
        picture.fill(peniko::Fill::NonZero, kurbo::Affine::IDENTITY, &anyrender::Paint::Image(brush), Some(fit), &kurbo::Rect::new(0.0, 0.0, width, height));
        self.ids.gpu_canvases.insert(id);
        self.m.doc.set_canvas_picture(node, Some(std::sync::Arc::new(picture)));
        Ok(())
    }

    pub(crate) fn canvas(&mut self, id: u32, ops: &[u8]) -> Result<()> {
        use crate::canvas::{Canvas, Source};
        let node = self.ids.node(id)?;
        if !self.m.doc.get_node(node).and_then(|n| n.element_data()).is_some_and(|e| &*e.name.local == "canvas") {
            return Err(Error::new(format!("node {id} is not a <canvas>")));
        }
        let size = Canvas::size_of(self.m.doc, node);
        let mut canvas = self.ids.canvases.remove(&id).filter(|c| c.size() == size).unwrap_or_else(|| Canvas::new(size));
        let ids = &*self.ids;
        let source = |doc: &blitz_dom::BaseDocument, kind: u8, source: u32| -> Option<Source> {
            match kind {
                0 => {
                    let image = doc.get_node(ids.node(source).ok()?)?.element_data()?.raster_image_data()?;
                    Some(Source::Raster(peniko::ImageBrush {
                        image: peniko::ImageData {
                            data: image.data.clone(),
                            format: peniko::ImageFormat::Rgba8,
                            width: image.width,
                            height: image.height,
                            alpha_type: peniko::ImageAlphaType::Alpha,
                        },
                        sampler: peniko::ImageSampler::default(),
                    }))
                }
                _ => ids.canvases.get(&source).map(Canvas::source),
            }
        };
        self.m.doc.set_canvas_picture(node, None);
        let result = canvas.run(self.m.doc, ops, &source);
        let picture = canvas.picture();
        self.ids.canvases.insert(id, canvas);
        self.m.doc.set_canvas_picture(node, Some(picture));
        result
    }
}
