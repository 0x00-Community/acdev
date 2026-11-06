use std::time::{Duration, Instant};

use acde_gpu::FilterEffect;
use acde_gpu::{PaintScene, Scene};
use acde_render::{Frame, Options};

mod common;
use common::{Doc, Handle};

const CSS: &str = "html, body { margin: 0; height: 100%; }
  body { background: repeating-linear-gradient(45deg, #ff3d7f 0 20px, #ffd23d 20px 40px, #3dd2ff 40px 60px), #fff; }
  .card { position: absolute; left: 50px; top: 40px; width: 200px; height: 120px; border-radius: 16px;
          background: rgba(255, 255, 255, .25); backdrop-filter: blur(20px) saturate(1.8); }
  .shadow { position: absolute; left: 300px; top: 60px; width: 80px; height: 80px; border-radius: 12px; background: #fff;
            filter: drop-shadow(0 8px 10px rgba(40, 16, 80, .45)); }";

struct Page {
    doc: Doc,
    handle: Handle,
    body: u32,
}

impl Page {
    fn new(scale: f32) -> Self {
        let doc = Doc::new((400.0 * scale) as u32, (200.0 * scale) as u32, scale, &Options::default()).unwrap();
        doc.add_stylesheet(CSS).unwrap();
        let body = doc.create_element("body").unwrap();
        doc.append_child(0, body).unwrap();
        let handle = doc.handle();
        Self { doc, handle, body }
    }

    fn div(&self, class: &str) -> u32 {
        let id = self.doc.create_element("div").unwrap();
        self.doc.set_attribute(id, "class", class).unwrap();
        self.doc.append_child(self.body, id).unwrap();
        id
    }

    fn frame(&self) -> Frame {
        self.handle.commit();
        let start = Instant::now();
        loop {
            if let Some(f) = self.handle.frame() {
                return f;
            }
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

fn raster(size: (u32, u32), scenes: Vec<Scene>) -> Vec<u8> {
    let mut all = Scene::new();
    for scene in scenes {
        all.append_scene(scene, Default::default());
    }
    common::rasterize(all, size)
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1.5
}

#[test]
fn no_filters_no_layers() {
    let page = Page::new(1.0);
    page.div("plain");
    assert!(page.frame().plane.layers.is_empty());
}

#[test]
fn backdrop_card_splits_into_two_segments() {
    let page = Page::new(2.0);
    page.div("card");
    let frame = page.frame();
    assert_eq!(frame.plane.layers.len(), 2, "the page, then the card over a filtered backdrop");
    let b = frame.plane.layers[1].backdrop.as_ref().unwrap();
    assert!(near(b.bounds.x0, 100.0) && near(b.bounds.y0, 80.0) && near(b.bounds.width(), 400.0) && near(b.bounds.height(), 240.0), "{:?}", b.bounds);
    assert_eq!(b.scale, 2.0);
    let effects: Vec<&FilterEffect> = b.filter.effects().iter().collect();
    assert!(matches!(effects[0], FilterEffect::GaussianBlur(_)), "{effects:?}");
    assert_eq!(effects.len(), 2, "blur + saturate: {effects:?}");
    assert!(near(b.radius(), 32.0), "radius {}", b.radius());
    assert!(near(b.blur(), 40.0), "blur {}", b.blur());
    assert!((b.saturate() - 1.8).abs() < 1e-3, "saturate {}", b.saturate());
    assert_eq!(b.brightness(), 1.0);
}

#[test]
fn drop_shadow_element_is_its_own_segment() {
    let page = Page::new(1.0);
    page.div("shadow");
    page.div("plain");
    let frame = page.frame();
    assert_eq!(frame.plane.layers.len(), 2, "the page, then the filtered element (nothing visible after it)");
    let f = frame.plane.layers[1].filter.as_ref().unwrap();
    assert!(matches!(f.filter.effects()[0], FilterEffect::DropShadow(_)));
    assert!(f.bounds.x0 < 300.0 && f.bounds.y1 > 140.0 + 8.0, "{:?}", f.bounds);
}

#[test]
fn segments_compose_to_the_whole_scene() {
    let page = Page::new(1.0);
    page.div("card");
    page.div("shadow");
    let frame = page.frame();
    assert_eq!(frame.plane.layers.len(), 3);
    assert!(frame.plane.drawing.scene().commands.is_empty());
    let whole = raster(frame.size, vec![page.doc.scene()]);
    let parts = raster(frame.size, frame.plane.layers.iter().map(|l| l.drawing.scene()).collect());
    let differing = whole.chunks(4).zip(parts.chunks(4)).filter(|(a, b)| a != b).count();
    assert_eq!(differing, 0);
}
