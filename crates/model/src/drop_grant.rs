use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

pub const LIFETIME: Duration = Duration::from_secs(5 * 60);
const CAPACITY: usize = 256;
const DESKTOP: &str = "@desktop";

struct Grant {
    id: u64,
    owner: String,
    path: PathBuf,
    expires: Instant,
    claimed: bool,
}

struct State {
    next: u64,
    grants: Vec<Grant>,
}

pub struct Ledger {
    state: Mutex<State>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

fn owner_of(app: Option<&str>) -> &str {
    app.unwrap_or(DESKTOP)
}

fn wanted(grant: &Grant, owner: &str, path: &Path, now: Instant) -> bool {
    !grant.claimed && grant.expires > now && grant.owner == owner && grant.path.as_path() == path
}

impl Ledger {
    pub const fn new() -> Self {
        Self { state: Mutex::new(State { next: 0, grants: Vec::new() }) }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn record(&self, app: Option<&str>, paths: &[PathBuf], now: Instant) {
        let owner = owner_of(app);
        let real: Vec<PathBuf> = paths.iter().filter_map(|path| fs::canonicalize(path).ok()).collect();
        let mut state = self.lock();
        state.grants.retain(|grant| grant.expires > now);
        for path in real {
            state.next += 1;
            let id = state.next;
            state.grants.push(Grant { id, owner: owner.to_owned(), path, expires: now + LIFETIME, claimed: false });
        }
        let excess = state.grants.len().saturating_sub(CAPACITY);
        state.grants.drain(..excess);
    }

    pub fn claim(&self, app: Option<&str>, path: &Path, now: Instant) -> Option<Claim<'_>> {
        let owner = owner_of(app);
        let mut state = self.lock();
        let grant = state.grants.iter_mut().find(|grant| wanted(grant, owner, path, now))?;
        grant.claimed = true;
        Some(Claim { ledger: self, id: grant.id, committed: false })
    }

    fn consume(&self, id: u64) {
        self.lock().grants.retain(|grant| grant.id != id);
    }

    fn release(&self, id: u64) {
        if let Some(grant) = self.lock().grants.iter_mut().find(|grant| grant.id == id) {
            grant.claimed = false;
        }
    }
}

#[must_use = "dropping a claim without commit gives the grant back"]
pub struct Claim<'a> {
    ledger: &'a Ledger,
    id: u64,
    committed: bool,
}

impl Claim<'_> {
    pub fn commit(mut self) {
        self.committed = true;
        self.ledger.consume(self.id);
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.ledger.release(self.id);
        }
    }
}

static LEDGER: Ledger = Ledger::new();

pub fn record(app: Option<&str>, paths: &[PathBuf]) {
    LEDGER.record(app, paths, Instant::now());
}

pub fn claim(app: Option<&str>, path: &Path) -> Option<Claim<'static>> {
    LEDGER.claim(app, path, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("acde-drop-{}-{id}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, name).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            _ = fs::remove_dir_all(&self.0);
        }
    }

    fn real(path: &Path) -> PathBuf {
        fs::canonicalize(path).unwrap()
    }

    #[test]
    fn a_dropped_file_authorizes_one_commit_for_its_app() {
        let dir = Scratch::new();
        let file = dir.file("a.txt");
        let ledger = Ledger::new();
        let now = Instant::now();
        ledger.record(Some("vault"), std::slice::from_ref(&file), now);
        let first = ledger.claim(Some("vault"), &real(&file), now).expect("the first use is accepted");
        drop(first);
        let second = ledger.claim(Some("vault"), &real(&file), now).expect("an uncommitted claim is given back");
        second.commit();
        assert!(ledger.claim(Some("vault"), &real(&file), now).is_none());
    }

    #[test]
    fn only_the_recording_app_and_the_exact_path_match() {
        let dir = Scratch::new();
        let file = dir.file("a.txt");
        let other = dir.file("b.txt");
        let ledger = Ledger::new();
        let now = Instant::now();
        ledger.record(Some("vault"), std::slice::from_ref(&file), now);
        assert!(ledger.claim(Some("other"), &real(&file), now).is_none());
        assert!(ledger.claim(None, &real(&file), now).is_none());
        assert!(ledger.claim(Some("vault"), &real(&other), now).is_none());
        assert!(ledger.claim(Some("vault"), &real(&file), now).is_some());
    }

    #[test]
    fn a_grant_expires_after_its_lifetime() {
        let dir = Scratch::new();
        let file = dir.file("a.txt");
        let ledger = Ledger::new();
        let start = Instant::now();
        ledger.record(Some("vault"), std::slice::from_ref(&file), start);
        assert!(ledger.claim(Some("vault"), &real(&file), start + LIFETIME - Duration::from_secs(1)).is_some());
        assert!(ledger.claim(Some("vault"), &real(&file), start + LIFETIME).is_none());
    }

    #[test]
    fn the_desktop_is_its_own_owner() {
        let dir = Scratch::new();
        let file = dir.file("a.txt");
        let ledger = Ledger::new();
        let now = Instant::now();
        ledger.record(None, std::slice::from_ref(&file), now);
        assert!(ledger.claim(Some("@desktop"), &real(&file), now).is_some());
        assert!(ledger.claim(Some("vault"), &real(&file), now).is_none());
    }

    #[test]
    fn paths_that_do_not_exist_are_not_recorded() {
        let dir = Scratch::new();
        let missing = dir.0.join("missing.txt");
        let ledger = Ledger::new();
        ledger.record(Some("vault"), std::slice::from_ref(&missing), Instant::now());
        fs::write(&missing, "now here").unwrap();
        assert!(ledger.claim(Some("vault"), &real(&missing), Instant::now()).is_none());
    }
}
