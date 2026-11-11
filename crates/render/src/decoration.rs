use acde_gpu::{Glyph, PaintScene, Scene};
use kurbo::{Affine, BezPath, Circle, Line, Rect, Shape, Stroke, Vec2};
use parley::fontique::{Collection, CollectionOptions, SourceCache};
use parley::{FontContext, FontFamily, FontWeight, Layout, LayoutContext, LineHeight, PositionedLayoutItem, StyleProperty};
use peniko::{Color, Fill};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FrameStyle {
    #[default]
    Mac,
    Windows,
}

static SESSION: AtomicBool = AtomicBool::new(false);

impl FrameStyle {
    pub fn current() -> Self {
        static NAMED: OnceLock<Option<FrameStyle>> = OnceLock::new();
        let named = *NAMED.get_or_init(|| Self::named(std::env::var("ACDE_FRAME_STYLE").ok().as_deref()));
        named.unwrap_or_else(|| Self::native(SESSION.load(Ordering::Relaxed)))
    }

    pub fn follow_session() {
        SESSION.store(true, Ordering::Relaxed);
    }

    pub fn parse(value: Option<&str>, session: bool) -> Self {
        Self::named(value).unwrap_or_else(|| Self::native(session))
    }

    fn named(value: Option<&str>) -> Option<Self> {
        match value {
            Some("mac") => Some(FrameStyle::Mac),
            Some("windows") => Some(FrameStyle::Windows),
            _ => None,
        }
    }

    fn native(session: bool) -> Self {
        match cfg!(windows) && !session {
            true => FrameStyle::Windows,
            false => FrameStyle::Mac,
        }
    }

    pub fn reserved(self) -> f64 {
        match self {
            FrameStyle::Mac => Decoration::BUTTONS,
            FrameStyle::Windows => 3.0 * Decoration::CAPTION,
        }
    }

    pub fn side(self) -> ButtonSide {
        match self {
            FrameStyle::Mac => ButtonSide::Left,
            FrameStyle::Windows => ButtonSide::Right,
        }
    }

    pub fn align(self) -> TitleAlign {
        match self {
            FrameStyle::Mac => TitleAlign::Center,
            FrameStyle::Windows => TitleAlign::Start,
        }
    }

    pub fn grab_hints(self, w: f64, h: f64, top: f64) -> [([f64; 4], u32); 9] {
        FrameTheme { style: Some(self), ..FrameTheme::default() }.grab_hints(w, h, top)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonSide {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TitleAlign {
    Center,
    Start,
}

pub type Rgba = [u8; 4];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameColors {
    pub background: Option<Rgba>,
    pub title: Option<Rgba>,
    pub line: Option<Rgba>,
    pub buttons: Option<Rgba>,
}

impl FrameColors {
    fn or(self, other: FrameColors) -> FrameColors {
        FrameColors {
            background: self.background.or(other.background),
            title: self.title.or(other.title),
            line: self.line.or(other.line),
            buttons: self.buttons.or(other.buttons),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameTheme {
    pub active: FrameColors,
    pub inactive: FrameColors,
    pub light: [FrameColors; 2],
    pub style: Option<FrameStyle>,
    pub side: Option<ButtonSide>,
    pub align: Option<TitleAlign>,
}

impl FrameTheme {
    const DEFAULT: FrameColors =
        FrameColors { background: Some([0xf4, 0xf2, 0xf7, 0xff]), title: Some([0x3a, 0x35, 0x42, 0xff]), line: Some([0, 0, 0, 20]), buttons: None };

    pub fn style(&self) -> FrameStyle {
        self.style.unwrap_or_else(FrameStyle::current)
    }

    pub fn side(&self) -> ButtonSide {
        self.side.unwrap_or_else(|| self.style().side())
    }

    pub fn colors(&self, active: bool, dark_page: bool) -> FrameColors {
        let none = FrameColors::default();
        let [on, off] = if dark_page || self.light == [none; 2] { [self.active, self.inactive] } else { self.light };
        let chosen = if active { on } else { off.or(on) };
        chosen.or(Self::DEFAULT)
    }

    pub fn grab_hints(&self, w: f64, h: f64, top: f64) -> [([f64; 4], u32); 9] {
        let (e, c) = (Bar::EDGE, Bar::CORNER);
        let reserved = self.style().reserved();
        let bar = match self.side() {
            ButtonSide::Left => [reserved, 0.0, w - reserved, top],
            ButtonSide::Right => [0.0, 0.0, w - reserved, top],
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

    fn slot(self, style: FrameStyle, side: ButtonSide, width: f64) -> (f64, f64) {
        let start = match side {
            ButtonSide::Left => 0.0,
            ButtonSide::Right => width - style.reserved(),
        };
        match style {
            FrameStyle::Mac => {
                let reach = (Decoration::DOT + Decoration::GAP) / 2.0;
                (start + self.centre() - reach, start + self.centre() + reach)
            }
            FrameStyle::Windows => {
                let x = start + self.caption() as f64 * Decoration::CAPTION;
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
    pub theme: FrameTheme,
    pub active: bool,
    pub dark_page: bool,
    pub minimize: bool,
}

impl Bar {
    const EDGE: f64 = 4.0;
    const CORNER: f64 = 10.0;

    pub fn grab_hints(w: f64, h: f64, top: f64) -> [([f64; 4], u32); 9] {
        FrameStyle::current().grab_hints(w, h, top)
    }

    fn style(&self) -> FrameStyle {
        self.theme.style.unwrap_or(self.style)
    }

    fn side(&self) -> ButtonSide {
        self.theme.side.unwrap_or_else(|| self.style().side())
    }

    fn align(&self) -> TitleAlign {
        self.theme.align.unwrap_or_else(|| self.style().align())
    }

    pub fn pixels(&self) -> (u32, u32) {
        ((self.width * self.scale).round().max(1.0) as u32, (self.height * self.scale).round().max(1.0) as u32)
    }

    pub fn button_at(&self, x: f64, y: f64) -> Option<FrameButton> {
        if y < 0.0 || y >= self.height {
            return None;
        }
        FrameButton::ALL.into_iter().filter(|b| self.minimize || *b != FrameButton::Minimize).find(|b| {
            let (from, to) = b.slot(self.style(), self.side(), self.width);
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
    const RING: Color = Color::from_rgba8(0, 0, 0, 46);
    const OFF: Color = Color::from_rgba8(0, 0, 0, 40);

    pub fn new() -> Self {
        let fonts =
            FontContext { source_cache: SourceCache::new_shared(), collection: Collection::new(CollectionOptions { shared: false, system_fonts: true }) };
        Self { fonts, layouts: LayoutContext::new() }
    }

    pub fn scene(&mut self, bar: &Bar) -> Scene {
        let mut scene = Scene::new();
        let scale = Affine::scale(bar.scale);
        let (w, h) = (bar.width, bar.height);
        let colors = bar.theme.colors(bar.active, bar.dark_page);
        let paint = |rgba: Rgba| Color::from_rgba8(rgba[0], rgba[1], rgba[2], rgba[3]);
        let text = colors.title.map_or(Color::TRANSPARENT, paint);
        scene.fill(Fill::NonZero, scale, colors.background.map_or(Color::TRANSPARENT, paint), None, &Rect::new(0.0, 0.0, w, h));
        scene.fill(Fill::NonZero, scale, colors.line.map_or(Color::TRANSPARENT, paint), None, &Rect::new(0.0, h - 1.0, w, h));
        let (style, side) = (bar.style(), bar.side());
        for button in FrameButton::ALL {
            let (from, to) = button.slot(style, side, w);
            match style {
                FrameStyle::Mac => {
                    let centre = ((from + to) / 2.0, h / 2.0);
                    let fill = if bar.minimize || button != FrameButton::Minimize { colors.buttons.map_or_else(|| button.color(), paint) } else { Self::OFF };
                    scene.fill(Fill::NonZero, scale, fill, None, &Circle::new(centre, Self::DOT / 2.0));
                    scene.stroke(&Stroke::new(0.5), scale, Self::RING, None, &Circle::new(centre, Self::DOT / 2.0 - 0.25));
                }
                FrameStyle::Windows => {
                    let glyph = Self::glyph(button, bar.fullscreen, ((from + to) / 2.0 - Self::GLYPH / 2.0).round(), ((h - Self::GLYPH) / 2.0).round());
                    let ink = if bar.minimize || button != FrameButton::Minimize { colors.buttons.map_or(text, paint) } else { Self::OFF };
                    scene.stroke(&Stroke::new(1.0), scale, ink, None, &glyph);
                }
            }
        }
        self.title(&mut scene, bar, text);
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

    fn title(&mut self, scene: &mut Scene, bar: &Bar, color: Color) {
        let reserved = bar.style().reserved();
        let (left, right) = match (bar.align(), bar.side()) {
            (TitleAlign::Center, _) => (reserved, reserved),
            (TitleAlign::Start, ButtonSide::Right) => (Self::PAD, reserved + Self::PAD),
            (TitleAlign::Start, ButtonSide::Left) => (reserved + Self::PAD, Self::PAD),
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
        let x = match bar.align() {
            TitleAlign::Center => (bar.width * bar.scale - f64::from(layout.width())) / 2.0,
            TitleAlign::Start => left * bar.scale,
        };
        let y = (bar.height * bar.scale - f64::from(line.metrics().line_height)) / 2.0;
        let transform = Affine::translate((x, y));
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(run) = item else { continue };
            let glyphs = run.positioned_glyphs().map(|g| Glyph { id: g.id as _, x: g.x, y: g.y });
            let r = run.run();
            let coords: &[i16] = bytemuck::cast_slice(r.normalized_coords());
            scene.draw_glyphs(r.font(), r.font_size(), false, coords, Vec2::ZERO, Fill::NonZero, color, 1.0, transform, None, glyphs);
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
