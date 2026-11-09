use acde_gpu::{Glyph, PaintScene, Scene};
use kurbo::{Affine, BezPath, Circle, Line, Rect, Shape, Stroke, Vec2};
use parley::fontique::{Collection, CollectionOptions, SourceCache};
use parley::{FontContext, FontFamily, FontWeight, Layout, LayoutContext, LineHeight, PositionedLayoutItem, StyleProperty};
use peniko::{Color, Fill};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FrameStyle {
    #[default]
    Mac,
    Windows,
}

impl FrameStyle {
    pub fn current() -> Self {
        static STYLE: OnceLock<FrameStyle> = OnceLock::new();
        *STYLE.get_or_init(|| Self::parse(std::env::var("ACDE_FRAME_STYLE").ok().as_deref()))
    }

    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("mac") => FrameStyle::Mac,
            Some("windows") => FrameStyle::Windows,
            _ if cfg!(windows) => FrameStyle::Windows,
            _ => FrameStyle::Mac,
        }
    }

    pub fn reserved(self) -> f64 {
        match self {
            FrameStyle::Mac => Decoration::BUTTONS,
            FrameStyle::Windows => 3.0 * Decoration::CAPTION,
        }
    }

    pub fn grab_hints(self, w: f64, h: f64, top: f64) -> [([f64; 4], u32); 9] {
        let (e, c) = (Bar::EDGE, Bar::CORNER);
        let bar = match self {
            FrameStyle::Mac => [self.reserved(), 0.0, w - self.reserved(), top],
            FrameStyle::Windows => [0.0, 0.0, w - self.reserved(), top],
        };
        [
            (bar, 0),
            ([0.0, 0.0, w, e], 1),
            ([0.0, h - e, w, e], 2),
            ([0.0, 0.0, e, h], 4),
            ([w - e, 0.0, e, h], 8),
            ([0.0, 0.0, c, c], 1 | 4),
            ([w - c, 0.0, c, c], 1 | 8),
            ([0.0, h - c, c, c], 2 | 4),
            ([w - c, h - c, c, c], 2 | 8),
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameButton {
    Close,
    Minimize,
    Fullscreen,
}

impl FrameButton {
    pub const ALL: [FrameButton; 3] = [FrameButton::Close, FrameButton::Minimize, FrameButton::Fullscreen];

    pub fn key(self, fullscreen: bool) -> &'static str {
        match self {
            FrameButton::Close => "close",
            FrameButton::Minimize => "minimize",
            FrameButton::Fullscreen if fullscreen => "restore",
            FrameButton::Fullscreen => "fullscreen",
        }
    }

    fn index(self) -> usize {
        match self {
            FrameButton::Close => 0,
            FrameButton::Minimize => 1,
            FrameButton::Fullscreen => 2,
        }
    }

    fn caption(self) -> usize {
        match self {
            FrameButton::Minimize => 0,
            FrameButton::Fullscreen => 1,
            FrameButton::Close => 2,
        }
    }

    fn centre(self) -> f64 {
        Decoration::PAD + Decoration::DOT / 2.0 + self.index() as f64 * (Decoration::DOT + Decoration::GAP)
    }

    fn slot(self, style: FrameStyle, width: f64) -> (f64, f64) {
        match style {
            FrameStyle::Mac => {
                let reach = (Decoration::DOT + Decoration::GAP) / 2.0;
                (self.centre() - reach, self.centre() + reach)
            }
            FrameStyle::Windows => {
                let x = width - style.reserved() + self.caption() as f64 * Decoration::CAPTION;
                (x, x + Decoration::CAPTION)
            }
        }
    }

    fn color(self) -> Color {
        match self {
            FrameButton::Close => Color::from_rgb8(0xff, 0x5f, 0x57),
            FrameButton::Minimize => Color::from_rgb8(0xfe, 0xbc, 0x2e),
            FrameButton::Fullscreen => Color::from_rgb8(0x28, 0xc8, 0x40),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bar {
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub style: FrameStyle,
    pub fullscreen: bool,
}

impl Bar {
    const EDGE: f64 = 4.0;
    const CORNER: f64 = 10.0;

    pub fn grab_hints(w: f64, h: f64, top: f64) -> [([f64; 4], u32); 9] {
        FrameStyle::current().grab_hints(w, h, top)
    }

    pub fn pixels(&self) -> (u32, u32) {
        ((self.width * self.scale).round().max(1.0) as u32, (self.height * self.scale).round().max(1.0) as u32)
    }

    pub fn button_at(&self, x: f64, y: f64) -> Option<FrameButton> {
        if y < 0.0 || y >= self.height {
            return None;
        }
        FrameButton::ALL.into_iter().find(|b| {
            let (from, to) = b.slot(self.style, self.width);
            x >= from && x < to
        })
    }
}

pub struct Decoration {
    fonts: FontContext,
    layouts: LayoutContext<()>,
}

impl Default for Decoration {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoration {
    pub const BUTTONS: f64 = 76.0;
    pub const CAPTION: f64 = 46.0;
    const GLYPH: f64 = 10.0;
    const PAD: f64 = 12.0;
    const DOT: f64 = 12.0;
    const GAP: f64 = 8.0;
    const FONT_SIZE: f32 = 13.0;
    const FAMILY: &'static str = "system-ui, sans-serif";
    const ELLIPSIS: &'static str = "…";
    const BACKGROUND: Color = Color::from_rgb8(0xf4, 0xf2, 0xf7);
    const TEXT: Color = Color::from_rgb8(0x3a, 0x35, 0x42);
    const LINE: Color = Color::from_rgba8(0, 0, 0, 20);
    const RING: Color = Color::from_rgba8(0, 0, 0, 46);

    pub fn new() -> Self {
        let fonts =
            FontContext { source_cache: SourceCache::new_shared(), collection: Collection::new(CollectionOptions { shared: false, system_fonts: true }) };
        Self { fonts, layouts: LayoutContext::new() }
    }

    pub fn scene(&mut self, bar: &Bar) -> Scene {
        let mut scene = Scene::new();
        let scale = Affine::scale(bar.scale);
        let (w, h) = (bar.width, bar.height);
        scene.fill(Fill::NonZero, scale, Self::BACKGROUND, None, &Rect::new(0.0, 0.0, w, h));
        scene.fill(Fill::NonZero, scale, Self::LINE, None, &Rect::new(0.0, h - 1.0, w, h));
        for button in FrameButton::ALL {
            match bar.style {
                FrameStyle::Mac => {
                    let centre = (button.centre(), h / 2.0);
                    scene.fill(Fill::NonZero, scale, button.color(), None, &Circle::new(centre, Self::DOT / 2.0));
                    scene.stroke(&Stroke::new(0.5), scale, Self::RING, None, &Circle::new(centre, Self::DOT / 2.0 - 0.25));
                }
                FrameStyle::Windows => {
                    let (from, to) = button.slot(bar.style, w);
                    let glyph = Self::glyph(button, bar.fullscreen, ((from + to) / 2.0 - Self::GLYPH / 2.0).round(), ((h - Self::GLYPH) / 2.0).round());
                    scene.stroke(&Stroke::new(1.0), scale, Self::TEXT, None, &glyph);
                }
            }
        }
        self.title(&mut scene, bar);
        scene
    }

    fn glyph(button: FrameButton, fullscreen: bool, x: f64, y: f64) -> BezPath {
        let g = Self::GLYPH;
        let (l, t, r, b) = (x + 0.5, y + 0.5, x + g - 0.5, y + g - 0.5);
        let mut path = BezPath::new();
        match button {
            FrameButton::Minimize => path.extend(Line::new((l, y + g / 2.0 + 0.5), (r, y + g / 2.0 + 0.5)).path_elements(0.1)),
            FrameButton::Close => {
                path.extend(Line::new((l, t), (r, b)).path_elements(0.1));
                path.extend(Line::new((r, t), (l, b)).path_elements(0.1));
            }
            FrameButton::Fullscreen if fullscreen => {
                path.extend(Rect::new(l, t + 2.0, r - 2.0, b).path_elements(0.1));
                path.move_to((l + 2.0, t + 2.0));
                path.line_to((l + 2.0, t));
                path.line_to((r, t));
                path.line_to((r, b - 2.0));
                path.line_to((r - 2.0, b - 2.0));
            }
            FrameButton::Fullscreen => path.extend(Rect::new(l, t, r, b).path_elements(0.1)),
        }
        path
    }

    fn title(&mut self, scene: &mut Scene, bar: &Bar) {
        let (left, right) = match bar.style {
            FrameStyle::Mac => (Self::BUTTONS, Self::BUTTONS),
            FrameStyle::Windows => (Self::PAD, bar.style.reserved() + Self::PAD),
        };
        let room = (bar.width - left - right) * bar.scale;
        if bar.title.is_empty() || room <= 0.0 {
            return;
        }
        let mut layout = self.layout(&bar.title, bar.scale);
        if f64::from(layout.width()) > room {
            let cuts: Vec<usize> = bar.title.char_indices().map(|(i, _)| i).collect();
            let (mut fits, mut over) = (0, cuts.len());
            while over - fits > 1 {
                let mid = (fits + over) / 2;
                match f64::from(self.layout(&Self::cut(&bar.title, cuts[mid]), bar.scale).width()) <= room {
                    true => fits = mid,
                    false => over = mid,
                }
            }
            layout = self.layout(&Self::cut(&bar.title, cuts[fits]), bar.scale);
            if f64::from(layout.width()) > room {
                return;
            }
        }
        let Some(line) = layout.lines().next() else { return };
        let x = match bar.style {
            FrameStyle::Mac => (bar.width * bar.scale - f64::from(layout.width())) / 2.0,
            FrameStyle::Windows => left * bar.scale,
        };
        let y = (bar.height * bar.scale - f64::from(line.metrics().line_height)) / 2.0;
        let transform = Affine::translate((x, y));
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(run) = item else { continue };
            let glyphs = run.positioned_glyphs().map(|g| Glyph { id: g.id as _, x: g.x, y: g.y });
            let r = run.run();
            let coords: &[i16] = bytemuck::cast_slice(r.normalized_coords());
            scene.draw_glyphs(r.font(), r.font_size(), false, coords, Vec2::ZERO, Fill::NonZero, Self::TEXT, 1.0, transform, None, glyphs);
        }
    }

    fn cut(title: &str, at: usize) -> String {
        format!("{}{}", title[..at].trim_end(), Self::ELLIPSIS)
    }

    fn layout(&mut self, text: &str, scale: f64) -> Layout<()> {
        let mut builder = self.layouts.ranged_builder(&mut self.fonts, text, scale as f32, true);
        builder.push_default(StyleProperty::FontFamily(FontFamily::from(Self::FAMILY)));
        builder.push_default(StyleProperty::FontSize(Self::FONT_SIZE));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(600.0)));
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(1.0)));
        builder.push_default(StyleProperty::Locale(parley::Language::parse("zh-Hans").ok()));
        let mut layout = builder.build(text);
        layout.break_all_lines(None);
        layout
    }
}
