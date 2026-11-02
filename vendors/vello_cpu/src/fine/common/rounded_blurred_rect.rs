// Copyright 2025 the Vello Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Drawing blurred, rounded rectangles.
//!
//! Implementation is adapted from: <https://git.sr.ht/~raph/blurrr/tree/master/src/distfield.rs>.

use crate::fine::{NumericVec, PosExt, ShaderResultF32};
use crate::kurbo::{Point, Vec2};
use vello_common::encode::EncodedBlurredRoundedRectangle;
use vello_common::fearless_simd::{Simd, SimdBase, SimdFloat, f32x8, u8x16};

#[cfg(not(feature = "std"))]
use vello_common::kurbo::common::FloatFuncs as _;

#[derive(Debug)]
pub(crate) struct BlurredRoundedRectFiller<S: Simd> {
    r: f32x8<S>,
    g: f32x8<S>,
    b: f32x8<S>,
    a: f32x8<S>,
    invert: bool,
    alpha_calculator: AlphaCalculator<S>,
}

impl<S: Simd> BlurredRoundedRectFiller<S> {
    pub(crate) fn new(
        simd: S,
        rect: &EncodedBlurredRoundedRectangle,
        start_x: f64,
        start_y: f64,
    ) -> Self {
        simd.vectorize(
            #[inline(always)]
            || {
                let start_pos = rect.transform * Point::new(start_x, start_y);
                let color_components = rect.color.as_premul_f32().components;
                let r = f32x8::splat(simd, color_components[0]);
                let g = f32x8::splat(simd, color_components[1]);
                let b = f32x8::splat(simd, color_components[2]);
                let a = f32x8::splat(simd, color_components[3]);
                let simd_rect = SimdRoundedBlurredRect::new(rect, simd);
                let alpha_calculator = AlphaCalculator::new(
                    start_pos,
                    rect.x_advance,
                    rect.y_advance,
                    simd_rect,
                    simd,
                );

                Self {
                    alpha_calculator,
                    r,
                    g,
                    b,
                    a,
                    invert: rect.invert,
                }
            },
        )
    }
}

impl<S: Simd> Iterator for BlurredRoundedRectFiller<S> {
    type Item = ShaderResultF32<S>;

    #[inline(always)]
    fn next(&mut self) -> Option<Self::Item> {
        let mut next = self.alpha_calculator.next().unwrap();
        if self.invert {
            next = f32x8::splat(next.simd, 1.0) - next;
        }
        let r = self.r * next;
        let g = self.g * next;
        let b = self.b * next;
        let a = self.a * next;

        Some(ShaderResultF32 { r, g, b, a })
    }
}

impl<S: Simd> crate::fine::Painter for BlurredRoundedRectFiller<S> {
    fn paint_u8(mut self, buf: &mut [u8]) {
        self.a.simd.vectorize(
            #[inline(always)]
            || {
                for chunk in buf.chunks_exact_mut(64) {
                    let first = self.next().unwrap();
                    let simd = first.r.simd;
                    let second = self.next().unwrap();

                    let r = u8x16::from_f32(simd, simd.combine_f32x8(first.r, second.r));
                    let g = u8x16::from_f32(simd, simd.combine_f32x8(first.g, second.g));
                    let b = u8x16::from_f32(simd, simd.combine_f32x8(first.b, second.b));
                    let a = u8x16::from_f32(simd, simd.combine_f32x8(first.a, second.a));

                    simd.store_four_interleaved_u8x16(
                        [r, g, b, a],
                        (&mut chunk[..]).try_into().unwrap(),
                    );
                }
            },
        );
    }

    fn paint_f32(mut self, buf: &mut [f32]) {
        self.a.simd.vectorize(
            #[inline(always)]
            || {
                for chunk in buf.chunks_exact_mut(32) {
                    let [c1, c2] = self.next().unwrap().get();
                    c1[0]
                        .simd
                        .store_four_interleaved_f32x4(c1, (&mut chunk[..16]).try_into().unwrap());
                    c2[0]
                        .simd
                        .store_four_interleaved_f32x4(c2, (&mut chunk[16..]).try_into().unwrap());
                }
            },
        );
    }
}

#[derive(Debug)]
struct AlphaCalculator<S: Simd> {
    cur_pos: Point,
    x_advance: Vec2,
    y_advance: Vec2,
    r: SimdRoundedBlurredRect<S>,
    simd: S,
}

impl<S: Simd> AlphaCalculator<S> {
    fn new(
        start_pos: Point,
        x_advance: Vec2,
        y_advance: Vec2,
        r: SimdRoundedBlurredRect<S>,
        simd: S,
    ) -> Self {
        Self {
            cur_pos: start_pos,
            x_advance,
            y_advance,
            r,
            simd,
        }
    }
}

impl<S: Simd> Iterator for AlphaCalculator<S> {
    type Item = f32x8<S>;

    #[inline(always)]
    fn next(&mut self) -> Option<Self::Item> {
        let i = f32x8::splat_pos(
            self.simd,
            self.cur_pos.x as f32,
            self.x_advance.x as f32,
            self.y_advance.x as f32,
        );
        let j = f32x8::splat_pos(
            self.simd,
            self.cur_pos.y as f32,
            self.x_advance.y as f32,
            self.y_advance.y as f32,
        );
        let r = &self.r;

        let y = j - r.v1 * r.height;
        // Equivalent to r.r1 + y.abs() - (r.h * r.v1)
        let y0 = r.r1 - r.h.mul_sub(r.v1, y.abs());
        let y1 = y0.max(r.v0);

        let x = i - r.v1 * r.width;
        // Equivalent to r.r1 + x.abs() - (r.w * r.v1)
        let x0 = r.r1 - r.w.mul_sub(r.v1, x.abs());
        let x1 = x0.max(r.v0);
        let d_pos = x1.superellipse(y1, r.exponent, r.recip_exponent);
        let d_neg = x0.max(y0).min(r.v0);
        let d = d_pos + d_neg - r.r1;
        let z = r.scale
            * (f32x8::compute_erf7(self.simd, r.std_dev_inv * (r.min_edge + d))
                - f32x8::compute_erf7(self.simd, r.std_dev_inv * d));

        self.cur_pos += 2.0 * self.x_advance;

        Some(z)
    }
}

#[derive(Debug)]
struct SimdRoundedBlurredRect<S: Simd> {
    pub exponent: f32,
    pub recip_exponent: f32,
    pub scale: f32x8<S>,
    pub std_dev_inv: f32x8<S>,
    pub min_edge: f32x8<S>,
    pub w: f32x8<S>,
    pub h: f32x8<S>,
    pub width: f32x8<S>,
    pub height: f32x8<S>,
    pub r1: f32x8<S>,
    pub v0: f32x8<S>,
    pub v1: f32x8<S>,
}

impl<S: Simd> SimdRoundedBlurredRect<S> {
    fn new(encoded: &EncodedBlurredRoundedRectangle, s: S) -> Self {
        s.vectorize(
            #[inline(always)]
            || {
                let h = f32x8::splat(s, encoded.h);
                let w = f32x8::splat(s, encoded.w);
                let width = f32x8::splat(s, encoded.width);
                let height = f32x8::splat(s, encoded.height);
                let r1 = f32x8::splat(s, encoded.r1);
                let exponent = encoded.exponent;
                let recip_exponent = encoded.recip_exponent;
                let scale = f32x8::splat(s, encoded.scale);
                let min_edge = f32x8::splat(s, encoded.min_edge);
                let std_dev_inv = f32x8::splat(s, encoded.std_dev_inv);
                let v0 = f32x8::splat(s, 0.0);
                let v1 = f32x8::splat(s, 0.5);

                Self {
                    exponent,
                    recip_exponent,
                    scale,
                    std_dev_inv,
                    min_edge,
                    w,
                    v0,
                    v1,
                    h,
                    width,
                    height,
                    r1,
                }
            },
        )
    }
}

trait FloatExt<S: Simd> {
    // See https://raphlinus.github.io/audio/2018/09/05/sigmoid.html for a little
    // explanation of this approximation to the erf function.
    /// Approximate the erf function.
    fn compute_erf7(simd: S, x: Self) -> Self;
    /// `(self^e + y^e)^(1/e)` per lane (`recip` is `1/e`); both are ≥ 0
    fn superellipse(self, y: Self, e: f32, recip: f32) -> Self;
}

impl<S: Simd> FloatExt<S> for f32x8<S> {
    #[inline(always)]
    fn compute_erf7(simd: S, x: Self) -> Self {
        // Clamp `x`, because for large `x` the terms here become `inf`, causing the result to be 0 or
        // `NaN`. This clamping doesn't lose any information, because `erf(±10) ≈ 1` well within `f64`
        // machine precision, let alone `f32`.
        let x = x.max(Self::splat(simd, -10.0)).min(Self::splat(simd, 10.0));
        let x = x * Self::splat(simd, core::f32::consts::FRAC_2_SQRT_PI);
        let xx = x * x;
        let p1 = Self::splat(simd, 0.0104).mul_add(xx, Self::splat(simd, 0.03395));
        let p2 = p1.mul_add(xx, Self::splat(simd, 0.24295));
        let p3 = x * xx;
        let x = p2.mul_add(p3, x);
        let denom = x.mul_add(x, Self::splat(simd, 1.0)).sqrt();
        x / denom
    }

    // acrender: upstream computed `(x.powf(e) + y.powf(e)).powf(1 / e)` for every pixel, 3 scalar libm powf per
    // lane, and that was 80% of the CPU rasterizer's time on a window's box-shadow. Outside the corners one of x, y
    // is 0 and the norm is the other one exactly (0^e = 0, (v^e)^(1/e) = v); in the corners it is
    // `hi * (1 + (lo / hi)^e)^(1/e)` with a cheap log2 / exp2 (within 2e-4 px of f64 powf for x, y ≤ 300, e ≤ 10).
    #[inline(always)]
    fn superellipse(mut self, y: Self, e: f32, recip: f32) -> Self {
        for i in 0..8 {
            self[i] = superellipse(self[i], y[i], e, recip);
        }
        self
    }
}

/// acrender: `(x^e + y^e)^(1/e)` for x, y ≥ 0 (see `superellipse` above)
#[inline(always)]
fn superellipse(x: f32, y: f32, e: f32, recip: f32) -> f32 {
    let (hi, lo) = (x.max(y), x.min(y));
    if lo == 0.0 {
        return hi;
    }
    let t = exp2(e * log2(lo / hi));
    hi * exp2(recip * log2(1.0 + t))
}

/// acrender: log2 of a positive normal f32: exponent plus ln of the mantissa in [√½, √2) by the atanh series
/// (error below 1e-7)
#[inline(always)]
fn log2(v: f32) -> f32 {
    let bits = v.to_bits();
    let big = (bits & 0x007f_ffff) > 0x0035_04f3;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + i32::from(big);
    let m = f32::from_bits((bits & 0x007f_ffff) | if big { 0x3f00_0000 } else { 0x3f80_0000 });
    let y = (m - 1.0) / (m + 1.0);
    let y2 = y * y;
    let ln = 2.0 * y * (1.0 + y2 * (1.0 / 3.0 + y2 * (1.0 / 5.0 + y2 * (1.0 / 7.0))));
    exponent as f32 + ln * core::f32::consts::LOG2_E
}

/// acrender: 2^x, 0 below 2^-126: 2^round(x) from the exponent bits times a Taylor series for the rest
/// (relative error below 2e-7)
#[inline(always)]
fn exp2(x: f32) -> f32 {
    let x = x.max(-127.0);
    let n = x.round();
    let f = (x - n) * core::f32::consts::LN_2;
    let p = 1.0 + f * (1.0 + f * (0.5 + f * (1.0 / 6.0 + f * (1.0 / 24.0 + f * (1.0 / 120.0 + f * (1.0 / 720.0))))));
    p * f32::from_bits(((n as i32 + 127).max(0) as u32) << 23)
}

// acrender: the fast norm against f64 powf over the range box-shadows use
#[cfg(test)]
mod acrender_tests {
    #[test]
    fn superellipse_matches_powf() {
        let mut worst = 0f64;
        for e in [2.0f32, 2.5, 3.7, 5.0, 7.3, 10.0] {
            for xi in 0..=300 {
                for yi in 0..=300 {
                    let (x, y) = (xi as f32 * 1.0, yi as f32 * 0.997);
                    let want = ((x as f64).powf(e as f64) + (y as f64).powf(e as f64)).powf(1.0 / e as f64);
                    let got = super::superellipse(x, y, e, 1.0 / e) as f64;
                    worst = worst.max((got - want).abs());
                }
            }
        }
        assert!(worst < 2e-4, "worst {worst}");
    }
}
