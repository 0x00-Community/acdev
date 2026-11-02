use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{BaseDocument, NodeId};
use kurbo::{Affine, Rect};

use crate::damage::Damage;
use crate::geometry::Geometry;

#[derive(Clone, Debug)]
pub struct Capture {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale: f64,
    pub rgba: Vec<u8>,
}

impl Capture {
    const MAX_SIDE: f64 = 2048.0;

    pub(crate) fn of(doc: &BaseDocument, node: NodeId, scale: Option<f64>) -> Option<Self> {
        doc.get_node(node).filter(|n| n.is_element())?;
        let doc_scale = doc.viewport().scale_f64();
        let wanted = scale.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(doc_scale);
        let zoom = Affine::scale(wanted / doc_scale);
        let mut scene = anyrender::Scene::new();
        blitz_paint::paint_element(&mut scene, doc, node, doc_scale, zoom);
        let everywhere = Rect::new(-1e9, -1e9, 1e9, 1e9);
        let draw = Damage::flat_draw_rects(&scene.commands);
        let bounds = Damage::painted_bounds(&scene.commands, &draw, everywhere)?.expand();

        let fit = (Self::MAX_SIDE / bounds.width().max(bounds.height())).min(1.0);
        let scale = wanted * fit;
        let pixel = |len: f64| ((len * fit).ceil() as u32).max(1);
        let (pixel_width, pixel_height) = (pixel(bounds.width()), pixel(bounds.height()));
        let mut rgba = Vec::new();
        let place = Affine::scale(fit) * Affine::translate(-bounds.origin().to_vec2());
        VelloCpuImageRenderer::new(pixel_width, pixel_height)
            .render_to_vec(|p| p.append_scene(scene, place), &mut rgba);
        Self::unpremultiply(&mut rgba);

        let n = doc.get_node(node)?;
        let size = n.final_layout().size;
        let own = n.transform().as_deref().copied().unwrap_or_default();
        let border_box = Rect::new(0.0, 0.0, f64::from(size.width), f64::from(size.height));
        let border_box = (zoom * own * Affine::scale(doc_scale)).transform_rect_bbox(border_box);
        let client = Geometry { doc }.client_rect(node)?;
        Some(Self {
            x: client.x + (bounds.x0 - border_box.x0) / wanted,
            y: client.y + (bounds.y0 - border_box.y0) / wanted,
            width: bounds.width() / wanted,
            height: bounds.height() / wanted,
            pixel_width,
            pixel_height,
            scale,
            rgba,
        })
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.pixel_width + x) * 4) as usize;
        [self.rgba[i], self.rgba[i + 1], self.rgba[i + 2], self.rgba[i + 3]]
    }

    pub(crate) fn unpremultiply(rgba: &mut [u8]) {
        for px in rgba.as_chunks_mut::<4>().0 {
            let a = u32::from(px[3]);
            if a != 0 && a != 255 {
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
    }
}
