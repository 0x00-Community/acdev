use std::sync::Arc;

use crate::gpu::{PaintScene, Scene};
use blitz_dom::{BaseDocument, NodeId};
use kurbo::{Affine, Rect};

use crate::render::damage::Damage;
use crate::render::geometry::Geometry;

#[derive(Clone, Debug)]
pub struct Capture {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale: f64,
    pub scene: Scene,
}

impl Capture {
    const MAX_SIDE: f64 = 2048.0;

    pub(crate) fn of(doc: &BaseDocument, node: NodeId, scale: f64) -> Option<Self> {
        doc.get_node(node).filter(|n| n.is_element())?;
        let doc_scale = doc.viewport().scale_f64();
        let wanted = if scale.is_finite() && scale > 0.0 { scale } else { doc_scale };
        let zoom = Affine::scale(wanted / doc_scale);
        let mut scene = crate::gpu::Scene::new();
        blitz_paint::paint_element(&mut scene, doc, node, doc_scale, zoom);
        let everywhere = Rect::new(-1e9, -1e9, 1e9, 1e9);
        let bounds = Damage::painted_bounds(&scene.commands, everywhere)?.expand();

        let fit = (Self::MAX_SIDE / bounds.width().max(bounds.height())).min(1.0);
        let scale = wanted * fit;
        let pixel = |len: f64| ((len * fit).ceil() as u32).max(1);
        let (pixel_width, pixel_height) = (pixel(bounds.width()), pixel(bounds.height()));
        let place = Affine::scale(fit) * Affine::translate(-bounds.origin().to_vec2());
        let mut placed = Scene::new();
        placed.append_scene(scene, place);

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
            scene: placed,
        })
    }

    pub fn pixels(&self) -> Vec<u8> {
        let size = (self.pixel_width, self.pixel_height);
        crate::render::gpu::draw(self.scene.clone(), size, Affine::IDENTITY)
            .and_then(|image| crate::render::gpu::read(&image, [0, 0, size.0, size.1]))
            .unwrap_or_else(|| vec![0; (size.0 * size.1 * 4) as usize])
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.pixel_width + x) * 4) as usize;
        let rgba = self.pixels();
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    pub fn bitmap(width: u32, height: u32, rgba: Vec<u8>) -> Scene {
        let mut scene = Scene::new();
        let image = peniko::ImageData {
            data: peniko::Blob::new(Arc::new(rgba)),
            format: peniko::ImageFormat::Rgba8,
            alpha_type: peniko::ImageAlphaType::Alpha,
            width,
            height,
        };
        scene.draw_image(peniko::ImageBrush { image, sampler: peniko::ImageSampler::default() }.as_ref(), Affine::IDENTITY);
        scene
    }
}
