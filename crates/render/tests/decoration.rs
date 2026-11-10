use acde_gpu::RenderCommand;
use acde_render::{Bar, ButtonSide, Decoration, FrameButton, FrameColors, FrameStyle, FrameTheme, TitleAlign};

mod common;

fn bar(title: &str, width: f64, scale: f64) -> Bar {
    Bar {
        title: title.into(),
        width,
        height: 32.0,
        scale,
        style: FrameStyle::Mac,
        fullscreen: false,
        theme: FrameTheme::default(),
        active: true,
        minimize: true,
    }
}

fn windows(title: &str, width: f64, scale: f64) -> Bar {
    Bar { style: FrameStyle::Windows, ..bar(title, width, scale) }
}

fn pixels(bar: &Bar) -> (Vec<u8>, u32) {
    let (w, h) = bar.pixels();
    (common::rasterize(Decoration::new().scene(bar), (w, h)), w)
}

fn rgb((pixels, width): &(Vec<u8>, u32), x: f64, y: f64) -> [u8; 3] {
    let i = ((y as usize) * *width as usize + x as usize) * 4;
    [pixels[i], pixels[i + 1], pixels[i + 2]]
}

fn glyph_runs(bar: &Bar) -> Vec<(f64, usize)> {
    Decoration::new()
        .scene(bar)
        .commands
        .iter()
        .filter_map(|c| match c {
            RenderCommand::GlyphRun(run) => Some((run.transform.translation().x + f64::from(run.glyphs[0].x), run.glyphs.len())),
            _ => None,
        })
        .collect()
}

fn glyph_count(bar: &Bar) -> usize {
    glyph_runs(bar).iter().map(|(_, n)| n).sum()
}

#[test]
fn the_bar_has_its_background_buttons_and_line() {
    for scale in [1.0, 2.0] {
        let b = bar("", 300.0, scale);
        assert_eq!(b.pixels(), ((300.0 * scale) as u32, (32.0 * scale) as u32));
        let px = pixels(&b);
        assert_eq!(rgb(&px, 150.0 * scale, 10.0 * scale), [0xf4, 0xf2, 0xf7]);
        assert_eq!(rgb(&px, 18.0 * scale, 16.0 * scale), [0xff, 0x5f, 0x57]);
        assert_eq!(rgb(&px, 38.0 * scale, 16.0 * scale), [0xfe, 0xbc, 0x2e]);
        assert_eq!(rgb(&px, 58.0 * scale, 16.0 * scale), [0x28, 0xc8, 0x40]);
        let line = rgb(&px, 150.0 * scale, 32.0 * scale - 1.0);
        assert!(line[0] < 0xf4 && line[0] > 0xd0, "the bottom line is a faint shade: {line:?}");
    }
}

#[test]
fn the_title_is_centred_on_the_bar() {
    let runs = glyph_runs(&bar("Notes", 400.0, 1.0));
    assert!(!runs.is_empty());
    let start = runs[0].0;
    assert!(start > 160.0 && start < 200.0, "{runs:?}");
}

#[test]
fn a_long_title_ends_in_an_ellipsis_within_the_buttons_margins() {
    let title = "A very long window title that cannot possibly fit in a narrow window";
    let wide = glyph_count(&bar(title, 2000.0, 1.0));
    let narrow = glyph_runs(&bar(title, 260.0, 1.0));
    let count: usize = narrow.iter().map(|(_, n)| n).sum();
    assert!(count > 0 && count < wide, "{count} of {wide}");
    assert!(narrow[0].0 >= Decoration::BUTTONS - 0.5, "{narrow:?}");
    assert_eq!(glyph_count(&bar(title, 150.0, 1.0)), 0, "no room left between the button areas");
}

#[test]
fn buttons_are_hit_in_their_slots_only() {
    let b = bar("x", 300.0, 2.0);
    assert_eq!(b.button_at(18.0, 16.0), Some(FrameButton::Close));
    assert_eq!(b.button_at(9.0, 3.0), Some(FrameButton::Close));
    assert_eq!(b.button_at(38.0, 16.0), Some(FrameButton::Minimize));
    assert_eq!(b.button_at(58.0, 30.0), Some(FrameButton::Fullscreen));
    assert_eq!(b.button_at(70.0, 16.0), None);
    assert_eq!(b.button_at(150.0, 16.0), None);
    assert_eq!(b.button_at(18.0, 32.0), None);
    assert_eq!(b.button_at(18.0, -1.0), None);
}

#[test]
fn the_style_comes_from_its_name_or_the_platform() {
    for session in [false, true] {
        assert_eq!(FrameStyle::parse(Some("mac"), session), FrameStyle::Mac);
        assert_eq!(FrameStyle::parse(Some("windows"), session), FrameStyle::Windows);
    }
    let native = if cfg!(windows) { FrameStyle::Windows } else { FrameStyle::Mac };
    assert_eq!(FrameStyle::parse(None, false), native);
    assert_eq!(FrameStyle::parse(Some("gnome"), false), native);
}

#[test]
fn a_full_desktop_draws_the_session_style_on_every_platform() {
    assert_eq!(FrameStyle::parse(None, true), FrameStyle::Mac);
    assert_eq!(FrameStyle::parse(Some("gnome"), true), FrameStyle::Mac);
}

#[test]
fn windows_buttons_sit_on_the_right_as_minimize_maximize_close() {
    let b = windows("x", 400.0, 2.0);
    assert_eq!(b.button_at(400.0 - 138.0, 16.0), Some(FrameButton::Minimize));
    assert_eq!(b.button_at(400.0 - 93.0, 1.0), Some(FrameButton::Minimize));
    assert_eq!(b.button_at(400.0 - 92.0, 16.0), Some(FrameButton::Fullscreen));
    assert_eq!(b.button_at(400.0 - 46.0, 31.0), Some(FrameButton::Close));
    assert_eq!(b.button_at(399.0, 16.0), Some(FrameButton::Close));
    assert_eq!(b.button_at(400.0 - 139.0, 16.0), None);
    assert_eq!(b.button_at(18.0, 16.0), None);
    assert_eq!(b.button_at(399.0, 32.0), None);
}

#[test]
fn windows_bar_draws_glyphs_not_dots_and_a_left_title() {
    for scale in [1.0, 2.0] {
        let b = windows("", 300.0, scale);
        let px = pixels(&b);
        assert_eq!(rgb(&px, 18.0 * scale, 16.0 * scale), [0xf4, 0xf2, 0xf7], "no traffic lights");
        let ink = |x: f64, y: f64| rgb(&px, x * scale, y * scale)[0] < 0xc0;
        let close = 300.0 - 23.0;
        assert!(ink(close - 0.5, 15.5) || ink(close, 16.0) || ink(close - 1.0, 15.0), "the close cross");
        assert!(ink(300.0 - 69.0 - 4.5, 11.5), "the maximize square's top edge");
        assert!(!ink(300.0 - 69.0, 16.0), "the maximize square is hollow");
    }
    let runs = glyph_runs(&windows("Notes", 400.0, 1.0));
    assert!(!runs.is_empty());
    assert!(runs[0].0 >= 11.0 && runs[0].0 < 20.0, "{runs:?}");
    let title = "A very long window title that cannot possibly fit in a narrow window";
    let narrow = glyph_runs(&windows(title, 260.0, 1.0));
    let end = narrow.last().map(|(x, _)| *x).unwrap_or(0.0);
    assert!(end < 260.0 - 138.0, "{narrow:?}");
}

#[test]
fn windows_maximize_turns_into_restore_when_fullscreen() {
    let corner = |b: &Bar| rgb(&pixels(b), 226.0, 11.0)[0] < 0xc0;
    assert!(corner(&windows("", 300.0, 1.0)), "maximize: one square from the glyph's corner");
    assert!(!corner(&Bar { fullscreen: true, ..windows("", 300.0, 1.0) }), "restore: two squares, the corner left open");
    assert_eq!(FrameButton::Fullscreen.key(true), "restore");
}

#[test]
fn windows_grab_hints_leave_the_buttons_on_the_right() {
    let hints = FrameStyle::Windows.grab_hints(640.0, 480.0, 32.0);
    assert_eq!(hints[0], ([0.0, 0.0, 640.0 - 138.0, 32.0], 0));
    let mac = FrameStyle::Mac.grab_hints(640.0, 480.0, 32.0);
    assert_eq!(mac[0], ([76.0, 0.0, 564.0, 32.0], 0));
}

fn themed(style: FrameStyle, theme: FrameTheme, active: bool) -> Bar {
    Bar { style, theme, active, ..bar("", 300.0, 1.0) }
}

const DARK: FrameColors = FrameColors { background: Some([0x20, 0x22, 0x28, 0xff]), title: Some([0xee, 0xee, 0xee, 0xff]), line: None, buttons: None };

#[test]
fn a_theme_colours_the_bar_for_active_and_inactive_windows() {
    let theme =
        FrameTheme { active: DARK, inactive: FrameColors { background: Some([0x40, 0x40, 0x40, 0xff]), ..FrameColors::default() }, ..FrameTheme::default() };
    assert_eq!(rgb(&pixels(&themed(FrameStyle::Mac, theme, true)), 150.0, 10.0), [0x20, 0x22, 0x28]);
    assert_eq!(rgb(&pixels(&themed(FrameStyle::Mac, theme, false)), 150.0, 10.0), [0x40, 0x40, 0x40]);
    let only_active = FrameTheme { active: DARK, ..FrameTheme::default() };
    assert_eq!(rgb(&pixels(&themed(FrameStyle::Mac, only_active, false)), 150.0, 10.0), [0x20, 0x22, 0x28], "inactive falls back to active");
    assert_eq!(rgb(&pixels(&themed(FrameStyle::Mac, FrameTheme::default(), false)), 150.0, 10.0), [0xf4, 0xf2, 0xf7], "no theme keeps today's look");
    let glyphs = FrameTheme { active: FrameColors { buttons: Some([0xff, 0, 0, 0xff]), ..DARK }, ..FrameTheme::default() };
    let px = pixels(&themed(FrameStyle::Windows, glyphs, true));
    assert_eq!(rgb(&px, 300.0 - 69.0 - 4.5, 11.5), [0xff, 0, 0], "the button colour draws the glyphs");
}

#[test]
fn the_theme_moves_the_buttons_and_their_hits() {
    let right = FrameTheme { style: Some(FrameStyle::Mac), side: Some(ButtonSide::Right), ..FrameTheme::default() };
    let b = themed(FrameStyle::Windows, right, true);
    assert_eq!(b.button_at(300.0 - 76.0 + 18.0, 16.0), Some(FrameButton::Close));
    assert_eq!(b.button_at(300.0 - 76.0 + 58.0, 16.0), Some(FrameButton::Fullscreen));
    assert_eq!(b.button_at(18.0, 16.0), None);
    assert_eq!(rgb(&pixels(&b), 300.0 - 76.0 + 18.0, 16.0), [0xff, 0x5f, 0x57], "the close dot is drawn where it is hit");
    assert_eq!(right.grab_hints(640.0, 480.0, 32.0)[0], ([0.0, 0.0, 640.0 - 76.0, 32.0], 0));
    let left = FrameTheme { style: Some(FrameStyle::Windows), side: Some(ButtonSide::Left), ..FrameTheme::default() };
    let b = themed(FrameStyle::Mac, left, true);
    assert_eq!(b.button_at(10.0, 16.0), Some(FrameButton::Minimize));
    assert_eq!(b.button_at(100.0, 16.0), Some(FrameButton::Close));
    assert_eq!(b.button_at(299.0, 16.0), None);
    assert_eq!(left.grab_hints(640.0, 480.0, 32.0)[0], ([138.0, 0.0, 640.0 - 138.0, 32.0], 0));
}

#[test]
fn the_theme_aligns_the_title() {
    let start = FrameTheme { style: Some(FrameStyle::Mac), align: Some(TitleAlign::Start), ..FrameTheme::default() };
    let runs = glyph_runs(&Bar { title: "Notes".into(), width: 400.0, ..themed(FrameStyle::Mac, start, true) });
    assert!(runs[0].0 >= 76.0 + 11.0 && runs[0].0 < 76.0 + 20.0, "after the buttons on the left: {runs:?}");
    let centre = FrameTheme { style: Some(FrameStyle::Windows), align: Some(TitleAlign::Center), ..FrameTheme::default() };
    let runs = glyph_runs(&Bar { title: "Notes".into(), width: 400.0, ..themed(FrameStyle::Windows, centre, true) });
    assert!(runs[0].0 > 160.0 && runs[0].0 < 200.0, "{runs:?}");
}

#[test]
fn a_disabled_minimize_button_is_dimmed_and_not_hit() {
    let off = Bar { minimize: false, ..bar("", 300.0, 1.0) };
    assert_eq!(off.button_at(38.0, 16.0), None);
    assert_eq!(off.button_at(18.0, 16.0), Some(FrameButton::Close));
    assert_ne!(rgb(&pixels(&off), 38.0, 16.0), [0xfe, 0xbc, 0x2e], "not the live yellow");
    let glyphs = Bar { minimize: false, ..windows("", 400.0, 1.0) };
    assert_eq!(glyphs.button_at(400.0 - 138.0, 16.0), None);
    assert_eq!(glyphs.button_at(399.0, 16.0), Some(FrameButton::Close));
}
