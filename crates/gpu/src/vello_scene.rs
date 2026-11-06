use std::sync::Arc;

use crate::{Filter, Glyph, NormalizedCoord, PaintRef, PaintScene};
use kurbo::{Affine, Rect, Shape, Stroke, Vec2};
use peniko::{BlendMode, BrushRef, Color, Fill, FontData, StyleRef};

pub struct VelloScene<'s>(pub &'s mut vello::Scene);

impl<'s> From<&'s mut vello::Scene> for VelloScene<'s> {
    fn from(scene: &'s mut vello::Scene) -> Self {
        Self(scene)
    }
}

impl VelloScene<'_> {
    pub fn keep_atlas(scene: &mut vello::Scene) {
        let clear = peniko::Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops([Color::TRANSPARENT, Color::TRANSPARENT]);
        scene.fill(Fill::NonZero, Affine::IDENTITY, &clear, None, &Rect::new(0.0, 0.0, 1.0, 1.0));
    }
}

impl PaintScene for VelloScene<'_> {
    fn reset(&mut self) {
        self.0.reset();
    }

    fn push_layer(
        &mut self,
        fill: Fill,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        _filter: Option<Arc<Filter>>,
        _backdrop_filter: Option<Arc<Filter>>,
    ) {
        self.0.push_layer(fill, blend, alpha, transform, clip);
    }

    fn push_clip_layer(&mut self, fill: Fill, transform: Affine, clip: &impl Shape) {
        self.0.push_clip_layer(fill, transform, clip);
    }

    fn pop_layer(&mut self) {
        self.0.pop_layer();
    }

    fn stroke<'a>(&mut self, style: &Stroke, transform: Affine, paint: impl Into<PaintRef<'a>>, paint_transform: Option<Affine>, shape: &impl Shape) {
        self.0.stroke(style, transform, BrushRef::from(paint.into()), paint_transform, shape);
    }

    fn fill<'a>(&mut self, fill: Fill, transform: Affine, paint: impl Into<PaintRef<'a>>, paint_transform: Option<Affine>, shape: &impl Shape) {
        self.0.fill(fill, transform, BrushRef::from(paint.into()), paint_transform, shape);
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'s mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        embolden: Vec2,
        style: impl Into<StyleRef<'a>>,
        paint: impl Into<PaintRef<'a>>,
        paint_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        self.0
            .draw_glyphs(font)
            .font_size(font_size)
            .hint(hint)
            .normalized_coords(normalized_coords)
            .font_embolden(vello::FontEmbolden::new(kurbo::Diagonal2::new(embolden.x, embolden.y)))
            .brush(BrushRef::from(paint.into()))
            .brush_alpha(paint_alpha)
            .transform(transform)
            .glyph_transform(glyph_transform)
            .draw(style, glyphs.map(|g| vello::Glyph { id: g.id, x: g.x, y: g.y }));
    }

    fn draw_box_shadow(&mut self, transform: Affine, rect: Rect, color: Color, radius: f64, std_dev: f64) {
        self.0.draw_blurred_rounded_rect(transform, rect, color, radius, std_dev);
    }
}
