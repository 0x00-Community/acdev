use crate::Rect;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub opacity: f32,
    pub scale: f64,
    pub dx: f64,
    pub dy: f64,
}

impl Default for Look {
    fn default() -> Self {
        Self { opacity: 1.0, scale: 1.0, dx: 0.0, dy: 0.0 }
    }
}

impl Look {
    pub fn is_identity(&self) -> bool {
        self.scale == 1.0 && self.dx == 0.0 && self.dy == 0.0
    }

    pub fn map(&self, at: &Rect, unit: f64, r: &Rect) -> Rect {
        let (cx, cy) = (at.x + at.w / 2.0, at.y + at.h / 2.0);
        Rect::new((r.x - cx) * self.scale + cx + self.dx * unit, (r.y - cy) * self.scale + cy + self.dy * unit, r.w * self.scale, r.h * self.scale)
    }

    pub fn unmap(&self, at: &Rect, unit: f64, x: f64, y: f64) -> (f64, f64) {
        let (cx, cy) = (at.x + at.w / 2.0, at.y + at.h / 2.0);
        let scale = if self.scale.abs() < 1e-6 { 1e-6 } else { self.scale };
        ((x - cx - self.dx * unit) / scale + cx, (y - cy - self.dy * unit) / scale + cy)
    }

    fn mix(&self, to: &Look, t: f64) -> Look {
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        Look { opacity: lerp(self.opacity.into(), to.opacity.into()) as f32, scale: lerp(self.scale, to.scale), dx: lerp(self.dx, to.dx), dy: lerp(self.dy, to.dy) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Easing {
    Linear,
    Ease,
    EaseIn,
    EaseOut,
    EaseInOut,
}

impl std::str::FromStr for Easing {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "linear" => Easing::Linear,
            "ease" => Easing::Ease,
            "ease-in" => Easing::EaseIn,
            "ease-out" => Easing::EaseOut,
            "ease-in-out" => Easing::EaseInOut,
            other => return Err(format!("unknown easing {other}")),
        })
    }
}

impl Easing {
    fn points(self) -> [f64; 4] {
        match self {
            Easing::Linear => [0.0, 0.0, 1.0, 1.0],
            Easing::Ease => [0.25, 0.1, 0.25, 1.0],
            Easing::EaseIn => [0.42, 0.0, 1.0, 1.0],
            Easing::EaseOut => [0.0, 0.0, 0.58, 1.0],
            Easing::EaseInOut => [0.42, 0.0, 0.58, 1.0],
        }
    }

    pub fn at(self, x: f64) -> f64 {
        let [x1, y1, x2, y2] = self.points();
        let bezier = |a: f64, b: f64, t: f64| 3.0 * a * t * (1.0 - t).powi(2) + 3.0 * b * t * t * (1.0 - t) + t.powi(3);
        let x = x.clamp(0.0, 1.0);
        let (mut lo, mut hi) = (0.0, 1.0);
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            match bezier(x1, x2, mid) < x {
                true => lo = mid,
                false => hi = mid,
            }
        }
        bezier(y1, y2, (lo + hi) / 2.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub from: Look,
    pub to: Look,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub easing: Easing,
}

impl Transition {
    pub fn at(&self, now_ms: f64) -> (Look, bool) {
        let t = match self.duration_ms > 0.0 {
            true => (now_ms - self.start_ms) / self.duration_ms,
            false => f64::from(u8::from(now_ms >= self.start_ms)),
        };
        match t >= 1.0 {
            true => (self.to, true),
            false => (self.from.mix(&self.to, self.easing.at(t.max(0.0))), false),
        }
    }
}
