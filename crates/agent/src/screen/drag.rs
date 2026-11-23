use std::io::Write;
use std::time::Instant;

use serde_json::{Value, json};
use wayland_client::protocol::{wl_data_device_manager, wl_data_source};
use wayland_client::{Connection, Dispatch, QueueHandle};

use super::{State, Worker};

const URIS: &str = "text/uri-list";

#[derive(Default)]
pub(super) struct Drag {
    uris: String,
    done: Option<Result<(), String>>,
}

impl Worker {
    pub(super) fn drop_files(&mut self, files: &[String], toplevel: Option<u64>, at: Option<(f64, f64)>) -> Result<Value, String> {
        if files.is_empty() || files.iter().any(|f| !f.starts_with('/')) {
            return Err("drop needs absolute file paths".into());
        }
        let (x, y) = match (at, self.geometry(toplevel)?) {
            (Some((x, y)), Some((ox, oy, _, _))) => (f64::from(ox) + x, f64::from(oy) + y),
            (Some(at), None) => at,
            (None, Some((ox, oy, w, h))) => (f64::from(ox) + f64::from(w) / 2.0, f64::from(oy) + f64::from(h) / 2.0),
            (None, None) => return Err("drop on the desktop needs x and y".into()),
        };
        self.state.drag = Drag { uris: files.iter().map(|f| file_uri(f) + "\r\n").collect(), done: None };
        let source = self.globals.drags.create_data_source(&self.qh, ());
        source.offer(URIS.to_string());
        source.set_actions(wl_data_device_manager::DndAction::Copy);
        self.globals.inject.drop(&source, x, y);
        let started = Instant::now();
        let waited = self.wait(|s| s.drag.done.is_some());
        source.destroy();
        waited?;
        let done = self.state.drag.done.take().unwrap_or(Err("the drop did not end".into()));
        done.map(|()| json!({ "window": toplevel, "files": files, "ms": started.elapsed().as_millis() as u64 }))
    }
}

fn file_uri(path: &str) -> String {
    let mut out = String::from("file://");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

impl Dispatch<wl_data_source::WlDataSource, ()> for State {
    fn event(state: &mut Self, _: &wl_data_source::WlDataSource, event: wl_data_source::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            wl_data_source::Event::Send { fd, .. } => {
                _ = std::fs::File::from(fd).write_all(state.drag.uris.as_bytes());
            }
            wl_data_source::Event::DndFinished => state.drag.done = Some(Ok(())),
            wl_data_source::Event::Cancelled if state.drag.done.is_none() => {
                state.drag.done = Some(Err("the drop was cancelled: nothing there took the files".into()));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_uri_escapes_all_but_the_unreserved_bytes() {
        assert_eq!(file_uri("/home/a b/Ü.txt"), "file:///home/a%20b/%C3%9C.txt");
    }
}
