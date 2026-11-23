use acde_wire::acompositor::desktop::acompositor_desktop_v1::Event;

use crate::journal;

pub(super) fn journal(event: &Event) {
    let n = |v: &dyn ToString| v.to_string();
    let (kind, fields): (&str, Vec<(&str, String)>) = match event {
        Event::Press { window, x, y, button } => ("press", vec![("window", n(window)), ("x", n(x)), ("y", n(y)), ("button", n(button))]),
        Event::MoveRequest { window, serial, accepted, reason } => {
            ("move-request", vec![("window", n(window)), ("serial", n(serial)), ("accepted", n(&(*accepted != 0))), ("reason", reason.clone())])
        }
        Event::ResizeRequest { window, serial, edges, accepted, reason } => (
            "resize-request",
            vec![("window", n(window)), ("serial", n(serial)), ("edges", n(edges)), ("accepted", n(&(*accepted != 0))), ("reason", reason.clone())],
        ),
        Event::Focus { window } => ("focus", vec![("window", n(window))]),
        Event::Map { window } => ("map", vec![("window", n(window))]),
        Event::Unmap { window } => ("unmap", vec![("window", n(window))]),
        Event::DragStart { window } => ("drag-start", vec![("window", n(window))]),
        Event::DragEnd { window, dropped } => ("drag-end", vec![("window", n(window)), ("dropped", n(&(*dropped != 0)))]),
        _ => return,
    };
    journal::timeline(&journal::line(kind, &fields));
}
