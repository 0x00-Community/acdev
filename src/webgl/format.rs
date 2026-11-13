use crate::webgl::consts::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Class {
    Float,
    Unfilterable,
    Sint,
    Uint,
    Depth,
    DepthStencil,
    Stencil,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expand {
    None,
    Rgb,
    Luminance,
    LuminanceAlpha,
    Alpha,
}

#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub internal: u32,
    pub wgpu: wgpu::TextureFormat,
    pub class: Class,
    pub renderable: bool,
    pub filterable: bool,
    pub expand: Expand,
    pub bits: [u8; 6],
    pub component_type: u32,
    pub srgb: bool,
}

#[allow(clippy::too_many_arguments, reason = "a format table row")]
const fn f(
    internal: u32,
    wgpu: wgpu::TextureFormat,
    class: Class,
    renderable: bool,
    filterable: bool,
    expand: Expand,
    bits: [u8; 6],
    component_type: u32,
) -> Format {
    Format { internal, wgpu, class, renderable, filterable, expand, bits, component_type, srgb: false }
}

use Class::*;
use Expand as E;
use wgpu::TextureFormat as T;

pub fn sized(internal: u32) -> Option<Format> {
    let un = UNSIGNED_NORMALIZED;
    let sn = SIGNED_NORMALIZED;
    let fl = FLOAT;
    let int = INT;
    let uint = UNSIGNED_INT;
    Some(match internal {
        RGBA8 | RGBA | RGB5_A1 | RGBA4 => f(internal, T::Rgba8Unorm, Float, true, true, E::None, [8, 8, 8, 8, 0, 0], un),
        RGB8 | RGB | RGB565 => f(internal, T::Rgba8Unorm, Float, true, true, E::Rgb, [8, 8, 8, 0, 0, 0], un),
        LUMINANCE => f(internal, T::Rgba8Unorm, Float, false, true, E::Luminance, [8, 8, 8, 0, 0, 0], un),
        LUMINANCE_ALPHA => f(internal, T::Rgba8Unorm, Float, false, true, E::LuminanceAlpha, [8, 8, 8, 8, 0, 0], un),
        ALPHA => f(internal, T::Rgba8Unorm, Float, false, true, E::Alpha, [0, 0, 0, 8, 0, 0], un),
        SRGB8_ALPHA8 | SRGB_ALPHA_EXT => Format { srgb: true, ..f(internal, T::Rgba8UnormSrgb, Float, true, true, E::None, [8, 8, 8, 8, 0, 0], un) },
        SRGB8 | SRGB_EXT => Format { srgb: true, ..f(internal, T::Rgba8UnormSrgb, Float, internal == SRGB_EXT, true, E::Rgb, [8, 8, 8, 0, 0, 0], un) },
        R8 => f(internal, T::R8Unorm, Float, true, true, E::None, [8, 0, 0, 0, 0, 0], un),
        RG8 => f(internal, T::Rg8Unorm, Float, true, true, E::None, [8, 8, 0, 0, 0, 0], un),
        R8_SNORM => f(internal, T::R8Snorm, Float, false, true, E::None, [8, 0, 0, 0, 0, 0], sn),
        RG8_SNORM => f(internal, T::Rg8Snorm, Float, false, true, E::None, [8, 8, 0, 0, 0, 0], sn),
        RGBA8_SNORM => f(internal, T::Rgba8Snorm, Float, false, true, E::None, [8, 8, 8, 8, 0, 0], sn),
        RGB8_SNORM => f(internal, T::Rgba8Snorm, Float, false, true, E::Rgb, [8, 8, 8, 0, 0, 0], sn),
        R16F => f(internal, T::R16Float, Float, true, true, E::None, [16, 0, 0, 0, 0, 0], fl),
        RG16F => f(internal, T::Rg16Float, Float, true, true, E::None, [16, 16, 0, 0, 0, 0], fl),
        RGBA16F => f(internal, T::Rgba16Float, Float, true, true, E::None, [16, 16, 16, 16, 0, 0], fl),
        RGB16F => f(internal, T::Rgba16Float, Float, false, true, E::Rgb, [16, 16, 16, 0, 0, 0], fl),
        R32F => f(internal, T::R32Float, Unfilterable, true, false, E::None, [32, 0, 0, 0, 0, 0], fl),
        RG32F => f(internal, T::Rg32Float, Unfilterable, true, false, E::None, [32, 32, 0, 0, 0, 0], fl),
        RGBA32F => f(internal, T::Rgba32Float, Unfilterable, true, false, E::None, [32, 32, 32, 32, 0, 0], fl),
        RGB32F => f(internal, T::Rgba32Float, Unfilterable, false, false, E::Rgb, [32, 32, 32, 0, 0, 0], fl),
        R11F_G11F_B10F => f(internal, T::Rg11b10Ufloat, Float, true, true, E::None, [11, 11, 10, 0, 0, 0], fl),
        RGB9_E5 => f(internal, T::Rgb9e5Ufloat, Float, false, true, E::None, [9, 9, 9, 0, 0, 0], fl),
        RGB10_A2 => f(internal, T::Rgb10a2Unorm, Float, true, true, E::None, [10, 10, 10, 2, 0, 0], un),
        RGB10_A2UI => f(internal, T::Rgb10a2Uint, Uint, true, false, E::None, [10, 10, 10, 2, 0, 0], uint),
        R8I => f(internal, T::R8Sint, Sint, true, false, E::None, [8, 0, 0, 0, 0, 0], int),
        R8UI => f(internal, T::R8Uint, Uint, true, false, E::None, [8, 0, 0, 0, 0, 0], uint),
        R16I => f(internal, T::R16Sint, Sint, true, false, E::None, [16, 0, 0, 0, 0, 0], int),
        R16UI => f(internal, T::R16Uint, Uint, true, false, E::None, [16, 0, 0, 0, 0, 0], uint),
        R32I => f(internal, T::R32Sint, Sint, true, false, E::None, [32, 0, 0, 0, 0, 0], int),
        R32UI => f(internal, T::R32Uint, Uint, true, false, E::None, [32, 0, 0, 0, 0, 0], uint),
        RG8I => f(internal, T::Rg8Sint, Sint, true, false, E::None, [8, 8, 0, 0, 0, 0], int),
        RG8UI => f(internal, T::Rg8Uint, Uint, true, false, E::None, [8, 8, 0, 0, 0, 0], uint),
        RG16I => f(internal, T::Rg16Sint, Sint, true, false, E::None, [16, 16, 0, 0, 0, 0], int),
        RG16UI => f(internal, T::Rg16Uint, Uint, true, false, E::None, [16, 16, 0, 0, 0, 0], uint),
        RG32I => f(internal, T::Rg32Sint, Sint, true, false, E::None, [32, 32, 0, 0, 0, 0], int),
        RG32UI => f(internal, T::Rg32Uint, Uint, true, false, E::None, [32, 32, 0, 0, 0, 0], uint),
        RGBA8I => f(internal, T::Rgba8Sint, Sint, true, false, E::None, [8, 8, 8, 8, 0, 0], int),
        RGBA8UI => f(internal, T::Rgba8Uint, Uint, true, false, E::None, [8, 8, 8, 8, 0, 0], uint),
        RGBA16I => f(internal, T::Rgba16Sint, Sint, true, false, E::None, [16, 16, 16, 16, 0, 0], int),
        RGBA16UI => f(internal, T::Rgba16Uint, Uint, true, false, E::None, [16, 16, 16, 16, 0, 0], uint),
        RGBA32I => f(internal, T::Rgba32Sint, Sint, true, false, E::None, [32, 32, 32, 32, 0, 0], int),
        RGBA32UI => f(internal, T::Rgba32Uint, Uint, true, false, E::None, [32, 32, 32, 32, 0, 0], uint),
        RGB8I => f(internal, T::Rgba8Sint, Sint, false, false, E::Rgb, [8, 8, 8, 0, 0, 0], int),
        RGB8UI => f(internal, T::Rgba8Uint, Uint, false, false, E::Rgb, [8, 8, 8, 0, 0, 0], uint),
        RGB16I => f(internal, T::Rgba16Sint, Sint, false, false, E::Rgb, [16, 16, 16, 0, 0, 0], int),
        RGB16UI => f(internal, T::Rgba16Uint, Uint, false, false, E::Rgb, [16, 16, 16, 0, 0, 0], uint),
        RGB32I => f(internal, T::Rgba32Sint, Sint, false, false, E::Rgb, [32, 32, 32, 0, 0, 0], int),
        RGB32UI => f(internal, T::Rgba32Uint, Uint, false, false, E::Rgb, [32, 32, 32, 0, 0, 0], uint),
        R16_EXT => f(internal, T::R16Unorm, Float, true, true, E::None, [16, 0, 0, 0, 0, 0], un),
        RG16_EXT => f(internal, T::Rg16Unorm, Float, true, true, E::None, [16, 16, 0, 0, 0, 0], un),
        RGBA16_EXT => f(internal, T::Rgba16Unorm, Float, true, true, E::None, [16, 16, 16, 16, 0, 0], un),
        RGB16_EXT => f(internal, T::Rgba16Unorm, Float, false, true, E::Rgb, [16, 16, 16, 0, 0, 0], un),
        R16_SNORM_EXT => f(internal, T::R16Snorm, Float, false, true, E::None, [16, 0, 0, 0, 0, 0], sn),
        RG16_SNORM_EXT => f(internal, T::Rg16Snorm, Float, false, true, E::None, [16, 16, 0, 0, 0, 0], sn),
        RGBA16_SNORM_EXT => f(internal, T::Rgba16Snorm, Float, false, true, E::None, [16, 16, 16, 16, 0, 0], sn),
        RGB16_SNORM_EXT => f(internal, T::Rgba16Snorm, Float, false, true, E::Rgb, [16, 16, 16, 0, 0, 0], sn),
        DEPTH_COMPONENT16 => f(internal, T::Depth16Unorm, Depth, true, false, E::None, [0, 0, 0, 0, 16, 0], un),
        DEPTH_COMPONENT24 | DEPTH_COMPONENT => f(internal, T::Depth24Plus, Depth, true, false, E::None, [0, 0, 0, 0, 24, 0], un),
        DEPTH_COMPONENT32F => f(internal, T::Depth32Float, Depth, true, false, E::None, [0, 0, 0, 0, 32, 0], fl),
        DEPTH24_STENCIL8 | DEPTH_STENCIL => f(internal, T::Depth24PlusStencil8, DepthStencil, true, false, E::None, [0, 0, 0, 0, 24, 8], un),
        DEPTH32F_STENCIL8 => f(internal, T::Depth32FloatStencil8, DepthStencil, true, false, E::None, [0, 0, 0, 0, 32, 8], fl),
        STENCIL_INDEX8 => f(internal, T::Stencil8, Stencil, true, false, E::None, [0, 0, 0, 0, 0, 8], un),
        _ => return None,
    })
}

pub fn unsized_internal(format: u32, ty: u32) -> Option<u32> {
    Some(match (format, ty) {
        (RGBA, UNSIGNED_BYTE | UNSIGNED_SHORT_4_4_4_4 | UNSIGNED_SHORT_5_5_5_1) => RGBA,
        (RGB, UNSIGNED_BYTE | UNSIGNED_SHORT_5_6_5) => RGB,
        (LUMINANCE | LUMINANCE_ALPHA | ALPHA, UNSIGNED_BYTE) => format,
        (RGBA, FLOAT) => RGBA32F,
        (RGB, FLOAT) => RGB32F,
        (RGBA, HALF_FLOAT | HALF_FLOAT_OES) => RGBA16F,
        (RGB, HALF_FLOAT | HALF_FLOAT_OES) => RGB16F,
        (LUMINANCE | LUMINANCE_ALPHA | ALPHA, FLOAT | HALF_FLOAT | HALF_FLOAT_OES) => return None,
        (SRGB_EXT, UNSIGNED_BYTE) => SRGB_EXT,
        (SRGB_ALPHA_EXT, UNSIGNED_BYTE) => SRGB_ALPHA_EXT,
        (DEPTH_COMPONENT, UNSIGNED_SHORT) => DEPTH_COMPONENT16,
        (DEPTH_COMPONENT, UNSIGNED_INT) => DEPTH_COMPONENT24,
        (DEPTH_STENCIL, UNSIGNED_INT_24_8) => DEPTH24_STENCIL8,
        _ => return None,
    })
}

pub fn valid_upload(internal: u32, format: u32, ty: u32) -> bool {
    let rgba = [UNSIGNED_BYTE];
    let pairs: &[(u32, &[u32])] = match internal {
        RGBA8 | SRGB8_ALPHA8 => &[(RGBA, &rgba)],
        RGB8 | SRGB8 => &[(RGB, &rgba)],
        RGBA4 => &[(RGBA, &[UNSIGNED_BYTE, UNSIGNED_SHORT_4_4_4_4])],
        RGB5_A1 => &[(RGBA, &[UNSIGNED_BYTE, UNSIGNED_SHORT_5_5_5_1, UNSIGNED_INT_2_10_10_10_REV])],
        RGB565 => &[(RGB, &[UNSIGNED_BYTE, UNSIGNED_SHORT_5_6_5])],
        R8 => &[(RED, &rgba)],
        RG8 => &[(RG, &rgba)],
        R8_SNORM => &[(RED, &[BYTE])],
        RG8_SNORM => &[(RG, &[BYTE])],
        RGB8_SNORM => &[(RGB, &[BYTE])],
        RGBA8_SNORM => &[(RGBA, &[BYTE])],
        R16F => &[(RED, &[HALF_FLOAT, FLOAT])],
        RG16F => &[(RG, &[HALF_FLOAT, FLOAT])],
        RGB16F => &[(RGB, &[HALF_FLOAT, FLOAT])],
        RGBA16F => &[(RGBA, &[HALF_FLOAT, FLOAT])],
        R32F => &[(RED, &[FLOAT])],
        RG32F => &[(RG, &[FLOAT])],
        RGB32F => &[(RGB, &[FLOAT])],
        RGBA32F => &[(RGBA, &[FLOAT])],
        R11F_G11F_B10F => &[(RGB, &[UNSIGNED_INT_10F_11F_11F_REV, HALF_FLOAT, FLOAT])],
        RGB9_E5 => &[(RGB, &[UNSIGNED_INT_5_9_9_9_REV, HALF_FLOAT, FLOAT])],
        RGB10_A2 => &[(RGBA, &[UNSIGNED_INT_2_10_10_10_REV])],
        RGB10_A2UI => &[(RGBA_INTEGER, &[UNSIGNED_INT_2_10_10_10_REV])],
        R8I => &[(RED_INTEGER, &[BYTE])],
        R8UI => &[(RED_INTEGER, &[UNSIGNED_BYTE])],
        R16I => &[(RED_INTEGER, &[SHORT])],
        R16UI => &[(RED_INTEGER, &[UNSIGNED_SHORT])],
        R32I => &[(RED_INTEGER, &[INT])],
        R32UI => &[(RED_INTEGER, &[UNSIGNED_INT])],
        RG8I => &[(RG_INTEGER, &[BYTE])],
        RG8UI => &[(RG_INTEGER, &[UNSIGNED_BYTE])],
        RG16I => &[(RG_INTEGER, &[SHORT])],
        RG16UI => &[(RG_INTEGER, &[UNSIGNED_SHORT])],
        RG32I => &[(RG_INTEGER, &[INT])],
        RG32UI => &[(RG_INTEGER, &[UNSIGNED_INT])],
        RGB8I => &[(RGB_INTEGER, &[BYTE])],
        RGB8UI => &[(RGB_INTEGER, &[UNSIGNED_BYTE])],
        RGB16I => &[(RGB_INTEGER, &[SHORT])],
        RGB16UI => &[(RGB_INTEGER, &[UNSIGNED_SHORT])],
        RGB32I => &[(RGB_INTEGER, &[INT])],
        RGB32UI => &[(RGB_INTEGER, &[UNSIGNED_INT])],
        RGBA8I => &[(RGBA_INTEGER, &[BYTE])],
        RGBA8UI => &[(RGBA_INTEGER, &[UNSIGNED_BYTE])],
        RGBA16I => &[(RGBA_INTEGER, &[SHORT])],
        RGBA16UI => &[(RGBA_INTEGER, &[UNSIGNED_SHORT])],
        RGBA32I => &[(RGBA_INTEGER, &[INT])],
        RGBA32UI => &[(RGBA_INTEGER, &[UNSIGNED_INT])],
        R16_EXT => &[(RED, &[UNSIGNED_SHORT])],
        RG16_EXT => &[(RG, &[UNSIGNED_SHORT])],
        RGB16_EXT => &[(RGB, &[UNSIGNED_SHORT])],
        RGBA16_EXT => &[(RGBA, &[UNSIGNED_SHORT])],
        R16_SNORM_EXT => &[(RED, &[SHORT])],
        RG16_SNORM_EXT => &[(RG, &[SHORT])],
        RGB16_SNORM_EXT => &[(RGB, &[SHORT])],
        RGBA16_SNORM_EXT => &[(RGBA, &[SHORT])],
        DEPTH_COMPONENT16 => &[(DEPTH_COMPONENT, &[UNSIGNED_SHORT, UNSIGNED_INT])],
        DEPTH_COMPONENT24 => &[(DEPTH_COMPONENT, &[UNSIGNED_INT])],
        DEPTH_COMPONENT32F => &[(DEPTH_COMPONENT, &[FLOAT])],
        DEPTH24_STENCIL8 => &[(DEPTH_STENCIL, &[UNSIGNED_INT_24_8])],
        DEPTH32F_STENCIL8 => &[(DEPTH_STENCIL, &[FLOAT_32_UNSIGNED_INT_24_8_REV])],
        _ => return unsized_internal(format, ty) == Some(internal),
    };
    pairs.iter().any(|(f, types)| *f == format && types.contains(&ty))
}

pub fn components(format: u32) -> Option<u32> {
    Some(match format {
        RED | RED_INTEGER | ALPHA | LUMINANCE | DEPTH_COMPONENT => 1,
        RG | RG_INTEGER | LUMINANCE_ALPHA | DEPTH_STENCIL => 2,
        RGB | RGB_INTEGER | SRGB_EXT => 3,
        RGBA | RGBA_INTEGER | SRGB_ALPHA_EXT => 4,
        _ => return None,
    })
}

pub fn texel_bytes(format: u32, ty: u32) -> Option<u32> {
    Some(match ty {
        UNSIGNED_SHORT_4_4_4_4 | UNSIGNED_SHORT_5_5_5_1 | UNSIGNED_SHORT_5_6_5 => 2,
        UNSIGNED_INT_2_10_10_10_REV | UNSIGNED_INT_10F_11F_11F_REV | UNSIGNED_INT_5_9_9_9_REV | UNSIGNED_INT_24_8 => 4,
        FLOAT_32_UNSIGNED_INT_24_8_REV => 8,
        BYTE | UNSIGNED_BYTE => components(format)?,
        SHORT | UNSIGNED_SHORT | HALF_FLOAT | HALF_FLOAT_OES => 2 * components(format)?,
        INT | UNSIGNED_INT | FLOAT => 4 * components(format)?,
        _ => return None,
    })
}

pub fn wgpu_texel_bytes(format: wgpu::TextureFormat) -> u32 {
    format.block_copy_size(None).unwrap_or(4)
}

pub fn half_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) as u32) << 31;
    let exp = ((h >> 10) & 0x1f) as u32;
    let mant = (h & 0x3ff) as u32;
    let bits = match exp {
        0 if mant == 0 => sign,
        0 => {
            let mut e = 127 - 15 + 1;
            let mut m = mant;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            sign | (e << 23) | ((m & 0x3ff) << 13)
        }
        31 => sign | 0x7f80_0000 | (mant << 13),
        _ => sign | ((exp + 127 - 15) << 23) | (mant << 13),
    };
    f32::from_bits(bits)
}

pub fn f32_to_half(v: f32) -> u16 {
    let bits = v.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32;
    let mant = bits & 0x7f_ffff;
    if exp == 255 {
        return sign | 0x7c00 | if mant != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 31 {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign;
        }
        let m = (mant | 0x80_0000) >> (1 - e);
        return sign | ((m + 0x1000) >> 13) as u16;
    }
    sign | ((e as u32) << 10) as u16 | ((mant + 0x1000) >> 13) as u16
}

pub struct Unpack {
    pub alignment: u32,
    pub row_length: u32,
    pub image_height: u32,
    pub skip_pixels: u32,
    pub skip_rows: u32,
    pub skip_images: u32,
}

impl Unpack {
    pub fn layout(&self, width: u32, height: u32, depth: u32, texel: u32) -> (u64, u64, u64, u64) {
        let row_texels = if self.row_length > 0 { self.row_length } else { width };
        let row = (u64::from(row_texels) * u64::from(texel)).next_multiple_of(u64::from(self.alignment.max(1)));
        let rows = if self.image_height > 0 { self.image_height } else { height };
        let image = row * u64::from(rows);
        let start = u64::from(self.skip_images) * image + u64::from(self.skip_rows) * row + u64::from(self.skip_pixels) * u64::from(texel);
        let last_row = u64::from(width) * u64::from(texel);
        let needed = if width == 0 || height == 0 || depth == 0 { 0 } else { start + u64::from(depth - 1) * image + u64::from(height - 1) * row + last_row };
        (start, row, image, needed)
    }
}

pub fn convert(src: &[u8], format: u32, ty: u32, target: &Format, width: u32) -> Vec<u8> {
    let texel = texel_bytes(format, ty).unwrap_or(4) as usize;
    let out_texel = wgpu_texel_bytes(target.wgpu) as usize;
    let n = width as usize;
    let mut out = vec![0u8; n * out_texel];
    let comps = components(format).unwrap_or(4) as usize;
    for i in 0..n {
        let s = &src[i * texel..(i + 1) * texel];
        let d = &mut out[i * out_texel..(i + 1) * out_texel];
        match ty {
            UNSIGNED_SHORT_4_4_4_4 => {
                let v = u16::from_le_bytes([s[0], s[1]]);
                let c = |shift: u16| ((v >> shift) & 0xf) as u8 * 17;
                d.copy_from_slice(&[c(12), c(8), c(4), c(0)]);
            }
            UNSIGNED_SHORT_5_5_5_1 => {
                let v = u16::from_le_bytes([s[0], s[1]]);
                let c = |shift: u16| (((v >> shift) & 0x1f) as u32 * 255 / 31) as u8;
                d.copy_from_slice(&[c(11), c(6), c(1), if v & 1 != 0 { 255 } else { 0 }]);
            }
            UNSIGNED_SHORT_5_6_5 => {
                let v = u16::from_le_bytes([s[0], s[1]]);
                d.copy_from_slice(&[
                    (((v >> 11) & 0x1f) as u32 * 255 / 31) as u8,
                    (((v >> 5) & 0x3f) as u32 * 255 / 63) as u8,
                    ((v & 0x1f) as u32 * 255 / 31) as u8,
                    255,
                ]);
            }
            _ => {
                let size = texel / comps.max(1);
                let target_size = match target.wgpu {
                    T::Rgba16Float | T::Rg16Float | T::R16Float => 2,
                    T::Rgba32Float | T::Rg32Float | T::R32Float => 4,
                    _ => size,
                };
                let float_to_half = size == 4 && target_size == 2 && matches!(ty, FLOAT);
                let channel = |c: usize| -> Option<&[u8]> { (c < comps).then(|| &s[c * size..(c + 1) * size]) };
                let one: Vec<u8> = match (ty, target_size) {
                    (FLOAT, 4) => 1f32.to_le_bytes().to_vec(),
                    (FLOAT | HALF_FLOAT | HALF_FLOAT_OES, 2) => f32_to_half(1.0).to_le_bytes().to_vec(),
                    (BYTE, _) => vec![127],
                    (SHORT, _) => 0x7fffi16.to_le_bytes().to_vec(),
                    (INT | UNSIGNED_INT, _) => 1u32.to_le_bytes().to_vec(),
                    (UNSIGNED_SHORT, _) => vec![0xff, 0xff],
                    _ => vec![0xff; target_size],
                };
                let zero = vec![0u8; target_size];
                let integer = matches!(target.class, Class::Sint | Class::Uint);
                let alpha_one = if integer { 1u32.to_le_bytes()[..target_size].to_vec() } else { one.clone() };
                let mut put = |slot: usize, bytes: Option<&[u8]>| {
                    let at = slot * target_size;
                    if at + target_size > d.len() {
                        return;
                    }
                    match bytes {
                        Some(b) if float_to_half => d[at..at + 2].copy_from_slice(&f32_to_half(f32::from_le_bytes([b[0], b[1], b[2], b[3]])).to_le_bytes()),
                        Some(b) => d[at..at + target_size].copy_from_slice(&b[..target_size]),
                        None => d[at..at + target_size].copy_from_slice(if slot == 3 { &alpha_one } else { &zero }),
                    }
                };
                match target.expand {
                    E::Luminance => {
                        put(0, channel(0));
                        put(1, channel(0));
                        put(2, channel(0));
                        put(3, None);
                    }
                    E::LuminanceAlpha => {
                        put(0, channel(0));
                        put(1, channel(0));
                        put(2, channel(0));
                        put(3, channel(1));
                    }
                    E::Alpha => {
                        put(0, Some(&zero));
                        put(1, Some(&zero));
                        put(2, Some(&zero));
                        put(3, channel(0));
                    }
                    _ => {
                        let slots = out_texel / target_size;
                        for c in 0..slots {
                            put(c, channel(c));
                        }
                    }
                }
            }
        }
    }
    out
}

pub fn passthrough(format: u32, ty: u32, target: &Format) -> bool {
    if target.expand != E::None {
        return false;
    }
    if matches!(ty, UNSIGNED_SHORT_4_4_4_4 | UNSIGNED_SHORT_5_5_5_1 | UNSIGNED_SHORT_5_6_5) {
        return false;
    }
    if ty == FLOAT && matches!(target.wgpu, T::Rgba16Float | T::Rg16Float | T::R16Float) {
        return false;
    }
    if matches!(ty, UNSIGNED_INT_10F_11F_11F_REV | UNSIGNED_INT_5_9_9_9_REV | UNSIGNED_INT_2_10_10_10_REV) {
        return true;
    }
    if matches!(target.wgpu, T::Rg11b10Ufloat | T::Rgb9e5Ufloat) {
        return false;
    }
    texel_bytes(format, ty) == Some(wgpu_texel_bytes(target.wgpu))
}

pub fn compressed(internal: u32) -> Option<(wgpu::TextureFormat, wgpu::Features)> {
    use wgpu::Features as F;
    Some(match internal {
        COMPRESSED_RGB_S3TC_DXT1_EXT | COMPRESSED_RGBA_S3TC_DXT1_EXT => (T::Bc1RgbaUnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RGBA_S3TC_DXT3_EXT => (T::Bc2RgbaUnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RGBA_S3TC_DXT5_EXT => (T::Bc3RgbaUnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_SRGB_S3TC_DXT1_EXT | COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT => (T::Bc1RgbaUnormSrgb, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT => (T::Bc2RgbaUnormSrgb, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT => (T::Bc3RgbaUnormSrgb, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RED_RGTC1_EXT => (T::Bc4RUnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_SIGNED_RED_RGTC1_EXT => (T::Bc4RSnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RED_GREEN_RGTC2_EXT => (T::Bc5RgUnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT => (T::Bc5RgSnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RGBA_BPTC_UNORM_EXT => (T::Bc7RgbaUnorm, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT => (T::Bc7RgbaUnormSrgb, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT => (T::Bc6hRgbFloat, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT => (T::Bc6hRgbUfloat, F::TEXTURE_COMPRESSION_BC),
        COMPRESSED_R11_EAC => (T::EacR11Unorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_SIGNED_R11_EAC => (T::EacR11Snorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_RG11_EAC => (T::EacRg11Unorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_SIGNED_RG11_EAC => (T::EacRg11Snorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_RGB8_ETC2 => (T::Etc2Rgb8Unorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_SRGB8_ETC2 => (T::Etc2Rgb8UnormSrgb, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2 => (T::Etc2Rgb8A1Unorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2 => (T::Etc2Rgb8A1UnormSrgb, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_RGBA8_ETC2_EAC => (T::Etc2Rgba8Unorm, F::TEXTURE_COMPRESSION_ETC2),
        COMPRESSED_SRGB8_ALPHA8_ETC2_EAC => (T::Etc2Rgba8UnormSrgb, F::TEXTURE_COMPRESSION_ETC2),
        0x93B0..=0x93BD => (astc(internal - 0x93B0, false)?, F::TEXTURE_COMPRESSION_ASTC),
        0x93D0..=0x93DD => (astc(internal - 0x93D0, true)?, F::TEXTURE_COMPRESSION_ASTC),
        _ => return None,
    })
}

fn astc(i: u32, srgb: bool) -> Option<wgpu::TextureFormat> {
    use wgpu::AstcBlock::*;
    let block = [B4x4, B5x4, B5x5, B6x5, B6x6, B8x5, B8x6, B8x8, B10x5, B10x6, B10x8, B10x10, B12x10, B12x12][i as usize];
    Some(T::Astc { block, channel: if srgb { wgpu::AstcChannel::UnormSrgb } else { wgpu::AstcChannel::Unorm } })
}

pub fn compressed_format(internal: u32, wgpu: wgpu::TextureFormat) -> Format {
    Format {
        internal,
        wgpu,
        class: Class::Float,
        renderable: false,
        filterable: true,
        expand: E::None,
        bits: [8, 8, 8, 8, 0, 0],
        component_type: UNSIGNED_NORMALIZED,
        srgb: wgpu.is_srgb(),
    }
}
