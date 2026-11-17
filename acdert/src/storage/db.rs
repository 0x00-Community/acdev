use std::path::Path;

use rusqlite::{Connection, ErrorCode};

pub fn open(path: &Path, schema: &str) -> Option<Connection> {
    if let Some(dir) = path.parent()
        && let Err(e) = create_private_dir(dir)
    {
        log::warn!("storage {}: cannot make the folder ({e}); keeping it in memory", path.display());
        return None;
    }
    match try_open(path, schema) {
        Ok(conn) => Some(conn),
        Err(e) if is_damaged(&e) => {
            let aside = path.with_extension(format!("bad-{}", now_ms()));
            log::warn!("storage {}: damaged ({e}); kept as {}, starting empty", path.display(), aside.display());
            if let Err(e) = std::fs::rename(path, &aside) {
                log::warn!("storage {}: cannot move it aside ({e}); keeping it in memory", path.display());
                return None;
            }
            for suffix in ["-wal", "-shm"] {
                let mut side = path.as_os_str().to_owned();
                side.push(suffix);
                _ = std::fs::remove_file(side);
            }
            try_open(path, schema).map_err(|e| log::warn!("storage {}: {e}; keeping it in memory", path.display())).ok()
        }
        Err(e) => {
            log::warn!("storage {}: {e}; keeping it in memory", path.display());
            None
        }
    }
}

fn try_open(path: &Path, schema: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(schema)?;
    Ok(conn)
}

fn is_damaged(e: &rusqlite::Error) -> bool {
    matches!(e.sqlite_error_code(), Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase))
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

pub fn utf16_bytes(text: &[u16]) -> Vec<u8> {
    text.iter().flat_map(|unit| unit.to_le_bytes()).collect()
}

pub fn utf16_from_bytes(bytes: &[u8]) -> Box<[u16]> {
    bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect()
}
