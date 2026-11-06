use acde_render::acgpu::Scene;
use smithay::utils::{Buffer as BufferCoord, Rectangle};

use acde_render::acgpu::fallback::{Backdrop, Effect, Px, Shadow};

pub type Rect = Rectangle<i32, BufferCoord>;

pub trait Pixels {
    fn covering(rect: [f32; 4]) -> Self;
    fn xywh(&self) -> [u32; 4];
    fn damaged(r: &acde_render::Rect) -> Self;
    fn grown(&self, m: i32) -> Self;
    /// as acgpu's pixel rectangle (both types are foreign here, so not `From`)
    fn px(&self) -> Px;
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

    fn px(&self) -> Px {
        Px { x: self.loc.x, y: self.loc.y, w: self.size.w, h: self.size.h }
    }
}

/// A layer of a page as acgpu composites it.
pub type Part = acde_render::acgpu::fallback::Part<Content>;

pub enum Content {
    Plane(Box<acde_render::Plane>),
    Layer(Box<acde_render::Layer>),
    Scene(Scene),
}

impl acde_render::acgpu::fallback::Content for Content {
    fn scene_for(&self, rect: Px) -> Scene {
        let [x, y, w, h] = rect.xywh().map(f64::from);
        let rect = acde_render::acgpu::fallback::vello::kurbo::Rect::new(x, y, x + w, y + h);
        match self {
            Self::Plane(plane) => plane.scene_for(rect),
            Self::Layer(layer) => layer.scene_for(rect),
            Self::Scene(scene) => scene.clone(),
        }
    }
}

impl Content {
    /// A layer with its backdrop, shadows and filter, as a part.
    fn part(layer: acde_render::Layer) -> Part {
        use acde_render::acgpu::FilterEffect;
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
        for (e, scale) in layer.filter.iter().flat_map(|f| f.filter.effects().iter().map(|e| (e, f.scale as f32))) {
            match e {
                FilterEffect::DropShadow(d) => shadows.push(Shadow { dx: d.dx * scale, dy: d.dy * scale, blur: d.std_deviation * scale, color: d.color.components }),
                FilterEffect::GaussianBlur(g) => effect.blur(g.std_deviation * scale),
                FilterEffect::ColorMatrix(m) => effect.matrix(m.0),
            }
        }
        let cover = |r: &acde_render::acgpu::fallback::vello::kurbo::Rect| Rect::damaged(&(*r).into());
        let bounds = Some(layer.filter.as_ref().map_or_else(|| layer.bounds.as_ref().map_or_else(Rect::default, cover), |f| cover(&f.bounds)));
        Part { content: Content::Layer(Box::new(layer)), backdrop, shadows, effect, bounds: bounds.map(|b| b.px()) }
    }
}

pub struct Sheet {
    pub parts: Vec<Part>,
    pub damage: Vec<Rect>,
}

impl Sheet {
    pub fn whole(scene: Scene, (w, h): (u32, u32)) -> Self {
        let all = Rect::from_size((w as i32, h as i32).into());
        let part = Part { content: Content::Scene(scene), backdrop: None, shadows: Vec::new(), effect: Effect::default(), bounds: Some(all.px()) };
        Self { parts: vec![part], damage: vec![all] }
    }
}

impl From<acde_render::Plane> for Sheet {
    fn from(plane: acde_render::Plane) -> Self {
        let damage = plane.damage_rects.iter().filter(|d| d.width > 0.0 && d.height > 0.0).map(Rect::damaged).collect();
        let bounds = plane.bounds.as_ref().map(|b| Rect::damaged(b).px());
        let parts = if plane.layers.is_empty() {
            vec![Part { content: Content::Plane(Box::new(plane)), backdrop: None, shadows: Vec::new(), effect: Effect::default(), bounds }]
        } else {
            plane.layers.into_iter().map(Content::part).collect()
        };
        Self { parts, damage }
    }
}
