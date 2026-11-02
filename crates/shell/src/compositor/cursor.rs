use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::Kind;
use smithay::backend::renderer::element::memory::{MemoryRenderBuffer, MemoryRenderBufferRenderElement};
use smithay::backend::renderer::element::surface::render_elements_from_surface_tree;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::input::pointer::{CursorImageAttributes, CursorImageStatus};
use smithay::utils::{Logical, Point, Transform};
use smithay::wayland::compositor::with_states;

use super::backend::Elements;

pub struct Cursor {
    pub status: CursorImageStatus,
    arrow: Option<(MemoryRenderBuffer, Point<i32, Logical>)>,
}

impl Default for Cursor {
    fn default() -> Self {
        let arrow = Self::load_arrow();
        if arrow.is_none() {
            log::warn!("光标主题里没有箭头 (XCURSOR_THEME / XCURSOR_PATH, 缺 adwaita-cursors?): 不画默认光标");
        }
        Self { status: CursorImageStatus::default_named(), arrow }
    }
}

impl Cursor {
    fn load_arrow() -> Option<(MemoryRenderBuffer, Point<i32, Logical>)> {
        let theme = xcursor::CursorTheme::load(&std::env::var("XCURSOR_THEME").unwrap_or_else(|_| "default".into()));
        let size: u32 = std::env::var("XCURSOR_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(24);
        let path = theme.load_icon("left_ptr").or_else(|| theme.load_icon("default"))?;
        let data = std::fs::read(path).ok()?;
        let images = xcursor::parser::parse_xcursor(&data)?;
        let image = images.iter().min_by_key(|i| i.size.abs_diff(size))?;
        let (w, h) = (i32::try_from(image.width).ok()?, i32::try_from(image.height).ok()?);
        let buffer = MemoryRenderBuffer::from_slice(&image.pixels_rgba, Fourcc::Abgr8888, (w, h), 1, Transform::Normal, None);
        let hotspot = (i32::try_from(image.xhot).ok()?, i32::try_from(image.yhot).ok()?).into();
        Some((buffer, hotspot))
    }

    pub fn elements(&self, renderer: &mut GlesRenderer, pos: Point<f64, Logical>, scale: f64) -> Vec<Elements> {
        match &self.status {
            CursorImageStatus::Hidden => Vec::new(),
            CursorImageStatus::Surface(surface) => {
                let hotspot = with_states(surface, |states| {
                    states.data_map.get::<std::sync::Mutex<CursorImageAttributes>>().map(|a| a.lock().expect("光标属性锁").hotspot)
                })
                .unwrap_or_default();
                let at = (pos - hotspot.to_f64()).to_physical(scale).to_i32_round();
                render_elements_from_surface_tree(renderer, surface, at, scale, 1.0, Kind::Cursor).into_iter().map(Elements::Surface).collect()
            }
            CursorImageStatus::Named(_) => {
                let Some((buffer, hotspot)) = &self.arrow else { return Vec::new() };
                let at = (pos - hotspot.to_f64()).to_physical(scale);
                MemoryRenderBufferRenderElement::from_buffer(renderer, at, buffer, None, None, None, Kind::Cursor)
                    .map(|e| vec![Elements::Memory(e)])
                    .unwrap_or_default()
            }
        }
    }
}
