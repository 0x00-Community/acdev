use crate::failure::{Failure, Outcome};
#[cfg(not(windows))]
use crate::fs::path::NodePath;
use crate::fs::path::same_folder;
#[cfg(windows)]
use crate::fs::path::windows_directory;
use crate::sync::Locked;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    roots: Vec<String>,
}

pub(crate) struct Grants {
    dir: Option<PathBuf>,
    owners: Mutex<HashMap<String, Vec<String>>>,
}

impl Grants {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir, owners: Mutex::new(HashMap::new()) }
    }

    pub fn from_env() -> Self {
        let memory = std::env::var_os("ACDE_STORAGE").is_some_and(|value| value.is_empty());
        Self::new(if memory { None } else { crate::state_file("grants") })
    }

    pub fn valid_owner(owner: &str) -> bool {
        !owner.is_empty() && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }

    fn file(&self, owner: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|dir| dir.join(format!("{owner}.json")))
    }

    fn load(&self, owner: &str) -> Vec<String> {
        let Some(file) = self.file(owner) else { return Vec::new() };
        let saved: Saved = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        #[cfg(windows)]
        return saved.roots.iter().filter_map(|path| native_folder(path)).collect();
        #[cfg(not(windows))]
        saved.roots.into_iter().filter(|path| path.is_absolute()).collect()
    }

    fn save(&self, owner: &str, roots: &[String]) {
        let Some(file) = self.file(owner) else { return };
        let text = serde_json::to_vec(&Saved { roots: roots.to_vec() }).unwrap_or_default();
        if let Err(error) = crate::write_state(&file, &text, 0o644) {
            log::warn!("remembering the folders granted to {owner} in {}: {error}", file.display());
        }
    }

    fn with<T>(&self, owner: &str, f: impl FnOnce(&mut Vec<String>) -> T) -> T {
        let mut owners = self.owners.locked();
        let roots = owners.entry(owner.to_owned()).or_insert_with(|| self.load(owner));
        f(roots)
    }

    pub fn of(&self, owner: &str) -> Vec<String> {
        if !Self::valid_owner(owner) {
            return Vec::new();
        }
        self.with(owner, |roots| roots.clone())
    }

    pub fn add(&self, owner: &str, path: &str) -> Outcome<String> {
        if !Self::valid_owner(owner) {
            return Err(Failure::invalid("folders are granted to an app"));
        }
        let path = folder(path, "granted")?;
        Ok(self.with(owner, |roots| {
            if let Some(known) = roots.iter().find(|root| same_folder(root, &path)) {
                return known.clone();
            }
            roots.push(path.clone());
            self.save(owner, roots);
            path
        }))
    }

    pub fn remove(&self, owner: &str, path: &str) -> Outcome<()> {
        if !Self::valid_owner(owner) {
            return Err(Failure::invalid("only an app can revoke a folder granted to it"));
        }
        #[cfg(windows)]
        let path = native_folder(path).unwrap_or_else(|| path.to_owned());
        self.with(owner, |roots| {
            let before = roots.len();
            roots.retain(|root| !same_folder(root, &path));
            if roots.len() == before {
                return Err(Failure::http(404, "not a folder granted to this app"));
            }
            self.save(owner, roots);
            Ok(())
        })
    }
}

#[cfg(windows)]
fn native_folder(path: &str) -> Option<String> {
    let path = windows_directory(path)?;
    let trimmed = path.trim_end_matches(['\\', '/']);
    Some(if Path::new(trimmed).is_absolute() { trimmed.to_owned() } else { path })
}

#[cfg(not(windows))]
fn native_folder(path: &str) -> Option<String> {
    path.is_absolute().then(|| match path.normalize() {
        clean if clean.len() > 1 => clean.trim_end_matches('/').to_owned(),
        clean => clean,
    })
}

pub fn folder(path: &str, what: &str) -> Outcome<String> {
    let path = native_folder(path).ok_or_else(|| Failure::invalid(format!("a {what} folder is an absolute path")))?;
    if !Path::new(&path).is_dir() {
        return Err(Failure::invalid(format!("a {what} folder must be an existing folder")));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("acde-grants-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("picked")).unwrap();
        dir
    }

    #[test]
    fn grants_persist_per_app() {
        let dir = scratch();
        let picked = dir.join("picked").to_string_lossy().into_owned();
        let state = dir.join("state");
        let grants = Grants::new(Some(state.clone()));
        assert_eq!(grants.add("vault", &format!("{picked}/")).unwrap(), picked);
        grants.add("vault", &picked).unwrap();
        assert_eq!(grants.of("vault"), std::slice::from_ref(&picked));
        assert!(grants.of("other").is_empty());
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(state.join("vault.json")).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({"roots": [picked]}));
        let again = Grants::new(Some(state.clone()));
        assert_eq!(again.of("vault"), std::slice::from_ref(&picked));
        assert_eq!(again.remove("vault", "/elsewhere").unwrap_err().status, 404);
        again.remove("vault", &picked).unwrap();
        assert!(Grants::new(Some(state)).of("vault").is_empty());
        _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_grants_ignore_case_and_separators() {
        let dir = scratch();
        let picked = dir.join("picked").to_string_lossy().into_owned();
        let grants = Grants::new(None);
        assert_eq!(grants.add("vault", &picked).unwrap(), picked);
        assert_eq!(grants.add("vault", &picked.to_uppercase()).unwrap(), picked);
        assert_eq!(grants.of("vault"), std::slice::from_ref(&picked));
        assert_eq!(grants.remove("vault", &format!("{}2", picked.to_lowercase())).unwrap_err().status, 404);
        grants.remove("vault", &format!("{}/", picked.replace('\\', "/").to_lowercase())).unwrap();
        assert!(grants.of("vault").is_empty());
        _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn memory_only_and_bad_input() {
        let dir = scratch();
        let picked = dir.join("picked").to_string_lossy().into_owned();
        let grants = Grants::new(None);
        grants.add("vault", &picked).unwrap();
        assert_eq!(grants.of("vault"), std::slice::from_ref(&picked));
        assert!(Grants::new(None).of("vault").is_empty());
        assert_eq!(grants.add("../x", &picked).unwrap_err().status, 400);
        assert_eq!(grants.add("vault", "relative").unwrap_err().status, 400);
        assert_eq!(grants.add("vault", &dir.join("missing").to_string_lossy()).unwrap_err().status, 400);
        assert_eq!(grants.remove("", &picked).unwrap_err().status, 400);
        _ = std::fs::remove_dir_all(dir);
    }
}
