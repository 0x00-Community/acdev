use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use v8::inspector::{Channel, ChannelImpl, StringBuffer, StringView, V8Inspector, V8InspectorClient, V8InspectorClientImpl, V8InspectorClientTrustLevel, V8InspectorSession};
use v8::UniquePtr;

thread_local! {
    static PROFILER: RefCell<Option<Profiler>> = const { RefCell::new(None) };
}

struct Client;

impl V8InspectorClientImpl for Client {}

struct Replies(Rc<RefCell<Option<String>>>);

impl ChannelImpl for Replies {
    fn send_response(&self, _: i32, mut message: UniquePtr<StringBuffer>) {
        *self.0.borrow_mut() = message.as_mut().map(|m| m.string().to_string());
    }

    fn send_notification(&self, _: UniquePtr<StringBuffer>) {}

    fn flush_protocol_notifications(&self) {}
}

struct Profiler {
    session: V8InspectorSession,
    _inspector: V8Inspector,
    reply: Rc<RefCell<Option<String>>>,
    dir: PathBuf,
    name: String,
    calls: Cell<i32>,
    parts: Cell<u32>,
}

impl Profiler {
    fn send(&self, method: &str, params: &str) -> Option<String> {
        let id = self.calls.get() + 1;
        self.calls.set(id);
        let message = format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#);
        self.session.dispatch_protocol_message(StringView::from(message.as_bytes()));
        self.reply.borrow_mut().take()
    }

    fn cut(&self, restart: bool) {
        let profile = self.send("Profiler.stop", "{}");
        if restart {
            self.send("Profiler.start", "{}");
        }
        let Some(mut reply) = profile.and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok()) else { return };
        let body = reply["result"]["profile"].take().to_string();
        let part = self.parts.get() + 1;
        self.parts.set(part);
        let file = self.dir.join(format!("{}-{part}.cpuprofile", self.name));
        match std::fs::write(&file, body) {
            Ok(()) => log::info!("cpu profile {}", file.display()),
            Err(e) => log::warn!("cpu profile {}: {e}", file.display()),
        }
    }
}

fn period() -> Duration {
    let seconds = std::env::var("ACDE_PROFILE_SECONDS").ok().and_then(|s| s.parse().ok()).filter(|s: &u64| *s > 0);
    Duration::from_secs(seconds.unwrap_or(30))
}

pub fn start(scope: &mut v8::PinScope, name: &str) {
    let Some(dir) = std::env::var_os("ACDE_PROFILE_DIR").map(PathBuf::from) else { return };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return log::warn!("ACDE_PROFILE_DIR {}: {e}", dir.display());
    }
    let inspector = V8Inspector::create(scope, V8InspectorClient::new(Box::new(Client)));
    let context = scope.get_current_context();
    inspector.context_created(context, 1, StringView::from(name.as_bytes()), StringView::empty());
    let reply = Rc::new(RefCell::new(None));
    let channel = Channel::new(Box::new(Replies(reply.clone())));
    let session = inspector.connect(1, channel, StringView::empty(), V8InspectorClientTrustLevel::FullyTrusted);
    let name = name.replace(['/', ' '], "_");
    let profiler = Profiler { session, _inspector: inspector, reply, dir, name, calls: Cell::new(0), parts: Cell::new(0) };
    profiler.send("Profiler.enable", "{}");
    profiler.send("Profiler.setSamplingInterval", r#"{"interval":250}"#);
    profiler.send("Profiler.start", "{}");
    PROFILER.with(|p| *p.borrow_mut() = Some(profiler));
    schedule();
}

fn schedule() {
    crate::rt::current().delay(period(), |_| {
        let live = PROFILER.with(|p| p.borrow().as_ref().map(|p| p.cut(true)).is_some());
        if live {
            schedule();
        }
    });
}

pub fn stop() {
    if let Some(profiler) = PROFILER.with(|p| p.borrow_mut().take()) {
        profiler.cut(false);
    }
}
