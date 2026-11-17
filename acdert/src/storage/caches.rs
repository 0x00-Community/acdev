use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};

use crate::storage::{Text, db};

const FILE: &str = "caches.sqlite3";
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS caches (id INTEGER PRIMARY KEY AUTOINCREMENT, name BLOB UNIQUE);
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cache INTEGER NOT NULL, url TEXT NOT NULL, bare TEXT NOT NULL, method TEXT NOT NULL,
    request_headers TEXT NOT NULL, response TEXT NOT NULL, response_headers TEXT NOT NULL, body BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS entries_by_url ON entries (cache, bare);
";

pub type Headers = Vec<(String, String)>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Query {
    pub url: String,
    pub method: String,
    pub headers: Headers,
    pub ignore_search: bool,
    pub ignore_method: bool,
    pub ignore_vary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub url: String,
    pub method: String,
    pub request_headers: Headers,
    pub response: String,
    pub response_headers: Headers,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Operation {
    Delete(Query),
    Put(Entry),
}

pub struct CacheStore {
    db: Mutex<Connection>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn without_search(url: &str) -> &str {
    url.split_once('?').map_or(url, |(bare, _)| bare)
}

fn without_fragment(url: &str) -> &str {
    url.split_once('#').map_or(url, |(bare, _)| bare)
}

fn header<'a>(headers: &'a Headers, name: &str) -> Option<String> {
    let values: Vec<&'a str> = headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).collect();
    (!values.is_empty()).then(|| values.join(", "))
}

fn matches(query: &Query, entry: &Entry) -> bool {
    if !query.ignore_method && query.method != "GET" {
        return false;
    }
    let (mut wanted, mut cached) = (without_fragment(&query.url), without_fragment(&entry.url));
    if query.ignore_search {
        wanted = without_search(wanted);
        cached = without_search(cached);
    }
    if wanted != cached {
        return false;
    }
    if query.ignore_vary {
        return true;
    }
    let Some(vary) = header(&entry.response_headers, "vary") else { return true };
    for field in vary.split(',').map(str::trim).filter(|f| !f.is_empty()) {
        if field == "*" || header(&entry.request_headers, field) != header(&query.headers, field) {
            return false;
        }
    }
    true
}

fn headers_json(headers: &Headers) -> String {
    serde_json::to_string(headers).unwrap_or_else(|_| "[]".into())
}

fn headers_of(json: &str) -> Headers {
    serde_json::from_str(json).unwrap_or_default()
}

type Sql<T> = rusqlite::Result<T>;

impl CacheStore {
    pub fn open(dir: Option<&Path>) -> CacheStore {
        let conn = dir.and_then(|dir| db::open(&dir.join(FILE), SCHEMA)).or_else(|| {
            let conn = Connection::open_in_memory().ok()?;
            conn.execute_batch(SCHEMA).ok()?;
            Some(conn)
        });
        let conn = conn.unwrap_or_else(|| Connection::open_in_memory().expect("acde-storage: an in-memory SQLite database"));
        let purged =
            conn.execute_batch("DELETE FROM entries WHERE cache IN (SELECT id FROM caches WHERE name IS NULL); DELETE FROM caches WHERE name IS NULL;");
        if let Err(e) = purged {
            log::warn!("storage: deleted caches not purged: {e}");
        }
        CacheStore { db: Mutex::new(conn) }
    }

    pub fn names(&self) -> Sql<Vec<Text>> {
        let conn = lock(&self.db);
        let mut query = conn.prepare_cached("SELECT name FROM caches WHERE name IS NOT NULL ORDER BY id")?;
        let rows = query.query_map([], |row| Ok(db::utf16_from_bytes(&row.get::<_, Vec<u8>>(0)?)))?;
        rows.collect()
    }

    fn find(conn: &Connection, name: &[u16]) -> Sql<Option<i64>> {
        conn.query_row("SELECT id FROM caches WHERE name = ?1", params![db::utf16_bytes(name)], |row| row.get(0)).optional()
    }

    pub fn has(&self, name: &[u16]) -> Sql<bool> {
        Ok(Self::find(&lock(&self.db), name)?.is_some())
    }

    pub fn open_cache(&self, name: &[u16]) -> Sql<i64> {
        let conn = lock(&self.db);
        if let Some(id) = Self::find(&conn, name)? {
            return Ok(id);
        }
        conn.execute("INSERT INTO caches (name) VALUES (?1)", params![db::utf16_bytes(name)])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn delete_cache(&self, name: &[u16]) -> Sql<bool> {
        let conn = lock(&self.db);
        let Some(id) = Self::find(&conn, name)? else { return Ok(false) };
        conn.execute("UPDATE caches SET name = NULL WHERE id = ?1", params![id])?;
        Ok(true)
    }

    fn candidates(conn: &Connection, cache: Option<i64>, query: Option<&Query>) -> Sql<Vec<(i64, Entry)>> {
        let bare = query.map(|q| without_search(without_fragment(&q.url)).to_owned());
        let sql = match (cache, &bare) {
            (Some(_), Some(_)) => {
                "SELECT id, url, method, request_headers, response, response_headers, body FROM entries WHERE cache = ?1 AND bare = ?2 ORDER BY id"
            }
            (Some(_), None) => "SELECT id, url, method, request_headers, response, response_headers, body FROM entries WHERE cache = ?1 ORDER BY id",
            (None, Some(_)) => {
                "SELECT e.id, e.url, e.method, e.request_headers, e.response, e.response_headers, e.body FROM entries e JOIN caches c ON c.id = e.cache WHERE c.name IS NOT NULL AND e.bare = ?2 ORDER BY c.id, e.id"
            }
            (None, None) => {
                "SELECT e.id, e.url, e.method, e.request_headers, e.response, e.response_headers, e.body FROM entries e JOIN caches c ON c.id = e.cache WHERE c.name IS NOT NULL ORDER BY c.id, e.id"
            }
        };
        let mut statement = conn.prepare_cached(sql)?;
        let map = |row: &rusqlite::Row| -> Sql<(i64, Entry)> {
            Ok((
                row.get(0)?,
                Entry {
                    url: row.get(1)?,
                    method: row.get(2)?,
                    request_headers: headers_of(&row.get::<_, String>(3)?),
                    response: row.get(4)?,
                    response_headers: headers_of(&row.get::<_, String>(5)?),
                    body: row.get(6)?,
                },
            ))
        };
        let rows: Vec<(i64, Entry)> = match (cache, bare) {
            (Some(cache), Some(bare)) => statement.query_map(params![cache, bare], map)?.collect::<Sql<_>>()?,
            (Some(cache), None) => statement.query_map(params![cache], map)?.collect::<Sql<_>>()?,
            (None, Some(bare)) => statement.query_map(params![rusqlite::types::Null, bare], map)?.collect::<Sql<_>>()?,
            (None, None) => statement.query_map([], map)?.collect::<Sql<_>>()?,
        };
        Ok(rows.into_iter().filter(|(_, entry)| query.is_none_or(|q| matches(q, entry))).collect())
    }

    pub fn query(&self, cache: Option<i64>, query: Option<&Query>, first: bool) -> Sql<Vec<Entry>> {
        let conn = lock(&self.db);
        let mut found = Self::candidates(&conn, cache, query)?;
        if first {
            found.truncate(1);
        }
        Ok(found.into_iter().map(|(_, entry)| entry).collect())
    }

    pub fn batch(&self, cache: i64, operations: &[Operation]) -> Sql<Vec<bool>> {
        let mut conn = lock(&self.db);
        let tx = conn.transaction()?;
        if tx.query_row("SELECT 1 FROM caches WHERE id = ?1", params![cache], |_| Ok(())).optional()?.is_none() {
            return Ok(vec![false; operations.len()]);
        }
        let mut outcomes = Vec::new();
        for operation in operations {
            match operation {
                Operation::Delete(query) => {
                    let found = Self::candidates(&tx, Some(cache), Some(query))?;
                    for (id, _) in &found {
                        tx.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
                    }
                    outcomes.push(!found.is_empty());
                }
                Operation::Put(entry) => {
                    let query = Query { url: entry.url.clone(), method: "GET".into(), headers: entry.request_headers.clone(), ..Query::default() };
                    for (id, _) in Self::candidates(&tx, Some(cache), Some(&query))? {
                        tx.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
                    }
                    tx.execute(
                        "INSERT INTO entries (cache, url, bare, method, request_headers, response, response_headers, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            cache,
                            entry.url,
                            without_search(without_fragment(&entry.url)),
                            entry.method,
                            headers_json(&entry.request_headers),
                            entry.response,
                            headers_json(&entry.response_headers),
                            entry.body
                        ],
                    )?;
                    outcomes.push(true);
                }
            }
        }
        tx.commit()?;
        Ok(outcomes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testing::TempDir;

    fn text(s: &str) -> Text {
        s.encode_utf16().collect()
    }

    fn entry(url: &str, request: &[(&str, &str)], response: &[(&str, &str)], body: &str) -> Entry {
        let headers = |list: &[(&str, &str)]| list.iter().map(|(n, v)| ((*n).into(), (*v).into())).collect();
        Entry {
            url: url.into(),
            method: "GET".into(),
            request_headers: headers(request),
            response: "{}".into(),
            response_headers: headers(response),
            body: body.as_bytes().to_vec(),
        }
    }

    fn get(url: &str) -> Query {
        Query { url: url.into(), method: "GET".into(), ..Query::default() }
    }

    #[test]
    fn caches_keep_their_order_and_entries_survive_a_restart() {
        let dir = TempDir::new("caches");
        {
            let store = CacheStore::open(Some(&dir.0));
            let a = store.open_cache(&text("a")).unwrap();
            store.open_cache(&text("b")).unwrap();
            assert_eq!(store.open_cache(&text("a")).unwrap(), a);
            store.batch(a, &[Operation::Put(entry("http://x/one?q=1#frag", &[], &[], "1"))]).unwrap();
            assert_eq!(store.names().unwrap(), vec![text("a"), text("b")]);
        }
        let store = CacheStore::open(Some(&dir.0));
        let found = store.query(None, Some(&get("http://x/one?q=1")), true).unwrap();
        assert_eq!(found[0].body, b"1");
        assert_eq!(found[0].url, "http://x/one?q=1#frag");
        assert!(store.query(None, Some(&get("http://x/one")), false).unwrap().is_empty());
        assert_eq!(store.query(None, Some(&Query { ignore_search: true, ..get("http://x/one") }), false).unwrap().len(), 1);
        let a = store.open_cache(&text("a")).unwrap();
        assert!(store.delete_cache(&text("a")).unwrap());
        assert!(!store.delete_cache(&text("a")).unwrap());
        assert!(store.query(None, None, false).unwrap().is_empty(), "a deleted cache is out of CacheStorage.match");
        assert_eq!(store.query(Some(a), None, false).unwrap().len(), 1, "a Cache object opened before keeps its entries");
        assert_eq!(store.names().unwrap(), vec![text("b")]);
        drop(store);
        let store = CacheStore::open(Some(&dir.0));
        assert!(store.query(Some(a), None, false).unwrap().is_empty(), "the doomed cache is purged on the next start");
    }

    #[test]
    fn vary_put_replaces_and_delete_reports() {
        let store = CacheStore::open(None);
        let c = store.open_cache(&text("v")).unwrap();
        let vary = [("Vary", "Accept-Language")];
        store.batch(c, &[Operation::Put(entry("http://x/v", &[("accept-language", "en")], &vary, "en"))]).unwrap();
        store.batch(c, &[Operation::Put(entry("http://x/v", &[("accept-language", "fr")], &vary, "fr"))]).unwrap();
        let fr = Query { headers: vec![("Accept-Language".into(), "fr".into())], ..get("http://x/v") };
        assert_eq!(store.query(Some(c), Some(&fr), false).unwrap().iter().map(|e| e.body.clone()).collect::<Vec<_>>(), vec![b"fr".to_vec()]);
        assert_eq!(store.query(Some(c), Some(&Query { ignore_vary: true, ..get("http://x/v") }), false).unwrap().len(), 2);
        store.batch(c, &[Operation::Put(entry("http://x/v", &[("accept-language", "fr")], &vary, "fr2"))]).unwrap();
        assert_eq!(store.query(Some(c), Some(&Query { ignore_vary: true, ..get("http://x/v") }), false).unwrap().len(), 2);
        assert!(store.query(Some(c), Some(&Query { method: "POST".into(), ..get("http://x/v") }), false).unwrap().is_empty());
        assert_eq!(store.batch(c, &[Operation::Delete(fr.clone()), Operation::Delete(fr)]).unwrap(), vec![true, false]);
        let star = [("Vary", "*")];
        store.batch(c, &[Operation::Put(entry("http://x/star", &[], &star, "s"))]).unwrap();
        assert!(store.query(Some(c), Some(&get("http://x/star")), false).unwrap().is_empty());
        assert_eq!(store.query(Some(c), Some(&Query { ignore_vary: true, ..get("http://x/star") }), false).unwrap().len(), 1);
    }
}
