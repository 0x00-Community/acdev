use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, params};

use crate::storage::db;

const FILE: &str = "cookies.sqlite3";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS cookies (
    name TEXT NOT NULL, path TEXT NOT NULL, value TEXT NOT NULL, expires REAL NOT NULL, http_only INTEGER NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (name, path)) WITHOUT ROWID;";

#[derive(Clone, Debug, PartialEq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub path: String,
    pub expires: Option<f64>,
    pub http_only: bool,
    created: u64,
}

#[derive(Default)]
struct State {
    cookies: Vec<Cookie>,
    next: u64,
}

pub struct CookieJar {
    state: Mutex<State>,
    db: Option<Mutex<Connection>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn path_matches(path: &str, cookie_path: &str) -> bool {
    path == cookie_path || (path.starts_with(cookie_path) && (cookie_path.ends_with('/') || path.as_bytes().get(cookie_path.len()) == Some(&b'/')))
}

pub struct NewCookie<'a> {
    pub name: &'a str,
    pub value: &'a str,
    pub path: &'a str,
    pub expires: Option<f64>,
    pub http_only: bool,
    pub from_script: bool,
}

impl CookieJar {
    pub fn open(dir: Option<&Path>, now: f64) -> Arc<CookieJar> {
        let db = dir.and_then(|dir| db::open(&dir.join(FILE), SCHEMA));
        let mut state = State::default();
        if let Some(conn) = &db {
            _ = conn.execute("DELETE FROM cookies WHERE expires <= ?1", params![now]);
            let loaded = conn.prepare("SELECT name, path, value, expires, http_only FROM cookies ORDER BY created").and_then(|mut q| {
                q.query_map([], |row| {
                    Ok(Cookie { name: row.get(0)?, path: row.get(1)?, value: row.get(2)?, expires: Some(row.get(3)?), http_only: row.get(4)?, created: 0 })
                })
                .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            });
            match loaded {
                Ok(cookies) => {
                    for mut cookie in cookies {
                        cookie.created = state.next;
                        state.next += 1;
                        state.cookies.push(cookie);
                    }
                }
                Err(e) => log::warn!("storage: cookies unreadable ({e}); starting without them"),
            }
        }
        Arc::new(CookieJar { state: Mutex::new(state), db: db.map(Mutex::new) })
    }

    pub fn set(&self, cookie: NewCookie, now: f64) {
        let mut state = lock(&self.state);
        let at = state.cookies.iter().position(|c| c.name == cookie.name && c.path == cookie.path);
        if cookie.from_script && (cookie.http_only || at.is_some_and(|i| state.cookies[i].http_only)) {
            return;
        }
        if cookie.expires.is_some_and(|e| e <= now) {
            if let Some(i) = at {
                state.cookies.remove(i);
            }
            self.write(|conn| conn.execute("DELETE FROM cookies WHERE name = ?1 AND path = ?2", params![cookie.name, cookie.path]));
            return;
        }
        let created = match at {
            Some(i) => state.cookies.remove(i).created,
            None => {
                state.next += 1;
                state.next - 1
            }
        };
        let entry = Cookie {
            name: cookie.name.into(),
            value: cookie.value.into(),
            path: cookie.path.into(),
            expires: cookie.expires,
            http_only: cookie.http_only,
            created,
        };
        match entry.expires {
            Some(expires) => self.write(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO cookies (name, path, value, expires, http_only, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![entry.name, entry.path, entry.value, expires, entry.http_only, created as i64],
                )
            }),
            None => self.write(|conn| conn.execute("DELETE FROM cookies WHERE name = ?1 AND path = ?2", params![entry.name, entry.path])),
        }
        let at = state.cookies.iter().position(|c| c.created > created).unwrap_or(state.cookies.len());
        state.cookies.insert(at, entry);
    }

    pub fn matching(&self, path: &str, script: bool, now: f64) -> Vec<(String, String)> {
        let mut state = lock(&self.state);
        let expired: Vec<(String, String)> =
            state.cookies.iter().filter(|c| c.expires.is_some_and(|e| e <= now)).map(|c| (c.name.clone(), c.path.clone())).collect();
        if !expired.is_empty() {
            state.cookies.retain(|c| !c.expires.is_some_and(|e| e <= now));
            self.write(|conn| conn.execute("DELETE FROM cookies WHERE expires <= ?1", params![now]));
        }
        let mut out: Vec<&Cookie> = state.cookies.iter().filter(|c| !(script && c.http_only) && path_matches(path, &c.path)).collect();
        out.sort_by(|a, b| b.path.len().cmp(&a.path.len()).then(a.created.cmp(&b.created)));
        out.into_iter().map(|c| (c.name.clone(), c.value.clone())).collect()
    }

    fn write(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<usize>) {
        if let Some(db) = &self.db
            && let Err(e) = f(&lock(db))
        {
            log::warn!("storage: a cookie change was not written: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testing::TempDir;

    fn cookie<'a>(name: &'a str, value: &'a str, path: &'a str, expires: Option<f64>) -> NewCookie<'a> {
        NewCookie { name, value, path, expires, http_only: false, from_script: false }
    }

    #[test]
    fn persistent_cookies_survive_and_session_cookies_do_not() {
        let dir = TempDir::new("cookies");
        {
            let jar = CookieJar::open(Some(&dir.0), 1000.0);
            jar.set(cookie("kept", "1", "/", Some(5000.0)), 1000.0);
            jar.set(cookie("session", "2", "/", None), 1000.0);
            jar.set(cookie("deep", "3", "/a/b", Some(5000.0)), 1000.0);
            jar.set(NewCookie { http_only: true, ..cookie("secret", "4", "/", Some(5000.0)) }, 1000.0);
            jar.set(NewCookie { from_script: true, ..cookie("secret", "overwritten", "/", Some(5000.0)) }, 1000.0);
            assert_eq!(
                jar.matching("/a/b/c", false, 1000.0),
                vec![("deep".into(), "3".into()), ("kept".into(), "1".into()), ("session".into(), "2".into()), ("secret".into(), "4".into())]
            );
            assert_eq!(jar.matching("/a/bc", true, 1000.0), vec![("kept".into(), "1".into()), ("session".into(), "2".into())]);
        }
        let jar = CookieJar::open(Some(&dir.0), 2000.0);
        assert_eq!(jar.matching("/", false, 2000.0), vec![("kept".into(), "1".into()), ("secret".into(), "4".into())]);
        jar.set(cookie("kept", "", "/", Some(0.0)), 2000.0);
        assert_eq!(jar.matching("/", false, 6000.0), vec![]);
        drop(jar);
        assert!(CookieJar::open(Some(&dir.0), 2000.0).matching("/", false, 2000.0).iter().all(|(name, _)| name != "kept"));
    }
}
