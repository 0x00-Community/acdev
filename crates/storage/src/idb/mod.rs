mod database;
mod sql;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};

use crate::Text;

pub type Bytes = Vec<u8>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Id {
    pub owner: u64,
    pub local: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    ReadOnly,
    ReadWrite,
    VersionChange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Next,
    NextUnique,
    Prev,
    PrevUnique,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Store(i64),
    Index(i64),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Range {
    pub lower: Option<(Bytes, bool)>,
    pub upper: Option<(Bytes, bool)>,
}

impl Range {
    pub fn only(key: Bytes) -> Range {
        Range { lower: Some((key.clone(), false)), upper: Some((key, false)) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetch {
    Keys,
    PrimaryKeys,
    Values,
    Records,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Put {
        store: i64,
        key: Bytes,
        value: Bytes,
        indexes: Vec<(i64, Bytes)>,
        overwrite: bool,
        generator: Option<f64>,
    },
    Delete {
        store: i64,
        range: Range,
    },
    Clear {
        store: i64,
    },
    Get {
        source: Source,
        range: Range,
        fetch: Fetch,
        count: Option<u32>,
        direction: Direction,
    },
    Count {
        source: Source,
        range: Range,
    },
    Cursor {
        source: Source,
        range: Range,
        direction: Direction,
        position: Option<(Bytes, Option<Bytes>)>,
        key: Option<Bytes>,
        primary_key: Option<Bytes>,
        advance: u32,
        values: bool,
    },
    CreateStore {
        id: i64,
        name: Text,
        key_path: Option<String>,
        auto_increment: bool,
    },
    DeleteStore {
        store: i64,
    },
    RenameStore {
        store: i64,
        name: Text,
    },
    CreateIndex {
        id: i64,
        store: i64,
        name: Text,
        key_path: String,
        unique: bool,
        multi_entry: bool,
    },
    IndexEntries {
        index: i64,
        entries: Vec<(Bytes, Bytes)>,
    },
    DeleteIndex {
        index: i64,
    },
    RenameIndex {
        index: i64,
        name: Text,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub key: Bytes,
    pub primary_key: Bytes,
    pub value: Option<Bytes>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Constraint,
    Version,
    Abort,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Error {
        Error { kind, message: message.into() }
    }

    fn unknown(e: impl std::fmt::Display) -> Error {
        Error::new(ErrorKind::Unknown, e.to_string())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    Done,
    Id(i64),
    Count(u64),
    Records(Vec<Record>),
    Failed(Error),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexInfo {
    pub id: i64,
    pub name: Text,
    pub key_path: String,
    pub unique: bool,
    pub multi_entry: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoreInfo {
    pub id: i64,
    pub name: Text,
    pub key_path: Option<String>,
    pub auto_increment: bool,
    pub generator: f64,
    pub indexes: Vec<IndexInfo>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Schema {
    pub version: u64,
    pub stores: Vec<StoreInfo>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Opened { req: Id, db: u64, conn: Id, schema: Schema },
    Upgrade { req: Id, db: u64, conn: Id, tx: Id, old: u64, schema: Schema },
    OpenFailed { req: Id, error: Error },
    Blocked { req: Id, old: u64, new: Option<u64> },
    VersionChange { conn: Id, old: u64, new: Option<u64> },
    Deleted { req: Id, old: u64 },
    Started { tx: Id, generators: Vec<(i64, f64)> },
    Result { tx: Id, op: u64, reply: Reply },
    Complete { tx: Id },
    Aborted { tx: Id, error: Option<Error> },
    ForcedClose { conn: Id },
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

pub(crate) enum Cmd {
    Open { req: Id, version: Option<u64>, sink: Sink },
    Delete { req: Id, sink: Sink },
    Begin { tx: Id, conn: Id, scope: Vec<i64>, mode: Mode },
    Op { tx: Id, op: u64, body: Op },
    Commit { tx: Id },
    Abort { tx: Id },
    Close { conn: Id },
    Acknowledge { conn: Id },
    OwnerGone { owner: u64 },
}

pub(crate) enum Catalog {
    Disk(Connection),
    Memory(HashMap<Text, (i64, u64)>),
}

impl Catalog {
    fn find(&mut self, name: &[u16]) -> rusqlite::Result<Option<(i64, u64)>> {
        match self {
            Catalog::Disk(conn) => conn
                .query_row("SELECT file, version FROM databases WHERE name = ?1", params![crate::db::utf16_bytes(name)], |row| {
                    Ok((row.get(0)?, row.get::<_, i64>(1)? as u64))
                })
                .optional(),
            Catalog::Memory(map) => Ok(map.get(name).copied()),
        }
    }

    pub(crate) fn reserve(&mut self, name: &[u16]) -> rusqlite::Result<i64> {
        match self {
            Catalog::Disk(conn) => {
                let file: i64 = conn.query_row("SELECT COALESCE(MAX(file), 0) + 1 FROM databases", [], |row| row.get(0))?;
                conn.execute("INSERT INTO databases (name, file, version) VALUES (?1, ?2, 0)", params![crate::db::utf16_bytes(name), file])?;
                Ok(file)
            }
            Catalog::Memory(map) => {
                let file = map.values().map(|(file, _)| *file).max().unwrap_or(0) + 1;
                map.insert(name.into(), (file, 0));
                Ok(file)
            }
        }
    }

    pub(crate) fn set_version(&mut self, name: &[u16], version: u64) -> rusqlite::Result<()> {
        match self {
            Catalog::Disk(conn) => {
                conn.execute("UPDATE databases SET version = ?2 WHERE name = ?1", params![crate::db::utf16_bytes(name), version as i64]).map(drop)
            }
            Catalog::Memory(map) => {
                if let Some(entry) = map.get_mut(name) {
                    entry.1 = version;
                }
                Ok(())
            }
        }
    }

    pub(crate) fn forget(&mut self, name: &[u16]) -> rusqlite::Result<()> {
        match self {
            Catalog::Disk(conn) => conn.execute("DELETE FROM databases WHERE name = ?1", params![crate::db::utf16_bytes(name)]).map(drop),
            Catalog::Memory(map) => {
                map.remove(name);
                Ok(())
            }
        }
    }

    fn list(&mut self) -> rusqlite::Result<Vec<(Text, u64)>> {
        match self {
            Catalog::Disk(conn) => {
                let mut query = conn.prepare("SELECT name, version FROM databases WHERE version > 0 ORDER BY rowid")?;
                let rows = query.query_map([], |row| Ok((crate::db::utf16_from_bytes(&row.get::<_, Vec<u8>>(0)?), row.get::<_, i64>(1)? as u64)))?;
                rows.collect()
            }
            Catalog::Memory(map) => Ok(map.iter().filter(|(_, (_, v))| *v > 0).map(|(name, (_, v))| (name.clone(), *v)).collect()),
        }
    }
}

const CATALOG: &str = "CREATE TABLE IF NOT EXISTS databases (name BLOB NOT NULL UNIQUE, file INTEGER NOT NULL UNIQUE, version INTEGER NOT NULL);";

enum Message {
    To(u64, Option<Text>, Box<Cmd>),
    OwnerGone(u64),
    Shutdown,
}

pub struct Idb {
    names: Mutex<Vec<Text>>,
    tx: Sender<Message>,
    thread: Option<std::thread::JoinHandle<()>>,
    catalog: Arc<Mutex<Catalog>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

pub fn new_owner() -> u64 {
    NEXT_OWNER.fetch_add(1, Ordering::Relaxed)
}

fn serve(rx: std::sync::mpsc::Receiver<Message>, dir: Option<PathBuf>, catalog: Arc<Mutex<Catalog>>) {
    let mut workers: Vec<Option<database::Worker>> = Vec::new();
    for message in rx {
        match message {
            Message::To(id, name, cmd) => {
                let at = id as usize;
                if let Some(name) = name {
                    if workers.len() <= at {
                        workers.resize_with(at + 1, || None);
                    }
                    if workers[at].is_none() {
                        workers[at] = Some(database::Worker::new(name, id, dir.clone(), catalog.clone()));
                    }
                }
                if let Some(worker) = workers.get_mut(at).and_then(Option::as_mut) {
                    worker.handle(*cmd);
                }
            }
            Message::OwnerGone(owner) => {
                for worker in workers.iter_mut().flatten() {
                    worker.handle(Cmd::OwnerGone { owner });
                }
            }
            Message::Shutdown => break,
        }
    }
    for worker in workers.iter_mut().flatten() {
        worker.shutdown();
    }
}

impl Idb {
    pub fn open(dir: Option<&Path>) -> Idb {
        let dir = dir.map(|d| d.join("indexeddb"));
        let catalog =
            dir.as_ref().and_then(|dir| crate::db::open(&dir.join("catalog.sqlite3"), CATALOG)).map_or_else(|| Catalog::Memory(HashMap::new()), Catalog::Disk);
        let dir = dir.filter(|_| matches!(catalog, Catalog::Disk(_)));
        let catalog = Arc::new(Mutex::new(catalog));
        let (tx, rx) = std::sync::mpsc::channel();
        let shared = catalog.clone();
        let thread = match std::thread::Builder::new().name("acde-idb".into()).spawn(move || serve(rx, dir, shared)) {
            Ok(thread) => Some(thread),
            Err(e) => {
                log::warn!("indexedDB: no thread for the databases ({e})");
                None
            }
        };
        Idb { names: Mutex::default(), tx, thread, catalog }
    }

    fn database(&self, name: &[u16]) -> u64 {
        let mut names = lock(&self.names);
        if let Some(i) = names.iter().position(|n| **n == *name) {
            return i as u64;
        }
        names.push(name.into());
        (names.len() - 1) as u64
    }

    fn send(&self, db: u64, cmd: Cmd) {
        _ = self.tx.send(Message::To(db, None, Box::new(cmd)));
    }

    pub fn open_database(&self, name: &[u16], req: Id, version: Option<u64>, sink: Sink) {
        let db = self.database(name);
        _ = self.tx.send(Message::To(db, Some(name.into()), Box::new(Cmd::Open { req, version, sink })));
    }

    pub fn delete_database(&self, name: &[u16], req: Id, sink: Sink) {
        let db = self.database(name);
        _ = self.tx.send(Message::To(db, Some(name.into()), Box::new(Cmd::Delete { req, sink })));
    }

    pub fn databases(&self) -> Result<Vec<(Text, u64)>, Error> {
        lock(&self.catalog).list().map_err(Error::unknown)
    }

    pub fn begin(&self, db: u64, tx: Id, conn: Id, scope: Vec<i64>, mode: Mode) {
        self.send(db, Cmd::Begin { tx, conn, scope, mode });
    }

    pub fn op(&self, db: u64, tx: Id, op: u64, body: Op) {
        self.send(db, Cmd::Op { tx, op, body });
    }

    pub fn commit(&self, db: u64, tx: Id) {
        self.send(db, Cmd::Commit { tx });
    }

    pub fn abort(&self, db: u64, tx: Id) {
        self.send(db, Cmd::Abort { tx });
    }

    pub fn close(&self, db: u64, conn: Id) {
        self.send(db, Cmd::Close { conn });
    }

    pub fn acknowledge(&self, db: u64, conn: Id) {
        self.send(db, Cmd::Acknowledge { conn });
    }

    pub fn owner_gone(&self, owner: u64) {
        _ = self.tx.send(Message::OwnerGone(owner));
    }
}

impl Drop for Idb {
    fn drop(&mut self) {
        _ = self.tx.send(Message::Shutdown);
        if let Some(thread) = self.thread.take() {
            _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests;
