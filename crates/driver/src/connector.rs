use std::path::PathBuf;

pub struct Connector(PathBuf);

impl Connector {
    const SYSFS: &str = "/sys/class/drm";

    pub fn find(name: &str) -> Option<Self> {
        let suffix = format!("-{name}");
        std::fs::read_dir(Self::SYSFS).ok()?.flatten().find(|e| e.file_name().to_string_lossy().ends_with(&suffix)).map(|e| Self(e.path()))
    }

    pub fn edid(&self) -> Option<Vec<u8>> {
        std::fs::read(self.0.join("edid")).ok()
    }
}
