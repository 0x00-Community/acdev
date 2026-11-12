use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{STATE, Sink};
use crate::{bind, rt};

pub(super) const DOMAINS: [&str; 5] = ["Page", "DOM", "CSS", "Overlay", "Network"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Rewritten {
    Resolve,
    Highlight,
}

pub(super) type Resolving = Arc<Mutex<HashMap<String, (Rewritten, Option<Value>)>>>;

const NODE_LOOKUP: &str = "acde.devtools.node";
const HIGHLIGHT: &str = "acde.devtools.highlight";
const HANDLER_WAIT: Duration = Duration::from_secs(2);
pub(super) const QUEUED: usize = 1000;

#[derive(Default)]
pub(super) struct PageSide {
    sinks: RefCell<HashMap<u32, Sink>>,
    handler: RefCell<Option<v8::Global<v8::Function>>>,
    resolving: RefCell<HashMap<u32, Resolving>>,
    waiting: RefCell<Vec<(u32, String)>>,
    timed: Cell<bool>,
    expected: Cell<Option<Instant>>,
}

impl PageSide {
    pub(super) fn connected(&self, id: u32, sink: Sink) {
        self.sinks.borrow_mut().insert(id, sink);
    }

    pub(super) fn resolving(&self, id: u32) -> Resolving {
        self.resolving.borrow_mut().entry(id).or_default().clone()
    }
}

pub(super) fn rewrite(session: u32, message: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(message).ok()?;
    let (kind, call) = rewritten(&value)?;
    let pending = STATE.with(|s| s.borrow().as_ref().map(|s| s.page.resolving(session)))?;
    pending.lock().unwrap_or_else(|e| e.into_inner()).insert(value["id"].to_string(), (kind, value.get("sessionId").cloned()));
    Some(call.to_string())
}

fn rewritten(value: &Value) -> Option<(Rewritten, Value)> {
    let params = &value["params"];
    let node = params["nodeId"].as_u64().or_else(|| params["backendNodeId"].as_u64());
    match value["method"].as_str()? {
        "DOM.resolveNode" => {
            let mut evaluate = serde_json::json!({
                "id": value["id"],
                "method": "Runtime.evaluate",
                "params": {"expression": format!("globalThis[Symbol.for({NODE_LOOKUP:?})]({})", node.unwrap_or(0)), "silent": true},
            });
            if let Some(group) = params.get("objectGroup").filter(|g| g.is_string()) {
                evaluate["params"]["objectGroup"] = group.clone();
            }
            Some((Rewritten::Resolve, evaluate))
        }
        "Overlay.highlightNode" if node.is_none() && params["objectId"].is_string() => {
            let call = serde_json::json!({
                "id": value["id"],
                "method": "Runtime.callFunctionOn",
                "params": {
                    "objectId": params["objectId"],
                    "functionDeclaration": format!("function () {{ return globalThis[Symbol.for({HIGHLIGHT:?})](this) }}"),
                    "returnByValue": true,
                    "silent": true,
                },
            });
            Some((Rewritten::Highlight, call))
        }
        _ => None,
    }
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
    let Some((kind, session)) = pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&key) else { return text };
    let thrown = value.get("error").is_some() || value["result"].get("exceptionDetails").is_some();
    let found = !thrown
        && match kind {
            Rewritten::Resolve => value["result"]["result"]["type"] == "object",
            Rewritten::Highlight => value["result"]["result"]["value"] == true,
        };
    let mut object = value["result"]["result"].take();
    if found && object.get("subtype").is_none() {
        object["subtype"] = "node".into();
    }
    let mut answer = match (found, kind) {
        (true, Rewritten::Resolve) => serde_json::json!({"id": value["id"], "result": {"object": object}}),
        (true, Rewritten::Highlight) => serde_json::json!({"id": value["id"], "result": {}}),
        (false, _) => serde_json::json!({"id": value["id"], "error": {"code": -32000, "message": "No node with given id found"}}),
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
    let Some(handler) = handler else { return wait(id, message, &sink) };
    let args = [v8::Integer::new_from_unsigned(scope, id).into(), bind::string(scope, message).into()];
    bind::call(scope, &handler, &args);
}

pub(super) fn expect_handler() {
    STATE.with(|s| {
        if let Some(s) = s.borrow().as_ref()
            && s.page.handler.borrow().is_none()
        {
            s.page.expected.set(Some(Instant::now() + HANDLER_WAIT));
        }
    });
}

enum Wait {
    Answer,
    Full,
    Queued(Option<Duration>),
}

fn wait(id: u32, message: &str, sink: &Sink) {
    let now = Instant::now();
    let wait = STATE.with(|s| {
        let s = s.borrow();
        let Some(s) = s.as_ref() else { return Wait::Answer };
        let Some(until) = s.page.expected.get().filter(|until| *until > now) else { return Wait::Answer };
        let mut waiting = s.page.waiting.borrow_mut();
        if waiting.len() >= QUEUED {
            return Wait::Full;
        }
        waiting.push((id, message.to_owned()));
        Wait::Queued((!s.page.timed.replace(true)).then(|| until - now))
    });
    match wait {
        Wait::Answer => sink(not_found(message)),
        Wait::Full => sink(reloading(message)),
        Wait::Queued(Some(left)) => rt::current().delay(left, |_: &mut v8::PinScope| unanswered()),
        Wait::Queued(None) => {}
    }
}

pub(super) fn reloading(message: &str) -> String {
    let value = serde_json::from_str::<serde_json::Value>(message).unwrap_or_default();
    let mut answer = serde_json::json!({"id": value["id"], "error": {"code": -32000, "message": "page is reloading"}});
    if let Some(session) = value.get("sessionId") {
        answer["sessionId"] = session.clone();
    }
    answer.to_string()
}

fn unanswered() {
    let left = STATE.with(|s| {
        let s = s.borrow();
        let s = s.as_ref()?;
        s.page.timed.set(false);
        s.page.expected.set(None);
        let waiting = std::mem::take(&mut *s.page.waiting.borrow_mut());
        Some(waiting.into_iter().filter_map(|(id, message)| s.page.sinks.borrow().get(&id).cloned().map(|sink| (sink, message))).collect::<Vec<_>>())
    });
    for (sink, message) in left.into_iter().flatten() {
        sink(not_found(&message));
    }
}

fn handed(scope: &mut v8::PinScope) {
    let waiting = STATE.with(|s| s.borrow().as_ref().map(|s| std::mem::take(&mut *s.page.waiting.borrow_mut()))).unwrap_or_default();
    for (id, text) in waiting {
        message(scope, id, &text);
    }
}

pub(super) fn disconnected(scope: &mut v8::PinScope, id: u32) {
    let handler = STATE.with(|s| {
        let s = s.borrow();
        let s = s.as_ref()?;
        s.page.resolving.borrow_mut().remove(&id);
        s.page.waiting.borrow_mut().retain(|(waiting, _)| *waiting != id);
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
            s.page.expected.set(None);
            (s.name.clone(), !s.page.waiting.borrow().is_empty())
        })
    });
    let Some((name, waiting)) = name else { return };
    if waiting {
        _ = rt::current().sender().send(rt::Msg::Task(Box::new(handed)));
    }
    rv.set(bind::string(scope, &name).into());
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
        pending.lock().unwrap().insert("7".into(), (Rewritten::Resolve, Some(Value::from("s"))));
        let node = r#"{"id":7,"result":{"result":{"type":"object","className":"HTMLDivElement","objectId":"1.2"}}}"#;
        let answer: Value = serde_json::from_str(&resolved(&pending, node.into())).unwrap();
        assert_eq!(answer["result"]["object"]["objectId"], "1.2");
        assert_eq!(answer["result"]["object"]["subtype"], "node");
        assert_eq!(answer["sessionId"], "s");
        let other = r#"{"id":7,"result":{}}"#;
        assert_eq!(resolved(&pending, other.into()), other, "answered once");
        pending.lock().unwrap().insert("8".into(), (Rewritten::Resolve, None));
        let thrown = r#"{"id":8,"result":{"result":{"type":"object"},"exceptionDetails":{}}}"#;
        let answer: Value = serde_json::from_str(&resolved(&pending, thrown.into())).unwrap();
        assert_eq!(answer["error"]["code"], -32000);
    }

    #[test]
    fn highlight_node_by_object_id_calls_the_page_on_that_object() {
        let message = serde_json::json!({"id": 3, "method": "Overlay.highlightNode", "params": {"objectId": "9.1", "highlightConfig": {}}});
        let (kind, call) = rewritten(&message).expect("rewritten");
        assert_eq!(kind, Rewritten::Highlight);
        assert_eq!(call["method"], "Runtime.callFunctionOn");
        assert_eq!(call["params"]["objectId"], "9.1");
        assert!(call["params"]["functionDeclaration"].as_str().unwrap().contains("acde.devtools.highlight"));
        let by_id = serde_json::json!({"id": 4, "method": "Overlay.highlightNode", "params": {"nodeId": 7}});
        assert!(rewritten(&by_id).is_none(), "a nodeId goes to the page as it is");
        let pending: Resolving = Arc::default();
        pending.lock().unwrap().insert("3".into(), (Rewritten::Highlight, None));
        let drawn: Value = serde_json::from_str(&resolved(&pending, r#"{"id":3,"result":{"result":{"type":"boolean","value":true}}}"#.into())).unwrap();
        assert_eq!(drawn, serde_json::json!({"id": 3, "result": {}}));
        pending.lock().unwrap().insert("5".into(), (Rewritten::Highlight, None));
        let other: Value = serde_json::from_str(&resolved(&pending, r#"{"id":5,"result":{"result":{"type":"boolean","value":false}}}"#.into())).unwrap();
        assert_eq!(other["error"]["code"], -32000);
    }
}
