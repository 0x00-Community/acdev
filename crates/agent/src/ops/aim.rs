use serde_json::Value;

use crate::agent::Agent;
use crate::screen::Aim;

const DESKTOP: &str = "desktop";

pub struct Shown {
    webs: Vec<Value>,
    windows: Option<Vec<Value>>,
}

impl Shown {
    pub fn ask(agent: &Agent) -> Result<Self, String> {
        let line = agent.hook("webs", Value::Null)?;
        Ok(Self::of(&line["result"]))
    }

    fn of(result: &Value) -> Self {
        Self { webs: result["webs"].as_array().cloned().unwrap_or_default(), windows: result["windows"].as_array().cloned() }
    }

    pub fn web(&self, web: &str) -> Result<Aim, String> {
        let named = self.webs.iter().find(|w| w["name"] == web).or_else(|| self.webs.iter().find(|w| w["app"] == web));
        let Some(row) = named else {
            return if web == DESKTOP { Ok(Aim::Screen) } else { Err(format!("no page {web}")) };
        };
        if row["kind"] == DESKTOP || row["lock"] == true || row["confirm"] == true {
            return Ok(Aim::Screen);
        }
        if let Some(n) = row["window"].as_u64().and_then(|id| self.toplevel(id)) {
            return Ok(Aim::Toplevel(n));
        }
        row["app"].as_str().map(|app| Aim::App(app.to_string())).ok_or_else(|| format!("{web}: no window of its on the screen"))
    }

    pub fn window(&self, id: u64) -> Result<Aim, String> {
        if id == 0 {
            return Ok(Aim::Screen);
        }
        if self.windows.is_none() {
            return Err("the session manager does not give acdev's agent its window table: acdes is older than the agent".into());
        }
        self.toplevel(id).map(Aim::Toplevel).ok_or_else(|| format!("no window {id}"))
    }

    fn toplevel(&self, id: u64) -> Option<u64> {
        self.windows.as_ref()?.iter().find(|w| w["id"].as_u64() == Some(id))?["toplevel"].as_u64()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn shown(windows: Option<Value>) -> Shown {
        let webs = json!([
            { "name": "desktop", "app": null, "kind": "desktop", "window": 0 },
            { "name": "notes", "app": "notes", "kind": "app", "window": 7 },
            { "name": "lock", "app": null, "kind": "desktop", "window": 4294967040_u64, "lock": true },
        ]);
        let mut result = json!({ "webs": webs });
        if let Some(windows) = windows {
            result["windows"] = windows;
        }
        Shown::of(&result)
    }

    #[test]
    fn a_page_aims_at_its_toplevel_through_the_window_table() {
        let table = shown(Some(json!([{ "id": 7, "toplevel": 12 }, { "id": 0, "desktop": true }])));
        assert_eq!(table.web("notes"), Ok(Aim::Toplevel(12)));
        assert_eq!(table.web("desktop"), Ok(Aim::Screen));
        assert_eq!(table.web("lock"), Ok(Aim::Screen));
        assert_eq!(table.window(7), Ok(Aim::Toplevel(12)));
        assert_eq!(table.window(0), Ok(Aim::Screen));
        assert!(table.web("files").is_err());
    }

    #[test]
    fn without_the_table_a_page_aims_at_its_app() {
        let bare = shown(None);
        assert_eq!(bare.web("notes"), Ok(Aim::App("notes".into())));
        assert!(bare.window(7).is_err());
    }
}
