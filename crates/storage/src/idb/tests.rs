use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use super::*;
use crate::testing::TempDir;

struct Web {
    owner: u64,
    next: u64,
    events: Receiver<Event>,
    sink: Sink,
}

impl Web {
    fn new() -> Web {
        let (tx, events) = channel();
        let tx = Mutex::new(tx);
        let sink: Sink = Arc::new(move |event| _ = lock(&tx).send(event));
        Web { owner: new_owner(), next: 1, events, sink }
    }

    fn id(&mut self) -> Id {
        self.next += 1;
        Id { owner: self.owner, local: self.next }
    }

    fn next_event(&self) -> Event {
        self.events.recv_timeout(Duration::from_secs(5)).expect("no event from the database")
    }

    fn quiet(&self) -> bool {
        self.events.recv_timeout(Duration::from_millis(100)).is_err()
    }
}

fn text(s: &str) -> Text {
    s.encode_utf16().collect()
}

fn key(n: u8) -> Bytes {
    vec![0x10, n]
}

fn result(web: &Web) -> Reply {
    match web.next_event() {
        Event::Result { reply, .. } => reply,
        other => panic!("expected a result, got {other:?}"),
    }
}

fn open_new(idb: &Idb, web: &mut Web, name: &str, version: u64) -> (u64, Id) {
    let req = web.id();
    idb.open_database(&text(name), req, Some(version), web.sink.clone());
    let Event::Upgrade { db, conn, tx, .. } = web.next_event() else { panic!("no upgrade") };
    assert!(matches!(web.next_event(), Event::Started { .. }));
    assert_eq!(tx, req);
    (db, conn)
}

fn put(idb: &Idb, db: u64, tx: Id, store: i64, k: u8, v: &[u8], indexes: Vec<(i64, Bytes)>) {
    idb.op(db, tx, 0, Op::Put { store, key: key(k), value: v.to_vec(), indexes, overwrite: true, generator: None });
}

#[test]
fn create_write_read_and_reopen() {
    let dir = TempDir::new("idb-basic");
    let mut web = Web::new();
    let idb = Idb::open(Some(&dir.0));
    let (db, conn) = open_new(&idb, &mut web, "notes", 1);
    idb.op(db, conn, 1, Op::CreateStore { id: 1, name: text("items"), key_path: Some("\"id\"".into()), auto_increment: true });
    let Reply::Id(store) = result(&web) else { panic!() };
    idb.op(db, conn, 2, Op::CreateIndex { id: 1, store, name: text("by tag"), key_path: "\"tag\"".into(), unique: true, multi_entry: false });
    let Reply::Id(index) = result(&web) else { panic!() };
    put(&idb, db, conn, store, 1, b"one", vec![(index, vec![0x30, b'a'])]);
    assert_eq!(result(&web), Reply::Done);
    idb.op(
        db,
        conn,
        3,
        Op::Put { store, key: key(2), value: b"two".to_vec(), indexes: vec![(index, vec![0x30, b'a'])], overwrite: false, generator: Some(3.0) },
    );
    assert!(matches!(result(&web), Reply::Failed(Error { kind: ErrorKind::Constraint, .. })));
    idb.op(db, conn, 4, Op::Count { source: Source::Store(store), range: Range::default() });
    assert_eq!(result(&web), Reply::Count(1));
    idb.commit(db, conn);
    assert_eq!(web.next_event(), Event::Complete { tx: conn });
    idb.close(db, conn);
    drop(idb);

    let idb = Idb::open(Some(&dir.0));
    assert_eq!(idb.databases().unwrap(), vec![(text("notes"), 1)]);
    let req = web.id();
    idb.open_database(&text("notes"), req, None, web.sink.clone());
    let Event::Opened { schema, db, conn, .. } = web.next_event() else { panic!("not opened") };
    assert_eq!(schema.version, 1);
    assert_eq!(schema.stores[0].name, text("items"));
    assert_eq!(schema.stores[0].generator, 1.0, "a failed put leaves the key generator alone");
    assert_eq!(schema.stores[0].indexes[0].name, text("by tag"));
    let tx = web.id();
    idb.begin(db, tx, conn, vec![store], Mode::ReadOnly);
    idb.op(
        db,
        tx,
        5,
        Op::Get { source: Source::Index(index), range: Range::only(vec![0x30, b'a']), fetch: Fetch::Records, count: Some(1), direction: Direction::Next },
    );
    assert!(matches!(web.next_event(), Event::Started { .. }));
    assert_eq!(result(&web), Reply::Records(vec![Record { key: vec![0x30, b'a'], primary_key: key(1), value: Some(b"one".to_vec()) }]));
}

#[test]
fn abort_rolls_back_and_a_failed_first_upgrade_leaves_no_database() {
    let dir = TempDir::new("idb-abort");
    let mut web = Web::new();
    let idb = Idb::open(Some(&dir.0));
    let (db, conn) = open_new(&idb, &mut web, "gone", 1);
    idb.op(db, conn, 1, Op::CreateStore { id: 2, name: text("s"), key_path: None, auto_increment: false });
    assert!(matches!(result(&web), Reply::Id(_)));
    idb.abort(db, conn);
    assert_eq!(web.next_event(), Event::Aborted { tx: conn, error: None });
    assert!(idb.databases().unwrap().is_empty());

    let (db, conn) = open_new(&idb, &mut web, "kept", 1);
    idb.op(db, conn, 1, Op::CreateStore { id: 3, name: text("s"), key_path: None, auto_increment: false });
    let Reply::Id(store) = result(&web) else { panic!() };
    idb.commit(db, conn);
    assert_eq!(web.next_event(), Event::Complete { tx: conn });
    let tx = web.id();
    idb.begin(db, tx, conn, vec![store], Mode::ReadWrite);
    assert!(matches!(web.next_event(), Event::Started { .. }));
    put(&idb, db, tx, store, 7, b"temp", vec![]);
    assert_eq!(result(&web), Reply::Done);
    idb.abort(db, tx);
    assert!(matches!(web.next_event(), Event::Aborted { .. }));
    let tx = web.id();
    idb.begin(db, tx, conn, vec![store], Mode::ReadOnly);
    idb.op(db, tx, 2, Op::Count { source: Source::Store(store), range: Range::default() });
    assert!(matches!(web.next_event(), Event::Started { .. }));
    assert_eq!(result(&web), Reply::Count(0));
}

#[test]
fn writers_wait_for_overlapping_readers_and_readers_share() {
    let mut web = Web::new();
    let idb = Idb::open(None);
    let (db, conn) = open_new(&idb, &mut web, "sched", 1);
    idb.op(db, conn, 1, Op::CreateStore { id: 4, name: text("a"), key_path: None, auto_increment: false });
    let Reply::Id(a) = result(&web) else { panic!() };
    idb.commit(db, conn);
    assert!(matches!(web.next_event(), Event::Complete { .. }));
    let (r1, r2, w) = (web.id(), web.id(), web.id());
    idb.begin(db, r1, conn, vec![a], Mode::ReadOnly);
    idb.begin(db, w, conn, vec![a], Mode::ReadWrite);
    idb.begin(db, r2, conn, vec![a], Mode::ReadOnly);
    assert_eq!(web.next_event(), Event::Started { tx: r1, generators: vec![] });
    assert!(web.quiet(), "the writer and the later reader wait for the first reader");
    idb.commit(db, r1);
    assert_eq!(web.next_event(), Event::Complete { tx: r1 });
    assert_eq!(web.next_event(), Event::Started { tx: w, generators: vec![] });
    assert!(web.quiet(), "the later reader waits for the writer");
    idb.commit(db, w);
    assert_eq!(web.next_event(), Event::Complete { tx: w });
    assert_eq!(web.next_event(), Event::Started { tx: r2, generators: vec![] });
}

#[test]
fn version_change_reaches_other_connections_and_blocks_until_they_close() {
    let mut first = Web::new();
    let mut second = Web::new();
    let idb = Idb::open(None);
    let (db, conn) = open_new(&idb, &mut first, "shared", 1);
    idb.commit(db, conn);
    assert!(matches!(first.next_event(), Event::Complete { .. }));
    let req = second.id();
    idb.open_database(&text("shared"), req, Some(2), second.sink.clone());
    assert_eq!(first.next_event(), Event::VersionChange { conn, old: 1, new: Some(2) });
    assert!(second.quiet(), "nothing for the opener until the old connection answers");
    idb.acknowledge(db, conn);
    assert_eq!(second.next_event(), Event::Blocked { req, old: 1, new: Some(2) });
    idb.close(db, conn);
    let Event::Upgrade { old, .. } = second.next_event() else { panic!("no upgrade after the close") };
    assert_eq!(old, 1);

    let req = first.id();
    idb.delete_database(&text("shared"), req, first.sink.clone());
    assert!(matches!(second.next_event(), Event::Started { .. }));
    assert!(first.quiet(), "the delete waits for the upgrade");
    idb.owner_gone(second.owner);
    assert_eq!(first.next_event(), Event::Deleted { req, old: 1 });
}

#[test]
fn cursors_walk_index_keys_in_all_directions() {
    let mut web = Web::new();
    let idb = Idb::open(None);
    let (db, conn) = open_new(&idb, &mut web, "cursor", 1);
    idb.op(db, conn, 1, Op::CreateStore { id: 5, name: text("s"), key_path: None, auto_increment: false });
    let Reply::Id(store) = result(&web) else { panic!() };
    idb.op(db, conn, 2, Op::CreateIndex { id: 1, store, name: text("i"), key_path: "\"k\"".into(), unique: false, multi_entry: false });
    let Reply::Id(index) = result(&web) else { panic!() };
    for (pk, ik) in [(1, b'a'), (2, b'b'), (3, b'b'), (4, b'c')] {
        put(&idb, db, conn, store, pk, &[pk], vec![(index, vec![0x30, ik])]);
        assert_eq!(result(&web), Reply::Done);
    }
    let walk = |web: &Web, direction: Direction| -> Vec<u8> {
        let mut seen = Vec::new();
        let mut position = None;
        loop {
            idb.op(
                db,
                conn,
                9,
                Op::Cursor {
                    source: Source::Index(index),
                    range: Range::default(),
                    direction,
                    position: position.clone(),
                    key: None,
                    primary_key: None,
                    advance: 1,
                    values: true,
                },
            );
            let Reply::Records(found) = result(web) else { panic!() };
            let Some(record) = found.into_iter().next() else { return seen };
            seen.push(record.value.unwrap()[0]);
            position = Some((record.key, Some(record.primary_key)));
        }
    };
    assert_eq!(walk(&web, Direction::Next), vec![1, 2, 3, 4]);
    assert_eq!(walk(&web, Direction::NextUnique), vec![1, 2, 4]);
    assert_eq!(walk(&web, Direction::Prev), vec![4, 3, 2, 1]);
    assert_eq!(walk(&web, Direction::PrevUnique), vec![4, 2, 1]);
    idb.op(
        db,
        conn,
        10,
        Op::Cursor {
            source: Source::Index(index),
            range: Range::default(),
            direction: Direction::Next,
            position: None,
            key: Some(vec![0x30, b'b']),
            primary_key: Some(key(3)),
            advance: 1,
            values: false,
        },
    );
    let Reply::Records(found) = result(&web) else { panic!() };
    assert_eq!(found[0].primary_key, key(3));
    idb.op(
        db,
        conn,
        11,
        Op::Cursor {
            source: Source::Store(store),
            range: Range::default(),
            direction: Direction::Next,
            position: None,
            key: None,
            primary_key: None,
            advance: 3,
            values: false,
        },
    );
    let Reply::Records(found) = result(&web) else { panic!() };
    assert_eq!(found[0].key, key(3));
    idb.op(
        db,
        conn,
        12,
        Op::Get { source: Source::Index(index), range: Range::default(), fetch: Fetch::PrimaryKeys, count: None, direction: Direction::PrevUnique },
    );
    let Reply::Records(found) = result(&web) else { panic!() };
    assert_eq!(found.iter().map(|r| r.primary_key[1]).collect::<Vec<_>>(), vec![4, 2, 1]);
    idb.op(db, conn, 13, Op::Delete { store, range: Range { lower: Some((key(2), false)), upper: Some((key(3), false)) } });
    assert_eq!(result(&web), Reply::Done);
    idb.op(db, conn, 14, Op::Count { source: Source::Index(index), range: Range::default() });
    assert_eq!(result(&web), Reply::Count(2));
}
