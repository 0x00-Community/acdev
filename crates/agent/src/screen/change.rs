use acde_wire::acompositor::desktop::acompositor_window_v1;
use serde_json::{Value, json};
use wayland_client::Proxy;

use super::{Worker, state_name};

const FOCUS_DESKTOP_SINCE: u32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Place {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Place {
    const NORMAL: &str = "normal";

    pub(super) fn of(change: &Value) -> Result<Option<Self>, String> {
        let Some(place) = change.get("place").filter(|p| !p.is_null()) else { return Ok(None) };
        let number = |key: &str, needed: bool| -> Result<i32, String> {
            match place.get(key).filter(|v| !v.is_null()) {
                None if needed => Err(format!("place needs {key}")),
                None => Ok(0),
                Some(v) => v
                    .as_f64()
                    .filter(|n| n.is_finite() && n.abs() <= f64::from(i32::MAX))
                    .map(|n| n.round() as i32)
                    .ok_or_else(|| format!("place.{key} is a number of logical pixels")),
            }
        };
        let (width, height) = (number("width", false)?, number("height", false)?);
        if width < 0 || height < 0 {
            return Err("place.width and place.height are 0 (the size stays) or above".into());
        }
        Ok(Some(Self { x: number("x", true)?, y: number("y", true)?, width, height }))
    }

    pub(super) fn allowed(state: &str) -> Result<(), String> {
        match state == Self::NORMAL {
            true => Ok(()),
            false => Err(format!("only a window in the normal state is placed; this one is {state}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_place_reads_its_corner_and_an_optional_size() {
        assert_eq!(Place::of(&json!({ "focus": true })), Ok(None));
        assert_eq!(Place::of(&json!({ "place": { "x": 10, "y": 20.4 } })), Ok(Some(Place { x: 10, y: 20, width: 0, height: 0 })));
        assert_eq!(Place::of(&json!({ "place": { "x": -5, "y": 0, "width": 640, "height": 0 } })), Ok(Some(Place { x: -5, y: 0, width: 640, height: 0 })));
        assert!(Place::of(&json!({ "place": { "y": 0 } })).is_err());
        assert!(Place::of(&json!({ "place": { "x": "a", "y": 0 } })).is_err());
        assert!(Place::of(&json!({ "place": { "x": 0, "y": 0, "width": -1 } })).is_err());
    }

    #[test]
    fn only_a_normal_window_is_placed() {
        assert_eq!(Place::allowed("normal"), Ok(()));
        let refused = Place::allowed("filled").expect_err("a filled window is not placed");
        assert!(refused.contains("filled"), "{refused}");
    }
}

impl Worker {
    pub(super) fn change_window(&mut self, change: &Value, toplevel: u64) -> Result<Value, String> {
        let (proxy, state) = self.state.row(toplevel).map(|(p, w)| (p.clone(), w.state)).ok_or_else(|| format!("no window acompositor-{toplevel}"))?;
        let place = Place::of(change)?;
        if place.is_some() {
            Place::allowed(state_name(state))?;
        }
        log::info!("devwindow: window acompositor-{toplevel}: {change}");
        if let Some(state) = change["state"].as_str() {
            let state = match state {
                "normal" => acompositor_window_v1::State::Normal,
                "minimized" => acompositor_window_v1::State::Minimized,
                "filled" => acompositor_window_v1::State::Filled,
                "fullscreen" => acompositor_window_v1::State::Fullscreen,
                other => return Err(format!("no window state {other}")),
            };
            proxy.set_state(state);
        }
        if change["focus"] == true {
            proxy.activate();
        }
        if let Some(Place { x, y, width, height }) = place {
            proxy.place(x, y, width, height);
        }
        if change["close"] == true {
            proxy.close();
        }
        self.settle()?;
        if place.is_none() {
            return Ok(Value::Null);
        }
        let (x, y, width, height) = self.geometry(Some(toplevel)).map_err(|_| format!("window acompositor-{toplevel} is gone"))?.unwrap_or_default();
        Ok(json!({ "x": x, "y": y, "width": width, "height": height }))
    }

    pub(super) fn focus_desktop(&mut self, change: &Value) -> Result<Value, String> {
        let only_focus = change.as_object().is_some_and(|c| c.iter().all(|(key, value)| key == "window" || (key == "focus" && value == true)));
        if !only_focus || change["focus"] != true {
            return Err("window 0 is the desktop: it only takes focus".into());
        }
        let inject = &self.globals.inject;
        if inject.version() < FOCUS_DESKTOP_SINCE {
            return Err(format!("acompositor cannot focus the desktop (acompositor_inject_v1 {} below {FOCUS_DESKTOP_SINCE})", inject.version()));
        }
        inject.focus_desktop();
        self.settle()?;
        Ok(Value::Null)
    }
}
