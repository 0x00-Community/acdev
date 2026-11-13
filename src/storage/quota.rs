use std::path::Path;

pub fn usage(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => usage(&entry.path()),
            Ok(meta) if meta.is_file() => meta.len(),
            _ => 0,
        })
        .sum()
}

pub fn quota(dir: &Path) -> u64 {
    let mut probe = dir;
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    disk_total(probe).map_or(0, |total| total / 10 * 6)
}

#[cfg(unix)]
fn disk_total(path: &Path) -> Option<u64> {
    let stat = rustix::fs::statvfs(path).ok()?;
    Some(stat.f_blocks.saturating_mul(stat.f_frsize))
}

#[cfg(windows)]
fn disk_total(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut total = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), std::ptr::null_mut(), &mut total, std::ptr::null_mut()) };
    (ok != 0).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testing::TempDir;

    #[test]
    fn usage_adds_up_files_below_the_folder_and_quota_is_most_of_the_disk() {
        let dir = TempDir::new("quota");
        std::fs::create_dir_all(dir.0.join("a/b")).unwrap();
        std::fs::write(dir.0.join("one"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.0.join("a/b/two"), vec![0u8; 23]).unwrap();
        assert_eq!(usage(&dir.0), 123);
        assert_eq!(usage(&dir.0.join("missing")), 0);
        assert!(quota(&dir.0.join("not/made/yet")) > 1 << 20);
    }
}
