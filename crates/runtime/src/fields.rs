use crate::failure::{Failure, Outcome};
use crate::js::JsText;
use serde_json::Value;
use std::collections::HashMap;

pub struct Fields(HashMap<String, String>);

impl Fields {
    pub fn read(body: Option<&Value>, names: &[&str], optional: &[&str]) -> Outcome<Self> {
        let empty = Value::Object(Default::default());
        let expected = || Failure::invalid(format!("expected fields: {}", names.join(", ")));
        let Value::Object(map) = body.unwrap_or(&empty) else { return Err(expected()) };
        let known = |key: &str| names.contains(&key) || optional.contains(&key);
        if !names.iter().all(|name| map.contains_key(*name)) || !map.keys().all(|key| known(key)) {
            return Err(expected());
        }
        let mut fields = HashMap::new();
        for (name, value) in map {
            match value {
                Value::String(text) if optional.contains(&name.as_str()) || !text.js_trim().is_empty() => {
                    fields.insert(name.clone(), text.clone());
                }
                _ => return Err(Failure::invalid("all fields must be non-empty strings")),
            }
        }
        Ok(Self(fields))
    }
    pub fn get(&self, name: &str) -> String {
        self.0.get(name).cloned().unwrap_or_default()
    }
    pub fn present(&self, name: &str) -> Option<String> {
        self.0.get(name).filter(|value| !value.is_empty()).cloned()
    }
}
