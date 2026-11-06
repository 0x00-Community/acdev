use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::damage::OutputDamageTracker;
use smithay::backend::renderer::gles::GlesTexture;
use smithay::backend::renderer::{Bind, ExportMem, Offscreen};
use smithay::utils::{Rectangle, Transform};

use super::Compositor;
use super::backend::CLEAR;

impl Compositor {
    pub(super) fn capture(&mut self) -> Result<(u32, u32, Vec<u8>), String> {
        let output = self.backend.output.clone();
        let mode = output.current_mode().ok_or("输出没有模式")?;
        let scale = output.current_scale().fractional_scale();
        let elements = self.screen_elements(&output, matches!(self.backend.target, super::backend::Target::Drm(_)));
        let renderer = &mut self.backend.renderer;
        let size = mode.size;
        let mut texture: GlesTexture =
            renderer.create_buffer(Fourcc::Abgr8888, size.to_logical(1).to_buffer(1, Transform::Normal)).map_err(|e| e.to_string())?;
        let mut fb = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
        let mut damage = OutputDamageTracker::new(size, scale, Transform::Normal);
        damage.render_output(renderer, &mut fb, 0, &elements, CLEAR).map_err(|e| e.to_string())?;
        let mapping = renderer
            .copy_framebuffer(&fb, Rectangle::from_size(size.to_logical(1).to_buffer(1, Transform::Normal)), Fourcc::Abgr8888)
            .map_err(|e| e.to_string())?;
        let rgba = renderer.map_texture(&mapping).map_err(|e| e.to_string())?.to_vec();
        Ok((u32::try_from(size.w).unwrap_or(0), u32::try_from(size.h).unwrap_or(0), rgba))
    }

    pub(super) fn write_png(path: &std::path::Path, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())
    }
}
