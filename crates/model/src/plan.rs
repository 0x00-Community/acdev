use crate::{Look, Rect, WindowId, WindowTable};

pub const MAX_DAMAGE: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Effect {
    Backdrop { rect: Rect, radius: f32, blur: f32, saturate: f32, brightness: f32 },
}

#[derive(Clone, Debug, Default)]
pub struct Input {
    pub window: WindowId,
    pub opaque: Vec<Rect>,
    pub damage: Vec<Rect>,
    pub moved_from: Option<Rect>,
    pub look: Look,
    pub changed_look: Option<Look>,
    pub backdrop: Option<Effect>,
    pub direct_buffer: bool,
    pub restacked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Composite,
    Direct,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub window: WindowId,
    pub dst: Rect,
    pub clip: Rect,
    pub look: Look,
    pub effect: Option<Effect>,
    pub redraw: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompositePlan {
    pub damage: Vec<Rect>,
    pub route: Route,
    pub layers: Vec<Layer>,
}

impl CompositePlan {
    pub fn build(table: &WindowTable, inputs: &[Input], gone: &[Rect]) -> Self {
        let mut covered: Vec<Rect> = Vec::new();
        let mut layers = Vec::new();
        let mut damage = Vec::new();
        let mut owns: Vec<Vec<Rect>> = Vec::new();
        let mut skipped: Vec<(usize, Vec<Rect>)> = Vec::new();
        for input in inputs.iter().rev() {
            let Some(w) = table.window(input.window) else { continue };
            let Some(canvas) = table.canvas(w.canvas) else { continue };
            let screen = canvas.physical();
            let at = w.rect.scale(canvas.scale);
            let unit = canvas.scale;
            let dst = input.look.map(&at, unit, &at);
            let hidden = |r: &Rect| covered.iter().any(|c| c.covers(r));
            let mut own = Vec::new();
            own.extend(input.damage.iter().map(|d| input.look.map(&at, unit, &d.translate(at.x, at.y)).round_out()));
            if let Some(from) = input.moved_from.filter(|f| *f != w.rect) {
                let from = from.scale(unit);
                own.push(input.look.map(&from, unit, &from).round_out());
                own.push(dst.round_out());
            }
            if let Some(before) = input.changed_look.filter(|l| *l != input.look) {
                own.push(before.map(&at, unit, &at).round_out());
                own.push(dst.round_out());
            }
            if input.restacked {
                own.push(dst.round_out());
            }
            let own: Vec<Rect> = own.into_iter().filter_map(|d| d.intersect(&screen)).filter(|d| !hidden(d)).collect();
            damage.extend(own.iter().copied());
            let Some(clip) = dst.intersect(&screen).filter(|c| !hidden(c)) else {
                skipped.push((layers.len(), own));
                continue;
            };
            let effect = input.backdrop.map(|Effect::Backdrop { rect, radius, blur, saturate, brightness }| Effect::Backdrop {
                rect: input.look.map(&at, unit, &rect.translate(at.x, at.y)),
                radius,
                blur,
                saturate,
                brightness,
            });
            if input.look.is_identity() && input.look.opacity >= 1.0 {
                covered.extend(input.opaque.iter().filter_map(|o| o.translate(at.x, at.y).intersect(&clip)));
            }
            layers.push(Layer { window: input.window, dst, clip, look: input.look, effect, redraw: false });
            owns.push(own);
        }
        layers.reverse();
        owns.reverse();
        damage.extend(gone.iter().copied());
        let count = layers.len();
        for i in 0..count {
            let Some(Effect::Backdrop { rect, blur, .. }) = layers[i].effect else { continue };
            let reach = Self::blur_margin(blur);
            let sampled = Rect::new(rect.x - reach, rect.y - reach, rect.w + 2.0 * reach, rect.h + 2.0 * reach);
            let vacated = skipped.iter().filter(|(above, _)| i + above >= count).flat_map(|(_, own)| own);
            let under = owns[..i].iter().flatten().chain(vacated).chain(gone).any(|d| d.intersects(&sampled));
            if under {
                layers[i].redraw = true;
                damage.extend(rect.round_out().intersect(&layers[i].clip));
                owns[i].push(rect.round_out());
            }
        }
        let route = match (&layers[..], inputs.iter().find(|i| layers.first().is_some_and(|l| l.window == i.window))) {
            ([only], Some(input)) => {
                let opaque = input.opaque.iter().any(|o| o.translate(only.dst.x, only.dst.y).covers(&only.dst));
                match table.can_direct(only.window, opaque, only.effect.is_some(), only.look.opacity, only.look.is_identity(), input.direct_buffer) {
                    true => Route::Direct,
                    false => Route::Composite,
                }
            }
            _ => Route::Composite,
        };
        Self { damage: Self::merge(damage), route, layers }
    }

    pub fn blur_margin(blur: f32) -> f64 {
        let levels = ((blur.max(1.0) / 2.0).log2().ceil() as u32).clamp(1, 5);
        f64::from((2i32 << levels).min(64))
    }

    pub fn merge(rects: Vec<Rect>) -> Vec<Rect> {
        let mut out = crate::merge(rects.into_iter().filter(|r| !r.is_empty()).collect());
        while out.len() > MAX_DAMAGE {
            let (mut best, mut cost) = ((0, 1), f64::MAX);
            for i in 0..out.len() {
                for j in i + 1..out.len() {
                    let u = out[i].union(&out[j]);
                    let grown = u.w * u.h - out[i].w * out[i].h - out[j].w * out[j].h;
                    if grown < cost {
                        (best, cost) = ((i, j), grown);
                    }
                }
            }
            let joined = out[best.0].union(&out[best.1]);
            out.swap_remove(best.1);
            out[best.0] = joined;
            out = crate::merge(out);
        }
        out
    }

    pub fn layer(&self, window: WindowId) -> Option<&Layer> {
        self.layers.iter().find(|l| l.window == window)
    }
}
