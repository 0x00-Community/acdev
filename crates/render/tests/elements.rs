use acde_gpu::RenderCommand;
use acde_render::{Options, Rect};

mod common;
use common::{Doc, near};

const W: u32 = 480;
const H: u32 = 320;

fn page(html: &str) -> Doc {
    let doc = Doc::new(W, H, 1.0, &Options::default()).unwrap();
    doc.dom.parse_document(html).unwrap();
    doc.commit();
    doc
}

fn rect(doc: &Doc, id: &str) -> Rect {
    doc.rect(doc.dom.get_element_by_id(id)).unwrap()
}

fn pixels(doc: &Doc) -> Vec<u8> {
    common::rasterize(doc.scene(), (W, H))
}

fn rgb(pixels: &[u8], x: f64, y: f64) -> [u8; 3] {
    let i = ((y as usize) * W as usize + x as usize) * 4;
    [pixels[i], pixels[i + 1], pixels[i + 2]]
}

const FIELDSET: &str = "<!doctype html><style>
    body { margin: 0; font: 16px/20px monospace; }
    fieldset { margin: 10px; padding: 8px; border: 4px solid rgb(255, 0, 0); width: 300px; }
    legend { padding: 0 2px; }
    .item { width: 50px; height: 30px; }
</style>";

#[test]
fn legend_of_a_flex_fieldset_sits_on_the_border_not_in_the_row() {
    let doc = page(&format!(
        "{FIELDSET}<style>fieldset {{ display: flex; gap: 6px; }}</style>
        <fieldset id=f><legend id=l>Title</legend><div class=item id=a></div><div class=item id=b></div></fieldset>"
    ));
    let (f, l, a, b) = (rect(&doc, "f"), rect(&doc, "l"), rect(&doc, "a"), rect(&doc, "b"));
    assert!(near(l.y, f.y), "the legend's top is the fieldset's: {l:?} {f:?}");
    assert!(near(l.height, 20.0), "{l:?}");
    assert!(near(l.x, f.x + 4.0 + 8.0), "the legend starts at the content edge: {l:?} {f:?}");
    assert!(l.width < 100.0, "the legend shrinks to fit: {l:?}");
    assert!(near(a.x, f.x + 4.0 + 8.0), "the first item starts the row: {a:?} {f:?}");
    assert!(near(b.x, a.x + 50.0 + 6.0), "the items share one row: {a:?} {b:?}");
    assert!(near(a.y, b.y), "{a:?} {b:?}");
    assert!(near(a.y, f.y + 20.0 + 8.0), "the row starts below the legend: {a:?} {f:?}");
    assert!(near(f.height, 20.0 + 8.0 + 30.0 + 8.0 + 4.0), "{f:?}");
}

#[test]
fn legend_of_a_block_fieldset_is_above_the_content() {
    let doc = page(&format!("{FIELDSET}<fieldset id=f><legend id=l>Title</legend><div class=item id=a></div></fieldset>"));
    let (f, l, a) = (rect(&doc, "f"), rect(&doc, "l"), rect(&doc, "a"));
    assert!(near(l.y, f.y), "{l:?} {f:?}");
    assert!(l.width < 100.0, "the legend shrinks to fit: {l:?}");
    assert!(near(a.y, f.y + 20.0 + 8.0), "{a:?} {f:?}");
    assert!(near(f.height, 20.0 + 8.0 + 30.0 + 8.0 + 4.0), "{f:?}");
}

#[test]
fn a_thick_border_centres_the_legend() {
    let doc = page(&format!(
        "{FIELDSET}<style>fieldset {{ border-width: 30px; }}</style>
        <fieldset id=f><legend id=l>Title</legend><div class=item id=a></div></fieldset>"
    ));
    let (f, l, a) = (rect(&doc, "f"), rect(&doc, "l"), rect(&doc, "a"));
    assert!(near(l.y, f.y + 5.0), "{l:?} {f:?}");
    assert!(near(a.y, f.y + 30.0 + 8.0), "{a:?} {f:?}");
}

#[test]
fn floated_or_positioned_legends_are_not_rendered_legends() {
    let doc = page(&format!(
        "{FIELDSET}<style>#l {{ float: left; }}</style>
        <fieldset id=f><legend id=l>Title</legend><div class=item id=a></div></fieldset>"
    ));
    let (f, l) = (rect(&doc, "f"), rect(&doc, "l"));
    assert!(near(l.y, f.y + 4.0 + 8.0), "a floated legend is in the content: {l:?} {f:?}");
}

#[test]
fn a_definite_height_keeps_the_border_box() {
    let doc = page(&format!(
        "{FIELDSET}<style>fieldset {{ height: 100px; }}</style>
        <fieldset id=f><legend id=l>Title</legend><div class=item id=a></div></fieldset>"
    ));
    let f = rect(&doc, "f");
    assert!(near(f.height, 100.0 + 8.0 + 8.0 + 4.0 + 4.0), "{f:?}");
}

#[test]
fn the_border_is_centred_on_the_legend_and_open_behind_it() {
    let doc = page(&format!(
        "{FIELDSET}<style>legend {{ color: transparent; }}</style>
        <fieldset id=f><legend id=l>Title</legend><div class=item id=a></div></fieldset>"
    ));
    let (f, l) = (rect(&doc, "f"), rect(&doc, "l"));
    let px = pixels(&doc);
    let mid = l.y + l.height / 2.0;
    let red = |p: [u8; 3]| p[0] > 200 && p[1] < 60 && p[2] < 60;
    assert!(red(rgb(&px, f.x + 1.0, mid)), "the left border reaches the legend's middle");
    assert!(!red(rgb(&px, f.x + 1.0, f.y + 1.0)), "nothing above the border line");
    assert!(red(rgb(&px, l.x + l.width + 10.0, mid)), "the top border runs at the legend's middle");
    assert!(!red(rgb(&px, l.x + l.width / 2.0, mid)), "no border behind the legend");
}

fn glyph_xs(doc: &Doc) -> Vec<f64> {
    doc.scene()
        .commands
        .iter()
        .filter_map(|c| match c {
            RenderCommand::GlyphRun(run) => run.glyphs.first().map(|g| (run.transform * kurbo::Point::new(g.x.into(), g.y.into())).x),
            _ => None,
        })
        .collect()
}

#[test]
fn ordered_markers_keep_their_space_before_the_text() {
    let doc = page(
        "<!doctype html><style>body { margin: 0; font: 20px monospace; } ol, ul { margin: 0; padding-left: 100px; }</style>
        <span id=probe>1. </span><ol id=o><li>abc</li></ol>",
    );
    let probe = doc.dom.first_child(doc.dom.get_element_by_id("probe")).unwrap();
    let advance = doc.text_rects(probe, 0, 2).unwrap()[0].width / 2.0;
    let xs = glyph_xs(&doc);
    let (text, marker) = (xs[xs.len() - 2], xs[xs.len() - 1]);
    assert!(near(text, 100.0), "{xs:?}");
    assert!(near(text - marker, 3.0 * advance), "\"1. \" ends where the text starts: {xs:?}, advance {advance}");
}

#[test]
fn the_gap_follows_the_legend_when_it_changes() {
    let doc = Doc::new(W, H, 1.0, &Options { verify_paint: Some(true), ..Options::default() }).unwrap();
    let rows: String = (0..16).map(|i| format!("<div>row {i}</div>")).collect();
    doc.dom
        .parse_document(&format!(
            "{FIELDSET}<style>legend {{ color: transparent; }} div {{ height: 4px; overflow: hidden; }}</style>
            <fieldset id=f><legend id=l>T</legend>{rows}</fieldset>"
        ))
        .unwrap();
    doc.commit();
    let before = rect(&doc, "l");
    pixels(&doc);
    let text = doc.dom.first_child(doc.dom.get_element_by_id("l")).unwrap();
    doc.set_data(text, "A much longer title").unwrap();
    doc.commit();
    let (f, l) = (rect(&doc, "f"), rect(&doc, "l"));
    assert!(l.width > before.width + 50.0, "{before:?} {l:?}");
    let px = pixels(&doc);
    assert_eq!(doc.stats().paint_mismatches, 0, "incremental frame differs from a full recording");
    let red = |p: [u8; 3]| p[0] > 200 && p[1] < 60 && p[2] < 60;
    let mid = l.y + l.height / 2.0;
    assert!(!red(rgb(&px, l.x + l.width - 4.0, mid)), "no border behind the longer legend");
    assert!(red(rgb(&px, f.x + f.width - 10.0, mid)), "the border after it");
}
