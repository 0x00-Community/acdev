use std::collections::HashMap;

use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::Kind;
use smithay::backend::renderer::element::memory::{MemoryRenderBuffer, MemoryRenderBufferRenderElement};
use smithay::backend::renderer::element::surface::render_elements_from_surface_tree;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::input::pointer::{CursorIcon, CursorImageAttributes, CursorImageStatus};
use smithay::utils::{Logical, Point, Transform};
use smithay::wayland::compositor::with_states;

use super::backend::Elements;

type Image = (MemoryRenderBuffer, Point<i32, Logical>);

pub struct Cursor {
    pub status: CursorImageStatus,
    pub hover: Option<CursorIcon>,
    pub drag: Option<CursorIcon>,
    theme: xcursor::CursorTheme,
    size: u32,
    images: HashMap<CursorIcon, Option<Image>>,
}

impl Default for Cursor {
    fn default() -> Self {
        let theme = xcursor::CursorTheme::load(&std::env::var("XCURSOR_THEME").unwrap_or_else(|_| "default".into()));
        let size = std::env::var("XCURSOR_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(24);
        let mut cursor = Self { status: CursorImageStatus::default_named(), hover: None, drag: None, theme, size, images: HashMap::new() };
        if cursor.image(CursorIcon::Default).is_none() {
            log::warn!("光标主题里没有箭头 (XCURSOR_THEME / XCURSOR_PATH, 缺 adwaita-cursors?): 不画默认光标");
        }
        cursor
    }
}

impl Cursor {
    fn load(&self, icon: CursorIcon) -> Option<Image> {
        let names = std::iter::once(icon.name()).chain(icon.alt_names().iter().copied());
        let names: Vec<&str> = match icon {
            CursorIcon::Default => names.chain(["left_ptr"]).collect(),
            _ => names.collect(),
        };
        let path = names.iter().find_map(|n| self.theme.load_icon(n))?;
        let data = std::fs::read(path).ok()?;
        let images = xcursor::parser::parse_xcursor(&data)?;
        let image = images.iter().min_by_key(|i| i.size.abs_diff(self.size))?;
        let (w, h) = (i32::try_from(image.width).ok()?, i32::try_from(image.height).ok()?);
        let buffer = MemoryRenderBuffer::from_slice(&image.pixels_rgba, Fourcc::Abgr8888, (w, h), 1, Transform::Normal, None);
        let hotspot = (i32::try_from(image.xhot).ok()?, i32::try_from(image.yhot).ok()?).into();
        Some((buffer, hotspot))
    }

    fn image(&mut self, icon: CursorIcon) -> Option<Image> {
        if !self.images.contains_key(&icon) {
            let image = self.load(icon);
            if image.is_none() && icon != CursorIcon::Default {
                log::debug!("光标主题里没有 {}: 画箭头", icon.name());
            }
            self.images.insert(icon, image);
        }
        self.images[&icon].clone().or_else(|| if icon == CursorIcon::Default { None } else { self.image(CursorIcon::Default) })
    }

    pub fn elements(&mut self, renderer: &mut GlesRenderer, pos: Point<f64, Logical>, scale: f64) -> Vec<Elements> {
        let icon = match (self.drag.or(self.hover), &self.status) {
            (Some(icon), _) => icon,
            (None, CursorImageStatus::Named(icon)) => *icon,
            (None, CursorImageStatus::Hidden) => return Vec::new(),
            (None, CursorImageStatus::Surface(surface)) => {
                let hotspot = with_states(surface, |states| {
                    states.data_map.get::<std::sync::Mutex<CursorImageAttributes>>().map(|a| a.lock().expect("光标属性锁").hotspot)
                })
                .unwrap_or_default();
                let at = (pos - hotspot.to_f64()).to_physical(scale).to_i32_round();
                return render_elements_from_surface_tree(renderer, surface, at, scale, 1.0, Kind::Cursor).into_iter().map(Elements::Surface).collect();
            }
        };
        let Some((buffer, hotspot)) = self.image(icon) else { return Vec::new() };
        let at = (pos - hotspot.to_f64()).to_physical(scale);
        MemoryRenderBufferRenderElement::from_buffer(renderer, at, &buffer, None, None, None, Kind::Cursor)
            .map(|e| vec![Elements::Memory(e)])
            .unwrap_or_default()
    }

    pub fn for_edges(edges: u32) -> CursorIcon {
        use super::grabs::{BOTTOM, LEFT, RIGHT, TOP};
        match (edges & (TOP | BOTTOM), edges & (LEFT | RIGHT)) {
            (0, 0) => CursorIcon::Grabbing,
            (TOP, LEFT) => CursorIcon::NwResize,
            (TOP, RIGHT) => CursorIcon::NeResize,
            (BOTTOM, LEFT) => CursorIcon::SwResize,
            (BOTTOM, RIGHT) => CursorIcon::SeResize,
            (TOP, _) => CursorIcon::NResize,
            (BOTTOM, _) => CursorIcon::SResize,
            (_, LEFT) => CursorIcon::WResize,
            _ => CursorIcon::EResize,
        }
    }
}
