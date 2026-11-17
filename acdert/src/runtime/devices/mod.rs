mod automount;
mod cups;
mod ipp;
mod udisks;

use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use zbus::blocking::MessageIterator;

use crate::runtime::sync::Locked;
use automount::{Settings, When};
use udisks::{Udisks, Volume};

const SETTLE: Duration = Duration::from_millis(300);
const PRINTER_POLL: Duration = Duration::from_secs(3);

pub enum DevCall {
    State,
    Mount { id: String },
    Unmount { id: String },
    Eject { id: String },
    SetAutomount { patch: Value },
    SetDeviceAutomount { id: String, patch: Value },
    ForgetDevice { id: String },
    SetDefaultPrinter { id: String },
    PausePrinter { id: String },
    ResumePrinter { id: String },
    Jobs { printer: String },
    CancelJob { printer: String, job: i32 },
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Topic {
    Changed,
    Added,
}

impl Topic {
    pub fn parse(name: &str) -> Option<Topic> {
        match name {
            "changed" => Some(Topic::Changed),
            "added" => Some(Topic::Added),
            _ => None,
        }
    }
}

type Sink = Box<dyn Fn(Value) -> bool + Send>;

#[derive(Default)]
struct Hub {
    udisks: Option<Udisks>,
    sinks: Vec<(u64, Topic, Sink)>,
    next: u64,
    watching: bool,
    polling: bool,
    automount: bool,
    attached: Option<HashSet<String>>,
    printers: Option<(bool, Vec<Value>)>,
    last: Option<Value>,
}

#[derive(Clone, Default)]
pub struct Devices {
    hub: Arc<Mutex<Hub>>,
}

fn flag(patch: &Value, name: &str) -> Option<bool> {
    patch.get(name).and_then(Value::as_bool)
}

impl Devices {
    fn udisks(&self) -> Result<Udisks, String> {
        if let Some(u) = &self.hub.locked().udisks {
            return Ok(u.clone());
        }
        let u = Udisks::open()?;
        self.hub.locked().udisks = Some(u.clone());
        Ok(u)
    }

    fn volumes(&self) -> Vec<Volume> {
        match self.udisks().and_then(|u| u.volumes()) {
            Ok(list) => list,
            Err(e) => {
                log::debug!("acde.devices: {e}");
                Vec::new()
            }
        }
    }

    fn state_of(volumes: &[Volume], printers: (bool, Vec<Value>), settings: &Settings) -> Value {
        let attached: Vec<String> = volumes.iter().map(|v| v.key.clone()).collect();
        json!({
            "drives": volumes.iter().map(Volume::json).collect::<Vec<_>>(),
            "printers": printers.1,
            "printing": printers.0,
            "automount": settings.view(&attached),
        })
    }

    fn state(&self) -> Value {
        Self::state_of(&self.volumes(), cups::printers(), &Settings::load())
    }

    pub fn call(&self, call: DevCall) -> Result<Value, String> {
        let done = |r: Result<(), String>| r.map(|()| Value::Null);
        match call {
            DevCall::State => Ok(self.state()),
            DevCall::Mount { id } => self.udisks()?.mount(&id).map(Value::String),
            DevCall::Unmount { id } => done(self.udisks()?.unmount(&id)),
            DevCall::Eject { id } => done(self.udisks()?.eject(&id)),
            DevCall::SetAutomount { patch } => self.settings(|s| {
                if let Some(on) = flag(&patch, "onLogin") {
                    s.on_login = on;
                }
                if let Some(on) = flag(&patch, "onAttach") {
                    s.on_attach = on;
                }
                if let Some(on) = flag(&patch, "unknown") {
                    s.unknown = on;
                }
                Ok(())
            }),
            DevCall::SetDeviceAutomount { id, patch } => self.settings(|s| {
                let known = s.devices.get_mut(&id).ok_or_else(|| format!("no such device: {id}"))?;
                if let Some(on) = flag(&patch, "login") {
                    known.login = on;
                }
                if let Some(on) = flag(&patch, "attach") {
                    known.attach = on;
                }
                Ok(())
            }),
            DevCall::ForgetDevice { id } => self.settings(|s| {
                s.devices.remove(&id);
                Ok(())
            }),
            DevCall::SetDefaultPrinter { id } => self.printer_done(cups::set_default(&id)),
            DevCall::PausePrinter { id } => self.printer_done(cups::pause(&id)),
            DevCall::ResumePrinter { id } => self.printer_done(cups::resume(&id)),
            DevCall::Jobs { printer } => cups::jobs(&printer),
            DevCall::CancelJob { printer, job } => self.printer_done(cups::cancel(&printer, job)),
        }
    }

    fn settings(&self, change: impl FnOnce(&mut Settings) -> Result<(), String>) -> Result<Value, String> {
        let mut settings = Settings::load();
        change(&mut settings)?;
        settings.save()?;
        self.announce();
        Ok(Value::Null)
    }

    fn printer_done(&self, result: Result<(), String>) -> Result<Value, String> {
        result?;
        self.hub.locked().printers = None;
        self.announce();
        Ok(Value::Null)
    }

    fn announce(&self) {
        if self.hub.locked().sinks.iter().any(|(_, t, _)| *t == Topic::Changed) {
            let state = self.state();
            self.send_changed(state);
        }
    }

    fn send_changed(&self, state: Value) {
        let mut hub = self.hub.locked();
        if hub.last.as_ref() == Some(&state) {
            return;
        }
        let printers = state["printers"].as_array().cloned().unwrap_or_default();
        hub.printers = Some((state["printing"] == true, printers));
        hub.last = Some(state.clone());
        hub.sinks.retain(|(_, topic, sink)| *topic != Topic::Changed || sink(state.clone()));
    }

    pub fn listen(&self, topic: Topic, sink: impl Fn(Value) -> bool + Send + 'static) -> u64 {
        let (id, poll) = {
            let mut hub = self.hub.locked();
            hub.next += 1;
            let id = hub.next;
            hub.sinks.push((id, topic, Box::new(sink)));
            (id, topic == Topic::Changed && !std::mem::replace(&mut hub.polling, true))
        };
        let devices = self.clone();
        let started = std::thread::Builder::new().name("acde-devices".into()).spawn(move || devices.watch());
        if let Err(e) = started {
            log::warn!("acde.devices: {e}");
        }
        if poll {
            self.poll_printers();
        }
        id
    }

    pub fn unlisten(&self, id: u64) {
        self.hub.locked().sinks.retain(|(i, _, _)| *i != id);
    }

    /// The session's own devices: mounts what is set to mount at login, then mounts on attach.
    pub fn start(&self) {
        let devices = self.clone();
        let started = std::thread::Builder::new().name("acde-devices".into()).spawn(move || {
            devices.hub.locked().automount = true;
            devices.watch();
            let Ok(udisks) = devices.udisks() else { return };
            let volumes = devices.volumes();
            let mut settings = Settings::load();
            let mut dirty = false;
            for v in &volumes {
                dirty |= settings.seen(&v.key, &v.label, !v.mounts.is_empty());
                if v.mounts.is_empty() && settings.should(&v.key, When::Login) {
                    match udisks.mount_volume(v) {
                        Ok(path) => log::info!("acde.devices: mounted {} ({}) at login on {path}", v.label, v.id),
                        Err(e) => log::warn!("acde.devices: mounting {} at login: {e}", v.id),
                    }
                }
            }
            if dirty && let Err(e) = settings.save() {
                log::warn!("acde.devices: {e}");
            }
        });
        if let Err(e) = started {
            log::warn!("acde.devices: {e}");
        }
    }

    fn watch(&self) {
        if std::mem::replace(&mut self.hub.locked().watching, true) {
            return;
        }
        let first: HashSet<String> = self.volumes().into_iter().map(|v| v.id).collect();
        self.hub.locked().attached.get_or_insert(first);
        let Ok(udisks) = self.udisks() else {
            self.hub.locked().watching = false;
            return;
        };
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(udisks::UDISKS)
            .and_then(|b| b.path_namespace(udisks::ROOT))
            .map(|b| b.build());
        let signals = match rule.and_then(|rule| MessageIterator::for_match_rule(rule, udisks.bus(), None)) {
            Ok(signals) => signals,
            Err(e) => {
                log::warn!("acde.devices: watching UDisks2: {e}");
                self.hub.locked().watching = false;
                return;
            }
        };
        let (tx, rx) = mpsc::channel::<()>();
        let reader = std::thread::Builder::new().name("acde-devices-bus".into()).spawn(move || {
            for message in signals {
                if message.is_err() || tx.send(()).is_err() {
                    break;
                }
            }
        });
        let hub = Arc::downgrade(&self.hub);
        let refresher = std::thread::Builder::new().name("acde-devices".into()).spawn(move || {
            while rx.recv().is_ok() {
                while rx.recv_timeout(SETTLE).is_ok() {}
                let Some(hub) = hub.upgrade() else { break };
                Devices { hub }.refresh();
            }
        });
        if let Err(e) = reader.and(refresher) {
            log::warn!("acde.devices: {e}");
        }
    }

    fn refresh(&self) {
        let Ok(udisks) = self.udisks() else { return };
        let mut volumes = self.volumes();
        let (before, automount) = {
            let hub = self.hub.locked();
            (hub.attached.clone().unwrap_or_default(), hub.automount)
        };
        let mut settings = Settings::load();
        let mut dirty = false;
        let mut added = Vec::new();
        for v in &mut volumes {
            if !before.contains(&v.id) {
                dirty |= settings.seen(&v.key, &v.label, false);
                if automount && v.mounts.is_empty() && settings.should(&v.key, When::Attach) {
                    match udisks.mount_volume(v) {
                        Ok(path) => {
                            log::info!("acde.devices: mounted {} ({}) on attach on {path}", v.label, v.id);
                            v.mounts.push(path);
                        }
                        Err(e) => log::warn!("acde.devices: mounting {} on attach: {e}", v.id),
                    }
                }
                added.push(v.json());
            }
            dirty |= settings.seen(&v.key, &v.label, !v.mounts.is_empty());
        }
        if dirty && let Err(e) = settings.save() {
            log::warn!("acde.devices: {e}");
        }
        self.hub.locked().attached = Some(volumes.iter().map(|v| v.id.clone()).collect());
        let wants_state = self.hub.locked().sinks.iter().any(|(_, t, _)| *t == Topic::Changed);
        if wants_state {
            let cached = self.hub.locked().printers.clone();
            let printers = cached.unwrap_or_else(cups::printers);
            self.send_changed(Self::state_of(&volumes, printers, &settings));
        }
        let mut hub = self.hub.locked();
        for drive in added {
            hub.sinks.retain(|(_, topic, sink)| *topic != Topic::Added || sink(drive.clone()));
        }
    }

    fn poll_printers(&self) {
        let hub: Weak<Mutex<Hub>> = Arc::downgrade(&self.hub);
        let started = std::thread::Builder::new().name("acde-printers".into()).spawn(move || {
            loop {
                std::thread::sleep(PRINTER_POLL);
                let Some(strong) = hub.upgrade() else { break };
                let devices = Devices { hub: strong };
                {
                    let mut hub = devices.hub.locked();
                    hub.sinks.retain(|(_, topic, sink)| *topic != Topic::Changed || sink(Value::Null));
                    if !hub.sinks.iter().any(|(_, t, _)| *t == Topic::Changed) {
                        hub.polling = false;
                        hub.last = None;
                        break;
                    }
                }
                let now = cups::printers();
                if devices.hub.locked().printers.as_ref() != Some(&now) {
                    devices.announce();
                }
            }
        });
        if let Err(e) = started {
            self.hub.locked().polling = false;
            log::warn!("acde.devices: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn next(rx: &mpsc::Receiver<Value>) -> Value {
        loop {
            let value = rx.recv_timeout(Duration::from_secs(10)).expect("no event in 10 s");
            if !value.is_null() {
                return value;
            }
        }
    }

    #[test]
    #[ignore = "needs ACDE_TEST_IMAGE (a file system image) and XDG_CONFIG_HOME (a scratch directory); sets it up and tears it down through UDisks2"]
    fn loop_drive() {
        let image = std::env::var("ACDE_TEST_IMAGE").expect("ACDE_TEST_IMAGE");
        let config = std::env::var("XDG_CONFIG_HOME").expect("XDG_CONFIG_HOME");
        std::fs::create_dir_all(format!("{config}/acde")).unwrap();
        std::fs::write(format!("{config}/acde/automount.json"), r#"{"onAttach": true, "unknown": true}"#).unwrap();
        let devices = Devices::default();
        devices.start();
        let (added_tx, added) = mpsc::channel();
        devices.listen(Topic::Added, move |v| added_tx.send(v).is_ok());
        let (changed_tx, changed) = mpsc::channel();
        devices.listen(Topic::Changed, move |v| changed_tx.send(v).is_ok());
        std::thread::sleep(Duration::from_secs(1));
        let setup = std::process::Command::new("udisksctl").args(["loop-setup", "--no-user-interaction", "-f", &image]).output().unwrap();
        assert!(setup.status.success(), "{}", String::from_utf8_lossy(&setup.stderr));
        let drive = next(&added);
        eprintln!("added: {drive}");
        assert_eq!(drive["mounted"], true, "mounted on attach");
        let id = drive["id"].as_str().unwrap().to_owned();
        let state = next(&changed);
        assert!(state["drives"].as_array().unwrap().iter().any(|d| d["id"] == id.as_str()));
        devices.call(DevCall::Unmount { id: id.clone() }).unwrap();
        let path = devices.call(DevCall::Mount { id: id.clone() }).unwrap();
        eprintln!("mounted again on {path}");
        let saved = std::fs::read_to_string(format!("{config}/acde/automount.json")).unwrap();
        assert!(saved.contains("\"everMounted\": true"), "{saved}");
        devices.call(DevCall::Eject { id: id.clone() }).unwrap();
        std::thread::sleep(Duration::from_secs(1));
        let state = devices.call(DevCall::State).unwrap();
        assert!(!state["drives"].as_array().unwrap().iter().any(|d| d["id"] == id.as_str()), "{state}");
    }

    #[test]
    #[ignore = "needs ACDE_TEST_PRINTER, a CUPS queue this user may administer"]
    fn printer() {
        let name = std::env::var("ACDE_TEST_PRINTER").expect("ACDE_TEST_PRINTER");
        let devices = Devices::default();
        let find = || {
            let state = devices.call(DevCall::State).unwrap();
            state["printers"].as_array().unwrap().iter().find(|p| p["id"] == name.as_str()).cloned().expect("the printer is listed")
        };
        eprintln!("{}", find());
        devices.call(DevCall::PausePrinter { id: name.clone() }).unwrap();
        assert_eq!(find()["state"], "stopped");
        let lp = std::process::Command::new("lp").args(["-d", &name, "-t", "acde test", "/etc/hostname"]).output().unwrap();
        assert!(lp.status.success(), "{}", String::from_utf8_lossy(&lp.stderr));
        let jobs = devices.call(DevCall::Jobs { printer: name.clone() }).unwrap();
        eprintln!("jobs: {jobs}");
        let job = jobs.as_array().unwrap().iter().find(|j| j["name"] == "acde test").expect("the job is queued")["id"].as_i64().unwrap();
        assert_eq!(find()["jobs"], 1);
        devices.call(DevCall::CancelJob { printer: name.clone(), job: job as i32 }).unwrap();
        let jobs = devices.call(DevCall::Jobs { printer: name.clone() }).unwrap();
        assert!(!jobs.as_array().unwrap().iter().any(|j| j["id"] == job), "{jobs}");
        devices.call(DevCall::ResumePrinter { id: name.clone() }).unwrap();
        assert_ne!(find()["state"], "stopped");
        devices.call(DevCall::SetDefaultPrinter { id: name.clone() }).unwrap();
        assert_eq!(find()["isDefault"], true);
    }
}
