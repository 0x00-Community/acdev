pub mod caches;
mod cookies;
mod db;
pub mod idb;
mod local;
pub mod quota;

pub use cookies::{Cookie, CookieJar, NewCookie};
pub use local::{Change, LocalArea, QUOTA, QuotaExceeded, Subscription, Text};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub key: String,
    pub dir: Option<PathBuf>,
    pub legacy: Option<PathBuf>,
}

pub struct Partition {
    place: Place,
    local: OnceLock<Arc<LocalArea>>,
    idb: OnceLock<idb::Idb>,
    cookies: OnceLock<Arc<CookieJar>>,
    caches: OnceLock<caches::CacheStore>,
}

impl Partition {
    pub fn key(&self) -> &str {
        &self.place.key
    }

    pub fn dir(&self) -> Option<&Path> {
        self.place.dir.as_deref()
    }

    pub fn local(&self) -> &Arc<LocalArea> {
        self.local.get_or_init(|| LocalArea::open(self.place.dir.as_deref(), self.place.legacy.as_deref()))
    }

    pub fn files_dir(&self) -> PathBuf {
        match &self.place.dir {
            Some(dir) => dir.clone(),
            None => memory_root().map_or_else(|| PathBuf::from("/nonexistent"), |root| root.join(&self.place.key)),
        }
    }

    pub fn estimate(&self) -> (u64, u64) {
        let dir = self.files_dir();
        let memory = if self.place.dir.is_some() { 0 } else { self.local.get().map_or(0, |local| local.used() as u64 * 2) };
        (quota::usage(&dir) + memory, quota::quota(&dir))
    }

    pub fn caches(&self) -> &caches::CacheStore {
        self.caches.get_or_init(|| caches::CacheStore::open(self.place.dir.as_deref()))
    }

    pub fn cookies(&self) -> &Arc<CookieJar> {
        self.cookies.get_or_init(|| CookieJar::open(self.place.dir.as_deref(), now_ms()))
    }

    pub fn idb_if_open(&self) -> Option<&idb::Idb> {
        self.idb.get()
    }

    pub fn idb(&self) -> &idb::Idb {
        self.idb.get_or_init(|| idb::Idb::open(self.place.dir.as_deref()))
    }

    fn forget_memory_files(&self) {
        if self.place.dir.is_none() {
            _ = std::fs::remove_dir_all(self.files_dir());
        }
    }

    fn flush(&self) {
        if let Some(local) = self.local.get() {
            local.flush();
        }
    }
}

struct Entry {
    partition: Arc<Partition>,
    leases: usize,
}

static PARTITIONS: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

fn partitions() -> MutexGuard<'static, Option<HashMap<String, Entry>>> {
    PARTITIONS.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Lease(Arc<Partition>);

impl Lease {
    pub fn open(place: Place) -> Lease {
        let mut all = partitions();
        let entry = all.get_or_insert_with(HashMap::new).entry(place.key.clone()).or_insert_with(|| Entry {
            partition: Arc::new(Partition {
                place: place.clone(),
                local: OnceLock::new(),
                idb: OnceLock::new(),
                cookies: OnceLock::new(),
                caches: OnceLock::new(),
            }),
            leases: 0,
        });
        if entry.partition.place != place {
            log::warn!("storage {:?}: already open at {:?}, not {:?}; using the open one", place.key, entry.partition.place.dir, place.dir);
        }
        entry.leases += 1;
        Lease(entry.partition.clone())
    }
}

impl std::ops::Deref for Lease {
    type Target = Partition;

    fn deref(&self) -> &Partition {
        &self.0
    }
}

impl Clone for Lease {
    fn clone(&self) -> Lease {
        let mut all = partitions();
        if let Some(entry) = all.as_mut().and_then(|all| all.get_mut(self.0.key())) {
            entry.leases += 1;
        }
        Lease(self.0.clone())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut all = partitions();
        let Some(map) = all.as_mut() else { return };
        let Some(entry) = map.get_mut(self.0.key()) else { return };
        entry.leases -= 1;
        if entry.leases == 0 {
            entry.partition.flush();
            entry.partition.forget_memory_files();
            map.remove(self.0.key());
        }
    }
}

static MEMORY_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

fn memory_root() -> Option<&'static Path> {
    MEMORY_ROOT
        .get_or_init(|| {
            use std::hash::{BuildHasher, Hasher};
            let base = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(std::env::temp_dir);
            for _ in 0..8 {
                let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
                hasher.write_u32(std::process::id());
                let dir = base.join(format!("acde-storage-{}-{:016x}", std::process::id(), hasher.finish()));
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
                match builder.create(&dir) {
                    Ok(()) => return Some(dir),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => {
                        log::warn!("storage: no private folder for in-memory storage under {} ({e})", base.display());
                        return None;
                    }
                }
            }
            None
        })
        .as_deref()
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

pub fn flush_all() {
    let all = partitions();
    for entry in all.iter().flat_map(HashMap::values) {
        entry.partition.flush();
        entry.partition.forget_memory_files();
    }
    if let Some(Some(root)) = MEMORY_ROOT.get() {
        _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new(name: &str) -> TempDir {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!("acde-storage-{name}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testing::TempDir;

    fn text(s: &str) -> Text {
        s.encode_utf16().collect()
    }

    #[test]
    fn leases_share_one_partition_and_the_last_one_writes_it_out() {
        let dir = TempDir::new("lease");
        let place = Place { key: "lease-test".into(), dir: Some(dir.0.join("app-x")), legacy: None };
        let a = Lease::open(place.clone());
        let b = Lease::open(place.clone());
        assert!(Arc::ptr_eq(a.local(), b.local()));
        a.local().set(text("k"), text("v"), 1, "").unwrap();
        drop(a);
        assert_eq!(b.local().get(&text("k")), Some(text("v")));
        drop(b);
        let c = Lease::open(place);
        assert_eq!(c.local().get(&text("k")), Some(text("v")));
    }
}

#[cfg(test)]
mod memory_root_tests {
    #[test]
    fn the_private_folder_is_fresh_and_only_for_us() {
        let root = super::memory_root().expect("a private folder");
        assert!(root.file_name().unwrap().to_string_lossy().starts_with(&format!("acde-storage-{}-", std::process::id())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::symlink_metadata(root).unwrap();
            assert!(meta.is_dir());
            assert_eq!(meta.permissions().mode() & 0o777, 0o700);
        }
    }
}
