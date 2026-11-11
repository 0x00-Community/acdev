use std::path::{Path, PathBuf};

use crate::var::Var;

#[derive(Clone, Debug)]
pub struct Config(PathBuf);

impl Config {
    pub fn home() -> Option<PathBuf> {
        Var::XdgConfigHome.path().or_else(|| Var::Home.path().map(|h| h.join(".config")))
    }

    pub fn at(relative: impl AsRef<Path>) -> Option<Self> {
        Self::home().map(|home| Self(home.join(relative)))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn read(&self) -> Option<Vec<u8>> {
        std::fs::read(&self.0).ok()
    }

    pub fn read_string(&self) -> std::io::Result<String> {
        std::fs::read_to_string(&self.0)
    }

    pub fn write(&self, bytes: impl AsRef<[u8]>) -> Result<(), String> {
        let path = &self.0;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
    }
}
