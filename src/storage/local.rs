use std::path::Path;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use indexmap::IndexMap;
use rusqlite::{Connection, params};

use crate::storage::db;

pub type Text = Box<[u16]>;

pub const QUOTA: usize = 5 * 1024 * 1024;

const FILE: &str = "localstorage.sqlite3";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS items (key BLOB NOT NULL UNIQUE, value BLOB NOT NULL);";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub key: Option<Text>,
    pub old: Option<Text>,
    pub new: Option<Text>,
    pub url: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct QuotaExceeded;

type Listener = Arc<dyn Fn(&Change) + Send + Sync>;

enum Op {
    Set(Text, Text),
    Remove(Text),
    Clear,
}

#[derive(Default)]
struct State {
    items: IndexMap<Text, Text>,
    used: usize,
    listeners: Vec<(u64, Listener)>,
    next_listener: u64,
    pending: Vec<Op>,
    scheduled: bool,
}

pub struct LocalArea {
    state: Mutex<State>,
    db: Option<Mutex<Connection>>,
}

pub struct Subscription {
    area: Weak<LocalArea>,
    id: u64,
}

impl Subscription {
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(area) = self.area.upgrade() {
            area.state().listeners.retain(|(id, _)| *id != self.id);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn writer() -> &'static Sender<Weak<LocalArea>> {
    static WRITER: OnceLock<Sender<Weak<LocalArea>>> = OnceLock::new();
    WRITER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Weak<LocalArea>>();
        let spawned = std::thread::Builder::new().name("acde-storage".into()).spawn(move || {
            for area in rx {
                if let Some(area) = area.upgrade() {
                    area.flush();
                }
            }
        });
        if let Err(e) = spawned {
            log::warn!("storage: no writer thread ({e}); changes are written when the app closes");
        }
        tx
    })
}

impl LocalArea {
    pub fn memory() -> Arc<LocalArea> {
        Arc::new(LocalArea { state: Mutex::default(), db: None })
    }

    pub fn open(dir: Option<&Path>, legacy: Option<&Path>) -> Arc<LocalArea> {
        let Some(dir) = dir else { return LocalArea::memory() };
        let path = dir.join(FILE);
        let fresh = !path.exists();
        let Some(conn) = db::open(&path, SCHEMA) else { return LocalArea::memory() };
        if fresh && let Some(legacy) = legacy.filter(|l| l.exists()) {
            migrate(&conn, legacy);
        }
        let mut state = State::default();
        if let Err(e) = load(&conn, &mut state) {
            log::warn!("storage {}: unreadable ({e}); starting empty and keeping it in memory", path.display());
            return LocalArea::memory();
        }
        Arc::new(LocalArea { state: Mutex::new(state), db: Some(Mutex::new(conn)) })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    pub fn subscribe(self: &Arc<Self>, listener: impl Fn(&Change) + Send + Sync + 'static) -> Subscription {
        let mut state = self.state();
        state.next_listener += 1;
        let id = state.next_listener;
        state.listeners.push((id, Arc::new(listener)));
        Subscription { area: Arc::downgrade(self), id }
    }

    pub fn len(&self) -> usize {
        self.state().items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.state().items.is_empty()
    }

    pub fn key(&self, index: usize) -> Option<Text> {
        self.state().items.get_index(index).map(|(key, _)| key.clone())
    }

    pub fn keys(&self) -> Vec<Text> {
        self.state().items.keys().cloned().collect()
    }

    pub fn get(&self, key: &[u16]) -> Option<Text> {
        self.state().items.get(key).cloned()
    }

    pub fn used(&self) -> usize {
        self.state().used
    }

    pub fn set(self: &Arc<Self>, key: Text, value: Text, source: u64, url: &str) -> Result<(), QuotaExceeded> {
        let (change, listeners) = {
            let mut state = self.state();
            let old = state.items.get(&key);
            if old == Some(&value) {
                return Ok(());
            }
            let freed = old.map_or(0, |old| key.len() + old.len());
            let used = state.used - freed + key.len() + value.len();
            if used > QUOTA && used > state.used {
                return Err(QuotaExceeded);
            }
            state.used = used;
            let old = state.items.insert(key.clone(), value.clone());
            self.record(&mut state, Op::Set(key.clone(), value.clone()));
            (Change { key: Some(key), old, new: Some(value), url: url.to_owned() }, others(&state, source))
        };
        listeners.iter().for_each(|listener| listener(&change));
        Ok(())
    }

    pub fn remove(self: &Arc<Self>, key: &[u16], source: u64, url: &str) {
        let (change, listeners) = {
            let mut state = self.state();
            let Some((key, old)) = state.items.swap_remove_entry(key) else { return };
            state.used -= key.len() + old.len();
            self.record(&mut state, Op::Remove(key.clone()));
            (Change { key: Some(key), old: Some(old), new: None, url: url.to_owned() }, others(&state, source))
        };
        listeners.iter().for_each(|listener| listener(&change));
    }

    pub fn clear(self: &Arc<Self>, source: u64, url: &str) {
        let (change, listeners) = {
            let mut state = self.state();
            if state.items.is_empty() {
                return;
            }
            state.items.clear();
            state.used = 0;
            self.record(&mut state, Op::Clear);
            (Change { key: None, old: None, new: None, url: url.to_owned() }, others(&state, source))
        };
        listeners.iter().for_each(|listener| listener(&change));
    }

    fn record(self: &Arc<Self>, state: &mut State, op: Op) {
        if self.db.is_none() {
            return;
        }
        if matches!(op, Op::Clear) {
            state.pending.clear();
        }
        state.pending.push(op);
        if !state.scheduled {
            state.scheduled = true;
            if writer().send(Arc::downgrade(self)).is_err() {
                state.scheduled = false;
            }
        }
    }

    pub fn flush(&self) {
        let Some(db) = &self.db else { return };
        let mut conn = lock(db);
        let ops = {
            let mut state = self.state();
            state.scheduled = false;
            std::mem::take(&mut state.pending)
        };
        if ops.is_empty() {
            return;
        }
        if let Err(e) = write(&mut conn, &ops) {
            log::warn!("storage {}: changes not written: {e}", conn.path().unwrap_or("?"));
        }
    }
}

fn others(state: &State, source: u64) -> Vec<Listener> {
    state.listeners.iter().filter(|(id, _)| *id != source).map(|(_, listener)| listener.clone()).collect()
}

fn load(conn: &Connection, state: &mut State) -> rusqlite::Result<()> {
    let mut query = conn.prepare("SELECT key, value FROM items ORDER BY rowid")?;
    let rows = query.query_map([], |row| Ok((db::utf16_from_bytes(&row.get::<_, Vec<u8>>(0)?), db::utf16_from_bytes(&row.get::<_, Vec<u8>>(1)?))))?;
    for row in rows {
        let (key, value) = row?;
        state.used += key.len() + value.len();
        state.items.insert(key, value);
    }
    Ok(())
}

fn write(conn: &mut Connection, ops: &[Op]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare_cached("INSERT INTO items (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?;
        let mut delete = tx.prepare_cached("DELETE FROM items WHERE key = ?1")?;
        for op in ops {
            match op {
                Op::Set(key, value) => _ = upsert.execute(params![db::utf16_bytes(key), db::utf16_bytes(value)])?,
                Op::Remove(key) => _ = delete.execute(params![db::utf16_bytes(key)])?,
                Op::Clear => _ = tx.execute("DELETE FROM items", [])?,
            }
        }
    }
    tx.commit()
}

fn migrate(conn: &Connection, legacy: &Path) {
    let entries = std::fs::read_to_string(legacy)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text).map_err(|e| e.to_string()));
    let entries = match entries {
        Ok(entries) => entries,
        Err(e) => {
            let aside = legacy.with_extension(format!("bad-{}", db::now_ms()));
            log::warn!("storage {}: not imported ({e}); kept as {}", legacy.display(), aside.display());
            _ = std::fs::rename(legacy, aside);
            return;
        }
    };
    let imported = (|| -> rusqlite::Result<usize> {
        let tx = conn.unchecked_transaction()?;
        let mut count = 0;
        {
            let mut insert = tx.prepare("INSERT INTO items (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?;
            for (key, value) in &entries {
                let Some(value) = value.as_str() else { continue };
                let key: Vec<u16> = key.encode_utf16().collect();
                let value: Vec<u16> = value.encode_utf16().collect();
                insert.execute(params![db::utf16_bytes(&key), db::utf16_bytes(&value)])?;
                count += 1;
            }
        }
        tx.commit()?;
        Ok(count)
    })();
    match imported {
        Ok(count) => {
            let done = legacy.with_extension("json.imported");
            log::info!("storage: imported {count} localStorage items from {} (kept as {})", legacy.display(), done.display());
            _ = std::fs::rename(legacy, done);
        }
        Err(e) => log::warn!("storage {}: not imported: {e}", legacy.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testing::TempDir;
    use std::sync::Mutex;

    fn text(s: &str) -> Text {
        s.encode_utf16().collect()
    }

    #[test]
    fn other_subscribers_hear_changes_and_the_writer_does_not() {
        let area = LocalArea::memory();
        let heard: Arc<Mutex<Vec<Change>>> = Arc::default();
        let a = area.subscribe(|_| panic!("the writer heard its own change"));
        let b = {
            let heard = heard.clone();
            area.subscribe(move |change| heard.lock().unwrap().push(change.clone()))
        };
        area.set(text("k"), text("1"), a.id(), "http://acde.local/a").unwrap();
        area.set(text("k"), text("1"), a.id(), "http://acde.local/a").unwrap();
        area.set(text("k"), text("2"), a.id(), "http://acde.local/a").unwrap();
        area.remove(&text("k"), a.id(), "u");
        area.remove(&text("k"), a.id(), "u");
        area.set(text("x"), text("y"), a.id(), "u").unwrap();
        area.clear(a.id(), "u");
        area.clear(a.id(), "u");
        let heard = heard.lock().unwrap();
        let summary: Vec<_> = heard
            .iter()
            .map(|c| {
                (c.key.as_deref().map(String::from_utf16_lossy), c.old.as_deref().map(String::from_utf16_lossy), c.new.as_deref().map(String::from_utf16_lossy))
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (Some("k".into()), None, Some("1".into())),
                (Some("k".into()), Some("1".into()), Some("2".into())),
                (Some("k".into()), Some("2".into()), None),
                (Some("x".into()), None, Some("y".into())),
                (None, None, None),
            ]
        );
        assert_eq!(heard[0].url, "http://acde.local/a");
        drop(b);
    }

    #[test]
    fn quota_counts_utf16_units_of_keys_and_values() {
        let area = LocalArea::memory();
        let big: Text = vec![b'a' as u16; QUOTA - 3].into();
        area.set(text("k"), big, 0, "").unwrap();
        assert_eq!(area.used(), QUOTA - 2);
        assert_eq!(area.set(text("j"), text("xy"), 0, ""), Err(QuotaExceeded));
        area.set(text("j"), text("x"), 0, "").unwrap();
        assert_eq!(area.set(text("k"), vec![b'a' as u16; QUOTA - 1].into(), 0, ""), Err(QuotaExceeded));
        area.set(text("k"), text("small"), 0, "").unwrap();
        assert_eq!(area.used(), 1 + 5 + 1 + 1);
    }

    #[test]
    fn lone_surrogates_survive_a_restart() {
        let dir = TempDir::new("surrogates");
        let odd: Text = vec![0xd800, b'x' as u16, 0xdfff].into();
        {
            let area = LocalArea::open(Some(&dir.0), None);
            area.set(odd.clone(), odd.clone(), 0, "").unwrap();
            area.flush();
        }
        let area = LocalArea::open(Some(&dir.0), None);
        assert_eq!(area.get(&odd), Some(odd.clone()));
        assert_eq!(area.used(), 6);
    }

    #[test]
    fn writes_reach_disk_in_order_and_clear_drops_earlier_ones() {
        let dir = TempDir::new("order");
        {
            let area = LocalArea::open(Some(&dir.0), None);
            for i in 0..200 {
                area.set(text("n"), text(&i.to_string()), 0, "").unwrap();
            }
            area.set(text("gone"), text("1"), 0, "").unwrap();
            area.clear(0, "");
            area.set(text("kept"), text("yes"), 0, "").unwrap();
            area.remove(&text("missing"), 0, "");
            area.flush();
        }
        let area = LocalArea::open(Some(&dir.0), None);
        assert_eq!(area.keys(), vec![text("kept")]);
        assert_eq!(area.get(&text("kept")), Some(text("yes")));
    }

    #[test]
    fn the_old_json_file_is_imported_once() {
        let dir = TempDir::new("legacy");
        let legacy = dir.0.join("app-x.json");
        std::fs::write(&legacy, r#"{"theme":"dark","n":"2","skip":3}"#).unwrap();
        let area = LocalArea::open(Some(&dir.0.join("app-x")), Some(&legacy));
        assert_eq!(area.get(&text("theme")), Some(text("dark")));
        assert_eq!(area.len(), 2);
        assert!(!legacy.exists());
        assert!(dir.0.join("app-x.json.imported").exists());
        std::fs::write(&legacy, r#"{"theme":"light"}"#).unwrap();
        drop(area);
        let area = LocalArea::open(Some(&dir.0.join("app-x")), Some(&legacy));
        assert_eq!(area.get(&text("theme")), Some(text("dark")));
    }

    #[test]
    fn a_damaged_file_is_kept_aside() {
        let dir = TempDir::new("damaged");
        std::fs::write(dir.0.join(FILE), b"this is not a database, just some bytes that are long enough to look like a header").unwrap();
        let area = LocalArea::open(Some(&dir.0), None);
        area.set(text("a"), text("b"), 0, "").unwrap();
        area.flush();
        assert!(std::fs::read_dir(&dir.0).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".bad-")));
        drop(area);
        assert_eq!(LocalArea::open(Some(&dir.0), None).get(&text("a")), Some(text("b")));
    }
}
