use crate::webgl::consts::*;
use crate::webgl::objects::Id;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct StencilFace {
    pub func: u32,
    pub reference: i32,
    pub value_mask: u32,
    pub write_mask: u32,
    pub fail: u32,
    pub depth_fail: u32,
    pub pass: u32,
}

impl Default for StencilFace {
    fn default() -> Self {
        StencilFace { func: ALWAYS, reference: 0, value_mask: 0xffff_ffff, write_mask: 0xffff_ffff, fail: KEEP, depth_fail: KEEP, pass: KEEP }
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Unit {
    pub texture_2d: Option<Id>,
    pub cube: Option<Id>,
    pub texture_3d: Option<Id>,
    pub array: Option<Id>,
    pub sampler: Option<Id>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Generic {
    Float([f32; 4]),
    Int([i32; 4]),
    Uint([u32; 4]),
}

impl Generic {
    pub fn bytes(&self) -> [u8; 16] {
        let mut out = [0u8; 16];
        for i in 0..4 {
            let b = match self {
                Generic::Float(v) => v[i].to_le_bytes(),
                Generic::Int(v) => v[i].to_le_bytes(),
                Generic::Uint(v) => v[i].to_le_bytes(),
            };
            out[i * 4..i * 4 + 4].copy_from_slice(&b);
        }
        out
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct IndexedBuffer {
    pub buffer: Option<Id>,
    pub offset: u64,
    pub size: u64,
}

pub struct State {
    pub viewport: [i32; 4],
    pub scissor: [i32; 4],
    pub scissor_test: bool,
    pub clear_color: [f32; 4],
    pub clear_depth: f32,
    pub clear_stencil: i32,
    pub color_mask: [bool; 4],
    pub depth_mask: bool,
    pub blend: bool,
    pub blend_equation: [u32; 2],
    pub blend_func: [u32; 4],
    pub blend_color: [f32; 4],
    pub depth_test: bool,
    pub depth_func: u32,
    pub depth_range: [f32; 2],
    pub stencil_test: bool,
    pub stencil: [StencilFace; 2],
    pub cull_face: bool,
    pub cull_mode: u32,
    pub front_face: u32,
    pub polygon_offset_fill: bool,
    pub polygon_offset: [f32; 2],
    pub alpha_to_coverage: bool,
    pub sample_coverage: bool,
    pub sample_coverage_value: f32,
    pub sample_coverage_invert: bool,
    pub rasterizer_discard: bool,
    pub dither: bool,
    pub line_width: f32,
    pub pack_alignment: u32,
    pub unpack_alignment: u32,
    pub unpack_flip_y: bool,
    pub unpack_premultiply: bool,
    pub unpack_colorspace: u32,
    pub unpack_row_length: u32,
    pub unpack_image_height: u32,
    pub unpack_skip_pixels: u32,
    pub unpack_skip_rows: u32,
    pub unpack_skip_images: u32,
    pub pack_row_length: u32,
    pub pack_skip_pixels: u32,
    pub pack_skip_rows: u32,
    pub generate_mipmap_hint: u32,
    pub derivative_hint: u32,
    pub array_buffer: Option<Id>,
    pub vertex_array: Option<Id>,
    pub program: Option<Id>,
    pub active_texture: u32,
    pub units: Vec<Unit>,
    pub draw_framebuffer: Option<Id>,
    pub read_framebuffer: Option<Id>,
    pub renderbuffer: Option<Id>,
    pub copy_read: Option<Id>,
    pub copy_write: Option<Id>,
    pub pixel_pack: Option<Id>,
    pub pixel_unpack: Option<Id>,
    pub uniform_buffer: Option<Id>,
    pub uniform_buffers: Vec<IndexedBuffer>,
    pub transform_feedback_buffer: Option<Id>,
    pub transform_feedback: Option<Id>,
    pub generic: [Generic; 16],
    pub queries: [(u32, Option<Id>); 3],
    pub default_draw_buffer: u32,
    pub default_read_buffer: u32,
}

impl State {
    pub fn new(width: u32, height: u32, units: usize, uniform_bindings: usize) -> Self {
        let back = StencilFace::default();
        State {
            viewport: [0, 0, width as i32, height as i32],
            scissor: [0, 0, width as i32, height as i32],
            scissor_test: false,
            clear_color: [0.0; 4],
            clear_depth: 1.0,
            clear_stencil: 0,
            color_mask: [true; 4],
            depth_mask: true,
            blend: false,
            blend_equation: [FUNC_ADD; 2],
            blend_func: [ONE, ZERO, ONE, ZERO],
            blend_color: [0.0; 4],
            depth_test: false,
            depth_func: LESS,
            depth_range: [0.0, 1.0],
            stencil_test: false,
            stencil: [StencilFace::default(), back],
            cull_face: false,
            cull_mode: BACK,
            front_face: CCW,
            polygon_offset_fill: false,
            polygon_offset: [0.0; 2],
            alpha_to_coverage: false,
            sample_coverage: false,
            sample_coverage_value: 1.0,
            sample_coverage_invert: false,
            rasterizer_discard: false,
            dither: true,
            line_width: 1.0,
            pack_alignment: 4,
            unpack_alignment: 4,
            unpack_flip_y: false,
            unpack_premultiply: false,
            unpack_colorspace: BROWSER_DEFAULT_WEBGL,
            unpack_row_length: 0,
            unpack_image_height: 0,
            unpack_skip_pixels: 0,
            unpack_skip_rows: 0,
            unpack_skip_images: 0,
            pack_row_length: 0,
            pack_skip_pixels: 0,
            pack_skip_rows: 0,
            generate_mipmap_hint: DONT_CARE,
            derivative_hint: DONT_CARE,
            array_buffer: None,
            vertex_array: None,
            program: None,
            active_texture: 0,
            units: vec![Unit::default(); units],
            draw_framebuffer: None,
            read_framebuffer: None,
            renderbuffer: None,
            copy_read: None,
            copy_write: None,
            pixel_pack: None,
            pixel_unpack: None,
            uniform_buffer: None,
            uniform_buffers: vec![IndexedBuffer::default(); uniform_bindings],
            transform_feedback_buffer: None,
            transform_feedback: None,
            generic: [Generic::Float([0.0, 0.0, 0.0, 1.0]); 16],
            queries: [(ANY_SAMPLES_PASSED, None), (ANY_SAMPLES_PASSED_CONSERVATIVE, None), (TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN, None)],
            default_draw_buffer: BACK,
            default_read_buffer: BACK,
        }
    }
}
