use crate::sync::Locked;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

const IDLE: Duration = Duration::from_secs(24 * 3600);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SaveState {
    Open,
    Saving,
    Saved,
    Failed,
    Conflict,
    Closed,
}

impl SaveState {
    fn name(&self) -> &str {
        match self {
            Self::Open => "open",
            Self::Saving => "saving",
            Self::Saved => "saved",
            Self::Failed => "failed",
            Self::Conflict => "conflict",
            Self::Closed => "closed",
        }
    }
}

pub struct Session {
    pub key: String,
    pub root: String,
    pub path: String,
    pub state: SaveState,
    pub saved_at: Option<i64>,
    pub message: Option<String>,
    pub conflict_path: Option<String>,
    pub editors: usize,
    pub touched: Instant,
    pub expected_ms: i64,
    pub target: String,
}

impl Session {
    pub fn status(&self) -> Value {
        json!({"key": self.key, "state": self.state.name(), "savedAt": self.saved_at, "expectedMs": self.expected_ms,
            "message": self.message, "conflictPath": self.conflict_path, "editors": self.editors})
    }
    pub fn touch(&mut self) {
        self.touched = Instant::now();
    }
}

pub type Shared = Arc<Mutex<Session>>;

#[derive(Default)]
struct Sessions {
    by_key: HashMap<String, Shared>,
    live: HashMap<String, String>,
}

#[derive(Default)]
pub struct EditSessions {
    inner: Mutex<Sessions>,
}

impl EditSessions {
    fn id(root: &str, path: &str) -> String {
        format!("{root}\0{path}")
    }

    fn key(root: &str, path: &str, modified_ms: i64, size: u64) -> String {
        let digest = Sha256::digest(format!("{root}\0{path}\0{modified_ms}\0{size}").as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)[..32].to_owned()
    }

    fn inner(&self) -> MutexGuard<'_, Sessions> {
        self.inner.locked()
    }

    fn fresh(key: String, root: &str, path: &str, expected_ms: i64) -> Shared {
        Arc::new(Mutex::new(Session {
            key,
            root: root.to_owned(),
            path: path.to_owned(),
            state: SaveState::Open,
            saved_at: None,
            message: None,
            conflict_path: None,
            editors: 0,
            touched: Instant::now(),
            expected_ms,
            target: path.to_owned(),
        }))
    }

    pub fn open(&self, root: &str, path: &str, modified_ms: i64, size: u64) -> Shared {
        let mut inner = self.inner();
        let cutoff = Instant::now() - IDLE;
        let stale: Vec<String> = inner.by_key.iter().filter(|(_, s)| s.locked().touched < cutoff).map(|(k, _)| k.clone()).collect();
        for key in stale {
            if let Some(session) = inner.by_key.remove(&key) {
                let id = Self::id(&session.locked().root, &session.locked().path);
                if inner.live.get(&id) == Some(&key) {
                    inner.live.remove(&id);
                }
            }
        }
        let id = Self::id(root, path);
        let current = inner.live.get(&id).and_then(|key| inner.by_key.get(key)).cloned();
        if let Some(current) = current.filter(|s| s.locked().state != SaveState::Closed) {
            current.locked().touch();
            return current;
        }
        let key = Self::key(root, path, modified_ms, size);
        let session = inner.by_key.get(&key).cloned().unwrap_or_else(|| Self::fresh(key.clone(), root, path, modified_ms));
        {
            let mut s = session.locked();
            s.state = SaveState::Open;
            s.message = None;
            s.touch();
        }
        inner.by_key.insert(key.clone(), Arc::clone(&session));
        inner.live.insert(id, key);
        session
    }

    pub fn get(&self, key: &str) -> Option<Shared> {
        self.inner().by_key.get(key).cloned()
    }

    pub fn resume(&self, key: &str, root: &str, path: &str, expected_ms: i64) -> Shared {
        let mut inner = self.inner();
        if let Some(session) = inner.by_key.get(key) {
            return Arc::clone(session);
        }
        let session = Self::fresh(key.to_owned(), root, path, expected_ms);
        inner.by_key.insert(key.to_owned(), Arc::clone(&session));
        inner.live.insert(Self::id(root, path), key.to_owned());
        session
    }

    pub fn close(&self, session: &mut Session) {
        if !matches!(session.state, SaveState::Failed | SaveState::Conflict) {
            session.state = SaveState::Closed;
        }
        session.editors = 0;
        session.touch();
        let id = Self::id(&session.root, &session.path);
        let mut inner = self.inner();
        if inner.live.get(&id) == Some(&session.key) {
            inner.live.remove(&id);
        }
    }
}
