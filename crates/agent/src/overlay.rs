use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rustix::mount::{UnmountFlags, mount_bind, unmount};
use serde_json::{Value, json};

pub const OVERLAYS: &str = "/var/lib/acdev/overlay";
const STATE: &str = "/run/acdev/overlay.json";
const ROOTS: [&str; 2] = ["/usr/local/share/acde/packages", "/usr/share/acde/packages"];

type Mounts = BTreeMap<String, Value>;

fn state() -> Mounts {
    fs::read(STATE).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save(mounts: &Mounts) -> Result<(), String> {
    fs::create_dir_all("/run/acdev").map_err(|e| format!("/run/acdev: {e}"))?;
    fs::write(STATE, json!(mounts).to_string()).map_err(|e| format!("{STATE}: {e}"))
}

pub fn named(name: &str) -> Result<&str, String> {
    let fine = !name.is_empty() && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._@-".contains(&b));
    if fine { Ok(name) } else { Err(format!("{name:?} is not a package name")) }
}

fn manifest(dir: &Path) -> Option<Value> {
    let bytes = fs::read(dir.join("package.json")).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok().map(|package| package["acde"].clone())
}

fn installed(name: &str) -> Option<PathBuf> {
    ROOTS.iter().map(|root| Path::new(root).join(name)).find(|dir| dir.join("package.json").is_file())
}

pub fn mount(name: &str) -> Result<Value, String> {
    let source = Path::new(OVERLAYS).join(named(name)?);
    let pushed = manifest(&source).ok_or_else(|| format!("{}: no package.json pushed", source.display()))?;
    for (path, mode) in [(source.clone(), 0o755), (source.join("package.json"), 0o644)] {
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(mode)).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let mut mounts = state();
    if let Some(held) = mounts.get(name) {
        if held["acde"] != pushed {
            return Err(format!("{name}: its manifest (the acde part of package.json) changed: install the package instead of pushing"));
        }
        return Ok(json!({ "target": held["target"], "mounted": false }));
    }
    let (target, created, acde) = match installed(name) {
        Some(dir) => {
            let acde = manifest(&dir).unwrap_or(Value::Null);
            if acde != pushed {
                return Err(format!("{name}: its manifest (the acde part of package.json) differs from the installed one: install the package instead"));
            }
            (dir, false, acde)
        }
        None => {
            let dir = Path::new(ROOTS[0]).join(name);
            fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            (dir, true, pushed)
        }
    };
    mount_bind(&source, &target).map_err(|e| format!("bind {} on {}: {e}", source.display(), target.display()))?;
    log::info!("acdev push: {} is bound on {}", source.display(), target.display());
    mounts.insert(name.to_string(), json!({ "target": target, "created": created, "acde": acde }));
    save(&mounts)?;
    Ok(json!({ "target": target, "mounted": true }))
}

pub fn reset(only: Option<&str>) -> Result<Vec<String>, String> {
    let mut mounts = state();
    let names: Vec<String> = match only {
        Some(name) => vec![named(name)?.to_string()],
        None => {
            let pushed: Vec<String> =
                fs::read_dir(OVERLAYS).map(|dir| dir.flatten().filter_map(|e| e.file_name().into_string().ok()).collect()).unwrap_or_default();
            mounts.keys().cloned().chain(pushed).collect::<std::collections::BTreeSet<_>>().into_iter().collect()
        }
    };
    for name in &names {
        if let Some(held) = mounts.remove(name) {
            let target = PathBuf::from(held["target"].as_str().unwrap_or_default());
            unmount(&target, UnmountFlags::DETACH).map_err(|e| format!("unmount {}: {e}", target.display()))?;
            if held["created"] == true {
                _ = fs::remove_dir(&target);
            }
        }
        let source = Path::new(OVERLAYS).join(name);
        if source.exists() {
            fs::remove_dir_all(&source).map_err(|e| format!("{}: {e}", source.display()))?;
        }
        log::info!("acdev push: the overlay of {name} is gone");
    }
    save(&mounts)?;
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_name_stays_one_path_part() {
        assert_eq!(named("dopame"), Ok("dopame"));
        assert_eq!(named("acde.notes-2"), Ok("acde.notes-2"));
        for bad in ["", ".", "..", "a/b", "a b"] {
            assert!(named(bad).is_err(), "{bad}");
        }
    }
}
