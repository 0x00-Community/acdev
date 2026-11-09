mod db;
mod local;

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
        let entry = all
            .get_or_insert_with(HashMap::new)
            .entry(place.key.clone())
            .or_insert_with(|| Entry { partition: Arc::new(Partition { place: place.clone(), local: OnceLock::new() }), leases: 0 });
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
            map.remove(self.0.key());
        }
    }
}

pub fn flush_all() {
    let all = partitions();
    for entry in all.iter().flat_map(HashMap::values) {
        entry.partition.flush();
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
    use crate::testing::TempDir;

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
