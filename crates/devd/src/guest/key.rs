use std::fs;
use std::path::Path;

pub const FW_CFG: &str = "/sys/firmware/qemu_fw_cfg/by_name/opt/acdev/key/raw";

pub fn load(path: impl AsRef<Path>) -> Option<Vec<u8>> {
    let text = fs::read(path).ok()?;
    let key = text.trim_ascii().to_vec();
    (!key.is_empty()).then_some(key)
}

pub fn matches(given: &[u8], key: &[u8]) -> bool {
    given.len() == key.len() && given.iter().zip(key).fold(0u8, |differ, (a, b)| differ | (a ^ b)) == 0
}
