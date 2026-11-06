use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use napi::bindgen_prelude::Unknown;
use napi::{Env, Result};
use napi_derive::napi;
use serde::Deserialize;
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as Variant};

use crate::js::{Watch, notify};
use crate::{blocking, failure};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const FILE_CHOOSER: &str = "org.freedesktop.portal.FileChooser";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SETTINGS: &str = "org.freedesktop.portal.Settings";
const APPEARANCE: &str = "org.freedesktop.appearance";
const COLOR_SCHEME: &str = "color-scheme";

static TOKENS: AtomicU64 = AtomicU64::new(1);

fn bus(error: zbus::Error) -> napi::Error {
    failure("portal_failed", &error.to_string())
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Filter {
    name: String,
    globs: Vec<String>,
    mimes: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OpenOptions {
    title: String,
    multiple: bool,
    directory: bool,
    filters: Vec<Filter>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SaveOptions {
    title: String,
    name: String,
    filters: Vec<Filter>,
}

fn filters(list: &[Filter]) -> Vec<(String, Vec<(u32, String)>)> {
    list.iter()
        .map(|f| {
            let patterns = f.globs.iter().map(|g| (0, g.clone())).chain(f.mimes.iter().map(|m| (1, m.clone()))).collect();
            (f.name.clone(), patterns)
        })
        .filter(|(_, patterns): &(String, Vec<(u32, String)>)| !patterns.is_empty())
        .collect()
}

fn local_path(uri: &str) -> Option<String> {
    url::Url::parse(uri).ok()?.to_file_path().ok()?.into_os_string().into_string().ok()
}

#[napi]
pub struct FileChooser {
    connection: Connection,
}

impl FileChooser {
    fn request(&self, method: &str, title: &str, mut options: HashMap<&str, Variant<'_>>) -> zbus::Result<Option<Vec<String>>> {
        let token = format!("acde{}_{}", std::process::id(), TOKENS.fetch_add(1, Ordering::Relaxed));
        options.insert("handle_token", Variant::from(token));
        let rule = zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(REQUEST)?.member("Response")?.build();
        let signals = MessageIterator::for_match_rule(rule, &self.connection, Some(16))?;
        let proxy = Proxy::new(&self.connection, PORTAL, PORTAL_PATH, FILE_CHOOSER)?;
        let handle: OwnedObjectPath = proxy.call(method, &("", title, options))?;
        for message in signals {
            let message = message?;
            if message.header().path().map(|p| p.as_str()) != Some(handle.as_str()) {
                continue;
            }
            let (response, results): (u32, HashMap<String, OwnedValue>) = message.body().deserialize()?;
            if response != 0 {
                return Ok(None);
            }
            let uris: Vec<String> = results.get("uris").and_then(|v| Vec::<String>::try_from(v.clone()).ok()).unwrap_or_default();
            let paths: Vec<String> = uris.iter().filter_map(|u| local_path(u)).collect();
            return Ok(if paths.is_empty() { None } else { Some(paths) });
        }
        Ok(None)
    }

    fn on(connection: Connection) -> zbus::Result<Self> {
        Proxy::new(&connection, PORTAL, PORTAL_PATH, FILE_CHOOSER)?.get_property::<u32>("version")?;
        Ok(Self { connection })
    }

    fn folder(&self, title: &str) -> zbus::Result<Option<String>> {
        let mut map: HashMap<&str, Variant<'_>> = HashMap::new();
        map.insert("multiple", Variant::from(false));
        map.insert("directory", Variant::from(true));
        Ok(self.request("OpenFile", title, map)?.and_then(|paths| paths.into_iter().next()))
    }
}

pub fn choose_folder(title: &str) -> std::result::Result<Option<String>, String> {
    let connection = Connection::session().map_err(|e| format!("no session bus: {e}"))?;
    let chooser = FileChooser::on(connection).map_err(|e| format!("no FileChooser portal: {e}"))?;
    chooser.folder(title).map_err(|e| format!("FileChooser portal: {e}"))
}

#[napi]
impl FileChooser {
    #[napi(factory)]
    pub async fn open() -> Result<Self> {
        blocking(|| Connection::session().and_then(Self::on).map_err(|e| failure("portal_unavailable", &format!("no FileChooser portal: {e}")))).await
    }

    #[napi(
        ts_args_type = "options: { title?: string; multiple?: boolean; directory?: boolean; filters?: { name: string; globs?: string[]; mimes?: string[] }[] }"
    )]
    pub async fn open_file(&self, options: serde_json::Value) -> Result<Option<Vec<String>>> {
        let options: OpenOptions = serde_json::from_value(options).map_err(|e| failure("bad_options", &e.to_string()))?;
        let chooser = Self { connection: self.connection.clone() };
        blocking(move || {
            let mut map: HashMap<&str, Variant<'_>> = HashMap::new();
            map.insert("multiple", Variant::from(options.multiple));
            map.insert("directory", Variant::from(options.directory));
            let list = filters(&options.filters);
            if !list.is_empty() {
                map.insert("filters", Variant::from(list));
            }
            chooser.request("OpenFile", &options.title, map).map_err(bus)
        })
        .await
    }

    #[napi(ts_args_type = "options: { title?: string; name?: string; filters?: { name: string; globs?: string[]; mimes?: string[] }[] }")]
    pub async fn save_file(&self, options: serde_json::Value) -> Result<Option<String>> {
        let options: SaveOptions = serde_json::from_value(options).map_err(|e| failure("bad_options", &e.to_string()))?;
        let chooser = Self { connection: self.connection.clone() };
        blocking(move || {
            let mut map: HashMap<&str, Variant<'_>> = HashMap::new();
            if !options.name.is_empty() {
                map.insert("current_name", Variant::from(options.name.as_str()));
            }
            let list = filters(&options.filters);
            if !list.is_empty() {
                map.insert("filters", Variant::from(list));
            }
            Ok(chooser.request("SaveFile", &options.title, map).map_err(bus)?.and_then(|paths| paths.into_iter().next()))
        })
        .await
    }
}

fn dark_scheme(value: &Variant<'_>) -> bool {
    match value {
        Variant::Value(inner) => dark_scheme(inner),
        Variant::U32(n) => *n == 1,
        _ => false,
    }
}

#[napi]
pub struct Appearance {
    connection: Connection,
    watch: Watch<bool>,
}

impl Appearance {
    fn read(connection: &Connection) -> zbus::Result<bool> {
        let proxy = Proxy::new(connection, PORTAL, PORTAL_PATH, SETTINGS)?;
        let value: OwnedValue = match proxy.call("ReadOne", &(APPEARANCE, COLOR_SCHEME)) {
            Ok(value) => value,
            Err(_) => proxy.call("Read", &(APPEARANCE, COLOR_SCHEME))?,
        };
        Ok(dark_scheme(&value))
    }

    fn changes(connection: &Connection) -> zbus::Result<MessageIterator> {
        let rule = zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).path(PORTAL_PATH)?.interface(SETTINGS)?.member("SettingChanged")?.build();
        MessageIterator::for_match_rule(rule, connection, Some(16))
    }

    fn on(connection: Connection) -> Self {
        Self { connection, watch: Watch::default() }
    }
}

#[napi]
impl Appearance {
    #[napi(factory)]
    pub async fn open() -> Result<Self> {
        blocking(|| Connection::session().map(Self::on).map_err(|e| failure("portal_unavailable", &format!("no session bus: {e}")))).await
    }

    #[napi]
    pub async fn dark(&self) -> Result<bool> {
        let connection = self.connection.clone();
        blocking(move || Self::read(&connection).map_err(bus)).await
    }

    #[napi(ts_args_type = "callback: (dark: boolean) => void")]
    pub fn watch(&self, env: Env, callback: Unknown<'_>) -> Result<()> {
        self.watch.watch(&env, callback, |sink| {
            let signals = Self::changes(&self.connection).map_err(bus)?;
            std::thread::Builder::new()
                .name("acde-appearance".into())
                .spawn(move || {
                    for message in signals {
                        let Ok(message) = message else { break };
                        let Ok((namespace, key, value)) = message.body().deserialize::<(String, String, OwnedValue)>() else { continue };
                        if namespace == APPEARANCE && key == COLOR_SCHEME {
                            notify(&sink, dark_scheme(&value));
                        }
                    }
                })
                .map(drop)
                .map_err(|e| napi::Error::from_reason(e.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private_bus;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    type Calls = Arc<Mutex<Vec<(String, String, HashMap<String, OwnedValue>)>>>;

    struct Stand {
        calls: Calls,
    }

    impl Stand {
        async fn answer(
            &self,
            method: &str,
            header: zbus::message::Header<'_>,
            connection: &zbus::Connection,
            title: &str,
            mut options: HashMap<String, OwnedValue>,
        ) -> OwnedObjectPath {
            let sender = header.sender().map(|s| s.to_string()).unwrap_or_default();
            let token = options.remove("handle_token").and_then(|v| String::try_from(v).ok()).unwrap_or_default();
            let handle =
                OwnedObjectPath::try_from(format!("/org/freedesktop/portal/desktop/request/{}/{token}", sender.trim_start_matches(':').replace('.', "_")))
                    .unwrap();
            let multiple = options.get("multiple").and_then(|v| bool::try_from(v.clone()).ok()).unwrap_or(false);
            let name = options.get("current_name").and_then(|v| String::try_from(v.clone()).ok()).unwrap_or_default();
            self.calls.lock().unwrap().push((method.into(), title.into(), options));
            let (response, uris): (u32, Vec<String>) = if title.contains("cancel") {
                (1, vec![])
            } else if method == "OpenFile" {
                let all = vec!["file:///tmp/picked/a%20b.txt".to_string(), "file:///tmp/picked/%E4%BD%A0.png".to_string()];
                (0, if multiple { all } else { all[..1].to_vec() })
            } else {
                (0, vec![format!("file:///tmp/picked/{name}")])
            };
            let mut results: HashMap<&str, Variant<'_>> = HashMap::new();
            if response == 0 {
                results.insert("uris", Variant::from(uris));
            }
            connection.emit_signal(Some(sender.as_str()), handle.as_str(), REQUEST, "Response", &(response, results)).await.unwrap();
            handle
        }
    }

    #[zbus::interface(name = "org.freedesktop.portal.FileChooser")]
    impl Stand {
        #[zbus(property, name = "version")]
        fn version(&self) -> u32 {
            4
        }

        async fn open_file(
            &self,
            #[zbus(header)] header: zbus::message::Header<'_>,
            #[zbus(connection)] connection: &zbus::Connection,
            _parent: &str,
            title: &str,
            options: HashMap<String, OwnedValue>,
        ) -> OwnedObjectPath {
            self.answer("OpenFile", header, connection, title, options).await
        }

        async fn save_file(
            &self,
            #[zbus(header)] header: zbus::message::Header<'_>,
            #[zbus(connection)] connection: &zbus::Connection,
            _parent: &str,
            title: &str,
            options: HashMap<String, OwnedValue>,
        ) -> OwnedObjectPath {
            self.answer("SaveFile", header, connection, title, options).await
        }
    }

    #[test]
    fn against_a_stand_in_portal() {
        let Some((mut daemon, address, dir)) = private_bus("portal") else {
            eprintln!("no dbus-daemon: skipped");
            return;
        };
        let connect = || zbus::blocking::connection::Builder::address(address.as_str()).unwrap().build().unwrap();
        assert!(FileChooser::on(connect()).is_err());
        let calls = Calls::default();
        let _portal = zbus::blocking::connection::Builder::address(address.as_str())
            .unwrap()
            .name(PORTAL)
            .unwrap()
            .serve_at(PORTAL_PATH, Stand { calls: calls.clone() })
            .unwrap()
            .build()
            .unwrap();
        let chooser = FileChooser::on(connect()).unwrap();
        let open = |title: &str, multiple: bool, list: &[Filter]| {
            let mut map: HashMap<&str, Variant<'_>> = HashMap::new();
            map.insert("multiple", Variant::from(multiple));
            if !list.is_empty() {
                map.insert("filters", Variant::from(filters(list)));
            }
            chooser.request("OpenFile", title, map).unwrap()
        };
        let images = [Filter { name: "Images".into(), globs: vec!["*.png".into()], mimes: vec!["image/jpeg".into()] }];
        assert_eq!(open("Pick", false, &images), Some(vec!["/tmp/picked/a b.txt".to_string()]));
        assert_eq!(open("Pick", true, &[]), Some(vec!["/tmp/picked/a b.txt".to_string(), "/tmp/picked/你.png".to_string()]));
        assert_eq!(open("cancel", true, &[]), None);
        let mut save: HashMap<&str, Variant<'_>> = HashMap::new();
        save.insert("current_name", Variant::from("out.json"));
        assert_eq!(chooser.request("SaveFile", "Save", save).unwrap(), Some(vec!["/tmp/picked/out.json".to_string()]));
        assert_eq!(chooser.folder("Folder").unwrap(), Some("/tmp/picked/a b.txt".to_string()));
        assert_eq!(chooser.folder("cancel").unwrap(), None);
        let calls = calls.lock().unwrap();
        let seen: Vec<(&str, &str)> = calls.iter().map(|(m, t, _)| (m.as_str(), t.as_str())).collect();
        assert_eq!(
            seen,
            [("OpenFile", "Pick"), ("OpenFile", "Pick"), ("OpenFile", "cancel"), ("SaveFile", "Save"), ("OpenFile", "Folder"), ("OpenFile", "cancel")]
        );
        assert_eq!(calls[0].2["filters"].value_signature().to_string(), "a(sa(us))");
        assert_eq!(bool::try_from(calls[4].2["directory"].clone()).ok(), Some(true));
        _ = daemon.kill();
        _ = daemon.wait();
        _ = std::fs::remove_dir_all(dir);
    }

    struct Settings {
        scheme: Arc<std::sync::atomic::AtomicU32>,
        read_one: Arc<AtomicBool>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.Settings")]
    impl Settings {
        async fn read_one(&self, namespace: &str, key: &str) -> zbus::fdo::Result<OwnedValue> {
            if !self.read_one.load(Ordering::SeqCst) {
                return Err(zbus::fdo::Error::UnknownMethod("ReadOne".into()));
            }
            if namespace != APPEARANCE || key != COLOR_SCHEME {
                return Err(zbus::fdo::Error::Failed("Requested setting not found".into()));
            }
            Ok(OwnedValue::from(self.scheme.load(Ordering::SeqCst)))
        }

        async fn read(&self, _namespace: &str, _key: &str) -> zbus::fdo::Result<OwnedValue> {
            Ok(Variant::Value(Box::new(Variant::U32(self.scheme.load(Ordering::SeqCst)))).try_into().unwrap())
        }
    }

    #[test]
    fn color_scheme_against_a_stand_in_portal() {
        let Some((mut daemon, address, dir)) = private_bus("portal") else {
            eprintln!("no dbus-daemon: skipped");
            return;
        };
        let connect = || zbus::blocking::connection::Builder::address(address.as_str()).unwrap().build().unwrap();
        let client = connect();
        assert!(Appearance::read(&client).is_err());
        let scheme = Arc::new(std::sync::atomic::AtomicU32::new(1));
        let read_one = Arc::new(AtomicBool::new(true));
        let portal = zbus::blocking::connection::Builder::address(address.as_str())
            .unwrap()
            .name(PORTAL)
            .unwrap()
            .serve_at(PORTAL_PATH, Settings { scheme: scheme.clone(), read_one: read_one.clone() })
            .unwrap()
            .build()
            .unwrap();
        assert!(Appearance::read(&client).unwrap());
        scheme.store(2, Ordering::SeqCst);
        assert!(!Appearance::read(&client).unwrap());
        read_one.store(false, Ordering::SeqCst);
        scheme.store(1, Ordering::SeqCst);
        assert!(Appearance::read(&client).unwrap());
        let mut changes = Appearance::changes(&client).unwrap();
        portal
            .emit_signal(None::<&str>, PORTAL_PATH, SETTINGS, "SettingChanged", &("org.gnome.desktop.interface", "gtk-theme", Variant::from("Adwaita")))
            .unwrap();
        portal.emit_signal(None::<&str>, PORTAL_PATH, SETTINGS, "SettingChanged", &(APPEARANCE, COLOR_SCHEME, Variant::from(1u32))).unwrap();
        let seen: Vec<(String, String, bool)> = changes
            .by_ref()
            .take(2)
            .map(|m| {
                let (namespace, key, value) = m.unwrap().body().deserialize::<(String, String, OwnedValue)>().unwrap();
                (namespace, key, dark_scheme(&value))
            })
            .collect();
        assert_eq!(
            seen,
            [("org.gnome.desktop.interface".to_string(), "gtk-theme".to_string(), false), (APPEARANCE.to_string(), COLOR_SCHEME.to_string(), true)]
        );
        _ = daemon.kill();
        _ = daemon.wait();
        _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn color_scheme_one_is_dark() {
        assert!(dark_scheme(&Variant::U32(1)));
        assert!(!dark_scheme(&Variant::U32(2)));
        assert!(!dark_scheme(&Variant::U32(0)));
        assert!(dark_scheme(&Variant::Value(Box::new(Variant::Value(Box::new(Variant::U32(1)))))));
        assert!(!dark_scheme(&Variant::from("dark")));
    }

    #[test]
    fn file_uris_become_paths() {
        assert_eq!(local_path("file:///home/u/a%20b.png").as_deref(), Some("/home/u/a b.png"));
        assert_eq!(local_path("file://localhost/tmp/%E4%BD%A0.txt").as_deref(), Some("/tmp/你.txt"));
        assert_eq!(local_path("file://other/tmp/x"), None);
        assert_eq!(local_path("https://example.com/x"), None);
    }

    #[test]
    fn empty_filters_are_left_out() {
        let list = filters(&[Filter { name: "Images".into(), globs: vec!["*.png".into()], mimes: vec!["image/jpeg".into()] }, Filter::default()]);
        assert_eq!(list, vec![("Images".to_string(), vec![(0, "*.png".to_string()), (1, "image/jpeg".to_string())])]);
    }
}
