use serde_json::{Value, json};
use zbus::blocking::{Connection, MessageIterator, Proxy};

pub struct Battery {
    bus: Connection,
}

impl Battery {
    const UPOWER: &str = "org.freedesktop.UPower";
    const DISPLAY: &str = "/org/freedesktop/UPower/devices/DisplayDevice";
    const DEVICE: &str = "org.freedesktop.UPower.Device";
    const CHARGING: u32 = 1;
    const EMPTY: u32 = 3;
    const FULL: u32 = 4;
    const PENDING_CHARGE: u32 = 5;
    const PERCENT: f64 = 100.0;

    pub fn open() -> Result<Self, String> {
        Connection::system().map(|bus| Self { bus }).map_err(|e| format!("system bus: {e}"))
    }

    pub fn status(&self) -> Value {
        self.read().unwrap_or_else(|e| {
            log::debug!("battery: {e}");
            Self::plugged()
        })
    }

    fn plugged() -> Value {
        json!({ "charging": true, "level": 1.0, "chargingTime": 0, "dischargingTime": null })
    }

    fn read(&self) -> zbus::Result<Value> {
        let device = Proxy::new(&self.bus, Self::UPOWER, Self::DISPLAY, Self::DEVICE)?;
        if !device.get_property::<bool>("IsPresent")? {
            return Ok(Self::plugged());
        }
        let state: u32 = device.get_property("State")?;
        let level = (device.get_property::<f64>("Percentage")? / Self::PERCENT).clamp(0.0, 1.0);
        let seconds = |name: &str| device.get_property::<i64>(name).ok().filter(|s| *s > 0);
        let charging = matches!(state, Self::CHARGING | Self::FULL | Self::PENDING_CHARGE);
        let charging_time = match state {
            Self::FULL => Some(0),
            _ if charging => seconds("TimeToFull"),
            _ => None,
        };
        let discharging_time = (!charging && state != Self::EMPTY).then(|| seconds("TimeToEmpty")).flatten();
        Ok(json!({ "charging": charging, "level": level, "chargingTime": charging_time, "dischargingTime": discharging_time }))
    }

    pub fn watch(&self, sink: impl Fn(Value) -> bool) -> Result<(), String> {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .path(Self::DISPLAY)
            .and_then(|b| b.interface("org.freedesktop.DBus.Properties"))
            .and_then(|b| b.member("PropertiesChanged"))
            .map(|b| b.build())
            .map_err(|e| e.to_string())?;
        let signals = MessageIterator::for_match_rule(rule, &self.bus, None).map_err(|e| e.to_string())?;
        let mut last = self.status();
        for message in signals {
            if message.is_err() {
                break;
            }
            let now = self.status();
            if now != last {
                if !sink(now.clone()) {
                    break;
                }
                last = now;
            }
        }
        Ok(())
    }
}
