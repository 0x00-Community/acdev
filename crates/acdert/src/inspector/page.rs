use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::{STATE, Sink};
use crate::bind;

pub(super) const DOMAINS: [&str; 5] = ["Page", "DOM", "CSS", "Overlay", "Network"];

pub(super) type Resolving = Arc<Mutex<HashMap<String, Option<Value>>>>;

const NODE_LOOKUP: &str = "acde.devtools.node";

#[derive(Default)]
pub(super) struct PageSide {
    sinks: RefCell<HashMap<u32, Sink>>,
    handler: RefCell<Option<v8::Global<v8::Function>>>,
    resolving: RefCell<HashMap<u32, Resolving>>,
}

impl PageSide {
    pub(super) fn connected(&self, id: u32, sink: Sink) {
        self.sinks.borrow_mut().insert(id, sink);
    }

    pub(super) fn resolving(&self, id: u32) -> Resolving {
        self.resolving.borrow_mut().entry(id).or_default().clone()
    }
}

pub(super) fn resolve_node(session: u32, message: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(message).ok()?;
    if value["method"] != "DOM.resolveNode" {
        return None;
    }
    let pending = STATE.with(|s| s.borrow().as_ref().map(|s| s.page.resolving(session)))?;
    let params = &value["params"];
    let node = params["nodeId"].as_u64().or_else(|| params["backendNodeId"].as_u64()).unwrap_or(0);
    let mut evaluate = serde_json::json!({
        "id": value["id"],
        "method": "Runtime.evaluate",
        "params": {"expression": format!("globalThis[Symbol.for({NODE_LOOKUP:?})]({node})"), "silent": true},
    });
    if let Some(group) = params.get("objectGroup").filter(|g| g.is_string()) {
        evaluate["params"]["objectGroup"] = group.clone();
    }
    pending.lock().unwrap_or_else(|e| e.into_inner()).insert(value["id"].to_string(), value.get("sessionId").cloned());
    Some(evaluate.to_string())
}

struct Inspected(v8::Global<v8::Value>);

impl v8::inspector::InspectableImpl for Inspected {
    fn get<'s>(&self, scope: &mut v8::PinScope<'s, '_>, _: v8::Local<'s, v8::Context>) -> v8::Local<'s, v8::Value> {
        v8::Local::new(scope, &self.0)
    }
}

fn lookup(scope: &mut v8::PinScope, node: u64) -> Option<v8::Global<v8::Value>> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let key = v8::String::new(scope, NODE_LOOKUP)?;
    let symbol = v8::Symbol::for_key(scope, key);
    let function = v8::Local::<v8::Function>::try_from(global.get(scope, symbol.into())?).ok()?;
    let id = v8::Number::new(scope, node as f64);
    v8::tc_scope!(let tc, scope);
    let recv = v8::undefined(tc);
    let found = function.call(tc, recv.into(), &[id.into()]);
    tc.reset();
    found.filter(|found| found.is_object()).map(|found| v8::Global::new(tc, found))
}

pub(super) fn set_inspected(scope: &mut v8::PinScope, session: u32, message: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(message) else { return false };
    if value["method"] != "DOM.setInspectedNode" {
        return false;
    }
    let params = &value["params"];
    let found = params["nodeId"].as_u64().or_else(|| params["backendNodeId"].as_u64()).and_then(|node| lookup(scope, node));
    let target = STATE.with(|s| s.borrow().as_ref().map(|s| (s.extra.borrow().get(&session).cloned(), s.page.sinks.borrow().get(&session).cloned())));
    let Some((inspector, Some(sink))) = target else { return true };
    let mut answer = match (found, inspector) {
        (Some(node), Some(inspector)) => {
            inspector.add_inspected_object(v8::inspector::Inspectable::new(Box::new(Inspected(node))));
            serde_json::json!({"id": value["id"], "result": {}})
        }
        _ => serde_json::json!({"id": value["id"], "error": {"code": -32000, "message": "No node with given id found"}}),
    };
    if let Some(id) = value.get("sessionId") {
        answer["sessionId"] = id.clone();
    }
    sink(answer.to_string());
    true
}

pub(super) fn resolved(pending: &Resolving, text: String) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else { return text };
    let key = value["id"].to_string();
    let Some(session) = pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&key) else { return text };
    let found = value["result"].get("exceptionDetails").is_none() && value["result"]["result"]["type"] == "object";
    let mut object = value["result"]["result"].take();
    if found && object.get("subtype").is_none() {
        object["subtype"] = "node".into();
    }
    let mut answer = match found {
        true => serde_json::json!({"id": value["id"], "result": {"object": object}}),
        false => serde_json::json!({"id": value["id"], "error": {"code": -32000, "message": "No node with given id found"}}),
    };
    if let Some(session) = session {
        answer["sessionId"] = session;
    }
    answer.to_string()
}

pub(super) fn routed(message: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(message) else { return false };
    value["method"].as_str().and_then(|method| method.split_once('.')).is_some_and(|(domain, _)| DOMAINS.contains(&domain))
}

pub(super) fn message(scope: &mut v8::PinScope, id: u32, message: &str) {
    let found = STATE.with(|s| s.borrow().as_ref().map(|s| (s.page.handler.borrow().clone(), s.page.sinks.borrow().get(&id).cloned())));
    let Some((handler, Some(sink))) = found else { return };
    let Some(handler) = handler else { return sink(not_found(message)) };
    let args = [v8::Integer::new_from_unsigned(scope, id).into(), bind::string(scope, message).into()];
    bind::call(scope, &handler, &args);
}

pub(super) fn disconnected(scope: &mut v8::PinScope, id: u32) {
    let handler = STATE.with(|s| {
        let s = s.borrow();
        let s = s.as_ref()?;
        s.page.resolving.borrow_mut().remove(&id);
        s.page.sinks.borrow_mut().remove(&id)?;
        s.page.handler.borrow().clone()
    });
    if let Some(handler) = handler {
        let args = [v8::Integer::new_from_unsigned(scope, id).into(), v8::null(scope).into()];
        bind::call(scope, &handler, &args);
    }
}

fn not_found(message: &str) -> String {
    let value = serde_json::from_str::<serde_json::Value>(message).unwrap_or_default();
    let method = value["method"].as_str().unwrap_or_default();
    let mut answer = serde_json::json!({"id": value["id"], "error": {"code": -32601, "message": format!("'{method}' wasn't found")}});
    if let Some(session) = value.get("sessionId") {
        answer["sessionId"] = session.clone();
    }
    answer.to_string()
}

pub fn install(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Ok(function) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return bind::throw_type_error(scope, "devtoolsHandler: the handler is a function");
    };
    let handler = v8::Global::new(scope, function);
    let name = STATE.with(|s| {
        s.borrow().as_ref().map(|s| {
            *s.page.handler.borrow_mut() = Some(handler);
            s.name.clone()
        })
    });
    if let Some(name) = name {
        rv.set(bind::string(scope, &name).into());
    }
}

pub fn reply(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_f64(scope, &args, 0);
    if !(0.0..=f64::from(u32::MAX)).contains(&id) {
        return;
    }
    let text = bind::arg_string(scope, &args, 1);
    let sink = STATE.with(|s| s.borrow().as_ref().and_then(|s| s.page.sinks.borrow().get(&(id as u32)).cloned()));
    if let Some(sink) = sink {
        sink(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_evaluated_node_answers_resolve_node_and_other_replies_pass() {
        let pending: Resolving = Arc::default();
        pending.lock().unwrap().insert("7".into(), Some(Value::from("s")));
        let node = r#"{"id":7,"result":{"result":{"type":"object","className":"HTMLDivElement","objectId":"1.2"}}}"#;
        let answer: Value = serde_json::from_str(&resolved(&pending, node.into())).unwrap();
        assert_eq!(answer["result"]["object"]["objectId"], "1.2");
        assert_eq!(answer["result"]["object"]["subtype"], "node");
        assert_eq!(answer["sessionId"], "s");
        let other = r#"{"id":7,"result":{}}"#;
        assert_eq!(resolved(&pending, other.into()), other, "answered once");
        pending.lock().unwrap().insert("8".into(), None);
        let thrown = r#"{"id":8,"result":{"result":{"type":"object"},"exceptionDetails":{}}}"#;
        let answer: Value = serde_json::from_str(&resolved(&pending, thrown.into())).unwrap();
        assert_eq!(answer["error"]["code"], -32000);
    }
}
