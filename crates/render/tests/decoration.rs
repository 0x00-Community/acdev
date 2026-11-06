use acde_render::acde_gpu::RenderCommand;
use acde_render::{Bar, Decoration, FrameButton};

fn bar(title: &str, width: f64, scale: f64) -> Bar {
    Bar { title: title.into(), width, height: 32.0, scale }
}

fn pixels(bar: &Bar) -> (Vec<u8>, u32) {
    let (w, h) = bar.pixels();
    (acde_render::gpu::rasterize(Decoration::new().scene(bar), (w, h)), w)
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
