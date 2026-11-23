use std::time::Duration;

use acde_scene::input::{Event, pace};
use serde_json::Value;

const WAIT_MAX: u64 = 10_000;

pub(super) fn paced(events: &[Value]) -> Result<Vec<Event<&Value>>, String> {
    let sorted = events.iter().map(|event| match event["type"].as_str().unwrap_or_default() {
        "move" | "motion" => Ok(Event::Move(event)),
        "down" => Ok(Event::Down(event)),
        "up" => Ok(Event::Up(event)),
        "keydown" | "keyup" | "wheel" | "text" => Ok(Event::Other(event)),
        "wait" => Ok(Event::Wait(Duration::from_millis(event["ms"].as_u64().unwrap_or(0).min(WAIT_MAX)))),
        other => Err(format!("no input event {other}")),
    });
    Ok(pace(sorted.collect::<Result<Vec<_>, String>>()?))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kinds(events: &[Value]) -> Vec<String> {
        let paced = paced(events).expect("known events");
        paced
            .iter()
            .map(|event| match event {
                Event::Wait(gap) => format!("wait {}", gap.as_millis()),
                Event::Move(e) | Event::Down(e) | Event::Up(e) | Event::Other(e) => e["type"].as_str().unwrap_or_default().to_string(),
            })
            .collect()
    }

    #[test]
    fn a_drag_is_paced_by_acde_scene() {
        let drag = [json!({ "type": "move" }), json!({ "type": "down" }), json!({ "type": "motion" }), json!({ "type": "move" }), json!({ "type": "up" })];
        assert_eq!(kinds(&drag), ["move", "down", "wait 150", "motion", "wait 16", "move", "wait 16", "up"]);
    }

    #[test]
    fn keys_wheels_and_text_pass_and_a_written_wait_is_kept_up_to_ten_seconds() {
        let typed = [json!({ "type": "keydown" }), json!({ "type": "text" }), json!({ "type": "wheel" }), json!({ "type": "keyup" })];
        assert_eq!(kinds(&typed), ["keydown", "text", "wheel", "keyup"]);
        let waited = [json!({ "type": "down" }), json!({ "type": "wait", "ms": 60_000 }), json!({ "type": "up" })];
        assert_eq!(kinds(&waited), ["down", "wait 10000", "up"]);
        assert_eq!(paced(&[json!({ "type": "jump" })]).err().as_deref(), Some("no input event jump"));
    }
}
