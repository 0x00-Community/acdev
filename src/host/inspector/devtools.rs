use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crate::runtime::devtools::{self, Client, RELOAD_WAIT};
use serde_json::Value;

use crate::host::inspector::{Remote, Sink};

const TARGET_CLOSED: &str = r#"{"method":"Inspector.detached","params":{"reason":"target_closed"}}"#;
const CONTEXTS_CLEARED: &str = r#"{"method":"Runtime.executionContextsCleared","params":{}}"#;
const DOCUMENT_UPDATED: &str = r#"{"method":"DOM.documentUpdated","params":{}}"#;
const REPLAYED: &str = r#"{"id":-"#;
const FRAME_TREE: &str = r#"{"id":-1,"#;

trait Peer: Clone + Send + Sync + 'static {
    fn id(&self) -> u64;
    fn target(&self) -> Option<&str>;
    fn send(&self, message: &str) -> bool;
    fn close(&self);
}

impl Peer for Client {
    fn id(&self) -> u64 {
        Client::id(self)
    }

    fn target(&self) -> Option<&str> {
        Client::target(self)
    }

    fn send(&self, message: &str) -> bool {
        Client::send(self, message)
    }

    fn close(&self) {
        Client::close(self)
    }
}

trait Reloads: Send + Sync {
    fn reloading(&self, web: &str) -> bool;
    fn reloaded(&self, web: &str);
}

struct Endpoint;

impl Reloads for Endpoint {
    fn reloading(&self, web: &str) -> bool {
        devtools::reloading(web)
    }

    fn reloaded(&self, web: &str) {
        devtools::reloaded(web);
    }
}

#[derive(Default)]
struct Enabled(Vec<(String, Value)>);

impl Enabled {
    fn note(&mut self, message: &Value) {
        let Some(method) = message["method"].as_str() else { return };
        if let Some(domain) = method.strip_suffix(".enable") {
            self.0.retain(|(d, _)| d != domain);
            self.0.push((domain.to_owned(), message.get("params").cloned().unwrap_or_else(|| Value::Object(Default::default()))));
        } else if let Some(domain) = method.strip_suffix(".disable") {
            self.0.retain(|(d, _)| d != domain);
        }
    }

    fn has(&self, domain: &str) -> bool {
        self.0.iter().any(|(d, _)| d == domain)
    }
}

struct Attached<P> {
    web: String,
    session: u32,
    remote: Remote,
    peer: P,
    enabled: Enabled,
}

struct Waiting<P> {
    web: String,
    peer: P,
    enabled: Enabled,
    queue: Vec<String>,
    until: Instant,
}

struct Pages<P> {
    pages: Mutex<HashMap<String, Remote>>,
    sessions: Mutex<HashMap<u64, Attached<P>>>,
    waiting: Mutex<HashMap<u64, Waiting<P>>>,
    reloads: Arc<dyn Reloads>,
}

impl<P> Default for Pages<P> {
    fn default() -> Self {
        Self::new(Arc::new(Endpoint))
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn post(remote: &Remote, session: u32, message: String) {
    match super::page::routed(&message) {
        true => remote.page(session, message),
        false => remote.send(session, message),
    }
}

fn sink<P: Peer>(peer: P) -> Sink {
    Arc::new(move |text: String| {
        if !text.starts_with(REPLAYED) {
            _ = peer.send(&text);
            return;
        }
        if !text.starts_with(FRAME_TREE) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return };
        let frame = &value["result"]["frameTree"]["frame"];
        if frame.is_object() {
            _ = peer.send(&serde_json::json!({"method": "Page.frameNavigated", "params": {"frame": frame, "type": "Navigation"}}).to_string());
        }
    })
}

impl<P> Pages<P> {
    fn new(reloads: Arc<dyn Reloads>) -> Self {
        Self { pages: Mutex::default(), sessions: Mutex::default(), waiting: Mutex::default(), reloads }
    }
}

impl<P: Peer> Pages<P> {
    fn opened(&self, web: &str, remote: Remote) {
        locked(&self.pages).insert(web.to_owned(), remote.clone());
        self.reloads.reloaded(web);
        let back: Vec<Waiting<P>> = {
            let mut waiting = locked(&self.waiting);
            let ids: Vec<u64> = waiting.iter().filter(|(_, w)| w.web == web).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| waiting.remove(&id)).collect()
        };
        for waiting in back {
            self.resume(waiting, remote.clone());
        }
    }

    fn resume(&self, waiting: Waiting<P>, remote: Remote) {
        let Waiting { web, peer, enabled, queue, .. } = waiting;
        let session = remote.connect(sink(peer.clone()));
        remote.expect_handler();
        if enabled.has("Runtime") {
            peer.send(CONTEXTS_CLEARED);
        }
        for (n, (domain, params)) in enabled.0.iter().enumerate() {
            let replay = serde_json::json!({"id": -2 - n as i64, "method": format!("{domain}.enable"), "params": params});
            post(&remote, session, replay.to_string());
        }
        if enabled.has("Page") {
            post(&remote, session, r#"{"id":-1,"method":"Page.getFrameTree","params":{}}"#.to_owned());
        }
        if enabled.has("DOM") {
            peer.send(DOCUMENT_UPDATED);
        }
        for message in queue {
            post(&remote, session, message);
        }
        locked(&self.sessions).insert(peer.id(), Attached { web, session, remote, peer, enabled });
    }

    fn closed(&self, web: &str) -> bool {
        locked(&self.pages).remove(web);
        let gone: Vec<Attached<P>> = {
            let mut sessions = locked(&self.sessions);
            let ids: Vec<u64> = sessions.iter().filter(|(_, a)| a.web == web).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| sessions.remove(&id)).collect()
        };
        let reloading = self.reloads.reloading(web);
        for attached in gone {
            if reloading {
                let Attached { web, peer, enabled, .. } = attached;
                let waiting = Waiting { web, peer: peer.clone(), enabled, queue: Vec::new(), until: Instant::now() + RELOAD_WAIT };
                locked(&self.waiting).insert(peer.id(), waiting);
            } else {
                attached.peer.send(TARGET_CLOSED);
                attached.peer.close();
            }
        }
        reloading
    }

    fn expire(&self, now: Instant) {
        let gone: Vec<Waiting<P>> = {
            let mut waiting = locked(&self.waiting);
            let ids: Vec<u64> = waiting.iter().filter(|(_, w)| w.until <= now).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| waiting.remove(&id)).collect()
        };
        for waiting in gone {
            waiting.peer.send(TARGET_CLOSED);
            waiting.peer.close();
        }
    }

    fn attach(&self, peer: &P) {
        let Some(web) = peer.target() else { return };
        let Some(remote) = locked(&self.pages).get(web).cloned() else {
            if self.reloads.reloading(web) {
                let until = Instant::now() + RELOAD_WAIT;
                let waiting = Waiting { web: web.to_owned(), peer: peer.clone(), enabled: Enabled::default(), queue: Vec::new(), until };
                locked(&self.waiting).insert(peer.id(), waiting);
            }
            return;
        };
        let session = remote.connect(sink(peer.clone()));
        let attached = Attached { web: web.to_owned(), session, remote, peer: peer.clone(), enabled: Enabled::default() };
        locked(&self.sessions).insert(peer.id(), attached);
    }

    fn message(&self, peer: &P, message: &str) -> bool {
        let parsed = serde_json::from_str::<Value>(message).unwrap_or_default();
        if let Some(attached) = locked(&self.sessions).get_mut(&peer.id()) {
            attached.enabled.note(&parsed);
            post(&attached.remote, attached.session, message.to_owned());
            return true;
        }
        let mut waiting = locked(&self.waiting);
        let Some(waiting) = waiting.get_mut(&peer.id()) else { return false };
        if waiting.queue.len() >= super::page::QUEUED {
            peer.send(&super::page::reloading(message));
            return true;
        }
        waiting.enabled.note(&parsed);
        waiting.queue.push(message.to_owned());
        true
    }

    fn detach(&self, peer: &P) {
        locked(&self.waiting).remove(&peer.id());
        let attached = locked(&self.sessions).remove(&peer.id());
        if let Some(attached) = attached {
            attached.remote.disconnect(attached.session);
        }
    }
}

impl devtools::Forward for Pages<Client> {
    fn attach(&self, client: &Client) {
        Pages::attach(self, client);
    }

    fn message(&self, client: &Client, message: &str) -> bool {
        Pages::message(self, client, message)
    }

    fn detach(&self, client: &Client) {
        Pages::detach(self, client);
    }
}

fn pages() -> &'static Arc<Pages<Client>> {
    static PAGES: OnceLock<Arc<Pages<Client>>> = OnceLock::new();
    PAGES.get_or_init(|| {
        let pages = Arc::new(Pages::default());
        devtools::forward(Some(pages.clone()));
        pages
    })
}

pub fn opened(web: &str, remote: Remote) {
    pages().opened(web, remote);
}

pub fn closed(web: &str) {
    if !pages().closed(web) {
        return;
    }
    let expire = || {
        std::thread::sleep(RELOAD_WAIT + Duration::from_millis(100));
        pages().expire(Instant::now());
    };
    if let Err(e) = std::thread::Builder::new().name("acde-devtools-reload".into()).spawn(expire) {
        log::warn!("devtools reload wait: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::rt;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    #[derive(Clone, Default)]
    struct Fake {
        got: Arc<Mutex<Vec<String>>>,
        closed: Arc<AtomicBool>,
    }

    impl Peer for Fake {
        fn id(&self) -> u64 {
            7
        }

        fn target(&self) -> Option<&str> {
            Some("alpha#1")
        }

        fn send(&self, message: &str) -> bool {
            self.got.lock().unwrap().push(message.to_owned());
            true
        }

        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    fn values(fake: &Fake) -> Vec<serde_json::Value> {
        fake.got.lock().unwrap().iter().map(|t| serde_json::from_str(t).expect("json")).collect()
    }

    #[test]
    fn a_client_evaluates_hears_the_console_and_is_told_when_the_page_closes() {
        let mut runtime = rt::Runtime::new(None, "alpha#1", std::sync::Arc::new(crate::host::platform::Headless));
        runtime.task(|scope| crate::host::inspector::attach(scope, "alpha#1"));
        let pages = Pages::<Fake>::default();
        pages.opened("alpha#1", crate::host::inspector::remote().expect("an inspector"));
        let fake = Fake::default();
        assert!(!pages.message(&fake, "{}"), "nothing is forwarded before attach");
        pages.attach(&fake);
        assert!(pages.message(&fake, r#"{"id":1,"method":"Runtime.enable","params":{}}"#));
        let evaluate = r#"{"id":2,"method":"Runtime.evaluate","params":{"expression":"console.log('hello', {a: 1}); 'v' + 8"}}"#;
        assert!(pages.message(&fake, evaluate));
        runtime.lp.delay(Duration::from_secs(10), |_: &mut v8::PinScope| {});
        let deadline = Instant::now() + Duration::from_secs(10);
        let done = RefCell::new(false);
        runtime.run_until(|| {
            let values = values(&fake);
            let console = values.iter().any(|m| m["method"] == "Runtime.consoleAPICalled" && m["params"]["args"][1]["type"] == "object");
            *done.borrow_mut() = console && values.iter().any(|m| m["id"] == 2);
            *done.borrow() || Instant::now() > deadline
        });
        let values = values(&fake);
        assert!(done.into_inner(), "evaluate answered and console event delivered: {values:?}");
        assert_eq!(values.iter().find(|m| m["id"] == 2).expect("answer")["result"]["result"]["value"], "v8");
        pages.closed("alpha#1");
        assert_eq!(fake.got.lock().unwrap().last().map(String::as_str), Some(TARGET_CLOSED));
        assert!(fake.closed.load(Ordering::SeqCst), "the WebSocket is closed");
        assert!(!pages.message(&fake, "{}"), "the session is gone");
        crate::host::inspector::stop();
    }

    fn answer(runtime: &mut rt::Runtime, fake: &Fake, id: i64) -> serde_json::Value {
        runtime.lp.delay(Duration::from_secs(10), |_: &mut v8::PinScope| {});
        let deadline = Instant::now() + Duration::from_secs(10);
        runtime.run_until(|| values(fake).iter().any(|m| m["id"] == id) || Instant::now() > deadline);
        values(fake).into_iter().find(|m| m["id"] == id).expect("an answer")
    }

    fn run(scope: &mut v8::PinScope, code: &str) -> Option<String> {
        let code = v8::String::new(scope, code)?;
        let value = v8::Script::compile(scope, code, None)?.run(scope)?;
        Some(value.to_rust_string_lossy(scope))
    }

    const HANDLER: &str = "const frame = host.devtoolsHandler((session, text) => {
        if (text === null) return void (globalThis.gone = session)
        const m = JSON.parse(text)
        host.devtoolsSend(session, JSON.stringify({id: m.id, result: {frameTree: {frame: {id: frame}}}}))
    })";

    #[test]
    fn page_domains_go_to_the_page_handler_and_the_rest_to_v8() {
        let mut runtime = rt::Runtime::new(None, "alpha#1", std::sync::Arc::new(crate::host::platform::Headless));
        runtime.task(|scope| crate::host::inspector::attach(scope, "alpha#1"));
        let pages = Pages::<Fake>::default();
        pages.opened("alpha#1", crate::host::inspector::remote().expect("an inspector"));
        let fake = Fake::default();
        pages.attach(&fake);
        let started = Instant::now();
        assert!(pages.message(&fake, r#"{"id":1,"method":"Page.getFrameTree","sessionId":"s"}"#));
        let refused = answer(&mut runtime, &fake, 1);
        assert!(started.elapsed() < Duration::from_secs(1), "a session that was not handed over is answered at once");
        assert_eq!((&refused["error"]["code"], &refused["sessionId"]), (&serde_json::json!(-32601), &serde_json::json!("s")), "no handler yet");
        runtime.task(|scope| {
            let host = v8::Object::new(scope);
            crate::methods!(scope, host, "devtoolsHandler" => crate::host::inspector::page_handler, "devtoolsSend" => crate::host::inspector::page_reply);
            let global = scope.get_current_context().global(scope);
            let key = crate::host::bind::string(scope, "host");
            global.set(scope, key.into(), host.into());
            run(scope, HANDLER).expect("the handler is installed");
        });
        assert!(pages.message(&fake, r#"{"id":2,"method":"Page.getFrameTree"}"#));
        assert!(pages.message(&fake, r#"{"id":3,"method":"Runtime.evaluate","params":{"expression":"6 * 7"}}"#));
        assert_eq!(answer(&mut runtime, &fake, 2)["result"]["frameTree"]["frame"]["id"], "alpha#1", "the frame id is the web name");
        assert_eq!(answer(&mut runtime, &fake, 3)["result"]["result"]["value"], 42, "Runtime still goes to V8");
        pages.detach(&fake);
        let gone = runtime.task(|scope| {
            crate::host::inspector::dispatch_posted(scope);
            run(scope, "String(globalThis.gone)")
        });
        assert_eq!(gone.as_deref(), Some("1"), "the handler hears the session end");
        crate::host::inspector::stop();
    }

    struct Reloading(AtomicBool);

    impl Reloads for Reloading {
        fn reloading(&self, _: &str) -> bool {
            self.0.load(Ordering::SeqCst)
        }

        fn reloaded(&self, _: &str) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    #[test]
    fn a_reload_keeps_the_client_and_moves_it_to_the_new_page() {
        let reloads = Arc::new(Reloading(AtomicBool::new(false)));
        let pages = Pages::<Fake>::new(reloads.clone());
        let fake = Fake::default();
        {
            let mut old = rt::Runtime::new(None, "alpha#1", std::sync::Arc::new(crate::host::platform::Headless));
            old.task(|scope| {
                crate::host::inspector::attach(scope, "alpha#1");
                run(scope, "globalThis.which = 'old'");
            });
            pages.opened("alpha#1", crate::host::inspector::remote().expect("an inspector"));
            pages.attach(&fake);
            assert!(pages.message(&fake, r#"{"id":1,"method":"Runtime.enable","params":{}}"#));
            answer(&mut old, &fake, 1);
            reloads.0.store(true, Ordering::SeqCst);
            assert!(pages.closed("alpha#1"), "a reload is waited for");
            crate::host::inspector::stop();
        }
        assert!(!fake.closed.load(Ordering::SeqCst), "the WebSocket stays open");
        assert!(values(&fake).iter().all(|m| m["method"] != "Inspector.detached"), "no detach on a reload");
        assert!(pages.message(&fake, r#"{"id":2,"method":"Runtime.evaluate","params":{"expression":"which"}}"#), "queued while the page reloads");
        let before = fake.got.lock().unwrap().len();
        let mut new = rt::Runtime::new(None, "alpha#1", std::sync::Arc::new(crate::host::platform::Headless));
        new.task(|scope| {
            crate::host::inspector::attach(scope, "alpha#1");
            run(scope, "globalThis.which = 'new'");
        });
        pages.opened("alpha#1", crate::host::inspector::remote().expect("an inspector"));
        let evaluated = answer(&mut new, &fake, 2);
        assert_eq!(evaluated["result"]["result"]["value"], "new", "evaluation lands on the new page");
        let after = values(&fake).split_off(before);
        let cleared = after.iter().position(|m| m["method"] == "Runtime.executionContextsCleared").expect("contexts cleared");
        let created = after.iter().position(|m| m["method"] == "Runtime.executionContextCreated").expect("a new context");
        assert!(cleared < created, "{after:?}");
        assert!(after.iter().all(|m| m["id"].as_i64().is_none_or(|id| id > 0)), "replayed enables are not answered to the client: {after:?}");
        assert!(!fake.closed.load(Ordering::SeqCst));
        assert!(!reloads.0.load(Ordering::SeqCst), "the reload mark is cleared");
        crate::host::inspector::stop();
    }

    #[test]
    fn a_reload_that_never_comes_back_detaches_after_the_wait() {
        let reloads = Arc::new(Reloading(AtomicBool::new(false)));
        let pages = Pages::<Fake>::new(reloads.clone());
        let fake = Fake::default();
        let mut runtime = rt::Runtime::new(None, "alpha#1", std::sync::Arc::new(crate::host::platform::Headless));
        runtime.task(|scope| crate::host::inspector::attach(scope, "alpha#1"));
        pages.opened("alpha#1", crate::host::inspector::remote().expect("an inspector"));
        pages.attach(&fake);
        reloads.0.store(true, Ordering::SeqCst);
        assert!(pages.closed("alpha#1"));
        assert!(pages.message(&fake, r#"{"id":1,"method":"Runtime.enable"}"#));
        for id in 2..=super::super::page::QUEUED as i64 + 1 {
            assert!(pages.message(&fake, &format!(r#"{{"id":{id},"method":"Runtime.evaluate","params":{{"expression":"1"}}}}"#)));
        }
        let over = values(&fake).into_iter().filter(|m| m["error"]["message"] == "page is reloading").collect::<Vec<_>>();
        assert_eq!(over.len(), 1, "one past the cap is refused");
        assert_eq!(over[0]["id"], super::super::page::QUEUED as i64 + 1);
        pages.expire(Instant::now());
        assert!(!fake.closed.load(Ordering::SeqCst), "still within the wait");
        pages.expire(Instant::now() + RELOAD_WAIT * 2);
        assert_eq!(fake.got.lock().unwrap().last().map(String::as_str), Some(TARGET_CLOSED));
        assert!(fake.closed.load(Ordering::SeqCst), "closed as a real close");
        assert!(!pages.message(&fake, "{}"), "nothing waits any more");
        crate::host::inspector::stop();
    }
}
