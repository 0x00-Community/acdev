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
            let reach = f64::from(Blur::of(blur).map_or(0, |b| b.margin()));
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
                let fills = table.window(only.window).is_some_and(|w| table.canvas(w.canvas).is_some_and(|c| w.rect.covers(&c.rect)));
                match opaque && fills && only.effect.is_none() && only.look.opacity == 1.0 && only.look.is_identity() && input.direct_buffer {
                    true => Route::Direct,
                    false => Route::Composite,
                }
            }
            _ => Route::Composite,
        };
        Self { damage: Self::merge(damage), route, layers }
    }

    fn merge(rects: Vec<Rect>) -> Vec<Rect> {
        let mut out = union_overlapping(rects.into_iter().filter(|r| !r.is_empty()).collect());
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
            out = union_overlapping(out);
        }
        out
    }

    pub fn layer(&self, window: WindowId) -> Option<&Layer> {
        self.layers.iter().find(|l| l.window == window)
    }
}

fn union_overlapping(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut out: Vec<Rect> = Vec::with_capacity(rects.len());
    while let Some(mut r) = rects.pop() {
        let mut i = 0;
        while i < out.len() {
            if r.intersects(&out[i]) {
                r = r.union(&out.swap_remove(i));
                i = 0;
            } else {
                i += 1;
            }
        }
        out.push(r);
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blur {
    pub levels: u32,
    pub offset: f32,
    pub mix: f32,
}

const MAX_LEVELS: u32 = 5;

const SPREAD: [(f32, f32); 8] = [(0.0, 0.92), (0.25, 1.17), (0.5, 2.32), (0.75, 4.07), (1.0, 6.82), (1.25, 9.93), (1.5, 13.985), (2.0, 24.31)];

const SWITCH: f32 = SPREAD[2].1;

impl Blur {
    pub fn of(sigma: f32) -> Option<Self> {
        if sigma.is_nan() || sigma <= 0.0 || sigma.is_infinite() {
            return None;
        }
        let variance = sigma * sigma;
        let least = SPREAD[0].1;
        if variance < least {
            return Some(Self { levels: 1, offset: 0.0, mix: variance / least });
        }
        let mut levels = 1;
        while levels < MAX_LEVELS && variance >= Self::chain(levels + 1) * SWITCH {
            levels += 1;
        }
        Some(Self { levels, offset: Self::offset_for(variance / Self::chain(levels)), mix: 1.0 })
    }

    pub fn sigma(&self) -> f32 {
        (Self::chain(self.levels) * Self::spread(self.offset) * self.mix).sqrt()
    }

    pub fn margin(&self) -> i32 {
        ((2 << self.levels) as f32 * self.offset.max(1.0)).ceil() as i32
    }

    fn chain(levels: u32) -> f32 {
        ((1u64 << (2 * levels)) - 1) as f32 / 3.0
    }

    fn spread(offset: f32) -> f32 {
        let at = SPREAD.windows(2).find(|w| offset <= w[1].0).unwrap_or(&SPREAD[SPREAD.len() - 2..]);
        let ((o0, s0), (o1, s1)) = (at[0], at[1]);
        s0 + (s1 - s0) * (offset - o0) / (o1 - o0)
    }

    fn offset_for(spread: f32) -> f32 {
        let at = SPREAD.windows(2).find(|w| spread <= w[1].1).unwrap_or(&SPREAD[SPREAD.len() - 2..]);
        let ((o0, s0), (o1, s1)) = (at[0], at[1]);
        (o0 + (o1 - o0) * (spread - s0) / (s1 - s0)).clamp(0.0, SPREAD[SPREAD.len() - 1].0)
    }
}
