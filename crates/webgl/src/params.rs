use crate::consts::*;
use crate::context::Context;
use crate::objects::Id;

pub enum Param {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Ints(Vec<i32>),
    Uints(Vec<u32>),
    Floats(Vec<f32>),
    Bools(Vec<bool>),
    Object(&'static str, Id),
}

impl Context {
    pub fn parameter(&mut self, name: u32) -> Param {
        use Param::*;
        let s = &self.state;
        let l = self.limits;
        let webgl2 = self.webgl2;
        let obj = |kind, id: Option<Id>| id.map_or(Null, |id| Object(kind, id));
        let unit = s.units[s.active_texture as usize];
        let fb_bits = |this: &mut Context, which: usize| -> i64 {
            match this.state.draw_framebuffer {
                None => match which {
                    0..=2 => 8,
                    3 => {
                        if this.attrs.alpha {
                            8
                        } else {
                            0
                        }
                    }
                    4 => {
                        if this.attrs.depth {
                            24
                        } else {
                            0
                        }
                    }
                    _ => {
                        if this.attrs.stencil {
                            8
                        } else {
                            0
                        }
                    }
                },
                Some(fb) => {
                    let Some(f) = this.framebuffer(fb) else { return 0 };
                    let a = if which < 4 {
                        f.color[0]
                    } else if which == 4 {
                        f.depth
                    } else {
                        f.stencil
                    };
                    a.and_then(|a| this.view_of(a)).map_or(0, |v| i64::from(v.format.bits[which]))
                }
            }
        };
        match name {
            ACTIVE_TEXTURE => Int(i64::from(TEXTURE0 + s.active_texture)),
            ALIASED_LINE_WIDTH_RANGE | ALIASED_POINT_SIZE_RANGE => Floats(vec![1.0, 1.0]),
            ALPHA_BITS => Int(fb_bits(self, 3)),
            RED_BITS => Int(fb_bits(self, 0)),
            GREEN_BITS => Int(fb_bits(self, 1)),
            BLUE_BITS => Int(fb_bits(self, 2)),
            DEPTH_BITS => Int(fb_bits(self, 4)),
            STENCIL_BITS => Int(fb_bits(self, 5)),
            ARRAY_BUFFER_BINDING => obj("buffer", s.array_buffer),
            ELEMENT_ARRAY_BUFFER_BINDING => obj("buffer", self.vao().element),
            BLEND => Bool(s.blend),
            BLEND_COLOR => Floats(s.blend_color.to_vec()),
            BLEND_DST_ALPHA => Int(i64::from(s.blend_func[3])),
            BLEND_DST_RGB => Int(i64::from(s.blend_func[1])),
            BLEND_SRC_ALPHA => Int(i64::from(s.blend_func[2])),
            BLEND_SRC_RGB => Int(i64::from(s.blend_func[0])),
            BLEND_EQUATION_RGB => Int(i64::from(s.blend_equation[0])),
            BLEND_EQUATION_ALPHA => Int(i64::from(s.blend_equation[1])),
            COLOR_CLEAR_VALUE => Floats(s.clear_color.to_vec()),
            COLOR_WRITEMASK => Bools(s.color_mask.to_vec()),
            COMPRESSED_TEXTURE_FORMATS => Uints(self.compressed_formats()),
            CULL_FACE => Bool(s.cull_face),
            CULL_FACE_MODE => Int(i64::from(s.cull_mode)),
            CURRENT_PROGRAM => obj("program", s.program),
            DEPTH_CLEAR_VALUE => Float(f64::from(s.clear_depth)),
            DEPTH_FUNC => Int(i64::from(s.depth_func)),
            DEPTH_RANGE => Floats(s.depth_range.to_vec()),
            DEPTH_TEST => Bool(s.depth_test),
            DEPTH_WRITEMASK => Bool(s.depth_mask),
            DITHER => Bool(s.dither),
            FRAMEBUFFER_BINDING => obj("framebuffer", s.draw_framebuffer),
            FRONT_FACE => Int(i64::from(s.front_face)),
            GENERATE_MIPMAP_HINT => Int(i64::from(s.generate_mipmap_hint)),
            LINE_WIDTH => Float(f64::from(s.line_width)),
            MAX_COMBINED_TEXTURE_IMAGE_UNITS => Int(i64::from(l.units * 2)),
            MAX_CUBE_MAP_TEXTURE_SIZE | MAX_TEXTURE_SIZE | MAX_RENDERBUFFER_SIZE => Int(i64::from(l.texture_size)),
            MAX_FRAGMENT_UNIFORM_VECTORS | MAX_VERTEX_UNIFORM_VECTORS => Int(i64::from(l.uniform_vectors)),
            MAX_TEXTURE_IMAGE_UNITS | MAX_VERTEX_TEXTURE_IMAGE_UNITS => Int(i64::from(l.units)),
            MAX_VARYING_VECTORS => Int(i64::from(l.varyings)),
            MAX_VERTEX_ATTRIBS => Int(i64::from(l.attributes)),
            MAX_VIEWPORT_DIMS => Ints(vec![l.texture_size as i32, l.texture_size as i32]),
            PACK_ALIGNMENT => Int(i64::from(s.pack_alignment)),
            POLYGON_OFFSET_FACTOR => Float(f64::from(s.polygon_offset[0])),
            POLYGON_OFFSET_FILL => Bool(s.polygon_offset_fill),
            POLYGON_OFFSET_UNITS => Float(f64::from(s.polygon_offset[1])),
            RENDERBUFFER_BINDING => obj("renderbuffer", s.renderbuffer),
            RENDERER => Str("WebKit WebGL".into()),
            SAMPLE_ALPHA_TO_COVERAGE => Bool(s.alpha_to_coverage),
            SAMPLE_BUFFERS => Int(i64::from(self.current_samples() > 1)),
            SAMPLE_COVERAGE => Bool(s.sample_coverage),
            SAMPLE_COVERAGE_INVERT => Bool(s.sample_coverage_invert),
            SAMPLE_COVERAGE_VALUE => Float(f64::from(s.sample_coverage_value)),
            SAMPLES => Int(i64::from(self.current_samples())),
            SCISSOR_BOX => Ints(s.scissor.to_vec()),
            SCISSOR_TEST => Bool(s.scissor_test),
            SHADING_LANGUAGE_VERSION => Str(if webgl2 { "WebGL GLSL ES 3.00 (acde)".into() } else { "WebGL GLSL ES 1.0 (acde)".into() }),
            STENCIL_BACK_FAIL => Int(i64::from(s.stencil[1].fail)),
            STENCIL_BACK_FUNC => Int(i64::from(s.stencil[1].func)),
            STENCIL_BACK_PASS_DEPTH_FAIL => Int(i64::from(s.stencil[1].depth_fail)),
            STENCIL_BACK_PASS_DEPTH_PASS => Int(i64::from(s.stencil[1].pass)),
            STENCIL_BACK_REF => Int(i64::from(s.stencil[1].reference)),
            STENCIL_BACK_VALUE_MASK => Int(i64::from(s.stencil[1].value_mask)),
            STENCIL_BACK_WRITEMASK => Int(i64::from(s.stencil[1].write_mask)),
            STENCIL_CLEAR_VALUE => Int(i64::from(s.clear_stencil)),
            STENCIL_FAIL => Int(i64::from(s.stencil[0].fail)),
            STENCIL_FUNC => Int(i64::from(s.stencil[0].func)),
            STENCIL_PASS_DEPTH_FAIL => Int(i64::from(s.stencil[0].depth_fail)),
            STENCIL_PASS_DEPTH_PASS => Int(i64::from(s.stencil[0].pass)),
            STENCIL_REF => Int(i64::from(s.stencil[0].reference)),
            STENCIL_TEST => Bool(s.stencil_test),
            STENCIL_VALUE_MASK => Int(i64::from(s.stencil[0].value_mask)),
            STENCIL_WRITEMASK => Int(i64::from(s.stencil[0].write_mask)),
            SUBPIXEL_BITS => Int(4),
            TEXTURE_BINDING_2D => obj("texture", unit.texture_2d),
            TEXTURE_BINDING_CUBE_MAP => obj("texture", unit.cube),
            UNPACK_ALIGNMENT => Int(i64::from(s.unpack_alignment)),
            UNPACK_COLORSPACE_CONVERSION_WEBGL => Int(i64::from(s.unpack_colorspace)),
            UNPACK_FLIP_Y_WEBGL => Bool(s.unpack_flip_y),
            UNPACK_PREMULTIPLY_ALPHA_WEBGL => Bool(s.unpack_premultiply),
            VENDOR => Str("WebKit".into()),
            VERSION => Str(if webgl2 { "WebGL 2.0 (acde)".into() } else { "WebGL 1.0 (acde)".into() }),
            VIEWPORT => Ints(s.viewport.to_vec()),
            IMPLEMENTATION_COLOR_READ_FORMAT => Int(i64::from(self.implementation_read_format().0)),
            IMPLEMENTATION_COLOR_READ_TYPE => Int(i64::from(self.implementation_read_format().1)),
            UNMASKED_VENDOR_WEBGL if self.extension("WEBGL_debug_renderer_info") => Str(self.vendor()),
            UNMASKED_RENDERER_WEBGL if self.extension("WEBGL_debug_renderer_info") => Str(self.renderer()),
            MAX_TEXTURE_MAX_ANISOTROPY_EXT if self.extension("EXT_texture_filter_anisotropic") => Float(f64::from(l.anisotropy)),
            FRAGMENT_SHADER_DERIVATIVE_HINT if webgl2 || self.extension("OES_standard_derivatives") => Int(i64::from(s.derivative_hint)),
            VERTEX_ARRAY_BINDING if webgl2 || self.extension("OES_vertex_array_object") => obj("vertexArray", s.vertex_array),
            MAX_DRAW_BUFFERS | MAX_COLOR_ATTACHMENTS if webgl2 || self.extension("WEBGL_draw_buffers") => Int(i64::from(l.draw_buffers)),
            n if (DRAW_BUFFER0..DRAW_BUFFER0 + 8).contains(&n) && (webgl2 || self.extension("WEBGL_draw_buffers")) => {
                let i = (n - DRAW_BUFFER0) as usize;
                Int(i64::from(match s.draw_framebuffer {
                    None => {
                        if i == 0 {
                            s.default_draw_buffer
                        } else {
                            NONE
                        }
                    }
                    Some(fb) => self.framebuffer(fb).map_or(NONE, |f| f.draw_buffers[i]),
                }))
            }
            _ if !webgl2 => {
                self.error(INVALID_ENUM);
                Null
            }
            COPY_READ_BUFFER_BINDING_ => obj("buffer", s.copy_read),
            COPY_WRITE_BUFFER_BINDING_ => obj("buffer", s.copy_write),
            READ_FRAMEBUFFER_BINDING => obj("framebuffer", s.read_framebuffer),
            MAX_3D_TEXTURE_SIZE => Int(i64::from(l.texture_3d)),
            MAX_ARRAY_TEXTURE_LAYERS => Int(i64::from(l.array_layers)),
            MAX_CLIENT_WAIT_TIMEOUT_WEBGL => Int(0),
            MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS | MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS => {
                Int(i64::from(l.uniform_vectors * 4 + l.uniform_blocks * l.block_size / 4))
            }
            MAX_COMBINED_UNIFORM_BLOCKS => Int(i64::from(l.uniform_blocks * 2)),
            MAX_ELEMENT_INDEX => Int(4_294_967_295),
            MAX_ELEMENTS_INDICES | MAX_ELEMENTS_VERTICES => Int(1 << 24),
            MAX_FRAGMENT_INPUT_COMPONENTS | MAX_VERTEX_OUTPUT_COMPONENTS => Int(i64::from(l.varyings * 4)),
            MAX_FRAGMENT_UNIFORM_BLOCKS | MAX_VERTEX_UNIFORM_BLOCKS => Int(i64::from(l.uniform_blocks)),
            MAX_FRAGMENT_UNIFORM_COMPONENTS | MAX_VERTEX_UNIFORM_COMPONENTS => Int(i64::from(l.uniform_vectors * 4)),
            MAX_PROGRAM_TEXEL_OFFSET => Int(7),
            MIN_PROGRAM_TEXEL_OFFSET => Int(-8),
            MAX_SAMPLES => Int(i64::from(l.samples)),
            MAX_SERVER_WAIT_TIMEOUT => Int(0),
            MAX_TEXTURE_LOD_BIAS => Float(16.0),
            MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS => Int(64),
            MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS => Int(4),
            MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS => Int(4),
            MAX_UNIFORM_BLOCK_SIZE => Int(i64::from(l.block_size)),
            MAX_UNIFORM_BUFFER_BINDINGS => Int(i64::from(l.uniform_bindings)),
            MAX_VARYING_COMPONENTS => Int(i64::from(l.varyings * 4)),
            PACK_ROW_LENGTH => Int(i64::from(s.pack_row_length)),
            PACK_SKIP_PIXELS => Int(i64::from(s.pack_skip_pixels)),
            PACK_SKIP_ROWS => Int(i64::from(s.pack_skip_rows)),
            PIXEL_PACK_BUFFER_BINDING => obj("buffer", s.pixel_pack),
            PIXEL_UNPACK_BUFFER_BINDING => obj("buffer", s.pixel_unpack),
            RASTERIZER_DISCARD => Bool(s.rasterizer_discard),
            READ_BUFFER => Int(i64::from(match s.read_framebuffer {
                None => s.default_read_buffer,
                Some(fb) => self.framebuffer(fb).map_or(NONE, |f| f.read_buffer),
            })),
            SAMPLER_BINDING => obj("sampler", unit.sampler),
            TEXTURE_BINDING_2D_ARRAY => obj("texture", unit.array),
            TEXTURE_BINDING_3D => obj("texture", unit.texture_3d),
            TRANSFORM_FEEDBACK_ACTIVE | TRANSFORM_FEEDBACK_PAUSED => Bool(false),
            TRANSFORM_FEEDBACK_BINDING => obj("transformFeedback", s.transform_feedback),
            TRANSFORM_FEEDBACK_BUFFER_BINDING => obj("buffer", s.transform_feedback_buffer),
            UNIFORM_BUFFER_BINDING => obj("buffer", s.uniform_buffer),
            UNIFORM_BUFFER_OFFSET_ALIGNMENT => Int(256),
            UNPACK_IMAGE_HEIGHT => Int(i64::from(s.unpack_image_height)),
            UNPACK_ROW_LENGTH => Int(i64::from(s.unpack_row_length)),
            UNPACK_SKIP_IMAGES => Int(i64::from(s.unpack_skip_images)),
            UNPACK_SKIP_PIXELS => Int(i64::from(s.unpack_skip_pixels)),
            UNPACK_SKIP_ROWS => Int(i64::from(s.unpack_skip_rows)),
            _ => {
                self.error(INVALID_ENUM);
                Null
            }
        }
    }

    pub fn indexed_parameter(&mut self, name: u32, index: u32) -> Param {
        let Some(b) = self.state.uniform_buffers.get(index as usize).copied() else {
            self.error(INVALID_VALUE);
            return Param::Null;
        };
        match name {
            UNIFORM_BUFFER_BINDING => b.buffer.map_or(Param::Null, |id| Param::Object("buffer", id)),
            UNIFORM_BUFFER_START => Param::Int(b.offset as i64),
            UNIFORM_BUFFER_SIZE => Param::Int(b.size as i64),
            TRANSFORM_FEEDBACK_BUFFER_BINDING => Param::Null,
            _ => {
                self.error(INVALID_ENUM);
                Param::Null
            }
        }
    }

    fn current_samples(&self) -> u32 {
        match self.state.draw_framebuffer {
            None => self.drawing.samples,
            Some(fb) => self.framebuffer(fb).and_then(|f| f.color.iter().flatten().next().copied()).and_then(|a| self.view_of(a)).map_or(1, |v| v.samples),
        }
    }

    fn compressed_formats(&self) -> Vec<u32> {
        let mut out = Vec::new();
        let candidates: &[(&str, &[u32])] = &[
            (
                "WEBGL_compressed_texture_s3tc",
                &[COMPRESSED_RGB_S3TC_DXT1_EXT, COMPRESSED_RGBA_S3TC_DXT1_EXT, COMPRESSED_RGBA_S3TC_DXT3_EXT, COMPRESSED_RGBA_S3TC_DXT5_EXT],
            ),
            (
                "WEBGL_compressed_texture_s3tc_srgb",
                &[COMPRESSED_SRGB_S3TC_DXT1_EXT, COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT, COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT, COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT],
            ),
            (
                "EXT_texture_compression_rgtc",
                &[COMPRESSED_RED_RGTC1_EXT, COMPRESSED_SIGNED_RED_RGTC1_EXT, COMPRESSED_RED_GREEN_RGTC2_EXT, COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT],
            ),
            (
                "EXT_texture_compression_bptc",
                &[
                    COMPRESSED_RGBA_BPTC_UNORM_EXT,
                    COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT,
                    COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT,
                    COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT,
                ],
            ),
            (
                "WEBGL_compressed_texture_etc",
                &[
                    COMPRESSED_R11_EAC,
                    COMPRESSED_SIGNED_R11_EAC,
                    COMPRESSED_RG11_EAC,
                    COMPRESSED_SIGNED_RG11_EAC,
                    COMPRESSED_RGB8_ETC2,
                    COMPRESSED_SRGB8_ETC2,
                    COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2,
                    COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2,
                    COMPRESSED_RGBA8_ETC2_EAC,
                    COMPRESSED_SRGB8_ALPHA8_ETC2_EAC,
                ],
            ),
        ];
        for (ext, formats) in candidates {
            if self.extension(ext) {
                out.extend_from_slice(formats);
            }
        }
        if self.extension("WEBGL_compressed_texture_astc") {
            out.extend(0x93B0..=0x93BD);
            out.extend(0x93D0..=0x93DD);
        }
        out
    }

    pub fn buffer_parameter(&mut self, target: u32, name: u32) -> Param {
        let Some(bound) = self.bound_buffer(target) else {
            self.error(INVALID_ENUM);
            return Param::Null;
        };
        let Some(b) = bound.and_then(|id| self.buffer(id)) else {
            self.error(INVALID_OPERATION);
            return Param::Null;
        };
        match name {
            BUFFER_SIZE => Param::Int(b.size as i64),
            BUFFER_USAGE => Param::Int(i64::from(b.usage)),
            _ => {
                self.error(INVALID_ENUM);
                Param::Null
            }
        }
    }

    pub fn renderbuffer_parameter(&mut self, name: u32) -> Param {
        let Some(rb) = self.state.renderbuffer.and_then(|id| self.renderbuffer(id)) else {
            self.error(INVALID_OPERATION);
            return Param::Null;
        };
        let bits = |i: usize| Param::Int(rb.format.map_or(0, |f| i64::from(f.bits[i])));
        match name {
            RENDERBUFFER_WIDTH => Param::Int(i64::from(rb.width)),
            RENDERBUFFER_HEIGHT => Param::Int(i64::from(rb.height)),
            RENDERBUFFER_INTERNAL_FORMAT => Param::Int(i64::from(rb.format.map_or(RGBA4, |f| f.internal))),
            RENDERBUFFER_RED_SIZE => bits(0),
            RENDERBUFFER_GREEN_SIZE => bits(1),
            RENDERBUFFER_BLUE_SIZE => bits(2),
            RENDERBUFFER_ALPHA_SIZE => bits(3),
            RENDERBUFFER_DEPTH_SIZE => bits(4),
            RENDERBUFFER_STENCIL_SIZE => bits(5),
            RENDERBUFFER_SAMPLES if self.webgl2 => Param::Int(i64::from(rb.samples)),
            _ => {
                self.error(INVALID_ENUM);
                Param::Null
            }
        }
    }

    pub fn attachment_parameter(&mut self, target: u32, attachment: u32, name: u32) -> Param {
        let fb = match target {
            FRAMEBUFFER | DRAW_FRAMEBUFFER => self.state.draw_framebuffer,
            READ_FRAMEBUFFER if self.webgl2 => self.state.read_framebuffer,
            _ => {
                self.error(INVALID_ENUM);
                return Param::Null;
            }
        };
        let Some(fb) = fb else {
            return match name {
                FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE => Param::Int(i64::from(FRAMEBUFFER_DEFAULT)),
                _ => Param::Null,
            };
        };
        let Some(f) = self.framebuffer(fb) else { return Param::Null };
        let a = match attachment {
            DEPTH_ATTACHMENT => f.depth,
            STENCIL_ATTACHMENT => f.stencil,
            DEPTH_STENCIL_ATTACHMENT => f.depth.filter(|d| Some(*d) == f.stencil),
            a if (COLOR_ATTACHMENT0..COLOR_ATTACHMENT0 + 8).contains(&a) => f.color[(a - COLOR_ATTACHMENT0) as usize],
            _ => {
                self.error(INVALID_ENUM);
                return Param::Null;
            }
        };
        let Some(a) = a else {
            return match name {
                FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE => Param::Int(i64::from(NONE)),
                FRAMEBUFFER_ATTACHMENT_OBJECT_NAME => Param::Null,
                _ => {
                    self.error(INVALID_OPERATION);
                    Param::Null
                }
            };
        };
        let format = self.view_of(a).map(|v| v.format);
        match (name, a) {
            (FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE, crate::objects::Attachment::Texture { .. }) => Param::Int(i64::from(TEXTURE)),
            (FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE, _) => Param::Int(i64::from(RENDERBUFFER)),
            (FRAMEBUFFER_ATTACHMENT_OBJECT_NAME, crate::objects::Attachment::Texture { id, .. }) => Param::Object("texture", id),
            (FRAMEBUFFER_ATTACHMENT_OBJECT_NAME, crate::objects::Attachment::Renderbuffer(id)) => Param::Object("renderbuffer", id),
            (FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL, crate::objects::Attachment::Texture { level, .. }) => Param::Int(i64::from(level)),
            (FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE, crate::objects::Attachment::Texture { id, layer, .. }) => {
                Param::Int(if self.texture(id).is_some_and(|t| t.target == TEXTURE_CUBE_MAP) { i64::from(TEXTURE_CUBE_MAP_POSITIVE_X + layer) } else { 0 })
            }
            (FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER, crate::objects::Attachment::Texture { layer, .. }) => Param::Int(i64::from(layer)),
            (FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING, _) => Param::Int(i64::from(if format.is_some_and(|f| f.srgb) { SRGB } else { LINEAR })),
            (FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE, _) => Param::Int(i64::from(format.map_or(NONE, |f| match f.class {
                crate::format::Class::Sint => INT,
                crate::format::Class::Uint => UNSIGNED_INT,
                _ => f.component_type,
            }))),
            (n, _) if (FRAMEBUFFER_ATTACHMENT_RED_SIZE..=FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE).contains(&n) => {
                Param::Int(format.map_or(0, |f| i64::from(f.bits[(n - FRAMEBUFFER_ATTACHMENT_RED_SIZE) as usize])))
            }
            _ => {
                self.error(INVALID_ENUM);
                Param::Null
            }
        }
    }
}

const COPY_READ_BUFFER_BINDING_: u32 = COPY_READ_BUFFER;
const COPY_WRITE_BUFFER_BINDING_: u32 = COPY_WRITE_BUFFER;
