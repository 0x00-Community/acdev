use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};
use zbus::blocking::{Connection, Proxy};
use zbus::proxy::CacheProperties;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

pub const UPOWER: &str = "org.freedesktop.UPower";
pub const UPOWER_PATH: &str = "/org/freedesktop/UPower";
const UPOWER_DEVICE: &str = "org.freedesktop.UPower.Device";
pub const LOGIN: &str = "org.freedesktop.login1";
pub const LOGIN_PATH: &str = "/org/freedesktop/login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";
const SESSION_PATH: &str = "/org/freedesktop/login1/session/auto";
const SESSION: &str = "org.freedesktop.login1.Session";
pub const PROFILES: [(&str, &str); 2] =
    [("org.freedesktop.UPower.PowerProfiles", "/org/freedesktop/UPower/PowerProfiles"), ("net.hadess.PowerProfiles", "/net/hadess/PowerProfiles")];
const BATTERY: u32 = 2;

pub fn said(error: zbus::Error) -> String {
    match error {
        zbus::Error::MethodError(_, Some(text), _) => text,
        other => other.to_string(),
    }
}

pub fn proxy(bus: &Connection, destination: &'static str, path: &str, interface: &'static str) -> zbus::Result<Proxy<'static>> {
    zbus::blocking::proxy::Builder::new(bus)
        .destination(destination)?
        .path(path.to_owned())?
        .interface(interface)?
        .cache_properties(CacheProperties::No)
        .build()
}

struct Props(HashMap<String, OwnedValue>);

impl Props {
    fn all(bus: &Connection, destination: &'static str, path: &str, interface: &str) -> zbus::Result<Self> {
        Ok(Self(proxy(bus, destination, path, "org.freedesktop.DBus.Properties")?.call("GetAll", &(interface,))?))
    }

    fn get<T: TryFrom<OwnedValue>>(&self, name: &str) -> Option<T> {
        T::try_from(self.0.get(name)?.try_clone().ok()?).ok()
    }
}

pub struct Facts {
    pub on_battery: bool,
    pub lid_present: bool,
    pub lid_closed: bool,
    pub percent: Option<f64>,
    pub battery: Value,
    pub batteries: Vec<Value>,
}

fn state_name(state: u32) -> &'static str {
    match state {
        1 | 5 => "charging",
        2 | 6 => "discharging",
        3 => "empty",
        4 => "full",
        _ => "unknown",
    }
}

fn charge_limit(native: &str, p: &Props) -> Value {
    let dir = Path::new("/sys/class/power_supply").join(native);
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok().and_then(|t| t.trim().parse::<u32>().ok());
    let end = read("charge_control_end_threshold");
    let upower = p.get::<bool>("ChargeThresholdSupported").unwrap_or(false);
    if end.is_none() && !upower {
        return Value::Null;
    }
    let writable = rustix::fs::access(dir.join("charge_control_end_threshold"), rustix::fs::Access::WRITE_OK).is_ok();
    let enabled = p.get::<bool>("ChargeThresholdEnabled");
    let end = end.or_else(|| p.get::<u32>("ChargeEndThreshold"));
    json!({
        "start": read("charge_control_start_threshold").or_else(|| p.get::<u32>("ChargeStartThreshold")),
        "end": end.filter(|e| *e < 100 && enabled != Some(false)),
        "writable": writable,
        "upower": upower,
    })
}

fn battery_json(path: &str, p: &Props) -> Value {
    let native = p.get::<String>("NativePath").unwrap_or_default();
    let name = [p.get::<String>("Vendor").unwrap_or_default(), p.get::<String>("Model").unwrap_or_default()]
        .iter()
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    let state = state_name(p.get::<u32>("State").unwrap_or(0));
    let left = match state {
        "charging" => p.get::<i64>("TimeToFull"),
        _ => p.get::<i64>("TimeToEmpty"),
    }
    .filter(|s| *s > 0);
    json!({
        "id": if native.is_empty() { path.rsplit('/').next().unwrap_or(path).to_owned() } else { native.clone() },
        "name": name,
        "percent": p.get::<f64>("Percentage").unwrap_or(0.0),
        "state": state,
        "secondsLeft": left,
        "health": p.get::<f64>("Capacity").filter(|c| *c > 0.0),
        "rate": p.get::<f64>("EnergyRate").filter(|r| *r > 0.0),
        "chargeLimit": charge_limit(&native, p),
    })
}

pub fn facts(bus: &Connection) -> Result<Facts, String> {
    let manager = Props::all(bus, UPOWER, UPOWER_PATH, UPOWER).map_err(|e| format!("UPower: {}", said(e)))?;
    let paths: Vec<OwnedObjectPath> = proxy(bus, UPOWER, UPOWER_PATH, UPOWER).and_then(|p| p.call("EnumerateDevices", &())).map_err(said)?;
    let mut batteries = Vec::new();
    for path in &paths {
        let Ok(p) = Props::all(bus, UPOWER, path.as_str(), UPOWER_DEVICE) else { continue };
        if p.get::<u32>("Type") == Some(BATTERY) && p.get::<bool>("PowerSupply").unwrap_or(false) && p.get::<bool>("IsPresent").unwrap_or(true) {
            batteries.push(battery_json(path.as_str(), &p));
        }
    }
    let display = Props::all(bus, UPOWER, "/org/freedesktop/UPower/devices/DisplayDevice", UPOWER_DEVICE).ok();
    let battery = match (&display, batteries.first()) {
        (Some(d), Some(first)) if d.get::<bool>("IsPresent").unwrap_or(false) => {
            let mut b = battery_json("DisplayDevice", d);
            for key in ["id", "name", "health", "chargeLimit"] {
                b[key] = first[key].clone();
            }
            if batteries.len() > 1 {
                b["id"] = "DisplayDevice".into();
                b["name"] = "".into();
            }
            b
        }
        (_, Some(first)) => first.clone(),
        _ => Value::Null,
    };
    Ok(Facts {
        on_battery: manager.get::<bool>("OnBattery").unwrap_or(false),
        lid_present: manager.get::<bool>("LidIsPresent").unwrap_or(false),
        lid_closed: manager.get::<bool>("LidIsClosed").unwrap_or(false),
        percent: battery.get("percent").and_then(Value::as_f64),
        battery,
        batteries,
    })
}

pub struct Profiles {
    pub active: String,
    pub list: Vec<String>,
    pub degraded: Option<String>,
}

pub fn profiles(bus: &Connection) -> Option<Profiles> {
    PROFILES.iter().find_map(|&(name, path)| {
        let p = Props::all(bus, name, path, name).ok()?;
        let active = p.get::<String>("ActiveProfile")?;
        let list: Vec<HashMap<String, OwnedValue>> = p.get("Profiles").unwrap_or_default();
        let order = ["power-saver", "balanced", "performance"];
        let mut list: Vec<String> =
            list.into_iter().filter_map(|m| String::try_from(m.get("Profile")?.try_clone().ok()?).ok()).filter(|n| order.contains(&n.as_str())).collect();
        list.sort_by_key(|n| order.iter().position(|o| o == n));
        list.dedup();
        Some(Profiles { active, list, degraded: p.get::<String>("PerformanceDegraded").filter(|d| !d.is_empty()) })
    })
}

pub fn set_profile(bus: &Connection, profile: &str) -> Result<(), String> {
    let mut last = "power-profiles-daemon is not running".to_owned();
    for &(name, path) in &PROFILES {
        match proxy(bus, name, path, name).and_then(|p| p.set_property("ActiveProfile", profile).map_err(zbus::Error::from)) {
            Ok(()) => return Ok(()),
            Err(e) => last = said(e),
        }
    }
    Err(last)
}

fn manager(bus: &Connection) -> zbus::Result<Proxy<'static>> {
    proxy(bus, LOGIN, LOGIN_PATH, MANAGER)
}

pub fn can(bus: &Connection, method: &str) -> bool {
    manager(bus).and_then(|m| m.call::<_, _, String>(method, &())).is_ok_and(|answer| matches!(answer.as_str(), "yes" | "challenge"))
}

pub fn logind(bus: &Connection, method: &str) -> Result<(), String> {
    manager(bus).and_then(|m| m.call::<_, _, ()>(method, &(false,))).map_err(said)
}

pub fn lock(bus: &Connection) -> Result<(), String> {
    proxy(bus, LOGIN, SESSION_PATH, SESSION).and_then(|s| s.call::<_, _, ()>("Lock", &())).map_err(said)
}

pub fn set_brightness(bus: &Connection, name: &str, value: u32) -> Result<(), String> {
    proxy(bus, LOGIN, SESSION_PATH, SESSION).and_then(|s| s.call::<_, _, ()>("SetBrightness", &("backlight", name, value))).map_err(said)
}

pub fn inhibit(bus: &Connection, what: &str, why: &str) -> Result<zbus::zvariant::OwnedFd, String> {
    manager(bus).and_then(|m| m.call("Inhibit", &(what, "acde", why, "block"))).map_err(said)
}

pub fn blocked(bus: &Connection, what: &str) -> bool {
    manager(bus).and_then(|m| m.get_property::<String>("BlockInhibited")).is_ok_and(|list| list.split(':').any(|w| w == what))
}

pub fn docked(bus: &Connection) -> bool {
    manager(bus).and_then(|m| m.get_property::<bool>("Docked")).unwrap_or(false)
}

pub fn inhibitors(bus: &Connection) -> Vec<Value> {
    let Ok(list) = manager(bus).and_then(|m| m.call::<_, _, Vec<(String, String, String, String, u32, u32)>>("ListInhibitors", &())) else { return Vec::new() };
    let me = rustix::process::getpid().as_raw_nonzero().get().unsigned_abs();
    list.into_iter()
        .filter(|(what, _, _, mode, _, pid)| mode == "block" && *pid != me && what.split(':').any(|w| w == "sleep" || w == "idle"))
        .map(|(what, who, why, _, _, _)| json!({ "who": who, "why": why, "what": what.split(':').filter(|w| *w == "sleep" || *w == "idle").collect::<Vec<_>>() }))
        .collect()
}

pub fn enable_charge_threshold(bus: &Connection, battery: &str, on: bool) -> Result<(), String> {
    let paths: Vec<OwnedObjectPath> = proxy(bus, UPOWER, UPOWER_PATH, UPOWER).and_then(|p| p.call("EnumerateDevices", &())).map_err(said)?;
    for path in paths {
        let Ok(p) = Props::all(bus, UPOWER, path.as_str(), UPOWER_DEVICE) else { continue };
        if p.get::<String>("NativePath").as_deref() == Some(battery) && p.get::<bool>("ChargeThresholdSupported").unwrap_or(false) {
            return proxy(bus, UPOWER, path.as_str(), UPOWER_DEVICE).and_then(|d| d.call::<_, _, ()>("EnableChargeThreshold", &(on,))).map_err(said);
        }
    }
    Err(format!("UPower cannot limit the charge of {battery}"))
}
