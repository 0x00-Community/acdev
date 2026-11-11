use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use acde_runtime::devtools::{self, Client};

use crate::inspector::Remote;

const TARGET_CLOSED: &str = r#"{"method":"Inspector.detached","params":{"reason":"target_closed"}}"#;

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

struct Attached<P> {
    web: String,
    session: u32,
    remote: Remote,
    peer: P,
}

struct Pages<P> {
    pages: Mutex<HashMap<String, Remote>>,
    sessions: Mutex<HashMap<u64, Attached<P>>>,
}

impl<P> Default for Pages<P> {
    fn default() -> Self {
        Self { pages: Mutex::default(), sessions: Mutex::default() }
    }
}

impl<P: Peer> Pages<P> {
    fn opened(&self, web: &str, remote: Remote) {
        self.pages.lock().unwrap_or_else(|e| e.into_inner()).insert(web.to_owned(), remote);
    }

    fn closed(&self, web: &str) {
        self.pages.lock().unwrap_or_else(|e| e.into_inner()).remove(web);
        let gone: Vec<Attached<P>> = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<u64> = sessions.iter().filter(|(_, a)| a.web == web).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| sessions.remove(&id)).collect()
        };
        for attached in gone {
            attached.peer.send(TARGET_CLOSED);
            attached.peer.close();
        }
    }

    fn attach(&self, peer: &P) {
        let Some(web) = peer.target() else { return };
        let Some(remote) = self.pages.lock().unwrap_or_else(|e| e.into_inner()).get(web).cloned() else { return };
        let to = peer.clone();
        let session = remote.connect(Arc::new(move |text: String| _ = to.send(&text)));
        let attached = Attached { web: web.to_owned(), session, remote, peer: peer.clone() };
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(peer.id(), attached);
    }

    fn message(&self, peer: &P, message: &str) -> bool {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(attached) = sessions.get(&peer.id()) else { return false };
        match super::page::routed(message) {
            true => attached.remote.page(attached.session, message.to_owned()),
            false => attached.remote.send(attached.session, message.to_owned()),
        }
        true
    }

    fn detach(&self, peer: &P) {
        let attached = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&peer.id());
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
    pages().closed(web);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rt;
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
        let mut runtime = rt::Runtime::new(None, "alpha#1");
        runtime.task(|scope| crate::inspector::attach(scope, "alpha#1"));
        let pages = Pages::<Fake>::default();
        pages.opened("alpha#1", crate::inspector::remote().expect("an inspector"));
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
        crate::inspector::stop();
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
        let mut runtime = rt::Runtime::new(None, "alpha#1");
        runtime.task(|scope| crate::inspector::attach(scope, "alpha#1"));
        let pages = Pages::<Fake>::default();
        pages.opened("alpha#1", crate::inspector::remote().expect("an inspector"));
        let fake = Fake::default();
        pages.attach(&fake);
        assert!(pages.message(&fake, r#"{"id":1,"method":"Page.getFrameTree","sessionId":"s"}"#));
        let refused = answer(&mut runtime, &fake, 1);
        assert_eq!((&refused["error"]["code"], &refused["sessionId"]), (&serde_json::json!(-32601), &serde_json::json!("s")), "no handler yet");
        runtime.task(|scope| {
            let host = v8::Object::new(scope);
            crate::methods!(scope, host, "devtoolsHandler" => crate::inspector::page_handler, "devtoolsSend" => crate::inspector::page_reply);
            let global = scope.get_current_context().global(scope);
            let key = crate::bind::string(scope, "host");
            global.set(scope, key.into(), host.into());
            run(scope, HANDLER).expect("the handler is installed");
        });
        assert!(pages.message(&fake, r#"{"id":2,"method":"Page.getFrameTree"}"#));
        assert!(pages.message(&fake, r#"{"id":3,"method":"Runtime.evaluate","params":{"expression":"6 * 7"}}"#));
        assert_eq!(answer(&mut runtime, &fake, 2)["result"]["frameTree"]["frame"]["id"], "alpha#1", "the frame id is the web name");
        assert_eq!(answer(&mut runtime, &fake, 3)["result"]["result"]["value"], 42, "Runtime still goes to V8");
        pages.detach(&fake);
        let gone = runtime.task(|scope| {
            crate::inspector::dispatch_posted(scope);
            run(scope, "String(globalThis.gone)")
        });
        assert_eq!(gone.as_deref(), Some("1"), "the handler hears the session end");
        crate::inspector::stop();
    }
}
