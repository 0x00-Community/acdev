use serde_json::{Value, json};

use super::aim::Shown;
use super::{Line, relay};
use crate::agent::Agent;
use crate::screen::{Aim, Job};

fn told(answer: Result<Value, String>) -> Value {
    answer.unwrap_or_else(|error| json!({ "error": error }))
}

fn joined(mut line: Value, compositor: Value) -> Value {
    if line["ok"] == true
        && let Some(result) = line["result"].as_object_mut()
    {
        result.insert("compositor".into(), compositor);
    }
    line
}

fn areas_of(mut state: Value, aim: &Aim) -> Value {
    let window = match aim {
        Aim::Screen => 0,
        Aim::Toplevel(n) => *n,
        Aim::App(_) => return state,
    };
    if let Some(areas) = state["areas"].as_array_mut() {
        areas.retain(|area| area["window"].as_u64() == Some(window));
    }
    state
}

pub fn render(agent: &Agent, request: &Value) -> Line {
    let line = relay(agent, request)?;
    let web = line["result"]["web"].as_str().or(request["web"].as_str()).unwrap_or("desktop").to_string();
    let state = agent.drive(Job::RenderState).and_then(|state| Ok(areas_of(state, &Shown::ask(agent)?.web(&web)?)));
    Ok(joined(line, told(state)))
}

pub fn hit(agent: &Agent, request: &Value) -> Line {
    let (x, y) = request["x"].as_f64().zip(request["y"].as_f64()).ok_or("hit needs x and y")?;
    let landed = told(agent.drive(Job::Hit { x, y }));
    Ok(joined(relay(agent, request)?, landed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_sees_only_the_compositors_areas_of_its_window() {
        let state = json!({ "composer": "gpu", "areas": [{ "window": 3, "drawn": "gpu-glass" }, { "window": 0, "drawn": "frost" }] });
        assert_eq!(areas_of(state.clone(), &Aim::Toplevel(3))["areas"], json!([{ "window": 3, "drawn": "gpu-glass" }]));
        assert_eq!(areas_of(state.clone(), &Aim::Screen)["areas"], json!([{ "window": 0, "drawn": "frost" }]));
        assert_eq!(areas_of(state.clone(), &Aim::App("notes".into())), state);
    }

    #[test]
    fn the_compositors_half_joins_only_an_answer_that_went_well() {
        let page = json!({ "ok": true, "result": { "x": 1 } });
        assert_eq!(joined(page, json!({ "window": 3 })), json!({ "ok": true, "result": { "x": 1, "compositor": { "window": 3 } } }));
        let failed = json!({ "ok": false, "error": "no page" });
        assert_eq!(joined(failed.clone(), json!({})), failed);
    }
}
