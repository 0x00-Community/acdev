use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;

use crate::journal;
use crate::link::{self, Link};
use crate::screen::{Job, Screen};

pub type Writer = Arc<Mutex<UnixStream>>;
type Watchers = Arc<Mutex<Vec<Writer>>>;

const WITHIN: Duration = Duration::from_secs(600);
const FOLLOW: Duration = Duration::from_secs(2);

pub struct Agent {
    key: String,
    link: Mutex<Option<Arc<Link>>>,
    screen: Mutex<Option<(u64, Arc<Screen>)>>,
    watchers: Watchers,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn write_line(writer: &Writer, value: &Value) -> bool {
    let mut text = value.to_string();
    text.push('\n');
    locked(writer).write_all(text.as_bytes()).is_ok()
}

fn heard(watchers: &Watchers, event: &Value) {
    match event["type"].as_str().unwrap_or_default() {
        "devevent" => locked(watchers).retain(|w| write_line(w, &event["event"])),
        "timeline" => journal::timeline(event["line"].as_str().unwrap_or_default()),
        _ => {}
    }
}

impl Agent {
    pub fn new(key: String) -> Arc<Self> {
        Arc::new(Self { key, link: Mutex::new(None), screen: Mutex::new(None), watchers: Watchers::default() })
    }

    fn link(&self) -> Result<Arc<Link>, String> {
        let wanted = link::manager_socket()?;
        let mut held = locked(&self.link);
        if let Some(link) = held.as_ref().filter(|l| l.alive() && l.path() == wanted) {
            return Ok(link.clone());
        }
        let watchers = self.watchers.clone();
        let link = Link::open(&wanted, &self.key, move |event| heard(&watchers, &event))?;
        log::info!("acdev's agent is connected to the session manager at {}", wanted.display());
        *held = Some(link.clone());
        Ok(link)
    }

    pub fn hook(&self, method: &str, arg: Value) -> Result<Value, String> {
        self.hook_within(method, arg, WITHIN)
    }

    pub fn hook_within(&self, method: &str, arg: Value, within: Duration) -> Result<Value, String> {
        self.link()?.call(method, arg, within).map(|(answer, _)| answer)
    }

    pub fn drive(&self, job: Job) -> Result<Value, String> {
        self.screen()?.run(job)
    }

    fn screen(&self) -> Result<Arc<Screen>, String> {
        let link = self.link()?;
        let session = link.serial();
        let mut held = locked(&self.screen);
        if let Some((_, screen)) = held.as_ref().filter(|(from, s)| *from == session && s.alive()) {
            return Ok(screen.clone());
        }
        let (_, fd) = link.call("screen", Value::Null, WITHIN)?;
        let screen = Arc::new(Screen::start(fd.ok_or("dev.screen answered without a connection")?)?);
        *held = Some((session, screen.clone()));
        Ok(screen)
    }

    pub fn watch(&self, writer: Writer) {
        locked(&self.watchers).push(writer);
    }

    pub fn unwatch(&self, writer: &Writer) {
        locked(&self.watchers).retain(|w| !Arc::ptr_eq(w, writer));
    }

    pub fn follow(self: Arc<Self>) {
        let thread = move || {
            let mut said = String::new();
            loop {
                let why = self.screen().err().unwrap_or_default();
                if why != said {
                    if !why.is_empty() {
                        log::warn!("acdev's agent waits for a session: {why}");
                    }
                    said = why;
                }
                std::thread::sleep(FOLLOW);
            }
        };
        if let Err(e) = std::thread::Builder::new().name("acdev-agent-follow".into()).spawn(thread) {
            log::warn!("acdev's agent does not follow the session: {e}");
        }
    }
}
