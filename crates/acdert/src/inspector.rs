use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use v8::UniquePtr;
use v8::inspector::{Channel, ChannelImpl, StringBuffer, StringView, V8Inspector, V8InspectorClient, V8InspectorClientImpl, V8InspectorClientTrustLevel, V8InspectorSession};

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

struct Client;

impl V8InspectorClientImpl for Client {}

#[derive(Default)]
struct Inbox {
    reply: RefCell<Option<String>>,
    scripts: RefCell<HashMap<String, String>>,
}

struct Replies(Rc<Inbox>);

impl ChannelImpl for Replies {
    fn send_response(&self, _: i32, mut message: UniquePtr<StringBuffer>) {
        *self.0.reply.borrow_mut() = message.as_mut().map(|m| m.string().to_string());
    }

    fn send_notification(&self, mut message: UniquePtr<StringBuffer>) {
        let Some(text) = message.as_mut().map(|m| m.string().to_string()) else { return };
        if !text.contains("\"Debugger.scriptParsed\"") {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        let params = &value["params"];
        if let (Some(url), Some(id)) = (params["url"].as_str(), params["scriptId"].as_str())
            && !url.is_empty()
        {
            self.0.scripts.borrow_mut().insert(url.to_owned(), id.to_owned());
        }
    }

    fn flush_protocol_notifications(&self) {}
}

struct Session {
    session: V8InspectorSession,
    _inspector: V8Inspector,
    inbox: Rc<Inbox>,
    calls: Cell<i32>,
}

pub fn wanted() -> bool {
    std::env::var_os("ACDE_PROFILE_DIR").is_some() || dev()
}

fn dev() -> bool {
    std::env::var_os("ACDE_DEV").is_some()
}

const TAIL: &str = "\n;";

pub fn module_source(source: &str) -> std::borrow::Cow<'_, str> {
    if dev() { format!("{source}{TAIL}").into() } else { source.into() }
}

pub fn start(scope: &mut v8::PinScope, name: &str) {
    if !wanted() {
        return;
    }
    let inspector = V8Inspector::create(scope, V8InspectorClient::new(Box::new(Client)));
    let context = scope.get_current_context();
    inspector.context_created(context, 1, StringView::from(name.as_bytes()), StringView::empty());
    let inbox = Rc::new(Inbox::default());
    let channel = Channel::new(Box::new(Replies(inbox.clone())));
    let session = inspector.connect(1, channel, StringView::empty(), V8InspectorClientTrustLevel::FullyTrusted);
    SESSION.with(|s| *s.borrow_mut() = Some(Session { session, _inspector: inspector, inbox, calls: Cell::new(0) }));
    if dev() {
        send("Debugger.enable", "{}");
    }
}

pub fn send(method: &str, params: &str) -> Option<String> {
    SESSION.with(|s| {
        let s = s.borrow();
        let s = s.as_ref()?;
        let id = s.calls.get() + 1;
        s.calls.set(id);
        let message = format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#);
        s.session.dispatch_protocol_message(StringView::from(message.as_bytes()));
        s.inbox.reply.borrow_mut().take()
    })
}

pub fn stop() {
    SESSION.with(|s| s.borrow_mut().take());
}

pub fn live_edit(url: &str, source: &str) -> Result<(), String> {
    let id = SESSION.with(|s| s.borrow().as_ref().and_then(|s| s.inbox.scripts.borrow().get(url).cloned()));
    let Some(id) = id else {
        return Err(if dev() { format!("no script {url}") } else { "not under acde dev".into() });
    };
    let params = serde_json::json!({ "scriptId": id, "scriptSource": format!("{source}{TAIL}"), "allowTopFrameEditing": false }).to_string();
    let reply = send("Debugger.setScriptSource", &params).ok_or("no reply")?;
    let value: serde_json::Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    if let Some(error) = value.get("error") {
        return Err(error["message"].as_str().unwrap_or("error").to_owned());
    }
    match value["result"]["status"].as_str() {
        Some("Ok") => Ok(()),
        Some("CompileError") => Err(format!("compile error: {}", value["result"]["exceptionDetails"]["text"].as_str().unwrap_or(""))),
        Some(status) => Err(status.to_owned()),
        None => Err("no status".into()),
    }
}
