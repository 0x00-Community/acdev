#![allow(dead_code)]

use std::ops::Deref;

use acde_render::{
    Capture, CaretPosition, Document, Dom, Error, Metrics, NONE, Ns, Options, Rect, RenderHandle, Result,
    Stats, TextMetrics,
};

pub struct Doc {
    document: Document,
    pub dom: Dom,
}

#[derive(Clone)]
pub struct Handle {
    handle: RenderHandle,
    dom: Dom,
}

impl Deref for Handle {
    type Target = RenderHandle;

    fn deref(&self) -> &RenderHandle {
        &self.handle
    }
}

impl Handle {
    pub fn commit(&self) -> u64 {
        self.dom.commit();
        self.handle.commit()
    }
}

fn rect([x, y, width, height]: [f64; 4]) -> Rect {
    Rect { x, y, width, height }
}

impl Doc {
    pub fn new(width: u32, height: u32, scale: f32, options: &Options) -> Result<Self> {
        let document = Document::new(width, height, scale, options)?;
        let dom = document.dom();
        Ok(Self { document, dom })
    }

    pub fn root(&self) -> Result<u32> {
        Ok(0)
    }

    pub fn handle(&self) -> Handle {
        Handle { handle: self.document.handle(), dom: Clone::clone(&self.dom) }
    }

    pub fn commit(&self) -> u64 {
        self.handle().commit()
    }

    pub fn sync(&self) {
        self.document.sync()
    }

    pub fn scene(&self) -> acde_render::acgpu::Scene {
        self.document.scene()
    }

    fn pinned(&self, id: Result<u32>) -> Result<u32> {
        let id = id?;
        self.dom.pin(id)?;
        Ok(id)
    }

    pub fn create_element(&self, tag: &str) -> Result<u32> {
        self.create_element_ns(0, tag)
    }

    pub fn create_element_ns(&self, ns: u8, tag: &str) -> Result<u32> {
        let ns = match ns {
            1 => Ns::Svg,
            2 => Ns::MathMl,
            _ => Ns::Html,
        };
        self.pinned(self.dom.create_element(ns, tag))
    }

    pub fn create_text(&self, text: &str) -> Result<u32> {
        self.pinned(self.dom.create_text(text))
    }

    pub fn set_attribute(&self, id: u32, name: &str, value: &str) -> Result<()> {
        self.dom.set_attribute(id, name, value).map(drop)
    }

    pub fn remove_attribute(&self, id: u32, name: &str) -> Result<()> {
        self.dom.remove_attribute(id, name).map(drop)
    }

    pub fn set_text(&self, id: u32, text: &str) -> Result<()> {
        self.dom.set_data(id, text)
    }

    pub fn append_child(&self, parent: u32, child: u32) -> Result<()> {
        self.dom.insert_before(parent, child, NONE)
    }

    pub fn insert_before(&self, parent: u32, child: u32, reference: Option<u32>) -> Result<()> {
        self.dom.insert_before(parent, child, reference.unwrap_or(NONE))
    }

    pub fn remove(&self, id: u32) -> Result<()> {
        self.dom.remove(id)
    }

    pub fn release(&self, id: u32) -> Result<()> {
        if id == 0 {
            return Err(Error("cannot release <html>".into()));
        }
        let pinned = match self.dom.pinned_in(id) {
            Ok(pinned) => pinned,
            Err(e) if e.0.contains("released") || e.0.contains("gone") => return Ok(()),
            Err(e) => return Err(e),
        };
        self.dom.remove(id)?;
        for node in pinned {
            self.dom.unpin(node)?;
        }
        self.dom.commit();
        Ok(())
    }

    pub fn add_stylesheet(&self, css: &str) -> Result<()> {
        let style = self.create_element("style")?;
        let text = self.create_text(css)?;
        self.append_child(style, text)?;
        self.append_child(0, style)
    }

    pub fn rect(&self, id: u32) -> Result<Rect> {
        self.dom.rect(id).map(rect)
    }

    pub fn metrics(&self, id: u32) -> Result<Metrics> {
        Ok(self.dom.metrics(id)?.unwrap_or_default())
    }

    pub fn hit_test(&self, x: f32, y: f32) -> Result<Option<u32>> {
        Ok(self.dom.hit_test(x.into(), y.into()))
    }

    pub fn caret_rect(&self, id: u32, offset: u32) -> Result<Rect> {
        self.dom.caret_rect(id, offset).map(rect)
    }

    pub fn caret_from_point(&self, x: f32, y: f32) -> Result<Option<CaretPosition>> {
        Ok(self.dom.caret_from_point(x.into(), y.into()))
    }

    pub fn text_rects(&self, id: u32, start: u32, end: u32) -> Result<Vec<Rect>> {
        Ok(self.dom.text_rects(id, start, end)?.into_iter().map(rect).collect())
    }

    pub fn scroll_by(&self, id: u32, dx: f64, dy: f64) -> Result<()> {
        let m = self.metrics(id)?;
        self.dom.scroll_to(id, m.scroll_left + dx, m.scroll_top + dy, false)
    }

    pub fn resize(&self, width: u32, height: u32, scale: f32) -> Result<()> {
        self.dom.resize(width, height, scale);
        Ok(())
    }

    pub fn stats(&self) -> Result<Stats> {
        Ok(self.dom.stats())
    }

    pub fn capture(&self, id: u32, scale: Option<f64>) -> Result<Option<Capture>> {
        self.dom.capture(id, scale.unwrap_or(0.0))
    }

    pub fn canvas(&self, id: u32, commands: &[u8]) -> Result<()> {
        self.dom.canvas(id, commands)
    }

    pub fn measure_text(&self, id: u32, font: &str, text: &str) -> Result<TextMetrics> {
        self.dom.measure_text(id, font, text)
    }

    pub fn to_data_url(&self, id: u32) -> Result<String> {
        self.dom.to_data_url(id, "image/png")
    }

    pub fn get_image_data(&self, id: u32, x: f64, y: f64, width: f64, height: f64) -> Result<Vec<u8>> {
        self.dom.get_image_data(id, x, y, width, height)
    }
}

pub fn damage(frame: &acde_render::Frame) -> Rect {
    frame.plane.damage
}
