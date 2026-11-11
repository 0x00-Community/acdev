use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

use crate::var::Var;

pub struct Dri;

impl Dri {
    const DIR: &str = "/dev/dri";
    const RENDER: &str = "renderD";
    const CARD: &str = "card";
    const DEFAULT: &str = "/dev/dri/renderD128";

    pub fn render_node() -> PathBuf {
        Var::RenderNode.path().unwrap_or_else(|| PathBuf::from(Self::DEFAULT))
    }

    pub fn forced() -> Option<PathBuf> {
        Var::RenderNode.path()
    }

    pub fn nodes() -> Vec<PathBuf> {
        let mut names: Vec<String> = std::fs::read_dir(Self::DIR)
            .map(|dir| dir.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.starts_with(Self::RENDER) || n.starts_with(Self::CARD)).collect())
            .unwrap_or_default();
        names.sort_by_key(|n| (!n.starts_with(Self::RENDER), n.len(), n.clone()));
        names.into_iter().map(|n| Path::new(Self::DIR).join(n)).collect()
    }

    pub fn open(path: &Path) -> Result<OwnedFd, String> {
        std::fs::OpenOptions::new().read(true).write(true).open(path).map(OwnedFd::from).map_err(|e| format!("{}: {e}", path.display()))
    }
}
