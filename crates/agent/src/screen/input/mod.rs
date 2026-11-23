mod keys;
mod paced;

use acde_scene::input::Event;
use acde_wire::acompositor::inject::acompositor_inject_v1::State as Press;
use serde_json::{Value, json};
use wayland_client::Proxy;

use self::keys::{button, evdev_key};
use super::Worker;

const TARGET_SINCE: u32 = 4;

fn pressed(kind: &str) -> Press {
    if kind.ends_with("down") { Press::Pressed } else { Press::Released }
}

impl Worker {
    pub(super) fn input(&mut self, events: &[Value], toplevel: Option<u64>) -> Result<Value, String> {
        let aimed = toplevel.filter(|_| self.globals.inject.version() >= TARGET_SINCE);
        let origin = match (aimed, self.geometry(toplevel)?) {
            (None, Some((x, y, _, _))) => (f64::from(x), f64::from(y)),
            _ => (0.0, 0.0),
        };
        if let Some(n) = aimed {
            self.state.lost = false;
            self.globals.inject.target(format!("acompositor-{n}"));
        }
        let given = self.inject(events, origin);
        if aimed.is_some() {
            self.globals.inject.target(String::new());
        }
        let settled = self.settle();
        if std::mem::take(&mut self.state.lost) {
            return Err("the window is gone".into());
        }
        settled?;
        given
    }

    fn inject(&mut self, events: &[Value], (ox, oy): (f64, f64)) -> Result<Value, String> {
        self.state.skipped = 0;
        for paced in paced::paced(events)? {
            let event = match paced {
                Event::Wait(gap) => {
                    self.queue.flush().map_err(|e| format!("acompositor: {e}"))?;
                    std::thread::sleep(gap);
                    continue;
                }
                Event::Move(event) | Event::Down(event) | Event::Up(event) | Event::Other(event) => event,
            };
            let at = event["x"].as_f64().zip(event["y"].as_f64()).map(|(x, y)| (ox + x, oy + y));
            let inject = &self.globals.inject;
            match event["type"].as_str().unwrap_or_default() {
                "move" => {
                    let (x, y) = at.ok_or("move needs x and y")?;
                    inject.move_to(x, y);
                }
                kind @ ("down" | "up") => {
                    if let Some((x, y)) = at {
                        inject.move_to(x, y);
                    }
                    inject.button(button(event["button"].as_str()), pressed(kind));
                }
                "wheel" => {
                    if let Some((x, y)) = at {
                        inject.move_to(x, y);
                    }
                    inject.scroll(event["dx"].as_f64().unwrap_or(0.0), event["dy"].as_f64().unwrap_or(0.0));
                }
                "motion" => inject.move_by(event["dx"].as_f64().unwrap_or(0.0), event["dy"].as_f64().unwrap_or(0.0)),
                kind @ ("keydown" | "keyup") => {
                    let name = event["key"].as_str().ok_or("a key event needs a key")?;
                    let code = evdev_key(name).ok_or_else(|| format!("no key {name}"))?;
                    inject.key(code, pressed(kind));
                }
                "text" => inject.text(event["text"].as_str().unwrap_or_default().to_string()),
                other => return Err(format!("no input event {other}")),
            }
        }
        self.settle()?;
        Ok(json!({ "done": true, "textSkipped": self.state.skipped }))
    }
}
