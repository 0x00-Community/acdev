use std::time::Duration;

use serde_json::{Map, Value, json};

use super::Line;
use crate::agent::Agent;

const WAIT: Duration = Duration::from_millis(1500);

fn for_page(request: &Value, key: &str) -> Value {
    let mut one = request.clone();
    if let Some(fields) = one.as_object_mut() {
        fields.remove("pages");
        fields.remove("since");
        if let Some(seq) = request["since"].get(key).filter(|seq| seq.is_number()) {
            fields.insert("since".into(), seq.clone());
        }
    }
    one
}

fn row(web: &Value, answered: Result<Value, String>) -> Value {
    let name = web["name"].as_str().unwrap_or_default();
    let mut row =
        Map::from_iter([("key".to_string(), json!(name)), ("app".to_string(), web.get("app").filter(|a| !a.is_null()).cloned().unwrap_or(json!(name)))]);
    let given = match answered {
        Ok(line) if line["ok"] == true => line["result"].clone(),
        Ok(line) => json!({ "error": line["error"].as_str().unwrap_or("refused") }),
        Err(why) => json!({ "error": why }),
    };
    match given {
        Value::Object(fields) => row.extend(fields.into_iter().filter(|(key, _)| !matches!(key.as_str(), "key" | "app"))),
        other => _ = row.insert("result".into(), other),
    }
    Value::Object(row)
}

pub fn gather(agent: &Agent, request: &Value) -> Line {
    let webs = agent.hook("webs", Value::Null)?["result"]["webs"].as_array().cloned().unwrap_or_default();
    let pages = std::thread::scope(|scope| {
        let asking: Vec<_> = webs
            .iter()
            .map(|web| {
                let one = for_page(request, web["name"].as_str().unwrap_or_default());
                let asked = json!({ "web": web["name"], "request": one });
                scope.spawn(move || row(web, agent.hook_within("relay", asked, WAIT)))
            })
            .collect();
        asking.into_iter().filter_map(|asked| asked.join().ok()).collect::<Vec<Value>>()
    });
    Ok(json!({ "ok": true, "result": { "pages": pages } }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_page_gets_its_own_since_and_no_pages_flag() {
        let request = json!({ "type": "request", "id": 3, "op": "console", "pages": true, "since": { "notes": 40, "desktop": 7 }, "limit": 5 });
        assert_eq!(for_page(&request, "notes"), json!({ "type": "request", "id": 3, "op": "console", "since": 40, "limit": 5 }));
        assert_eq!(for_page(&request, "lock"), json!({ "type": "request", "id": 3, "op": "console", "limit": 5 }));
    }

    #[test]
    fn a_page_that_fails_or_stays_silent_is_one_row_with_its_error() {
        let web = json!({ "name": "notes", "app": "notes" });
        assert_eq!(
            row(&web, Ok(json!({ "ok": true, "result": { "entries": [1], "next": 2 } }))),
            json!({ "key": "notes", "app": "notes", "entries": [1], "next": 2 })
        );
        assert_eq!(row(&web, Ok(json!({ "ok": false, "error": "boom" }))), json!({ "key": "notes", "app": "notes", "error": "boom" }));
        let desktop = json!({ "name": "desktop", "app": null });
        assert_eq!(row(&desktop, Err("late".into()))["app"], "desktop");
    }
}
