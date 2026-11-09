use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use super::{Bytes, Direction, Error, ErrorKind, Fetch, IndexInfo, Op, Range, Record, Reply, Schema, Source, StoreInfo};
use crate::db;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name BLOB NOT NULL UNIQUE, key_path TEXT, auto_increment INTEGER NOT NULL, generator REAL NOT NULL);
CREATE TABLE IF NOT EXISTS indexes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, store INTEGER NOT NULL, name BLOB NOT NULL, key_path TEXT NOT NULL,
    is_unique INTEGER NOT NULL, multi_entry INTEGER NOT NULL, UNIQUE (store, name));
CREATE TABLE IF NOT EXISTS records (store INTEGER NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY (store, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS index_records (idx INTEGER NOT NULL, key BLOB NOT NULL, pk BLOB NOT NULL, PRIMARY KEY (idx, key, pk)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS index_records_by_pk ON index_records (idx, pk);
";

type Sql<T> = rusqlite::Result<T>;

pub fn version(conn: &Connection) -> Sql<u64> {
    Ok(conn.query_row("SELECT version FROM meta", [], |row| row.get::<_, i64>(0)).optional()?.map_or(0, |v| v as u64))
}

pub fn set_version(conn: &Connection, version: u64) -> Sql<()> {
    conn.execute("DELETE FROM meta", [])?;
    conn.execute("INSERT INTO meta (version) VALUES (?1)", params![version as i64])?;
    Ok(())
}

pub fn schema(conn: &Connection) -> Sql<Schema> {
    let mut stores: Vec<StoreInfo> = {
        let mut query = conn.prepare_cached("SELECT id, name, key_path, auto_increment, generator FROM stores ORDER BY id")?;
        let rows = query.query_map([], |row| {
            Ok(StoreInfo {
                id: row.get(0)?,
                name: db::utf16_from_bytes(&row.get::<_, Vec<u8>>(1)?),
                key_path: row.get(2)?,
                auto_increment: row.get(3)?,
                generator: row.get(4)?,
                indexes: Vec::new(),
            })
        })?;
        rows.collect::<Sql<_>>()?
    };
    let mut query = conn.prepare_cached("SELECT id, store, name, key_path, is_unique, multi_entry FROM indexes ORDER BY id")?;
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, i64>(1)?,
            IndexInfo {
                id: row.get(0)?,
                name: db::utf16_from_bytes(&row.get::<_, Vec<u8>>(2)?),
                key_path: row.get(3)?,
                unique: row.get(4)?,
                multi_entry: row.get(5)?,
            },
        ))
    })?;
    for row in rows {
        let (store, index) = row?;
        if let Some(store) = stores.iter_mut().find(|s| s.id == store) {
            store.indexes.push(index);
        }
    }
    Ok(Schema { version: version(conn)?, stores })
}

pub fn generators(conn: &Connection, scope: &[i64]) -> Sql<Vec<(i64, f64)>> {
    let mut query = conn.prepare_cached("SELECT id, generator FROM stores WHERE auto_increment = 1")?;
    let rows = query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))?;
    let all: Vec<(i64, f64)> = rows.collect::<Sql<_>>()?;
    Ok(all.into_iter().filter(|(id, _)| scope.is_empty() || scope.contains(id)).collect())
}

struct Query {
    sql: String,
    args: Vec<Value>,
}

impl Query {
    fn new(sql: &str) -> Query {
        Query { sql: sql.to_owned(), args: Vec::new() }
    }

    fn arg(&mut self, value: impl Into<Value>) -> String {
        self.args.push(value.into());
        format!("?{}", self.args.len())
    }

    fn and(&mut self, clause: &str) {
        self.sql.push_str(" AND ");
        self.sql.push_str(clause);
    }

    fn range(&mut self, column: &str, range: &Range) {
        if let Some((lower, open)) = &range.lower {
            let p = self.arg(lower.clone());
            self.and(&format!("{column} {} {p}", if *open { ">" } else { ">=" }));
        }
        if let Some((upper, open)) = &range.upper {
            let p = self.arg(upper.clone());
            self.and(&format!("{column} {} {p}", if *open { "<" } else { "<=" }));
        }
    }
}

fn store_of_index(conn: &Connection, index: i64) -> Sql<i64> {
    conn.query_row("SELECT store FROM indexes WHERE id = ?1", params![index], |row| row.get(0))
}

fn source_query(conn: &Connection, source: Source, values: bool) -> Sql<Query> {
    Ok(match source {
        Source::Store(store) => {
            let mut q = Query::new(if values { "SELECT key, key, value FROM records WHERE" } else { "SELECT key, key, NULL FROM records WHERE" });
            let p = q.arg(store);
            q.sql.push_str(&format!(" store = {p}"));
            q
        }
        Source::Index(index) => {
            let store = store_of_index(conn, index)?;
            let mut q = Query::new(if values {
                "SELECT ir.key, ir.pk, r.value FROM index_records ir JOIN records r ON r.key = ir.pk AND r.store = "
            } else {
                "SELECT ir.key, ir.pk, NULL FROM index_records ir JOIN records r ON r.key = ir.pk AND r.store = "
            });
            let s = q.arg(store);
            let i = q.arg(index);
            q.sql.push_str(&format!("{s} WHERE ir.idx = {i}"));
            q
        }
    })
}

fn columns(source: Source) -> (&'static str, &'static str) {
    match source {
        Source::Store(_) => ("key", "key"),
        Source::Index(_) => ("ir.key", "ir.pk"),
    }
}

fn records(conn: &Connection, q: &Query) -> Sql<Vec<Record>> {
    let mut stmt = conn.prepare_cached(&q.sql)?;
    let rows = stmt.query_map(params_from_iter(q.args.iter()), |row| Ok(Record { key: row.get(0)?, primary_key: row.get(1)?, value: row.get(2)? }))?;
    rows.collect()
}

fn get(conn: &Connection, source: Source, range: &Range, fetch: Fetch, count: Option<u32>, direction: Direction) -> Sql<Vec<Record>> {
    let values = matches!(fetch, Fetch::Values | Fetch::Records);
    if matches!(direction, Direction::NextUnique | Direction::PrevUnique) && matches!(source, Source::Index(_)) {
        let mut out = Vec::new();
        let mut position: Option<(Bytes, Option<Bytes>)> = None;
        while count.is_none_or(|n| out.len() < n as usize) {
            let Some(record) = step(conn, source, range, direction, position.as_ref(), None, None, values)? else { break };
            position = Some((record.key.clone(), Some(record.primary_key.clone())));
            out.push(record);
        }
        return Ok(out);
    }
    let mut q = source_query(conn, source, values)?;
    let (key, pk) = columns(source);
    q.range(key, range);
    let order = if matches!(direction, Direction::Prev | Direction::PrevUnique) { "DESC" } else { "ASC" };
    q.sql.push_str(&format!(" ORDER BY {key} {order}, {pk} {order}"));
    if let Some(n) = count {
        let p = q.arg(i64::from(n));
        q.sql.push_str(&format!(" LIMIT {p}"));
    }
    records(conn, &q)
}

fn count(conn: &Connection, source: Source, range: &Range) -> Sql<u64> {
    let mut q = source_query(conn, source, false)?;
    q.range(columns(source).0, range);
    q.sql = format!("SELECT COUNT(*) FROM ({})", q.sql);
    conn.prepare_cached(&q.sql)?.query_row(params_from_iter(q.args.iter()), |row| row.get::<_, i64>(0)).map(|n| n as u64)
}

#[allow(clippy::too_many_arguments)]
fn step(
    conn: &Connection,
    source: Source,
    range: &Range,
    direction: Direction,
    position: Option<&(Bytes, Option<Bytes>)>,
    target: Option<&Bytes>,
    target_pk: Option<&Bytes>,
    values: bool,
) -> Sql<Option<Record>> {
    let forward = matches!(direction, Direction::Next | Direction::NextUnique);
    let unique = matches!(direction, Direction::NextUnique | Direction::PrevUnique);
    let (key, pk) = columns(source);
    let index = matches!(source, Source::Index(_));
    let (after, at_least) = if forward { (">", ">=") } else { ("<", "<=") };
    let mut q = source_query(conn, source, values)?;
    q.range(key, range);
    if let Some((pos_key, pos_pk)) = position {
        match pos_pk.as_ref().filter(|_| index && !unique) {
            Some(pos_pk) => {
                let (a, b) = (q.arg(pos_key.clone()), q.arg(pos_pk.clone()));
                q.and(&format!("({key}, {pk}) {after} ({a}, {b})"));
            }
            None => {
                let a = q.arg(pos_key.clone());
                q.and(&format!("{key} {after} {a}"));
            }
        }
    }
    match (target, target_pk) {
        (Some(target), Some(target_pk)) if index => {
            let (a, b) = (q.arg(target.clone()), q.arg(target_pk.clone()));
            q.and(&format!("({key}, {pk}) {at_least} ({a}, {b})"));
        }
        (Some(target), _) => {
            let a = q.arg(target.clone());
            q.and(&format!("{key} {at_least} {a}"));
        }
        _ => {}
    }
    let order = if forward { "ASC" } else { "DESC" };
    q.sql.push_str(&format!(" ORDER BY {key} {order}, {pk} {order} LIMIT 1"));
    let found = records(conn, &q)?.pop();
    if direction != Direction::PrevUnique || !index {
        return Ok(found);
    }
    let Some(found) = found else { return Ok(None) };
    let mut first = source_query(conn, source, values)?;
    let a = first.arg(found.key.clone());
    first.and(&format!("{key} = {a}"));
    first.sql.push_str(&format!(" ORDER BY {pk} ASC LIMIT 1"));
    Ok(records(conn, &first)?.pop())
}

#[allow(clippy::too_many_arguments)]
fn cursor(
    conn: &Connection,
    source: Source,
    range: &Range,
    direction: Direction,
    position: Option<(Bytes, Option<Bytes>)>,
    key: Option<Bytes>,
    primary_key: Option<Bytes>,
    advance: u32,
    values: bool,
) -> Sql<Option<Record>> {
    let mut position = position;
    let mut found = None;
    for i in 0..advance.max(1) {
        let (target, target_pk) = if i == 0 { (key.as_ref(), primary_key.as_ref()) } else { (None, None) };
        found = step(conn, source, range, direction, position.as_ref(), target, target_pk, values)?;
        let Some(record) = &found else { return Ok(None) };
        position = Some((record.key.clone(), Some(record.primary_key.clone())));
    }
    Ok(found)
}

fn constraint(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::Constraint, message)
}

fn index_entries(conn: &Connection, pk: &[u8], entries: &[(i64, Bytes)]) -> Result<(), Error> {
    let run = || -> Sql<Option<Error>> {
        let mut unique = conn.prepare_cached("SELECT is_unique FROM indexes WHERE id = ?1")?;
        let mut taken = conn.prepare_cached("SELECT 1 FROM index_records WHERE idx = ?1 AND key = ?2 AND pk <> ?3 LIMIT 1")?;
        let mut insert = conn.prepare_cached("INSERT OR IGNORE INTO index_records (idx, key, pk) VALUES (?1, ?2, ?3)")?;
        for (index, key) in entries {
            let is_unique: bool = unique.query_row(params![index], |row| row.get(0))?;
            if is_unique && taken.exists(params![index, key, pk])? {
                return Ok(Some(constraint("A record in the index already has this key and the index is unique.")));
            }
            insert.execute(params![index, key, pk])?;
        }
        Ok(None)
    };
    match run() {
        Ok(None) => Ok(()),
        Ok(Some(e)) => Err(e),
        Err(e) => Err(Error::unknown(e)),
    }
}

fn drop_index_records(conn: &Connection, store: i64, pk: Option<&[u8]>) -> Sql<()> {
    match pk {
        Some(pk) => conn
            .prepare_cached("DELETE FROM index_records WHERE idx IN (SELECT id FROM indexes WHERE store = ?1) AND pk = ?2")?
            .execute(params![store, pk])
            .map(drop),
        None => conn.prepare_cached("DELETE FROM index_records WHERE idx IN (SELECT id FROM indexes WHERE store = ?1)")?.execute(params![store]).map(drop),
    }
}

fn in_savepoint(conn: &Connection, f: impl FnOnce() -> Result<Reply, Error>) -> Reply {
    if let Err(e) = conn.execute_batch("SAVEPOINT op") {
        return Reply::Failed(Error::unknown(e));
    }
    let reply = f().unwrap_or_else(Reply::Failed);
    let end = if matches!(reply, Reply::Failed(_)) { "ROLLBACK TO op; RELEASE op" } else { "RELEASE op" };
    if let Err(e) = conn.execute_batch(end) {
        return Reply::Failed(Error::unknown(e));
    }
    reply
}

fn put(conn: &Connection, store: i64, key: &[u8], value: &[u8], indexes: &[(i64, Bytes)], overwrite: bool) -> Result<Reply, Error> {
    let exists =
        conn.prepare_cached("SELECT 1 FROM records WHERE store = ?1 AND key = ?2").and_then(|mut q| q.exists(params![store, key])).map_err(Error::unknown)?;
    if exists && !overwrite {
        return Err(constraint("Key already exists in the object store."));
    }
    if exists {
        drop_index_records(conn, store, Some(key)).map_err(Error::unknown)?;
    }
    conn.prepare_cached("INSERT OR REPLACE INTO records (store, key, value) VALUES (?1, ?2, ?3)")
        .and_then(|mut q| q.execute(params![store, key, value]))
        .map_err(Error::unknown)?;
    index_entries(conn, key, indexes)?;
    Ok(Reply::Done)
}

fn delete(conn: &Connection, store: i64, range: &Range) -> Sql<()> {
    let mut q = Query::new("DELETE FROM index_records WHERE idx IN (SELECT id FROM indexes WHERE store = ?1) AND pk IN (SELECT key FROM records WHERE");
    q.arg(store);
    q.sql.push_str(" store = ?1");
    q.range("key", range);
    q.sql.push(')');
    conn.prepare_cached(&q.sql)?.execute(params_from_iter(q.args.iter()))?;
    let mut q = Query::new("DELETE FROM records WHERE store = ?1");
    q.arg(store);
    q.range("key", range);
    conn.prepare_cached(&q.sql)?.execute(params_from_iter(q.args.iter()))?;
    Ok(())
}

fn named_exists(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<bool, Error> {
    conn.prepare_cached(sql).and_then(|mut q| q.exists(args)).map_err(Error::unknown)
}

pub fn execute(conn: &Connection, op: Op) -> Reply {
    let unknown = |e: rusqlite::Error| Reply::Failed(Error::unknown(e));
    match op {
        Op::Put { store, key, value, indexes, overwrite, generator } => in_savepoint(conn, || {
            let reply = put(conn, store, &key, &value, &indexes, overwrite)?;
            if let Some(generator) = generator {
                conn.execute("UPDATE stores SET generator = ?2 WHERE id = ?1", params![store, generator]).map_err(Error::unknown)?;
            }
            Ok(reply)
        }),
        Op::Delete { store, range } => in_savepoint(conn, || delete(conn, store, &range).map(|()| Reply::Done).map_err(Error::unknown)),
        Op::Clear { store } => in_savepoint(conn, || {
            drop_index_records(conn, store, None)
                .and_then(|()| conn.execute("DELETE FROM records WHERE store = ?1", params![store]))
                .map(|_| Reply::Done)
                .map_err(Error::unknown)
        }),
        Op::Get { source, range, fetch, count, direction } => get(conn, source, &range, fetch, count, direction).map_or_else(unknown, Reply::Records),
        Op::Count { source, range } => count(conn, source, &range).map_or_else(unknown, Reply::Count),
        Op::Cursor { source, range, direction, position, key, primary_key, advance, values } => {
            cursor(conn, source, &range, direction, position, key, primary_key, advance, values)
                .map_or_else(unknown, |found| Reply::Records(found.into_iter().collect()))
        }
        Op::CreateStore { id, name, key_path, auto_increment } => in_savepoint(conn, || {
            if named_exists(conn, "SELECT 1 FROM stores WHERE name = ?1", params![db::utf16_bytes(&name)])? {
                return Err(constraint("An object store with this name already exists."));
            }
            conn.execute(
                "INSERT INTO stores (id, name, key_path, auto_increment, generator) VALUES (?1, ?2, ?3, ?4, 1)",
                params![id, db::utf16_bytes(&name), key_path, auto_increment],
            )
            .map(|_| Reply::Id(conn.last_insert_rowid()))
            .map_err(Error::unknown)
        }),
        Op::DeleteStore { store } => in_savepoint(conn, || {
            drop_index_records(conn, store, None)
                .and_then(|()| conn.execute("DELETE FROM indexes WHERE store = ?1", params![store]))
                .and_then(|_| conn.execute("DELETE FROM records WHERE store = ?1", params![store]))
                .and_then(|_| conn.execute("DELETE FROM stores WHERE id = ?1", params![store]))
                .map(|_| Reply::Done)
                .map_err(Error::unknown)
        }),
        Op::RenameStore { store, name } => in_savepoint(conn, || {
            if named_exists(conn, "SELECT 1 FROM stores WHERE name = ?1 AND id <> ?2", params![db::utf16_bytes(&name), store])? {
                return Err(constraint("An object store with this name already exists."));
            }
            conn.execute("UPDATE stores SET name = ?2 WHERE id = ?1", params![store, db::utf16_bytes(&name)]).map(|_| Reply::Done).map_err(Error::unknown)
        }),
        Op::CreateIndex { id, store, name, key_path, unique, multi_entry } => in_savepoint(conn, || {
            if named_exists(conn, "SELECT 1 FROM indexes WHERE store = ?1 AND name = ?2", params![store, db::utf16_bytes(&name)])? {
                return Err(constraint("An index with this name already exists."));
            }
            conn.execute(
                "INSERT INTO indexes (id, store, name, key_path, is_unique, multi_entry) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, store, db::utf16_bytes(&name), key_path, unique, multi_entry],
            )
            .map(|_| Reply::Id(conn.last_insert_rowid()))
            .map_err(Error::unknown)
        }),
        Op::IndexEntries { index, entries } => in_savepoint(conn, || {
            for (key, pk) in &entries {
                index_entries(conn, pk, &[(index, key.clone())])?;
            }
            Ok(Reply::Done)
        }),
        Op::DeleteIndex { index } => in_savepoint(conn, || {
            conn.execute("DELETE FROM index_records WHERE idx = ?1", params![index])
                .and_then(|_| conn.execute("DELETE FROM indexes WHERE id = ?1", params![index]))
                .map(|_| Reply::Done)
                .map_err(Error::unknown)
        }),
        Op::RenameIndex { index, name } => in_savepoint(conn, || {
            let store = store_of_index(conn, index).map_err(Error::unknown)?;
            if named_exists(conn, "SELECT 1 FROM indexes WHERE store = ?1 AND name = ?2 AND id <> ?3", params![store, db::utf16_bytes(&name), index])? {
                return Err(constraint("An index with this name already exists."));
            }
            conn.execute("UPDATE indexes SET name = ?2 WHERE id = ?1", params![index, db::utf16_bytes(&name)]).map(|_| Reply::Done).map_err(Error::unknown)
        }),
    }
}
