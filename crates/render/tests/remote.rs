use std::sync::{Arc, Mutex};

use acde_render::{Document, Dom, Load, Loader, NONE, Options};

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR4nGP4z8DwH4QZMBgAoXkL9U3EmgcAAAAASUVORK5CYII=";

type Loads = Arc<Mutex<Vec<Load>>>;

fn page(html: &str) -> (Document, Dom, Loads) {
    let loads = Loads::default();
    let sink = loads.clone();
    let options = Options { loader: Some(Loader::new(move |load| sink.lock().unwrap().push(load))), ..Options::default() };
    let doc = Document::new(800, 600, 1.0, &options).unwrap();
    let dom = doc.dom();
    dom.parse_document(html).unwrap();
    (doc, dom, loads)
}

fn by_id(dom: &Dom, id: &str) -> u32 {
    let found = dom.get_element_by_id(id);
    assert_ne!(found, NONE, "#{id}");
    found
}

fn take(loads: &Loads, url: &str) -> Load {
    let mut loads = loads.lock().unwrap();
    let i = loads.iter().position(|l| l.url == url).unwrap_or_else(|| panic!("{url} was not asked for"));
    loads.remove(i)
}

fn png() -> Vec<u8> {
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, PNG).unwrap()
}

#[test]
fn remote_images_load_through_the_loader() {
    let (_doc, dom, loads) = page("<body><img id=a src='https://img.example.com/a.png'><img id=b src='https://img.example.com/b.png'></body>");
    let (a, b) = (by_id(&dom, "a"), by_id(&dom, "b"));
    assert_eq!(dom.take_loaded(), vec![a, b], "both reported as loading, so the page keeps asking");
    assert!(dom.take_loaded().is_empty(), "loading is reported once");
    assert_eq!(dom.image_state(a).unwrap()[2], 0.0, "loading");

    let load = take(&loads, "https://img.example.com/a.png");
    assert_eq!(load.destination, "image");
    load.finish(Some(png()));
    assert_eq!(dom.take_loaded(), vec![a]);
    assert_eq!(dom.image_state(a).unwrap(), [2.0, 3.0, 1.0]);

    drop(take(&loads, "https://img.example.com/b.png"));
    assert_eq!(dom.take_loaded(), vec![b], "a load dropped unanswered fails");
    assert_eq!(dom.image_state(b).unwrap(), [0.0, 0.0, 2.0]);
}

#[test]
fn remote_stylesheets_apply_when_they_arrive_and_ask_for_their_fonts() {
    let (_doc, dom, loads) = page("<head><link rel=stylesheet href='https://cdn.example.com/css/site.css'></head><body><p id=p>x</p></body>");
    let p = by_id(&dom, "p");
    let load = take(&loads, "https://cdn.example.com/css/site.css");
    assert_eq!(load.destination, "style");
    load.finish(Some(b"@font-face { font-family: Remote; src: url(../fonts/r.woff2) } p { color: rgb(255, 0, 0) }".to_vec()));
    assert_eq!(dom.computed_style(p, "", "color").unwrap(), "rgb(255, 0, 0)");
    assert_eq!(take(&loads, "https://cdn.example.com/fonts/r.woff2").destination, "font");
}

#[test]
fn local_and_data_urls_never_reach_the_loader() {
    let (_doc, dom, loads) = page(&format!("<body><img id=a src='data:image/png;base64,{PNG}'><img src='file:///nowhere/x.png'></body>"));
    assert_eq!(dom.image_state(by_id(&dom, "a")).unwrap()[2], 1.0);
    assert!(loads.lock().unwrap().is_empty());
}
