use std::collections::HashMap;

use serde_json::{Value, json};
use zbus::blocking::{Connection, Proxy};
use zbus::proxy::CacheProperties;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as Variant};

pub const UDISKS: &str = "org.freedesktop.UDisks2";
pub const ROOT: &str = "/org/freedesktop/UDisks2";
const BLOCKS: &str = "/org/freedesktop/UDisks2/block_devices/";
const BLOCK: &str = "org.freedesktop.UDisks2.Block";
const FILESYSTEM: &str = "org.freedesktop.UDisks2.Filesystem";
const PARTITION: &str = "org.freedesktop.UDisks2.Partition";
const LOOP: &str = "org.freedesktop.UDisks2.Loop";
const ENCRYPTED: &str = "org.freedesktop.UDisks2.Encrypted";
const DRIVE: &str = "org.freedesktop.UDisks2.Drive";

type Props = HashMap<String, OwnedValue>;
type Objects = HashMap<OwnedObjectPath, HashMap<String, Props>>;

fn said(error: zbus::Error) -> String {
    match error {
        zbus::Error::MethodError(name, text, _) => {
            let name = name.as_str();
            if name.ends_with("NotAuthorized") || name.ends_with("NotAuthorizedCanObtain") || name.ends_with("NotAuthorizedDismissed") {
                return format!("not allowed: {}", text.unwrap_or_default());
            }
            text.unwrap_or_else(|| name.to_owned())
        }
        other => other.to_string(),
    }
}

fn get<'a>(props: Option<&'a Props>, name: &str) -> Option<&'a Variant<'static>> {
    props?.get(name).map(|v| &**v)
}

fn flag(props: Option<&Props>, name: &str) -> bool {
    matches!(get(props, name), Some(Variant::Bool(true)))
}

fn string(props: Option<&Props>, name: &str) -> String {
    match get(props, name) {
        Some(Variant::Str(s)) => s.as_str().trim().to_owned(),
        _ => String::new(),
    }
}

fn path(props: Option<&Props>, name: &str) -> Option<String> {
    match get(props, name) {
        Some(Variant::ObjectPath(p)) if p.as_str() != "/" => Some(p.as_str().to_owned()),
        _ => None,
    }
}

fn number(props: Option<&Props>, name: &str) -> u64 {
    match get(props, name) {
        Some(Variant::U64(n)) => *n,
        Some(Variant::U32(n)) => u64::from(*n),
        _ => 0,
    }
}

fn bytes_of(value: &Variant) -> Option<String> {
    let Variant::Array(array) = value else { return None };
    let bytes: Vec<u8> = array.iter().filter_map(|b| if let Variant::U8(b) = b { Some(*b) } else { None }).take_while(|b| *b != 0).collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn mount_points(props: Option<&Props>) -> Vec<String> {
    match get(props, "MountPoints") {
        Some(Variant::Array(array)) => array.iter().filter_map(bytes_of).collect(),
        _ => Vec::new(),
    }
}

fn strings(props: Option<&Props>, name: &str) -> Vec<String> {
    match get(props, name) {
        Some(Variant::Array(array)) => array.iter().filter_map(|s| if let Variant::Str(s) = s { Some(s.as_str().to_owned()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Volume {
    pub id: String,
    pub key: String,
    pub label: String,
    pub kind: &'static str,
    pub size: u64,
    pub mounts: Vec<String>,
    pub ejectable: bool,
    block: String,
    drive: Option<String>,
    backing: Option<String>,
    loop_device: Option<String>,
}

impl Volume {
    pub fn json(&self) -> Value {
        let path = self.mounts.first().cloned();
        let free = path.as_deref().and_then(|p| rustix::fs::statvfs(p).ok()).map(|s| s.f_bavail.saturating_mul(s.f_frsize));
        json!({
            "id": self.id,
            "device": self.key,
            "label": self.label,
            "kind": self.kind,
            "size": self.size,
            "free": free,
            "mounted": path.is_some(),
            "path": path,
            "ejectable": self.ejectable,
        })
    }
}

#[derive(Clone)]
pub struct Udisks {
    bus: Connection,
}

fn options() -> HashMap<&'static str, Variant<'static>> {
    HashMap::from([("auth.no_user_interaction", Variant::from(true))])
}

impl Udisks {
    pub fn open() -> Result<Self, String> {
        let bus = Connection::system().map_err(said)?;
        let udisks = Udisks { bus };
        udisks.objects().map_err(|e| format!("UDisks2 is not running: {e}"))?;
        Ok(udisks)
    }

    pub fn bus(&self) -> &Connection {
        &self.bus
    }

    fn proxy(&self, path: &str, interface: &'static str) -> Result<Proxy<'static>, String> {
        zbus::blocking::proxy::Builder::new(&self.bus)
            .destination(UDISKS)
            .and_then(|b| b.path(path.to_owned()))
            .and_then(|b| b.interface(interface))
            .map(|b| b.cache_properties(CacheProperties::No))
            .and_then(|b| b.build())
            .map_err(said)
    }

    fn objects(&self) -> Result<Objects, String> {
        let manager = self.proxy(ROOT, "org.freedesktop.DBus.ObjectManager")?;
        manager.call("GetManagedObjects", &()).map_err(said)
    }

    pub fn volumes(&self) -> Result<Vec<Volume>, String> {
        let objects = self.objects()?;
        let props = |path: &str, iface: &str| objects.get(&OwnedObjectPath::try_from(path.to_owned()).ok()?).and_then(|o| o.get(iface));
        let uid = rustix::process::getuid().as_raw();
        let mut list = Vec::new();
        for (object, ifaces) in &objects {
            let object = object.as_str();
            let (Some(block), Some(fs)) = (ifaces.get(BLOCK), ifaces.get(FILESYSTEM)) else { continue };
            let (block, fs) = (Some(block), Some(fs));
            if flag(block, "HintIgnore") || string(block, "IdUsage") != "filesystem" {
                continue;
            }
            let backing = path(block, "CryptoBackingDevice");
            let parent = backing.clone().unwrap_or_else(|| object.to_owned());
            let drive = path(block, "Drive").or_else(|| path(props(&parent, BLOCK), "Drive"));
            let table = path(props(&parent, PARTITION), "Table");
            let loop_device = [Some(parent.clone()), table].into_iter().flatten().find(|p| props(p, LOOP).is_some());
            let mine = loop_device.as_deref().is_some_and(|l| number(props(l, LOOP), "SetupByUID") == u64::from(uid));
            if flag(block, "HintSystem") && !mine {
                continue;
            }
            if loop_device.is_some() && !mine {
                continue;
            }
            let d = drive.as_deref().and_then(|p| props(p, DRIVE));
            let media = string(d, "Media");
            let bus = string(d, "ConnectionBus");
            let optical = flag(d, "Optical") || media.starts_with("optical") || strings(d, "MediaCompatibility").iter().any(|m| m.starts_with("optical"));
            let kind = if loop_device.is_some() {
                "disk"
            } else if optical {
                "disc"
            } else if media.starts_with("flash") || bus == "sdio" {
                "card"
            } else if bus == "usb" || bus == "ieee1394" || flag(d, "Removable") {
                "usb"
            } else {
                "disk"
            };
            let id = object.strip_prefix(BLOCKS).unwrap_or(object).to_owned();
            let model = [string(d, "Vendor"), string(d, "Model")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
            let backing_file = loop_device.as_deref().and_then(|l| get(props(l, LOOP), "BackingFile")).and_then(bytes_of);
            let backing_name = backing_file.as_deref().and_then(|f| f.rsplit('/').next()).map(str::to_owned);
            let label = [string(block, "IdLabel"), string(block, "HintName"), model, backing_name.unwrap_or_default()]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or_else(|| id.clone());
            let uuid = string(block, "IdUUID");
            let key = if !uuid.is_empty() {
                uuid
            } else {
                let serial = string(d, "Id");
                let number = number(props(&parent, PARTITION), "Number");
                if serial.is_empty() { id.clone() } else { format!("{serial}-{number}") }
            };
            let ejectable = loop_device.is_some() || flag(d, "Ejectable") || flag(d, "CanPowerOff") || flag(d, "Removable") || flag(d, "MediaRemovable");
            list.push(Volume {
                id,
                key,
                label,
                kind,
                size: number(block, "Size"),
                mounts: mount_points(fs),
                ejectable,
                block: object.to_owned(),
                drive,
                backing,
                loop_device,
            });
        }
        list.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
        Ok(list)
    }

    fn find(&self, id: &str) -> Result<(Volume, Vec<Volume>), String> {
        let all = self.volumes()?;
        let volume = all.iter().find(|v| v.id == id).cloned().ok_or_else(|| format!("no such drive: {id}"))?;
        Ok((volume, all))
    }

    pub fn mount(&self, id: &str) -> Result<String, String> {
        let (volume, _) = self.find(id)?;
        self.mount_volume(&volume)
    }

    pub fn mount_volume(&self, volume: &Volume) -> Result<String, String> {
        if let Some(path) = volume.mounts.first() {
            return Ok(path.clone());
        }
        self.proxy(&volume.block, FILESYSTEM)?.call("Mount", &(options(),)).map_err(said)
    }

    fn release(&self, volume: &Volume) -> Result<(), String> {
        if !volume.mounts.is_empty() {
            self.proxy(&volume.block, FILESYSTEM)?.call::<_, _, ()>("Unmount", &(options(),)).map_err(said)?;
        }
        if let Some(backing) = &volume.backing {
            self.proxy(backing, ENCRYPTED)?.call::<_, _, ()>("Lock", &(options(),)).map_err(said)?;
        }
        Ok(())
    }

    pub fn unmount(&self, id: &str) -> Result<(), String> {
        let (volume, _) = self.find(id)?;
        self.release(&volume)
    }

    pub fn eject(&self, id: &str) -> Result<(), String> {
        let (volume, all) = self.find(id)?;
        let siblings: Vec<&Volume> = all
            .iter()
            .filter(|v| match (&volume.loop_device, &volume.drive) {
                (Some(l), _) => v.loop_device.as_ref() == Some(l),
                (None, Some(d)) => v.drive.as_ref() == Some(d),
                (None, None) => v.id == volume.id,
            })
            .collect();
        for v in &siblings {
            self.release(v)?;
        }
        if let Some(l) = &volume.loop_device {
            return self.proxy(l, LOOP)?.call::<_, _, ()>("Delete", &(options(),)).map_err(said);
        }
        let Some(drive) = &volume.drive else { return Ok(()) };
        let d = self.proxy(drive, DRIVE)?;
        let ejectable = d.get_property::<bool>("Ejectable").unwrap_or(false);
        let can_power_off = d.get_property::<bool>("CanPowerOff").unwrap_or(false);
        if ejectable && let Err(e) = d.call::<_, _, ()>("Eject", &(options(),)) {
            if volume.kind == "disc" {
                return Err(said(e));
            }
            log::info!("acde.devices: eject {drive}: {}", said(e));
        }
        if can_power_off && let Err(e) = d.call::<_, _, ()>("PowerOff", &(options(),)) {
            log::info!("acde.devices: power off {drive}: {}", said(e));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "talks to this machine's UDisks2"]
    fn this_machine() {
        let udisks = Udisks::open().unwrap();
        for v in udisks.volumes().unwrap() {
            eprintln!("{}", v.json());
        }
    }
}
