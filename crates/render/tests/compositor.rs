use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use acde_render::{Frame, Options};

mod common;
use common::{Doc, Handle};

struct Page {
    doc: Doc,
    body: u32,
}

impl Page {
    fn new(css: &str) -> Self {
        let doc = Doc::new(800, 600, 2.0, &Options::default()).unwrap();
        doc.add_stylesheet(css).unwrap();
        let body = doc.create_element("body").unwrap();
        doc.append_child(doc.root().unwrap(), body).unwrap();
        Self { doc, body }
    }

    fn div(&self, parent: u32, class: &str) -> u32 {
        let id = self.doc.create_element("div").unwrap();
        self.doc.set_attribute(id, "class", class).unwrap();
        self.doc.append_child(parent, id).unwrap();
        id
    }
}

trait WaitFrame {
    fn wait_frame(&self) -> Frame;
}

impl WaitFrame for Handle {
    fn wait_frame(&self) -> Frame {
        let start = Instant::now();
        loop {
            if let Some(frame) = self.frame() {
                return frame;
            }
            assert!(start.elapsed() < Duration::from_secs(5), "no frame");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

const CSS: &str = "
    html, body { height: 100%; margin: 0; }
    .mover { position: absolute; left: 0; top: 0; width: 10px; height: 10px; transition: left 1000ms linear; }
    .mover.go { left: 100px; }
    .list { position: absolute; left: 200px; top: 0; width: 100px; height: 100px; overflow: scroll; }
    .item { height: 50px; }
    .h { position: absolute; left: 0; top: 200px; width: 20px; height: 20px; }
    .h:hover { width: 60px; }
";

#[test]
fn transition_runs_on_compositor_ticks_while_js_is_blocked() {
    let page = Page::new(CSS);
    let mover = page.div(page.body, "mover");
    let handle = page.doc.handle();
    let wakes = Arc::new(AtomicUsize::new(0));
    let counter = wakes.clone();
    handle.set_waker(Box::new(move || _ = counter.fetch_add(1, Ordering::SeqCst)));

    handle.commit();
    let first = handle.wait_frame();
    assert_eq!(first.size, (800, 600));
    assert!(!first.animating);

    page.doc.set_attribute(mover, "class", "mover go").unwrap();
    handle.commit();
    assert!(handle.wait_frame().animating);

    let compositor = handle.clone();
    let frames = std::thread::spawn(move || {
        let mut frames = Vec::new();
        for i in 1..=120 {
            compositor.tick(f64::from(i) * 1000.0 / 60.0);
            let frame = compositor.wait_frame();
            let done = !frame.animating;
            frames.push(frame);
            if done {
                break;
            }
        }
        frames
    })
    .join()
    .unwrap();
    assert!((59..=62).contains(&frames.len()), "{} frames", frames.len());
    assert!(!frames.last().unwrap().animating);
    assert!(wakes.load(Ordering::SeqCst) >= 61);
    assert_eq!(page.doc.rect(mover).unwrap().x.round(), 100.0);
    handle.tick(2000.0);
    page.doc.root().unwrap();
    assert!(handle.frame().is_none());
}

#[test]
fn transition_follows_tick_time() {
    let page = Page::new(CSS);
    let mover = page.div(page.body, "mover");
    page.doc.rect(mover).unwrap();
    page.doc.set_attribute(mover, "class", "mover go").unwrap();
    page.doc.rect(mover).unwrap();
    let handle = page.doc.handle();
    handle.tick(250.0);
    assert!((page.doc.rect(mover).unwrap().x - 25.0).abs() < 2.0);
    handle.tick(500.0);
    assert!((page.doc.rect(mover).unwrap().x - 50.0).abs() < 2.0);
}

#[test]
fn scroll_and_hover_from_compositor() {
    let page = Page::new(CSS);
    let list = page.div(page.body, "list");
    let items: Vec<u32> = (0..4).map(|_| page.div(list, "item")).collect();
    let hover = page.div(page.body, "h");
    let handle = page.doc.handle();
    handle.commit();
    assert_eq!(page.doc.rect(items[1]).unwrap().y, 50.0);

    handle.scroll_at(500.0, 50.0, 0.0, 30.0);
    handle.wait_frame();
    assert_eq!(page.doc.rect(items[1]).unwrap().y, 35.0);

    assert_eq!(page.doc.rect(hover).unwrap().width, 20.0);
    handle.pointer(20.0, 420.0);
    handle.wait_frame();
    assert_eq!(page.doc.rect(hover).unwrap().width, 60.0);
}

#[test]
fn panic_on_render_thread_is_an_error_not_an_abort() {
    let options = Options {
        base_url: Some("data:text/css;base64,".into()),
        ..Default::default()
    };
    let doc = Doc::new(100, 100, 1.0, &options).unwrap();
    let head = doc.create_element("head").unwrap();
    let link = doc.create_element("link").unwrap();
    doc.set_attribute(link, "rel", "stylesheet").unwrap();
    doc.set_attribute(link, "href", "/x.css").unwrap();
    doc.append_child(head, link).unwrap();
    let error = doc.append_child(doc.root().unwrap(), head).unwrap_err();
    assert!(error.0.contains("panicked"), "{error}");
    assert!(doc.create_element("div").is_ok());
}

#[test]
fn release_drops_subtree_and_ids_stay_unique() {
    let page = Page::new(CSS);
    let box_ = page.div(page.body, "h");
    let child = page.div(box_, "");
    let frame = page.doc.create_element("iframe").unwrap();
    page.doc.append_child(box_, frame).unwrap();

    page.doc.release(box_).unwrap();
    assert!(page.doc.rect(child).unwrap_err().0.contains("released"));
    assert!(page.doc.rect(frame).unwrap_err().0.contains("released"));
    page.doc.release(child).unwrap();
    assert!(page.doc.release(9999).is_err());
    assert!(page.doc.release(page.doc.root().unwrap()).is_err());
    assert!(page.doc.create_element("div").unwrap() > frame);
}

#[test]
fn release_keeps_memory_flat() {
    let rss = || {
        let statm = std::fs::read_to_string("/proc/self/statm").unwrap();
        statm
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u64>()
            .unwrap()
            * 4096
    };
    let page = Page::new(CSS);
    let round = |page: &Page| {
        let root = page.div(page.body, "list");
        (0..49).for_each(|_| _ = page.div(root, "item"));
        page.doc.rect(root).unwrap();
        page.doc.remove(root).unwrap();
        page.doc.release(root).unwrap();
    };
    (0..200).for_each(|_| round(&page));
    let before = rss();
    (0..2000).for_each(|_| round(&page));
    let grown = rss().saturating_sub(before);
    eprintln!(
        "rss grew {} KiB over 2000 rounds (100k nodes)",
        grown / 1024
    );
    assert!(grown < 16 << 20, "rss grew {grown} bytes");
}

#[test]
fn transition_after_idle_has_intermediate_frames() {
    let page = Page::new(
        ".box { position: absolute; left: 0; top: 0; width: 10px; height: 10px; transition: left 600ms linear; } .box.moved { left: 300px; }",
    );
    let b = page.div(page.body, "box");
    let handle = page.doc.handle();
    let start = Instant::now();
    let now = || start.elapsed().as_secs_f64() * 1e3;
    handle.commit();
    handle.wait_frame();
    handle.tick(now());
    std::thread::sleep(Duration::from_millis(300));

    page.doc.set_attribute(b, "class", "box moved").unwrap();
    handle.commit();
    assert!(
        handle.wait_frame().animating,
        "the frame after the class change must be animating"
    );
    let mut xs = Vec::new();
    loop {
        std::thread::sleep(Duration::from_millis(16));
        handle.tick(now());
        let frame = handle.wait_frame();
        xs.push(page.doc.rect(b).unwrap().x);
        if !frame.animating {
            break;
        }
        assert!(xs.len() < 200);
    }
    assert!(xs.len() >= 25, "only {} frames: {xs:?}", xs.len());
    assert!(xs.windows(2).all(|w| w[1] >= w[0]), "{xs:?}");
    assert!(xs[0] < 60.0, "first tick jumped to {}", xs[0]);
    assert_eq!(xs.last().unwrap().round(), 300.0);
}

#[test]
fn queries_do_not_resolve_every_time_while_animating() {
    let page = Page::new("@keyframes spin { from { left: 0; } to { left: 100px; } }
        .spin { position: absolute; width: 10px; height: 10px; animation: spin 1s infinite linear; }");
    let spin = page.div(page.body, "spin");
    page.doc.rect(spin).unwrap();
    let before = page.doc.stats().unwrap().resolves;
    let start = Instant::now();
    for _ in 0..200 {
        page.doc.metrics(spin).unwrap();
    }
    let elapsed = start.elapsed().as_secs_f64();
    let resolves = page.doc.stats().unwrap().resolves - before;
    assert!(
        f64::from(resolves) <= elapsed * 60.0 + 2.0,
        "{resolves} resolves in {elapsed:.3}s"
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(page.doc.rect(spin).unwrap().x > 0.0);
}

#[test]
fn offset_parent() {
    let page = Page::new(
        ".pos { position: relative; } .fixed { position: fixed; } .none { display: none; }",
    );
    let pos = page.div(page.body, "pos");
    let inner = page.div(pos, "");
    let plain = page.div(page.body, "");
    let fixed = page.div(page.body, "fixed");
    let hidden = page.div(page.body, "none");
    let under_hidden = page.div(hidden, "");
    let parent = |id| page.doc.metrics(id).ok().and_then(|m| m.offset_parent);
    assert_eq!(parent(inner), Some(pos));
    assert_eq!(parent(plain), Some(page.body));
    assert_eq!(parent(fixed), None);
    assert_eq!(parent(hidden), None);
    assert_eq!(parent(under_hidden), None);
    assert_eq!(parent(page.body), None);
    assert!(page.doc.metrics(9999).is_err());
}

#[test]
fn absolute_without_positioned_ancestor_has_body_as_offset_parent() {
    let page = Page::new(".abs { position: absolute; }");
    let wrap = page.div(page.body, "");
    let abs = page.div(wrap, "abs");
    assert_eq!(
        page.doc.metrics(abs).unwrap().offset_parent,
        Some(page.body)
    );
}

#[test]
fn paused_and_undisplayed_animations_do_not_keep_ticking() {
    let page = Page::new(
        "@keyframes march { to { stroke-dashoffset: -20 } }
         .dash { stroke: red; stroke-dasharray: 12 8; animation: march .6s linear infinite paused }
         .dash.on { animation-play-state: running }
         .gone { display: none }
         .spin { animation: march 1s infinite }",
    );
    let svg = page.doc.create_element_ns(1, "svg").unwrap();
    page.doc.append_child(page.body, svg).unwrap();
    let rect = page.doc.create_element_ns(1, "rect").unwrap();
    page.doc.set_attribute(rect, "class", "dash").unwrap();
    page.doc.append_child(svg, rect).unwrap();
    let gone = page.div(page.body, "gone");
    page.div(gone, "spin");
    let handle = page.doc.handle();
    handle.commit();
    assert!(!handle.wait_frame().animating);
    assert!(!page.doc.stats().unwrap().animating);
    page.doc.set_attribute(rect, "class", "dash on").unwrap();
    handle.commit();
    assert!(handle.wait_frame().animating);
    page.doc.set_attribute(rect, "class", "dash").unwrap();
    handle.commit();
    assert!(!handle.wait_frame().animating, "paused again");
}

fn waapi(names: &[&str], delays: &[&str]) -> String {
    let n = names.len();
    let list = |v: &str| vec![v; n].join(", ");
    format!(
        "position: absolute; top: 0; width: 10px; height: 10px; animation-name: {}; animation-duration: {}; animation-timing-function: {}; animation-delay: {}; animation-iteration-count: {}; animation-direction: {}; animation-fill-mode: {}; animation-play-state: {};",
        names.join(", "),
        list("1000ms"),
        list("linear"),
        delays.join(", "),
        list("1"),
        list("normal"),
        list("forwards"),
        list("running"),
    )
}

#[test]
fn inserted_keyframes_and_inline_animation_lists_run_like_web_animations() {
    let page = Page::new(CSS);
    let style = page.doc.create_element("style").unwrap();
    page.doc.append_child(page.body, style).unwrap();
    let m = page.div(page.body, "");
    let handle = page.doc.handle();
    handle.tick(0.0);
    page.doc.dom.sheet_insert_rule(style, "@keyframes acde-animation-1 { 0% { left: 0px } 100% { left: 100px } }", 0).unwrap();
    page.doc.set_attribute(m, "style", &waapi(&["acde-animation-1"], &["-250ms"])).unwrap();
    assert!((page.doc.rect(m).unwrap().x - 25.0).abs() < 2.0, "{}", page.doc.rect(m).unwrap().x);
    handle.tick(500.0);
    assert!((page.doc.rect(m).unwrap().x - 75.0).abs() < 2.0, "{}", page.doc.rect(m).unwrap().x);
    page.doc.dom.sheet_insert_rule(style, "@keyframes acde-animation-2 { 0% { top: 0px } 100% { top: 100px } }", 1).unwrap();
    page.doc.set_attribute(m, "style", &waapi(&["acde-animation-1", "acde-animation-2"], &["-250ms", "0ms"])).unwrap();
    let r = page.doc.rect(m).unwrap();
    assert!((r.x - 75.0).abs() < 2.0 && r.y.abs() < 2.0, "the first keeps its time: {} {}", r.x, r.y);
    handle.tick(700.0);
    let r = page.doc.rect(m).unwrap();
    assert!((r.x - 95.0).abs() < 2.0 && (r.y - 20.0).abs() < 2.0, "the second starts, the first runs on: {} {}", r.x, r.y);
    page.doc.dom.sheet_insert_rule(style, "@keyframes acde-animation-3 { 0% { top: 0px } 100% { top: 100px } }", 2).unwrap();
    page.doc.set_attribute(m, "style", &waapi(&["acde-animation-1", "acde-animation-3"], &["-250ms", "-100ms"])).unwrap();
    page.doc.rect(m).unwrap();
    handle.tick(750.0);
    let r = page.doc.rect(m).unwrap();
    assert!((r.x - 100.0).abs() < 2.0 && (r.y - 15.0).abs() < 2.0, "a restarted second leaves the first alone: {} {}", r.x, r.y);
    handle.tick(2000.0);
    let r = page.doc.rect(m).unwrap();
    assert!((r.x - 100.0).abs() < 2.0 && (r.y - 100.0).abs() < 2.0, "fill forwards holds the end: {} {}", r.x, r.y);
}
