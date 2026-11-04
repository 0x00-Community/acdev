use acde_render::Options;
use acde_render::acgpu::xe::Xe;
use acde_render::acgpu::xe3::{Codegen, Context, CpuScene, Pages};
use acde_render::acgpu::{Gpu, Native, Scene};

mod common;
use common::Doc;

const SIZE: u16 = 96;

struct Fixture {
    doc: Doc,
}

impl Fixture {
    fn new(source: &str) -> Option<Self> {
        let doc = Doc::new(SIZE.into(), SIZE.into(), 1.0, &Options::default()).ok()?;
        doc.add_stylesheet("html, body { margin: 0; background: #fff; } svg { display: block; width: 80px; height: 80px; margin: 8px; overflow: hidden; }").ok()?;
        let body = doc.create_element("body").ok()?;
        doc.append_child(doc.root().ok()?, body).ok()?;
        let fixture = Fixture { doc };
        let xml = roxmltree::Document::parse(source).ok()?;
        fixture.element(xml.root_element(), body);
        Some(fixture)
    }

    fn element(&self, el: roxmltree::Node, parent: u32) {
        let id = self.doc.create_element_ns(1, el.tag_name().name()).unwrap();
        for a in el.attributes() {
            if !(el.parent_element().is_none() && matches!(a.name(), "width" | "height" | "style")) && a.namespace().is_none() {
                self.doc.set_attribute(id, a.name(), a.value()).unwrap();
            }
        }
        self.doc.append_child(parent, id).unwrap();
        for child in el.children() {
            if child.is_element() {
                self.element(child, id);
            } else if let Some(text) = child.text().filter(|t| !t.trim().is_empty()) {
                let t = self.doc.create_text(text).unwrap();
                self.doc.append_child(id, t).unwrap();
            }
        }
    }

    fn scene(&self) -> Scene {
        self.doc.scene()
    }
}

#[test]
fn svg_fixtures_on_xe3_match_vello_cpu() {
    let Ok(xe) = Xe::open_first() else {
        eprintln!("no Xe3");
        return;
    };
    let mut cx = Context::<Xe, Native>::new(&xe).unwrap();
    let mut pages = Pages::new(&mut cx, &Codegen::default(), [SIZE.into(), SIZE.into()]).unwrap();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/svg");
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "svg")).collect();
    files.sort();
    let (mut same, mut skipped, mut differ, mut refused) = (0, 0, Vec::new(), Vec::new());
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let Some(fixture) = Fixture::new(&std::fs::read_to_string(path).unwrap()) else {
            skipped += 1;
            continue;
        };
        let scene = fixture.scene();
        let want = CpuScene::reference(scene.clone(), (SIZE, SIZE));
        match pages.draw(&mut cx, scene, (SIZE, SIZE), &()) {
            Ok(got) if got == want => same += 1,
            Ok(got) => differ.push((name, got.as_chunks::<4>().0.iter().zip(want.as_chunks::<4>().0).filter(|(g, w)| g != w).count())),
            Err(e) => refused.push((name, e.to_string())),
        }
    }
    eprintln!("{same} of {} byte for byte, {skipped} not XML, refused {refused:?}", files.len());
    assert!(differ.is_empty(), "pixels differ: {differ:?}");
}
