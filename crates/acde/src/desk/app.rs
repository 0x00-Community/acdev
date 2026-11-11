//! What the Broker hands the desk once it has scanned the packages: the apps' manifests, and what every isolate's init
//! carries (screen, look, languages, resources, the services' shapes, the environment).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum FsCap {
    All(bool),
    Roots { roots: Vec<String> },
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum OpenCap {
    All(bool),
    Apps(Vec<String>),
}

/// An app's manifest `capabilities`; the keys acde knows are fields, the rest are service names.
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub fs: Option<FsCap>,
    pub terminal: bool,
    pub office: bool,
    pub network: bool,
    pub launch: bool,
    pub slots: bool,
    pub open: Option<OpenCap>,
    pub open_files: bool,
    pub session: bool,
    pub desktops: bool,
    pub system: bool,
    pub display: bool,
    #[serde(flatten)]
    pub services: HashMap<String, Value>,
}

impl Capabilities {
    /// Whether this app may open `app` (`acde.open`, `apps.launch`).
    pub fn opens(&self, app: &str) -> bool {
        match &self.open {
            Some(OpenCap::All(all)) => *all,
            Some(OpenCap::Apps(apps)) => apps.iter().any(|a| a == app),
            None => false,
        }
    }

    /// Whether the capability that grants a service is given.
    pub fn has(&self, key: &Key) -> bool {
        match key {
            Key::Session => self.session,
            Key::Desktops => self.desktops,
            Key::OpenFiles => self.open_files,
            Key::Service(name) => self.services.get(name).is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false))),
        }
    }
}

/// The capability key a service is granted by: the builtins acde still serves from the Broker, or a package service's name.
#[derive(Deserialize, Clone)]
#[serde(from = "String")]
pub enum Key {
    Session,
    Desktops,
    OpenFiles,
    Service(String),
}

impl From<String> for Key {
    fn from(name: String) -> Self {
        match name.as_str() {
            "session" => Key::Session,
            "desktops" => Key::Desktops,
            "openFiles" => Key::OpenFiles,
            _ => Key::Service(name),
        }
    }
}

/// One app of an installed package (acde-api `AppManifest` as acde-app's `Manifest.app` normalized it).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub id: String,
    pub label: String,
    pub icon: String,
    pub entry: String,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub heap_mb: f64,
    pub size: Option<[u32; 2]>,
    #[serde(default)]
    pub multiple: bool,
    /// Whether its windows get the desktop's frame (the desktop's `frame` module).
    #[serde(default = "yes")]
    pub frame: bool,
    /// The app's backend (started by the Broker when its first window opens); the desk only needs to know there is one.
    pub backend: Option<Value>,
    /// What it opens (「默认应用」): MIME types, `type/*` too.
    #[serde(default)]
    pub mime_types: Vec<String>,
    /// The manifest as the Broker sent it: what a window's init carries as `app`.
    #[serde(skip)]
    pub raw: Value,
}

const fn yes() -> bool {
    true
}

impl App {
    pub fn parse(raw: Value) -> Result<Arc<Self>, String> {
        let mut app: App = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        app.raw = raw;
        Ok(Arc::new(app))
    }

    /// Whether the entry is an HTML page (or a server-rendered one, ending in `/`) rather than a `WindowApp` module.
    pub fn html_entry(&self) -> bool {
        let path = self.entry.split(['?', '#']).next().unwrap_or_default();
        path.ends_with('/') || path.to_ascii_lowercase().ends_with(".html") || path.to_ascii_lowercase().ends_with(".htm")
    }

    pub fn listing(&self) -> Value {
        json!({ "id": self.id, "label": self.label, "icon": self.icon, "script": self.entry })
    }
}

/// A service (a desktop package's, or a Broker builtin still served by it) as a window's init announces it.
#[derive(Deserialize, Clone)]
pub struct Service {
    pub name: String,
    /// The capability key that grants it (its own name for package services).
    pub capability: Key,
    /// Only the desktop gets it (`inspect`).
    #[serde(default, rename = "desktopOnly")]
    pub desktop_only: bool,
    pub shape: Value,
}

/// One prefix of the installed packages' assets.
#[derive(Deserialize, Clone, serde::Serialize)]
pub struct Resource {
    pub prefix: String,
    pub dirs: Vec<String>,
}

/// What a desktop in `desktops.list()` is: one of the packages' (acde) or another Wayland session (KDE …).
#[derive(Deserialize, serde::Serialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DesktopKind {
    #[default]
    Acde,
    Session,
}

#[derive(Deserialize, serde::Serialize, Clone, Default)]
pub struct DesktopInfo {
    pub kind: DesktopKind,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub package: Option<String>,
}

/// `desktops.list()`: what is installed, and the current one.
#[derive(Deserialize, serde::Serialize, Clone, Default)]
pub struct Desktops {
    pub desktops: Vec<DesktopInfo>,
    pub current: String,
}

/// What every isolate's init carries; the Broker sets it (all at once at start, then the parts that change).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub reduced_motion: Option<bool>,
    pub dark: bool,
    pub languages: Value,
    pub resources: Vec<Resource>,
    pub services: Vec<Service>,
    pub theme: String,
    pub env: Vec<(String, String)>,
    /// `false` when `ACDE_STORAGE` is empty: page storage only in memory.
    pub storage: bool,
    /// The current desktop's window frame module (an own-origin path), if it has one.
    pub frame: Option<String>,
    /// This acde is the login session (not nested in another desktop).
    pub own: bool,
    /// `acde window <app>`: one app, no desktop to hand the session to.
    pub standalone: bool,
    pub desktops: Desktops,
    #[serde(skip)]
    pub output: OutputLook,
}

#[derive(Default, Clone, PartialEq)]
pub struct OutputLook {
    pub name: String,
    pub description: String,
    pub refresh: u32,
}

/// A partial update of [`Look`] from the Broker.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LookChange {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub scale: Option<f64>,
    pub reduced_motion: Option<Option<bool>>,
    pub dark: Option<bool>,
    pub languages: Option<Value>,
    pub resources: Option<Vec<Resource>>,
    pub services: Option<Vec<Service>>,
    pub theme: Option<String>,
    pub env: Option<Vec<(String, String)>>,
    pub storage: Option<bool>,
    pub frame: Option<Option<String>>,
    pub own: Option<bool>,
    pub standalone: Option<bool>,
    pub desktops: Option<Desktops>,
}

impl Look {
    pub fn apply(&mut self, c: LookChange) {
        macro_rules! take {
            ($($f:ident),*) => { $( if let Some(v) = c.$f { self.$f = v; } )* };
        }
        take!(width, height, scale, reduced_motion, dark, languages, resources, services, theme, env, storage, frame, own, standalone, desktops);
    }

    /// The screen's logical size.
    pub fn display(&self) -> Value {
        let o = &self.output;
        if o.name.is_empty() || self.width <= 0.0 {
            return json!({ "displays": [], "nightLight": null });
        }
        let builtin = ["eDP", "LVDS", "DSI"].iter().any(|p| o.name.starts_with(p));
        let mode = json!({ "width": self.width, "height": self.height, "refresh": f64::from(o.refresh) / 1000.0, "preferred": true });
        let name = if o.description.is_empty() { o.name.clone() } else { o.description.clone() };
        json!({
            "displays": [{
                "id": o.name, "name": name, "builtin": builtin, "primary": true, "enabled": true,
                "mode": mode, "modes": [mode], "scale": self.scale, "scales": [1, 2, 3],
                "brightness": null, "rotation": 0,
            }],
            "nightLight": null,
        })
    }

    pub fn screen(&self) -> Value {
        let scale = if self.scale > 0.0 { self.scale } else { 1.0 };
        json!({ "width": (self.width / scale).round(), "height": (self.height / scale).round() })
    }

    /// The services' shapes an isolate gets: all for the desktop, those its capabilities name for an app.
    pub fn shapes(&self, caps: Option<&Capabilities>) -> Value {
        let given = self.services.iter().filter(|s| match caps {
            None => true,
            Some(caps) => !s.desktop_only && caps.has(&s.capability),
        });
        Value::Object(given.map(|s| (s.name.clone(), s.shape.clone())).collect())
    }

    /// The resources a window of `app` sees: an HTML entry's directory becomes its root (acde-host `PageSource.rooted`).
    pub fn resources_for(&self, app: &App) -> Vec<Resource> {
        if !app.html_entry() {
            return self.resources.clone();
        }
        let path = app.entry.split(['?', '#']).next().unwrap_or_default();
        let dir = if path.ends_with('/') { path.to_owned() } else { format!("{}/", path.rsplit_once('/').map_or("", |(d, _)| d)) };
        let Some(best) = self.resources.iter().filter(|r| dir.starts_with(&r.prefix)).max_by_key(|r| r.prefix.len()) else {
            return self.resources.clone();
        };
        if best.prefix == "/" {
            return self.resources.clone();
        }
        let rest = dir[best.prefix.len()..].trim_end_matches('/');
        let mut dirs: Vec<String> = best.dirs.iter().map(|d| if rest.is_empty() { d.clone() } else { format!("{d}/{rest}") }).collect();
        if let Some(root) = self.resources.iter().find(|r| r.prefix == "/") {
            dirs.extend(root.dirs.iter().cloned());
        }
        std::iter::once(Resource { prefix: "/".into(), dirs }).chain(self.resources.iter().filter(|r| r.prefix != "/").cloned()).collect()
    }
}
