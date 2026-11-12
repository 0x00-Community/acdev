use acde_gpu::Scene;
use smithay::utils::{Buffer as BufferCoord, Rectangle};

use acde_gpu::{Backdrop, Effect, Px, Shadow};

pub type Rect = Rectangle<i32, BufferCoord>;

pub(crate) fn rect(p: Px) -> Rect {
    Rect::new((p.x, p.y).into(), (p.w, p.h).into())
}

pub(crate) fn px(r: &Rect) -> Px {
    Px { x: r.loc.x, y: r.loc.y, w: r.size.w, h: r.size.h }
}

fn damaged(r: &acde_render::Rect) -> Px {
    Px::covering([r.x as f32 - 1.0, r.y as f32 - 1.0, r.width as f32 + 2.0, r.height as f32 + 2.0])
}

pub type Part = acde_gpu::Part<Content>;

pub enum Content {
    Plane(Box<acde_render::Plane>),
    Layer(Box<acde_render::Layer>),
    Scene(Scene),
}

impl acde_gpu::Content for Content {
    fn scene_for(&self, rect: Px) -> Scene {
        let [x, y, w, h] = rect.xywh().map(f64::from);
        let rect = acde_gpu::kurbo::Rect::new(x, y, x + w, y + h);
        match self {
            Self::Plane(plane) => plane.drawing.scene_for(rect),
            Self::Layer(layer) => layer.drawing.scene_for(rect),
            Self::Scene(scene) => scene.clone(),
        }
    }
}

impl Content {
    /// A layer with its backdrop, shadows and filter, as a part.
    fn part(layer: acde_render::Layer) -> Part {
        use acde_gpu::FilterEffect;
        let backdrop = layer.backdrop.as_ref().map(|b| {
            let r = b.bounds.intersect(b.clip);
            Backdrop { rect: [r.x0 as f32, r.y0 as f32, r.width().max(0.0) as f32, r.height().max(0.0) as f32], radius: b.radius() as f32, effect: b.effect() }
        });
        let mut shadows = Vec::new();
        let mut effect = Effect::default();
        for (e, scale) in layer.filter.iter().flat_map(|f| f.filter.effects().iter().map(|e| (e, f.scale as f32))) {
            match e {
                FilterEffect::DropShadow(d) => {
                    shadows.push(Shadow { dx: d.dx * scale, dy: d.dy * scale, blur: d.std_deviation * scale, color: d.color.components })
                }
                FilterEffect::GaussianBlur(g) => effect.blur(g.std_deviation * scale),
                FilterEffect::ColorMatrix(m) => effect.matrix(m.0),
            }
        }
        let cover = |r: &acde_gpu::kurbo::Rect| damaged(&(*r).into());
        let bounds = layer.filter.as_ref().map_or_else(|| layer.bounds.as_ref().map_or_else(Px::default, cover), |f| cover(&f.bounds));
        Part { backdrop, shadows, effect, ..Part::plain(Content::Layer(Box::new(layer)), Some(bounds)) }
    }
}

pub struct Sheet {
    pub parts: Vec<Part>,
    pub damage: Vec<Rect>,
}

impl Sheet {
    pub fn whole(scene: Scene, size: (u32, u32)) -> Self {
        Self { parts: vec![Part::plain(Content::Scene(scene), Some(Px::sized(size)))], damage: vec![rect(Px::sized(size))] }
    }
}

impl From<acde_render::Plane> for Sheet {
    fn from(plane: acde_render::Plane) -> Self {
        let damage = plane.damage_rects.iter().filter(|d| d.width > 0.0 && d.height > 0.0).map(|d| rect(damaged(d))).collect();
        let bounds = plane.bounds.as_ref().map(damaged);
        let parts = if plane.layers.is_empty() {
            vec![Part::plain(Content::Plane(Box::new(plane)), bounds)]
        } else {
            plane.layers.into_iter().map(Content::part).collect()
        };
        Self { parts, damage }
    }
}
