//! Default apps (AGENTS.md「默认应用」): which of the packages' apps opens a file, a folder or a link, and handing it
//! over. Called on the caller's thread (`acde:apps` `openPath` / `handlers` / `setDefault`) and for the Broker's
//! D-Bus `FileManager1` and `acde open`. Only the packages' apps: other programs are the desktop package's business.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::files::Xdg;
use super::{App, Desk, Done, Failure};

const DIRECTORY: &str = "inode/directory";
const GROUP: &str = "[Default Applications]";

/// A MIME type as `type/subtype`, checked when it is first read.
#[derive(Clone, PartialEq, Eq)]
pub struct Mime(String);

impl TryFrom<&str> for Mime {
    type Error = Failure;

    fn try_from(text: &str) -> Result<Self, Failure> {
        let ok = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b));
        match text.split_once('/') {
            Some((kind, sub)) if ok(kind) && ok(sub) => Ok(Mime(text.to_owned())),
            _ => Err(Failure::new(400, "bad_mime", format!("not a MIME type: {text}"))),
        }
    }
}

impl Mime {
    const BY_EXTENSION: [(&'static str, &'static str); 21] = [
        ("txt", "text/plain"), ("md", "text/markdown"), ("json", "application/json"), ("html", "text/html"), ("htm", "text/html"),
        ("pdf", "application/pdf"), ("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"),
        ("webp", "image/webp"), ("svg", "image/svg+xml"), ("mp4", "video/mp4"), ("webm", "video/webm"), ("mp3", "audio/mpeg"),
        ("wav", "audio/x-wav"), ("ogg", "audio/ogg"),
        ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        ("csv", "text/csv"),
    ];

    fn directory() -> Self {
        Mime(DIRECTORY.into())
    }

    fn scheme(scheme: &str) -> Self {
        Mime(format!("x-scheme-handler/{scheme}"))
    }

    /// A path's type: a folder, else what `gio info` says, else `file --mime-type`, else its extension.
    fn of(path: &Path) -> Self {
        if path.is_dir() {
            return Self::directory();
        }
        if let Some(out) = Self::run_with(&["gio", "info", "--attributes=standard::content-type"], path)
            && let Some(found) = out.lines().find_map(|l| l.trim().strip_prefix("standard::content-type:")).map(str::trim)
            && let Ok(mime) = Mime::try_from(found)
        {
            return mime;
        }
        if let Some(out) = Self::run_with(&["file", "--brief", "--mime-type"], path)
            && let Ok(mime) = Mime::try_from(out.trim())
            && mime.0 != "application/octet-stream"
        {
            return mime;
        }
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        Self::BY_EXTENSION.iter().find(|(e, _)| *e == ext).map_or_else(|| Mime("application/octet-stream".into()), |(_, m)| Mime((*m).into()))
    }

    /// Runs `argv path` for at most three seconds; its stdout when it succeeded.
    fn run_with(argv: &[&str], path: &Path) -> Option<String> {
        let mut child = std::process::Command::new(argv[0])
            .args(&argv[1..])
            .arg(path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let until = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait().ok()? {
                Some(status) if status.success() => break,
                Some(_) => return None,
                None if std::time::Instant::now() >= until => {
                    _ = child.kill();
                    return None;
                }
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
        Some(out)
    }

    /// How well an app's `mimeTypes` take it: 2 exactly, 1 by `type/*`, 0 not.
    fn taken_by(&self, patterns: &[String]) -> u8 {
        if patterns.contains(&self.0) {
            return 2;
        }
        let wild = format!("{}/*", self.0.split('/').next().unwrap_or_default());
        u8::from(patterns.contains(&wild))
    }
}

/// The XDG MIME Applications lists, `acde-mimeapps.list` before `mimeapps.list` in each directory.
struct MimeApps;

impl MimeApps {
    fn dirs(var: &str, fallback: &str) -> Vec<PathBuf> {
        std::env::var(var).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.into()).split(':').map(PathBuf::from).filter(|p| p.is_absolute()).collect()
    }

    fn lists() -> Vec<PathBuf> {
        let data = |d: PathBuf| d.join("applications");
        let config = std::iter::once(Xdg::config()).chain(Self::dirs("XDG_CONFIG_DIRS", "/etc/xdg"));
        let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share"));
        let datas = std::iter::once(data_home).chain(Self::dirs("XDG_DATA_DIRS", "/usr/local/share:/usr/share")).map(data);
        config.chain(datas).flat_map(|dir| [dir.join("acde-mimeapps.list"), dir.join("mimeapps.list")]).collect()
    }

    /// The `[Default Applications]` entries for `mime`, in order.
    fn listed(text: &str, mime: &Mime) -> Vec<String> {
        let mut inside = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                inside = line == GROUP;
                continue;
            }
            if let Some((key, ids)) = line.split_once('=')
                && inside
                && key.trim() == mime.0
            {
                return ids.split(';').map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned).collect();
            }
        }
        Vec::new()
    }

    /// The default app for `mime`: the first `acde-<app>.desktop` the lists name for an installed app.
    fn default_for(mime: &Mime, installed: impl Fn(&str) -> bool) -> Option<String> {
        Self::lists().iter().filter_map(|list| std::fs::read_to_string(list).ok()).find_map(|text| {
            Self::listed(&text, mime).into_iter().filter_map(|id| Some(id.strip_prefix("acde-")?.strip_suffix(".desktop")?.to_owned())).find(|app| installed(app))
        })
    }

    /// Writes `mime=acde-<app>.desktop;` into the user's `acde-mimeapps.list`, other groups and lines kept.
    fn set(mime: &Mime, app: &str) -> std::io::Result<PathBuf> {
        let file = Xdg::config().join("acde-mimeapps.list");
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        let group = match lines.iter().position(|l| l.trim() == GROUP) {
            Some(at) => at,
            None => {
                if !lines.is_empty() {
                    lines.push(String::new());
                }
                lines.push(GROUP.into());
                lines.len() - 1
            }
        };
        let end = lines[group + 1..].iter().position(|l| l.trim().starts_with('[')).map_or(lines.len(), |at| group + 1 + at);
        let kept: Vec<String> = lines[group + 1..end].iter().filter(|l| l.split('=').next().map(str::trim) != Some(mime.0.as_str())).cloned().collect();
        let mut out: Vec<String> = lines[..=group].to_vec();
        out.push(format!("{}=acde-{app}.desktop;", mime.0));
        out.extend(kept);
        out.extend(lines[end..].iter().cloned());
        out.push(String::new());
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&file, out.join("\n"))?;
        Ok(file)
    }
}

/// Where the Finder has a path: one of its roots and the path inside it.
#[derive(Deserialize)]
struct Place {
    root: String,
    path: String,
}

/// `openPath`'s options.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct OpenOptions {
    pub app: Option<String>,
    pub select: bool,
}

impl Desk {
    fn installed(&self) -> Vec<Arc<App>> {
        self.state().apps.iter().filter(|(_, available)| *available).map(|(a, _)| a.clone()).collect()
    }

    /// The apps that take `mime`, exact matches first.
    fn apps_for(apps: &[Arc<App>], mime: &Mime) -> Vec<Arc<App>> {
        let (exact, wild): (Vec<_>, Vec<_>) = apps.iter().filter(|a| mime.taken_by(&a.mime_types) > 0).cloned().partition(|a| mime.taken_by(&a.mime_types) == 2);
        exact.into_iter().chain(wild).collect()
    }

    fn chosen(apps: &[Arc<App>], mime: &Mime) -> Option<String> {
        MimeApps::default_for(mime, |id| apps.iter().any(|a| a.id == id)).or_else(|| Self::apps_for(apps, mime).first().map(|a| a.id.clone()))
    }

    fn open_rights(&self, caller: Option<u32>) -> Done<()> {
        let Some(caller) = caller else { return Ok(()) };
        let (desktop, who, caps) = self.rights(caller);
        if desktop || caps.open_files { Ok(()) } else { Err(Failure::refused(&who, "opening files with their apps")) }
    }

    fn existing(target: &str) -> Done<PathBuf> {
        let path = match url::Url::parse(target) {
            Ok(url) if url.scheme() == "file" => url.to_file_path().map_err(|()| Failure::new(400, "bad_path", format!("not a local file: {target}")))?,
            _ => PathBuf::from(target),
        };
        if !path.is_absolute() {
            return Err(Failure::new(400, "bad_path", format!("not a local file: {target}")));
        }
        if !path.exists() {
            return Err(Failure::missing(format!("{} does not exist", path.display())));
        }
        Ok(path)
    }

    /// `handlers(path)`: the apps that open it, the default marked. Blocking (the type may be asked of `gio`).
    pub fn handlers(&self, caller: Option<u32>, target: &str) -> Done<Value> {
        self.open_rights(caller)?;
        let mime = Mime::of(&Self::existing(target)?);
        let apps = self.installed();
        let chosen = Self::chosen(&apps, &mime);
        let handlers: Vec<Value> = Self::apps_for(&apps, &mime).iter().map(|a| json!({ "id": a.id, "label": a.label, "icon": a.icon, "default": chosen.as_deref() == Some(a.id.as_str()) })).collect();
        Ok(json!({ "mime": mime.0, "handlers": handlers }))
    }

    /// `setDefault(mime, app)`: the user's `acde-mimeapps.list` (only read under `XDG_CURRENT_DESKTOP=acde`).
    pub fn set_default(&self, caller: Option<u32>, mime: &str, app: &str) -> Done<String> {
        self.open_rights(caller)?;
        let mime = Mime::try_from(mime)?;
        if !self.installed().iter().any(|a| a.id == app) {
            return Err(Failure::missing(format!("no app {app}")));
        }
        let file = MimeApps::set(&mime, app).map_err(|e| format!("acde-mimeapps.list: {e}"))?;
        Ok(file.to_string_lossy().into_owned())
    }

    /// `openPath(path | URI, {app?, select?})`: to its app's `request`, the window raised. Blocking (type, Finder).
    pub fn open_path(self: &Arc<Self>, caller: Option<u32>, target: &str, options: OpenOptions) -> Done<Value> {
        self.open_rights(caller)?;
        let apps = self.installed();
        let pick = |mime: &Mime| -> Done<Arc<App>> {
            let id = options.app.clone().or_else(|| Self::chosen(&apps, mime));
            id.as_deref().and_then(|id| apps.iter().find(|a| a.id == id)).cloned().ok_or_else(|| match &id {
                Some(id) => Failure::missing(format!("no app {id}")),
                None => Failure::new(404, "no_app", format!("没有能打开这种文件的应用 ({})", mime.0)),
            })
        };
        let scheme = url::Url::parse(target).ok().map(|u| u.scheme().to_ascii_lowercase()).filter(|s| s != "file");
        let (app, request) = match scheme {
            Some(scheme) => (pick(&Mime::scheme(&scheme))?, json!({ "url": target })),
            None => {
                let path = Self::existing(target)?;
                let is_dir = path.is_dir();
                let select = options.select && !is_dir;
                let mime = if select { Mime::directory() } else { Mime::of(&path) };
                let app = pick(&mime)?;
                let request = self.request(&app, &path, is_dir, select)?;
                (app, request)
            }
        };
        let window = self.launch(&app.id, Some(request), acde_model::Mode::Free)?;
        self.raise(window);
        Ok(json!({ "app": app.id, "window": window }))
    }

    /// What the app is handed: a Finder place when it has `fs`, else the `file://` URL.
    fn request(&self, app: &App, path: &Path, is_dir: bool, select: bool) -> Done<Value> {
        let url = || url::Url::from_file_path(path).map(String::from).unwrap_or_default();
        if app.capabilities.fs.is_none() {
            return Ok(json!({ "url": url() }));
        }
        let workspace = {
            let mut system = self.system.lock().unwrap_or_else(|e| e.into_inner());
            system.workspace.get_or_insert_with(acde_runtime::Workspace::new).scoped(None, None)
        };
        let located = match workspace.call(acde_runtime::FsCall::Locate { path: path.to_string_lossy().into_owned() }) {
            Ok(acde_runtime::FsReply::Json(place)) => serde_json::from_value::<Place>(place).ok(),
            _ => None,
        };
        let Some(place) = located else {
            return Err(Failure::new(404, "outside_roots", format!("{} 不在「文件」能打开的位置 (桌面、下载、工作区)", path.display())));
        };
        let takes_folders = Mime::directory().taken_by(&app.mime_types) == 2;
        if select || (!is_dir && takes_folders) {
            let (dir, file) = place.path.rsplit_once('/').map_or(("", place.path.as_str()), |(d, f)| (d, f));
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.to_owned());
            return Ok(json!({ "root": place.root, "path": dir, "file": name }));
        }
        Ok(json!({ "root": place.root, "path": place.path, "file": null }))
    }
}
