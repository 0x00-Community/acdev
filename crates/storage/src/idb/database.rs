use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use super::{Catalog, Cmd, Error, ErrorKind, Event, Id, Mode, Op, Sink, lock, sql};
use crate::Text;

struct Conn {
    id: Id,
    sink: Sink,
    closing: bool,
}

struct Tx {
    id: Id,
    conn: Id,
    scope: Vec<i64>,
    mode: Mode,
    started: bool,
    backlog: Vec<(u64, Op)>,
    commit: bool,
}

impl Tx {
    fn writes(&self) -> bool {
        self.mode != Mode::ReadOnly
    }

    fn overlaps(&self, other: &Tx) -> bool {
        self.mode == Mode::VersionChange || other.mode == Mode::VersionChange || self.scope.iter().any(|s| other.scope.contains(s))
    }
}

enum Request {
    Open { req: Id, version: Option<u64>, sink: Sink },
    Delete { req: Id, sink: Sink },
}

impl Request {
    fn req(&self) -> Id {
        match self {
            Request::Open { req, .. } | Request::Delete { req, .. } => *req,
        }
    }

    fn sink(&self) -> &Sink {
        match self {
            Request::Open { sink, .. } | Request::Delete { sink, .. } => sink,
        }
    }
}

enum Current {
    Waiting { request: Request, old: u64, new: Option<u64>, awaiting: Vec<Id>, blocked: bool },
    Upgrading { req: Id, old: u64, new: u64 },
}

pub(crate) struct Worker {
    name: Text,
    handle: u64,
    dir: Option<PathBuf>,
    catalog: Arc<Mutex<Catalog>>,
    db: Option<Connection>,
    version: u64,
    conns: Vec<Conn>,
    txs: Vec<Tx>,
    queue: VecDeque<Request>,
    current: Option<Current>,
    writing: Option<Id>,
}

fn sql_error(e: rusqlite::Error) -> Error {
    Error::new(ErrorKind::Unknown, e.to_string())
}

impl Worker {
    pub(crate) fn new(name: Text, handle: u64, dir: Option<PathBuf>, catalog: Arc<Mutex<Catalog>>) -> Worker {
        Worker { name, handle, dir, catalog, db: None, version: 0, conns: Vec::new(), txs: Vec::new(), queue: VecDeque::new(), current: None, writing: None }
    }

    pub(crate) fn run(mut self, rx: Receiver<Cmd>) {
        for cmd in rx {
            match cmd {
                Cmd::Open { req, version, sink } => self.queue.push_back(Request::Open { req, version, sink }),
                Cmd::Delete { req, sink } => self.queue.push_back(Request::Delete { req, sink }),
                Cmd::Begin { tx, conn, scope, mode } => {
                    if self.conns.iter().any(|c| c.id == conn) {
                        self.txs.push(Tx { id: tx, conn, scope, mode, started: false, backlog: Vec::new(), commit: false });
                    } else if let Some(sink) = self.sink_of_owner(tx.owner) {
                        sink(Event::Aborted { tx, error: Some(Error::new(ErrorKind::Unknown, "The connection is closed.")) });
                    }
                }
                Cmd::Op { tx, op, body } => self.op(tx, op, body),
                Cmd::Commit { tx } => self.commit_requested(tx),
                Cmd::Abort { tx } => self.abort(tx, None, true),
                Cmd::Close { conn } => {
                    if let Some(c) = self.conns.iter_mut().find(|c| c.id == conn) {
                        c.closing = true;
                    }
                }
                Cmd::Acknowledge { conn } => {
                    if let Some(Current::Waiting { awaiting, .. }) = &mut self.current {
                        awaiting.retain(|c| *c != conn);
                    }
                }
                Cmd::OwnerGone { owner } => self.owner_gone(owner),
                Cmd::Shutdown => break,
            }
            self.progress();
        }
        if self.writing.take().is_some()
            && let Some(db) = &self.db
        {
            _ = db.execute_batch("ROLLBACK");
        }
    }

    fn sink_of_owner(&self, owner: u64) -> Option<Sink> {
        self.conns.iter().find(|c| c.id.owner == owner).map(|c| c.sink.clone())
    }

    fn sink_of(&self, conn: Id) -> Option<Sink> {
        self.conns.iter().find(|c| c.id == conn).map(|c| c.sink.clone())
    }

    fn tx_sink(&self, tx: Id) -> Option<Sink> {
        let conn = self.txs.iter().find(|t| t.id == tx)?.conn;
        self.sink_of(conn)
    }

    fn progress(&mut self) {
        loop {
            self.drop_closed();
            let before = (self.current.is_some(), self.queue.len(), self.txs.iter().filter(|t| t.started).count(), self.txs.len());
            self.advance_request();
            self.schedule();
            let after = (self.current.is_some(), self.queue.len(), self.txs.iter().filter(|t| t.started).count(), self.txs.len());
            if before == after {
                break;
            }
        }
    }

    fn drop_closed(&mut self) {
        let txs = &self.txs;
        self.conns.retain(|c| !c.closing || txs.iter().any(|t| t.conn == c.id));
        let open: Vec<Id> = self.conns.iter().map(|c| c.id).collect();
        if let Some(Current::Waiting { awaiting, .. }) = &mut self.current {
            awaiting.retain(|c| open.contains(c));
        }
    }

    fn load(&mut self) -> Result<(), Error> {
        if self.db.is_some() {
            return Ok(());
        }
        let found = lock(&self.catalog).find(&self.name).map_err(sql_error)?;
        let Some((file, _)) = found else {
            self.version = 0;
            return Ok(());
        };
        let db = self.connect(file)?;
        self.version = sql::version(&db).map_err(sql_error)?;
        self.db = Some(db);
        Ok(())
    }

    fn connect(&self, file: i64) -> Result<Connection, Error> {
        match &self.dir {
            Some(dir) => crate::db::open(&dir.join(format!("{file}.sqlite3")), sql::SCHEMA)
                .ok_or_else(|| Error::new(ErrorKind::Unknown, "The database file cannot be opened.")),
            None => {
                let db = Connection::open_in_memory().map_err(sql_error)?;
                db.execute_batch(sql::SCHEMA).map_err(sql_error)?;
                Ok(db)
            }
        }
    }

    fn file_of(&self) -> Option<i64> {
        lock(&self.catalog).find(&self.name).ok().flatten().map(|(file, _)| file)
    }

    fn remove_files(&mut self) {
        let file = self.file_of();
        self.db = None;
        if let (Some(dir), Some(file)) = (&self.dir, file) {
            for suffix in ["", "-wal", "-shm"] {
                _ = std::fs::remove_file(dir.join(format!("{file}.sqlite3{suffix}")));
            }
        }
        if let Err(e) = lock(&self.catalog).forget(&self.name) {
            log::warn!("indexedDB: the catalog kept a deleted database: {e}");
        }
        self.version = 0;
    }

    fn advance_request(&mut self) {
        if self.current.is_none() {
            let Some(request) = self.queue.pop_front() else { return };
            if let Err(error) = self.load() {
                request.sink()(Event::OpenFailed { req: request.req(), error });
                return;
            }
            let old = self.version;
            let new = match &request {
                Request::Open { version, .. } => Some(version.unwrap_or(old.max(1))),
                Request::Delete { .. } => None,
            };
            if let (Request::Open { req, sink, .. }, Some(new)) = (&request, new) {
                if new < old {
                    sink(Event::OpenFailed {
                        req: *req,
                        error: Error::new(ErrorKind::Version, format!("The requested version ({new}) is less than the existing version ({old}).")),
                    });
                    return;
                }
                if new == old {
                    let schema = self.db.as_ref().map(sql::schema).transpose().map_err(sql_error);
                    match schema {
                        Ok(schema) => {
                            self.conns.push(Conn { id: *req, sink: sink.clone(), closing: false });
                            sink(Event::Opened { req: *req, db: self.handle, conn: *req, schema: schema.unwrap_or_default() });
                        }
                        Err(error) => sink(Event::OpenFailed { req: *req, error }),
                    }
                    return;
                }
            }
            let awaiting: Vec<Id> = self.conns.iter().filter(|c| !c.closing).map(|c| c.id).collect();
            for conn in &self.conns {
                if !conn.closing {
                    (conn.sink)(Event::VersionChange { conn: conn.id, old, new });
                }
            }
            self.current = Some(Current::Waiting { request, old, new, awaiting, blocked: false });
        }
        let Some(Current::Waiting { request, old, new, awaiting, blocked }) = &mut self.current else { return };
        if !awaiting.is_empty() {
            return;
        }
        if !self.conns.is_empty() {
            if !*blocked {
                *blocked = true;
                request.sink()(Event::Blocked { req: request.req(), old: *old, new: *new });
            }
            return;
        }
        let Some(Current::Waiting { request, old, new, .. }) = self.current.take() else { return };
        match request {
            Request::Delete { req, sink } => {
                if self.version > 0 || self.file_of().is_some() {
                    self.remove_files();
                }
                sink(Event::Deleted { req, old });
            }
            Request::Open { req, sink, .. } => {
                let new = new.unwrap_or(1);
                match self.begin_upgrade(new) {
                    Ok(schema) => {
                        self.conns.push(Conn { id: req, sink: sink.clone(), closing: false });
                        self.txs.push(Tx {
                            id: req,
                            conn: req,
                            scope: Vec::new(),
                            mode: Mode::VersionChange,
                            started: true,
                            backlog: Vec::new(),
                            commit: false,
                        });
                        self.writing = Some(req);
                        self.current = Some(Current::Upgrading { req, old, new });
                        let generators = schema.stores.iter().filter(|s| s.auto_increment).map(|s| (s.id, s.generator)).collect();
                        sink(Event::Upgrade { req, db: self.handle, conn: req, tx: req, old, schema });
                        sink(Event::Started { tx: req, generators });
                    }
                    Err(error) => {
                        if old == 0 {
                            self.remove_files();
                        }
                        sink(Event::OpenFailed { req, error });
                    }
                }
            }
        }
    }

    fn begin_upgrade(&mut self, new: u64) -> Result<super::Schema, Error> {
        if self.db.is_none() {
            let file = lock(&self.catalog).reserve(&self.name).map_err(sql_error)?;
            self.db = Some(self.connect(file)?);
        }
        let db = self.db.as_ref().ok_or_else(|| Error::new(ErrorKind::Unknown, "no database"))?;
        db.execute_batch("BEGIN IMMEDIATE").map_err(sql_error)?;
        let schema = sql::set_version(db, new).and_then(|()| sql::schema(db)).map_err(sql_error);
        if schema.is_err() {
            _ = db.execute_batch("ROLLBACK");
        }
        schema
    }

    fn schedule(&mut self) {
        while let Some(i) = self.startable() {
            self.start(i);
        }
    }

    fn startable(&self) -> Option<usize> {
        (0..self.txs.len()).find(|&i| {
            let tx = &self.txs[i];
            !tx.started
                && !(tx.writes() && self.writing.is_some())
                && !self.txs[..i].iter().any(|earlier| earlier.overlaps(tx) && (earlier.writes() || tx.writes()))
        })
    }

    fn start(&mut self, i: usize) {
        let id = self.txs[i].id;
        let sink = self.tx_sink(id);
        let Some(db) = &self.db else {
            self.txs.remove(i);
            if let Some(sink) = sink {
                sink(Event::Aborted { tx: id, error: Some(Error::new(ErrorKind::Unknown, "The database is gone.")) });
            }
            return;
        };
        if self.txs[i].writes() {
            if let Err(e) = db.execute_batch("BEGIN IMMEDIATE") {
                self.txs.remove(i);
                if let Some(sink) = sink {
                    sink(Event::Aborted { tx: id, error: Some(sql_error(e)) });
                }
                return;
            }
            self.writing = Some(id);
        }
        let scope = self.txs[i].scope.clone();
        let generators = sql::generators(db, &scope).unwrap_or_default();
        self.txs[i].started = true;
        if let Some(sink) = &sink {
            sink(Event::Started { tx: id, generators });
        }
        let backlog = std::mem::take(&mut self.txs[i].backlog);
        for (op, body) in backlog {
            self.op(id, op, body);
        }
        if self.txs.iter().any(|t| t.id == id && t.commit) {
            self.commit(id);
        }
    }

    fn op(&mut self, tx: Id, op: u64, body: Op) {
        let Some(t) = self.txs.iter_mut().find(|t| t.id == tx) else { return };
        if !t.started {
            t.backlog.push((op, body));
            return;
        }
        let Some(db) = &self.db else { return };
        let reply = sql::execute(db, body);
        if let Some(sink) = self.tx_sink(tx) {
            sink(Event::Result { tx, op, reply });
        }
    }

    fn commit_requested(&mut self, tx: Id) {
        let Some(t) = self.txs.iter_mut().find(|t| t.id == tx) else { return };
        if t.started {
            self.commit(tx);
        } else {
            t.commit = true;
        }
    }

    fn commit(&mut self, tx: Id) {
        let Some(i) = self.txs.iter().position(|t| t.id == tx) else { return };
        let sink = self.tx_sink(tx);
        let writes = self.txs[i].writes();
        let mode = self.txs[i].mode;
        if writes && let Some(db) = &self.db {
            if let Err(e) = db.execute_batch("COMMIT") {
                _ = db.execute_batch("ROLLBACK");
                self.writing = None;
                self.txs.remove(i);
                self.upgrade_ended(mode, false);
                if let Some(sink) = sink {
                    sink(Event::Aborted { tx, error: Some(sql_error(e)) });
                }
                return;
            }
            self.writing = None;
        }
        self.txs.remove(i);
        self.upgrade_ended(mode, true);
        if let Some(sink) = sink {
            sink(Event::Complete { tx });
        }
    }

    fn upgrade_ended(&mut self, mode: Mode, committed: bool) {
        if mode != Mode::VersionChange {
            return;
        }
        let Some(Current::Upgrading { req, old, new }) = self.current.take() else { return };
        if committed {
            self.version = new;
            if let Err(e) = lock(&self.catalog).set_version(&self.name, new) {
                log::warn!("indexedDB: the catalog kept an old version: {e}");
            }
        } else {
            self.conns.retain(|c| c.id != req);
            self.version = old;
            if old == 0 {
                self.remove_files();
            }
        }
    }

    fn abort(&mut self, tx: Id, error: Option<Error>, tell: bool) {
        let Some(i) = self.txs.iter().position(|t| t.id == tx) else { return };
        let sink = self.tx_sink(tx);
        let (started, writes, mode) = (self.txs[i].started, self.txs[i].writes(), self.txs[i].mode);
        if started
            && writes
            && let Some(db) = &self.db
        {
            _ = db.execute_batch("ROLLBACK");
            self.writing = None;
        }
        self.txs.remove(i);
        self.upgrade_ended(mode, false);
        if tell && let Some(sink) = sink {
            sink(Event::Aborted { tx, error });
        }
    }

    fn owner_gone(&mut self, owner: u64) {
        let gone: Vec<Id> = self.txs.iter().filter(|t| t.conn.owner == owner).map(|t| t.id).collect();
        for tx in gone {
            self.abort(tx, None, false);
        }
        self.conns.retain(|c| c.id.owner != owner);
        self.queue.retain(|r| r.req().owner != owner);
        if let Some(Current::Waiting { request, .. }) = &self.current
            && request.req().owner == owner
        {
            self.current = None;
        }
    }
}
