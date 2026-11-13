use serde_json::{Value, json};
use zbus::blocking::{Connection, MessageIterator, Proxy};

pub struct Idle {
    bus: Connection,
}

impl Idle {
    const LOGIND: &str = "org.freedesktop.login1";
    const SESSION: &str = "/org/freedesktop/login1/session/auto";
    const INTERFACE: &str = "org.freedesktop.login1.Session";
    const MICROS: u64 = 1000;

    pub fn open() -> Result<Self, String> {
        Connection::system().map(|bus| Self { bus }).map_err(|e| format!("system bus: {e}"))
    }

    pub fn status(&self) -> Result<Value, String> {
        let session = Proxy::new(&self.bus, Self::LOGIND, Self::SESSION, Self::INTERFACE).map_err(|e| e.to_string())?;
        let idle: bool = session.get_property("IdleHint").map_err(|e| e.to_string())?;
        let locked: bool = session.get_property("LockedHint").unwrap_or(false);
        let since: u64 = session.get_property("IdleSinceHintMonotonic").unwrap_or(0);
        let now = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
        let now = u64::try_from(now.tv_sec).unwrap_or(0) * 1_000_000 + u64::try_from(now.tv_nsec).unwrap_or(0) / Self::MICROS;
        let idle_for = (idle && since > 0).then(|| now.saturating_sub(since) / Self::MICROS);
        Ok(json!({ "idle": idle, "idleForMs": idle_for, "locked": locked }))
    }

    pub fn watch(&self, sink: impl Fn(Value) -> bool) -> Result<(), String> {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(Self::LOGIND)
            .and_then(|b| b.interface("org.freedesktop.DBus.Properties"))
            .and_then(|b| b.member("PropertiesChanged"))
            .map(|b| b.build())
            .map_err(|e| e.to_string())?;
        let signals = MessageIterator::for_match_rule(rule, &self.bus, None).map_err(|e| e.to_string())?;
        let mut last = self.status()?;
        for message in signals {
            if message.is_err() {
                break;
            }
            let Ok(now) = self.status() else { continue };
            if now["idle"] != last["idle"] || now["locked"] != last["locked"] {
                if !sink(now.clone()) {
                    break;
                }
                last = now;
            }
        }
        Ok(())
    }
}
