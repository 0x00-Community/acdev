use crate::ColorMatrix;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Px {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Px {
    pub fn sized((w, h): (u32, u32)) -> Self {
        Self { x: 0, y: 0, w: w as i32, h: h as i32 }
    }

    pub fn covering([x, y, w, h]: [f32; 4]) -> Self {
        let (x0, y0) = (x.floor() as i32, y.floor() as i32);
        Self { x: x0, y: y0, w: (x + w).ceil() as i32 - x0, h: (y + h).ceil() as i32 - y0 }
    }

    pub fn grown(self, m: i32) -> Self {
        Self { x: self.x - m, y: self.y - m, w: self.w + 2 * m, h: self.h + 2 * m }
    }

    pub fn intersection(self, o: Self) -> Option<Self> {
        let (x0, y0) = (self.x.max(o.x), self.y.max(o.y));
        let (x1, y1) = ((self.x + self.w).min(o.x + o.w), (self.y + self.h).min(o.y + o.h));
        (x1 > x0 && y1 > y0).then_some(Self { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }

    pub fn union(self, o: Self) -> Self {
        let (x0, y0) = (self.x.min(o.x), self.y.min(o.y));
        let (x1, y1) = ((self.x + self.w).max(o.x + o.w), (self.y + self.h).max(o.y + o.h));
        Self { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    pub fn contains(self, o: Self) -> bool {
        o.x >= self.x && o.y >= self.y && o.x + o.w <= self.x + self.w && o.y + o.h <= self.y + self.h
    }

    pub fn area(self) -> i64 {
        i64::from(self.w.max(0)) * i64::from(self.h.max(0))
    }

    pub fn overlaps(self, o: Self) -> bool {
        self.intersection(o).is_some()
    }

    pub fn xywh(self) -> [u32; 4] {
        [self.x, self.y, self.w, self.h].map(|v| v.max(0) as u32)
    }

    pub fn of([x, y, w, h]: [u32; 4]) -> Self {
        Self { x: x as i32, y: y as i32, w: w as i32, h: h as i32 }
    }
}

pub fn reach(shadows: &[Shadow], effect: &Effect) -> i32 {
    let shadows = shadows.iter().map(|s| (s.dx.abs().max(s.dy.abs()) + 4.0 * s.blur).ceil() as i32).max().unwrap_or(0);
    shadows.max((3.0 * effect.blur).ceil() as i32)
}

#[derive(Clone, Copy, Debug)]
pub struct Backdrop {
    pub rect: [f32; 4],
    pub radius: f32,
    pub effect: Effect,
}

#[derive(Clone, Copy, Debug)]
pub struct Shadow {
    pub dx: f32,
    pub dy: f32,
    pub blur: f32,
    pub color: [f32; 4],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Effect {
    pub blur: f32,
    pub matrix: Option<[f32; 20]>,
}

impl Effect {
    pub fn is_none(&self) -> bool {
        self.blur <= 0.0 && self.matrix.is_none()
    }

    pub fn blur(&mut self, sigma: f32) {
        self.blur = self.blur.hypot(sigma);
    }

    pub fn matrix(&mut self, m: [f32; 20]) {
        let a = self.matrix.unwrap_or(ColorMatrix::IDENTITY.0);
        self.matrix = Some(std::array::from_fn(|k| {
            let (i, j) = (k / 5, k % 5);
            (0..4).map(|t| m[i * 5 + t] * a[t * 5 + j]).sum::<f32>() + if j == 4 { m[i * 5 + 4] } else { 0.0 }
        }));
    }

    pub fn columns(&self) -> ([f32; 16], [f32; 4]) {
        let m = self.matrix.unwrap_or(ColorMatrix::IDENTITY.0);
        (std::array::from_fn(|k| m[(k % 4) * 5 + k / 4]), [m[4], m[9], m[14], m[19]])
    }
}
