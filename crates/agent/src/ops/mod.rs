mod aim;
mod pages;
mod probe;

use serde_json::{Map, Value, json};

use self::aim::Shown;
use crate::agent::Agent;
use crate::screen::Job;

type Line = Result<Value, String>;

pub fn answer(agent: &Agent, request: &Value) -> Value {
    let op = request["op"].as_str().unwrap_or_default();
    let line = match op {
        "webs" => webs(agent),
        "devtools" => devtools(agent),
        "call" => agent.hook("call", json!({ "service": request["target"], "method": request["method"], "args": request["params"] })),
        "open" => agent.hook("act", opening(request)),
        "appearance" => agent.hook("act", appearance(request)),
        "console" | "network" if request["pages"] == true => pages::gather(agent, request),
        "screen" | "pointer" | "clipboard" | "drop" | "shot" | "input" | "window" => {
            drive(agent, op, request).map(|result| json!({ "ok": true, "result": result }))
        }
        "render" => probe::render(agent, request),
        "hit" => probe::hit(agent, request),
        _ => relay(agent, request),
    };
    respond(&request["id"], line)
}

fn respond(asked: &Value, line: Line) -> Value {
    let mut out = match line {
        Ok(Value::Object(fields)) => fields,
        Ok(other) => Map::from_iter([("ok".to_string(), json!(true)), ("result".to_string(), other)]),
        Err(error) => Map::from_iter([("ok".to_string(), json!(false)), ("error".to_string(), json!(error))]),
    };
    out.insert("type".into(), json!("response"));
    out.insert("id".into(), asked.clone());
    Value::Object(out)
}

fn relay(agent: &Agent, request: &Value) -> Line {
    agent.hook("relay", json!({ "request": request }))
}

fn without(request: &Value, dropped: &[&str]) -> Map<String, Value> {
    let mut kept = request.as_object().cloned().unwrap_or_default();
    for key in ["type", "id", "op"].iter().chain(dropped) {
        kept.remove(*key);
    }
    kept
}

fn opening(request: &Value) -> Value {
    let mut given = without(request, &["name"]);
    given.insert("action".into(), json!("open"));
    if let Some(name) = request.get("name") {
        given.insert("app".into(), name.clone());
    }
    Value::Object(given)
}

fn appearance(request: &Value) -> Value {
    let mut given = without(request, &[]);
    given.insert("action".into(), json!("appearance"));
    Value::Object(given)
}

fn webs(agent: &Agent) -> Line {
    let mut line = agent.hook("webs", Value::Null)?;
    if let Some(result) = line["result"].as_object_mut() {
        result.remove("ports");
        result.remove("windows");
    }
    Ok(line)
}

fn devtools(agent: &Agent) -> Line {
    let line = agent.hook("webs", Value::Null)?;
    Ok(json!({ "ok": true, "result": { "ports": line["result"]["ports"] } }))
}

fn drive(agent: &Agent, op: &str, request: &Value) -> Result<Value, String> {
    let number = |key: &str| request[key].as_f64().ok_or_else(|| format!("{op} needs {key}"));
    let web = || request["web"].as_str().unwrap_or("desktop");
    let job = match op {
        "pointer" => Job::Pointer { x: number("x")?, y: number("y")? },
        "screen" => Job::Screen { path: request["path"].as_str().map(String::from) },
        "clipboard" => Job::Clipboard { text: request["text"].as_str().map(String::from) },
        "shot" => {
            let max = request["max"].as_u64().and_then(|m| u32::try_from(m).ok());
            Job::Shot { aim: Shown::ask(agent)?.web(web())?, max }
        }
        "input" => {
            let events = request["events"].as_array().cloned().ok_or("input needs events")?;
            Job::Input { aim: Shown::ask(agent)?.web(web())?, events }
        }
        "drop" => {
            let files = request["files"].as_array().ok_or("drop needs files")?.iter().filter_map(Value::as_str).map(String::from).collect();
            let at = number("x").ok().zip(number("y").ok());
            Job::Drop { aim: Shown::ask(agent)?.web(web())?, files, at }
        }
        _ => {
            let id = request["window"].as_u64().ok_or("window needs window, a window number of the window table")?;
            Job::Window { aim: Shown::ask(agent)?.window(id)?, change: request["change"].clone() }
        }
    };
    agent.drive(job).map_err(|why| format!("{op}: {why}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_is_the_hook_line_with_the_hosts_type_and_id() {
        let line = json!({ "ok": true, "result": { "webs": [] } });
        assert_eq!(respond(&json!(7), Ok(line)), json!({ "type": "response", "id": 7, "ok": true, "result": { "webs": [] } }));
        assert_eq!(respond(&json!(8), Err("no page x".into())), json!({ "type": "response", "id": 8, "ok": false, "error": "no page x" }));
    }

    #[test]
    fn open_and_appearance_become_dev_act() {
        let open = json!({ "type": "request", "id": 1, "op": "open", "name": "notes", "path": "/tmp/a" });
        assert_eq!(opening(&open), json!({ "action": "open", "app": "notes", "path": "/tmp/a" }));
        let look = json!({ "type": "request", "id": 2, "op": "appearance", "scheme": "dark" });
        assert_eq!(appearance(&look), json!({ "action": "appearance", "scheme": "dark" }));
    }
}
