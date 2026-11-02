use acde_render::anyrender::Scene;
use smithay::utils::{Buffer as BufferCoord, Rectangle};

use crate::compose::{Backdrop, Effect, Shadow};

pub type Rect = Rectangle<i32, BufferCoord>;

pub trait Pixels {
    fn covering(rect: [f32; 4]) -> Self;
    fn xywh(&self) -> [u32; 4];
    fn damaged(r: &acde_render::Rect) -> Self;
    fn grown(&self, m: i32) -> Self;
}

impl Pixels for Rect {
    fn covering([x, y, w, h]: [f32; 4]) -> Self {
        let (x0, y0) = (x.floor() as i32, y.floor() as i32);
        Rect::new((x0, y0).into(), ((x + w).ceil() as i32 - x0, (y + h).ceil() as i32 - y0).into())
    }

    fn xywh(&self) -> [u32; 4] {
        [self.loc.x, self.loc.y, self.size.w, self.size.h].map(|v| v.max(0) as u32)
    }

    fn damaged(r: &acde_render::Rect) -> Self {
        Self::covering([r.x as f32 - 1.0, r.y as f32 - 1.0, r.width as f32 + 2.0, r.height as f32 + 2.0])
    }

    fn grown(&self, m: i32) -> Self {
        Rect::new((self.loc.x - m, self.loc.y - m).into(), (self.size.w + 2 * m, self.size.h + 2 * m).into())
    }
}


pub struct Part {
    pub content: Content,
    pub backdrop: Option<Backdrop>,
    pub shadows: Vec<Shadow>,
    pub effect: Effect,
    pub bounds: Option<Rect>,
}

pub enum Content {
    Plane(Box<acde_render::Plane>),
    Layer(Box<acde_render::Layer>),
}

impl Content {
    pub fn scene_for(&self, rect: Rect) -> Scene {
        let [x, y, w, h] = rect.xywh().map(f64::from);
        let rect = vello::kurbo::Rect::new(x, y, x + w, y + h);
        match self {
            Self::Plane(plane) => plane.scene_for(rect),
            Self::Layer(layer) => layer.scene_for(rect),
        }
    }
}

impl From<acde_render::Layer> for Part {
    fn from(layer: acde_render::Layer) -> Self {
        use acde_render::anyrender::filters::FilterEffect;
        let backdrop = layer.backdrop.as_ref().map(|b| {
            let r = b.bounds.intersect(b.clip);
            Backdrop {
                rect: [r.x0 as f32, r.y0 as f32, r.width().max(0.0) as f32, r.height().max(0.0) as f32],
                radius: b.radius() as f32,
                blur: b.blur() as f32,
                saturate: b.saturate(),
                brightness: b.brightness(),
            }
        });
        let mut shadows = Vec::new();
        let mut effect = Effect::default();
        for (n, scale) in layer.filter.iter().flat_map(|f| f.filter.nodes().iter().map(|n| (n, f.scale as f32))) {
            match &n.effect {
                FilterEffect::DropShadow(d) => shadows.push(Shadow { dx: d.dx * scale, dy: d.dy * scale, blur: d.std_deviation * scale, color: d.color.components }),
                FilterEffect::GaussianBlur(g) => effect.blur(g.std_deviation * scale),
                FilterEffect::ColorMatrix(m) => effect.matrix(m.0),
                _ => {}
            }
        }
        let cover = |r: &vello::kurbo::Rect| Rect::covering([r.x0 as f32 - 1.0, r.y0 as f32 - 1.0, r.width() as f32 + 2.0, r.height() as f32 + 2.0]);
        let bounds = Some(layer.filter.as_ref().map_or_else(|| layer.bounds.as_ref().map_or_else(Rect::default, cover), |f| cover(&f.bounds)));
        Self { content: Content::Layer(Box::new(layer)), backdrop, shadows, effect, bounds }
    }
}

pub struct Sheet {
    pub parts: Vec<Part>,
    pub damage: Option<Vec<Rect>>,
}

impl Sheet {
    pub fn damaged(rects: &[acde_render::Rect]) -> Option<Vec<Rect>> {
        Some(rects.iter().filter(|d| d.width > 0.0 && d.height > 0.0).map(Rect::damaged).collect())
    }
}

impl From<acde_render::Plane> for Sheet {
    fn from(plane: acde_render::Plane) -> Self {
        let damage = Self::damaged(&plane.damage_rects);
        let bounds = plane.bounds.as_ref().map(Rect::damaged);
        let parts = if plane.layers.is_empty() {
            vec![Part { content: Content::Plane(Box::new(plane)), backdrop: None, shadows: Vec::new(), effect: Effect::default(), bounds }]
        } else {
            plane.layers.into_iter().map(Part::from).collect()
        };
        Self { parts, damage }
    }
}

