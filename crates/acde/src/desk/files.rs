//! The files the desk keeps or writes for windows: where each app's window was last (`windows.json`), downloads,
//! and the XDG directories they live under.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct Xdg;

impl Xdg {
    fn home() -> PathBuf {
        std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
    }

    fn base(var: &str, fallback: &str) -> PathBuf {
        std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| Self::home().join(fallback))
    }

    pub fn state() -> PathBuf {
        Self::base("XDG_STATE_HOME", ".local/state")
    }

    pub fn config() -> PathBuf {
        Self::base("XDG_CONFIG_HOME", ".config")
    }

    pub fn runtime() -> PathBuf {
        std::env::var_os("XDG_RUNTIME_DIR").map_or_else(|| PathBuf::from(format!("/run/user/{}", rustix::process::getuid().as_raw())), PathBuf::from)
    }

    /// A user directory from `user-dirs.dirs` (`PICTURES`, `DOWNLOAD`), or `~/<fallback>`.
    pub fn user(name: &str, fallback: &str) -> PathBuf {
        let home = Self::home();
        let dirs = std::fs::read_to_string(Self::config().join("user-dirs.dirs")).unwrap_or_default();
        let key = format!("XDG_{name}_DIR=\"");
        dirs.lines()
            .find_map(|line| line.strip_prefix(&key)?.strip_suffix('"').map(|v| PathBuf::from(v.replacen("$HOME", &home.to_string_lossy(), 1))))
            .unwrap_or_else(|| home.join(fallback))
    }

    /// An app's page storage file (`localStorage`), unless storage is only in memory.
    pub fn app_storage(id: &str, kept: bool) -> Option<PathBuf> {
        kept.then(|| Self::config().join("acde/storage").join(format!("app-{id}.json")))
    }

    /// Where an app's backend listens (acde-host `AppBackends.socketDir`).
    pub fn app_sockets(id: &str) -> PathBuf {
        Self::runtime().join("acde/apps").join(id)
    }
}

/// Where each app's window was when it closed, so its next window opens there (acde `windows.json`).
pub struct Places {
    file: Option<PathBuf>,
    rects: HashMap<String, [f64; 4]>,
}

impl Places {
    /// How much of a remembered window must stay on screen for it to be put back there.
    const VISIBLE: f64 = 48.0;

    pub fn load(kept: bool) -> Self {
        let file = kept.then(|| Xdg::state().join("acde/windows.json"));
        let saved: HashMap<String, String> = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let rects = saved.into_iter().filter_map(|(app, rect)| Some((app, serde_json::from_str::<[f64; 4]>(&rect).ok()?))).collect();
        Self { file, rects }
    }

    /// The rect to open `app`'s window at, if it is remembered and still mostly on a screen of this logical size.
    pub fn get(&self, app: &str, screen: [f64; 2]) -> Option<[i32; 4]> {
        let [x, y, w, h] = *self.rects.get(app)?;
        let (width, height) = (w.min(screen[0]), h.min(screen[1]));
        let shown = width >= 1.0 && height >= 1.0 && x + width >= Self::VISIBLE && x <= screen[0] - Self::VISIBLE && y >= 0.0 && y <= screen[1] - Self::VISIBLE;
        shown.then_some([x as i32, y as i32, width as i32, height as i32])
    }

    pub fn set(&mut self, app: &str, rect: [i32; 4]) {
        if rect[2] >= 1 && rect[3] >= 1 {
            self.rects.insert(app.to_owned(), rect.map(f64::from));
        }
    }

    pub fn flush(&self) {
        let Some(file) = &self.file else { return };
        let saved: HashMap<&str, String> = self.rects.iter().map(|(app, r)| (app.as_str(), format!("[{},{},{},{}]", r[0], r[1], r[2], r[3]))).collect();
        let written = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(file, serde_json::to_vec(&saved).unwrap_or_default()));
        if let Err(e) = written {
            log::warn!("window places {}: {e}", file.display());
        }
    }
}

/// A page's download (acde-host `Downloads`): a clean file name in the download folder, never over an existing file.
pub struct Download;

impl Download {
    const EXTENSIONS: [(&'static str, &'static str); 19] = [
        ("text/plain", "txt"), ("text/csv", "csv"), ("text/html", "html"), ("text/markdown", "md"), ("text/css", "css"),
        ("text/javascript", "js"), ("application/json", "json"), ("application/pdf", "pdf"), ("application/zip", "zip"),
        ("application/xml", "xml"), ("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp"),
        ("image/svg+xml", "svg"), ("audio/mpeg", "mp3"), ("audio/wav", "wav"), ("video/mp4", "mp4"), ("video/webm", "webm"),
    ];

    fn has_extension(name: &str) -> bool {
        name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()))
    }

    fn name(name: &str, kind: &str) -> String {
        let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
        let mut clean: String = last.chars().filter(|c| !c.is_control()).collect::<String>().trim().trim_start_matches('.').to_owned();
        if clean.chars().count() > 200 {
            clean = clean.chars().take(200).collect();
        }
        if clean.is_empty() {
            clean = "download".into();
        }
        let mime = kind.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
        match Self::EXTENSIONS.iter().find(|(m, _)| *m == mime) {
            Some((_, ext)) if !Self::has_extension(&clean) => format!("{clean}.{ext}"),
            _ => clean,
        }
    }

    fn unique(dir: &Path, name: String) -> PathBuf {
        if !dir.join(&name).exists() {
            return dir.join(name);
        }
        let (stem, ext) = match name.rfind('.') {
            Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
            _ => (name.as_str(), ""),
        };
        (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or_else(|| dir.join(&name))
    }

    pub fn save(name: &str, kind: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
        let dir = Xdg::user("DOWNLOAD", "Downloads");
        std::fs::create_dir_all(&dir)?;
        let path = Self::unique(&dir, Self::name(name, kind));
        std::fs::write(&path, bytes)?;
        Ok(path)
    }
}
