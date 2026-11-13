use crate::webgl::consts::*;
use crate::webgl::context::Context;

fn blend_factor(f: u32) -> bool {
    matches!(
        f,
        ZERO | ONE
            | SRC_COLOR
            | ONE_MINUS_SRC_COLOR
            | DST_COLOR
            | ONE_MINUS_DST_COLOR
            | SRC_ALPHA
            | ONE_MINUS_SRC_ALPHA
            | DST_ALPHA
            | ONE_MINUS_DST_ALPHA
            | CONSTANT_COLOR
            | ONE_MINUS_CONSTANT_COLOR
            | CONSTANT_ALPHA
            | ONE_MINUS_CONSTANT_ALPHA
            | SRC_ALPHA_SATURATE
    )
}

fn compare(f: u32) -> bool {
    (NEVER..=ALWAYS).contains(&f)
}

fn stencil_op(op: u32) -> bool {
    matches!(op, KEEP | ZERO | REPLACE | INCR | DECR | INVERT | INCR_WRAP | DECR_WRAP)
}

impl Context {
    fn capability(&mut self, cap: u32) -> Option<&mut bool> {
        let s = &mut self.state;
        Some(match cap {
            BLEND => &mut s.blend,
            CULL_FACE => &mut s.cull_face,
            DEPTH_TEST => &mut s.depth_test,
            DITHER => &mut s.dither,
            POLYGON_OFFSET_FILL => &mut s.polygon_offset_fill,
            SAMPLE_ALPHA_TO_COVERAGE => &mut s.alpha_to_coverage,
            SAMPLE_COVERAGE => &mut s.sample_coverage,
            SCISSOR_TEST => &mut s.scissor_test,
            STENCIL_TEST => &mut s.stencil_test,
            RASTERIZER_DISCARD if self.webgl2 => &mut s.rasterizer_discard,
            _ => return None,
        })
    }

    pub fn enable(&mut self, cap: u32, on: bool) {
        match self.capability(cap) {
            Some(v) => *v = on,
            None => self.error(INVALID_ENUM),
        }
    }

    pub fn is_enabled(&mut self, cap: u32) -> bool {
        match self.capability(cap) {
            Some(v) => *v,
            None => {
                self.error(INVALID_ENUM);
                false
            }
        }
    }

    pub fn viewport(&mut self, x: i32, y: i32, w: i32, h: i32) {
        if w < 0 || h < 0 {
            return self.error(INVALID_VALUE);
        }
        let max = self.limits.texture_size as i32;
        self.state.viewport = [x, y, w.min(max), h.min(max)];
    }

    pub fn scissor(&mut self, x: i32, y: i32, w: i32, h: i32) {
        if w < 0 || h < 0 {
            return self.error(INVALID_VALUE);
        }
        self.state.scissor = [x, y, w, h];
    }

    pub fn clear_color(&mut self, r: f32, g: f32, b: f32, a: f32) {
        self.state.clear_color = [r, g, b, a];
    }

    pub fn clear_depth(&mut self, d: f32) {
        self.state.clear_depth = d.clamp(0.0, 1.0);
    }

    pub fn clear_stencil(&mut self, s: i32) {
        self.state.clear_stencil = s;
    }

    pub fn color_mask(&mut self, r: bool, g: bool, b: bool, a: bool) {
        self.state.color_mask = [r, g, b, a];
    }

    pub fn depth_mask(&mut self, on: bool) {
        self.state.depth_mask = on;
    }

    pub fn depth_func(&mut self, f: u32) {
        if !compare(f) {
            return self.error(INVALID_ENUM);
        }
        self.state.depth_func = f;
    }

    pub fn depth_range(&mut self, near: f32, far: f32) {
        if near > far && self.webgl2 {
            return self.error(INVALID_OPERATION);
        }
        if near > far {
            return self.error(INVALID_OPERATION);
        }
        self.state.depth_range = [near.clamp(0.0, 1.0), far.clamp(0.0, 1.0)];
    }

    pub fn blend_color(&mut self, r: f32, g: f32, b: f32, a: f32) {
        self.state.blend_color = [r, g, b, a];
    }

    pub fn blend_equation(&mut self, rgb: u32, alpha: u32) {
        let ok = |e| {
            matches!(e, FUNC_ADD | FUNC_SUBTRACT | FUNC_REVERSE_SUBTRACT) || ((self.webgl2 || self.extension("EXT_blend_minmax")) && matches!(e, MIN | MAX))
        };
        if !ok(rgb) || !ok(alpha) {
            return self.error(INVALID_ENUM);
        }
        self.state.blend_equation = [rgb, alpha];
    }

    pub fn blend_func(&mut self, src_rgb: u32, dst_rgb: u32, src_alpha: u32, dst_alpha: u32) {
        if ![src_rgb, dst_rgb, src_alpha, dst_alpha].into_iter().all(blend_factor) {
            return self.error(INVALID_ENUM);
        }
        if !self.webgl2 && [dst_rgb, dst_alpha].contains(&SRC_ALPHA_SATURATE) {
            return self.error(INVALID_ENUM);
        }
        let constant_color = |f| matches!(f, CONSTANT_COLOR | ONE_MINUS_CONSTANT_COLOR);
        let constant_alpha = |f| matches!(f, CONSTANT_ALPHA | ONE_MINUS_CONSTANT_ALPHA);
        if (constant_color(src_rgb) && constant_alpha(dst_rgb)) || (constant_alpha(src_rgb) && constant_color(dst_rgb)) {
            return self.error(INVALID_OPERATION);
        }
        self.state.blend_func = [src_rgb, dst_rgb, src_alpha, dst_alpha];
    }

    pub fn stencil_func(&mut self, face: u32, func: u32, reference: i32, mask: u32) {
        if !compare(func) {
            return self.error(INVALID_ENUM);
        }
        for i in self.faces(face) {
            let f = &mut self.state.stencil[i];
            f.func = func;
            f.reference = reference;
            f.value_mask = mask;
        }
    }

    pub fn stencil_mask(&mut self, face: u32, mask: u32) {
        for i in self.faces(face) {
            self.state.stencil[i].write_mask = mask;
        }
    }

    pub fn stencil_op(&mut self, face: u32, fail: u32, depth_fail: u32, pass: u32) {
        if ![fail, depth_fail, pass].into_iter().all(stencil_op) {
            return self.error(INVALID_ENUM);
        }
        for i in self.faces(face) {
            let f = &mut self.state.stencil[i];
            f.fail = fail;
            f.depth_fail = depth_fail;
            f.pass = pass;
        }
    }

    fn faces(&mut self, face: u32) -> std::ops::Range<usize> {
        match face {
            FRONT => 0..1,
            BACK => 1..2,
            FRONT_AND_BACK => 0..2,
            _ => {
                self.error(INVALID_ENUM);
                0..0
            }
        }
    }

    pub fn cull_face(&mut self, mode: u32) {
        if !matches!(mode, FRONT | BACK | FRONT_AND_BACK) {
            return self.error(INVALID_ENUM);
        }
        self.state.cull_mode = mode;
    }

    pub fn front_face(&mut self, mode: u32) {
        if !matches!(mode, CW | CCW) {
            return self.error(INVALID_ENUM);
        }
        self.state.front_face = mode;
    }

    pub fn line_width(&mut self, w: f32) {
        if w <= 0.0 || w.is_nan() {
            return self.error(INVALID_VALUE);
        }
        self.state.line_width = w;
    }

    pub fn polygon_offset(&mut self, factor: f32, units: f32) {
        self.state.polygon_offset = [factor, units];
    }

    pub fn sample_coverage(&mut self, value: f32, invert: bool) {
        self.state.sample_coverage_value = value.clamp(0.0, 1.0);
        self.state.sample_coverage_invert = invert;
    }

    pub fn hint(&mut self, target: u32, mode: u32) {
        if !matches!(mode, DONT_CARE | FASTEST | NICEST) {
            return self.error(INVALID_ENUM);
        }
        match target {
            GENERATE_MIPMAP_HINT => self.state.generate_mipmap_hint = mode,
            FRAGMENT_SHADER_DERIVATIVE_HINT if self.webgl2 || self.extension("OES_standard_derivatives") => self.state.derivative_hint = mode,
            _ => self.error(INVALID_ENUM),
        }
    }

    pub fn pixel_store(&mut self, name: u32, value: i32) {
        let s = &mut self.state;
        let alignment = |v: i32| matches!(v, 1 | 2 | 4 | 8);
        let positive = value >= 0;
        match name {
            PACK_ALIGNMENT if alignment(value) => s.pack_alignment = value as u32,
            UNPACK_ALIGNMENT if alignment(value) => s.unpack_alignment = value as u32,
            PACK_ALIGNMENT | UNPACK_ALIGNMENT => self.error(INVALID_VALUE),
            UNPACK_FLIP_Y_WEBGL => s.unpack_flip_y = value != 0,
            UNPACK_PREMULTIPLY_ALPHA_WEBGL => s.unpack_premultiply = value != 0,
            UNPACK_COLORSPACE_CONVERSION_WEBGL if matches!(value as u32, NONE | BROWSER_DEFAULT_WEBGL) => s.unpack_colorspace = value as u32,
            UNPACK_COLORSPACE_CONVERSION_WEBGL => self.error(INVALID_ENUM),
            UNPACK_ROW_LENGTH | UNPACK_IMAGE_HEIGHT | UNPACK_SKIP_PIXELS | UNPACK_SKIP_ROWS | UNPACK_SKIP_IMAGES | PACK_ROW_LENGTH | PACK_SKIP_PIXELS
            | PACK_SKIP_ROWS
                if self.webgl2 =>
            {
                if !positive {
                    return self.error(INVALID_VALUE);
                }
                let v = value as u32;
                match name {
                    UNPACK_ROW_LENGTH => s.unpack_row_length = v,
                    UNPACK_IMAGE_HEIGHT => s.unpack_image_height = v,
                    UNPACK_SKIP_PIXELS => s.unpack_skip_pixels = v,
                    UNPACK_SKIP_ROWS => s.unpack_skip_rows = v,
                    UNPACK_SKIP_IMAGES => s.unpack_skip_images = v,
                    PACK_ROW_LENGTH => s.pack_row_length = v,
                    PACK_SKIP_PIXELS => s.pack_skip_pixels = v,
                    _ => s.pack_skip_rows = v,
                }
            }
            _ => self.error(INVALID_ENUM),
        }
    }

    pub fn active_texture(&mut self, unit: u32) {
        let n = self.state.units.len() as u32;
        match unit.checked_sub(TEXTURE0).filter(|u| *u < n) {
            Some(u) => self.state.active_texture = u,
            None => self.error(INVALID_ENUM),
        }
    }
}
