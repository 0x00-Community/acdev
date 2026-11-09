mod admit;
mod copy_source;
mod grants;
pub(crate) mod path;
mod picked;
pub(crate) mod workspace;

use grants::Grants;
#[cfg(not(windows))]
use path::NodePath;
#[cfg(windows)]
use path::windows_directory;
pub use picked::PickedFolders;
pub use workspace::EntryKind;
use workspace::{Contents, FinderEntry, FinderPreview, FinderRoot, MkdirOptions, WorkspaceFs, WriteOptions};

use crate::blocking;
use crate::failure::{Failure, Outcome};
use crate::sync::Locked;
use napi::Result;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, sync::Mutex};

trait IntoJson {
    fn json(self) -> Outcome<Value>;
}
impl<T: Serialize> IntoJson for Outcome<T> {
    fn json(self) -> Outcome<Value> {
        serde_json::to_value(self?).map_err(Failure::internal)
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Place {
    root: Option<String>,
    path: String,
    file: Option<String>,
}

impl Place {
    fn file() -> Option<std::path::PathBuf> {
        crate::state_file("finder-place.json")
    }

    fn load() -> Self {
        Self::file().and_then(|file| std::fs::read(file).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn save(&self) {
        let Some(file) = Self::file() else { return };
        if let Err(error) = crate::write_state(&file, &serde_json::to_vec(self).unwrap_or_default(), 0o644) {
            log::warn!("remembering the Finder's place in {}: {error}", file.display());
        }
    }
}

#[derive(Serialize)]
struct State {
    roots: Vec<FinderRoot>,
    root: Option<String>,
    path: String,
    entries: Vec<FinderEntry>,
    truncated: bool,
    preview: Option<FinderPreview>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Desktop {
    root: String,
    entries: Vec<FinderEntry>,
    truncated: bool,
}

pub(crate) struct Shared {
    pub(crate) fs: WorkspaceFs,
    place: Mutex<Place>,
    grants: Grants,
}

impl Shared {
    fn place(&self) -> Place {
        self.place.locked().clone()
    }

    fn roots(&self, owner: Option<&str>) -> Outcome<Vec<FinderRoot>> {
        let mut roots = self.fs.roots()?;
        for path in owner.map(|owner| self.grants.of(owner)).unwrap_or_default() {
            if !roots.iter().any(|root| root.path == path) {
                roots.push(WorkspaceFs::granted(&path));
            }
        }
        Ok(roots)
    }

    fn root(&self, owner: Option<&str>, path: &str) -> Outcome<FinderRoot> {
        self.roots(owner)?.into_iter().find(|root| root.path == path).ok_or_else(|| Failure::invalid("not a Runtime workspace"))
    }

    fn state(&self, owner: Option<&str>) -> Outcome<State> {
        let (fs, place) = (&self.fs, self.place());
        let roots = self.roots(owner)?;
        let wanted = place.root.as_deref();
        let root = roots.iter().find(|item| Some(item.path.as_str()) == wanted).or_else(|| roots.first()).cloned();
        let mut state = State {
            roots,
            root: root.as_ref().map(|root| root.path.clone()),
            path: String::new(),
            entries: Vec::new(),
            truncated: false,
            preview: None,
            error: None,
        };
        let Some(root) = root else {
            return Ok(state);
        };
        let here = place.root.as_deref() == Some(root.path.as_str());
        let loaded = fs.list_in(root.clone(), if here { &place.path } else { "" }, true).and_then(|listing| {
            (state.path, state.entries, state.truncated) = (listing.path, listing.entries, listing.truncated);
            match place.file.as_deref().filter(|_| here) {
                Some(file) => WorkspaceFs::preview_in(&root, file).map(Some),
                None => Ok(None),
            }
        });
        match loaded {
            Ok(preview) => state.preview = preview,
            Err(failure) if failure.shown_in_state() => state.error = Some(failure.message),
            Err(failure) => return Err(failure),
        }
        Ok(state)
    }
}

pub enum FsCall {
    State,
    Roots,
    Desktop,
    List { root: String, path: Option<String>, hidden: Option<bool> },
    Preview { root: String, path: String },
    Download { root: String, path: String },
    Locate { path: String },
    OpenPath { root: String, path: String },
    Place { root: String, path: Option<String>, file: Option<String> },
    Mkdir { root: String, path: String, options: Option<Value> },
    Stat { root: String, path: String },
    ReadText { root: String, path: String },
    ReadBytes { root: String, path: String },
    WriteFile { root: String, path: String, data: Option<Vec<u8>>, options: Option<Value> },
    Revoke { root: String },
    Write { root: String, path: String, content: Option<String>, expected_modified_ms: String },
    CopyIn { root: String, dir: String, source: String },
    Rename { root: String, from: String, to: String },
    Delete { root: String, path: String },
}

pub enum FsReply {
    Json(Value),
    File { name: String, data: Vec<u8> },
    Text { text: String, modified_ms: i64, size: u64 },
    Bytes { data: Vec<u8>, modified_ms: i64 },
    Done,
}

#[derive(Debug)]
pub struct FsError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl From<Failure> for FsError {
    fn from(failure: Failure) -> Self {
        Self { status: failure.status, code: failure.errno.as_str(), message: failure.message }
    }
}

impl FsCall {
    fn scope(&self) -> Option<&str> {
        match self {
            Self::State | Self::Roots | Self::Desktop | Self::Locate { .. } | Self::Revoke { .. } => None,
            Self::List { root, .. }
            | Self::Preview { root, .. }
            | Self::Download { root, .. }
            | Self::OpenPath { root, .. }
            | Self::Place { root, .. }
            | Self::Mkdir { root, .. }
            | Self::Stat { root, .. }
            | Self::ReadText { root, .. }
            | Self::ReadBytes { root, .. }
            | Self::WriteFile { root, .. }
            | Self::Write { root, .. }
            | Self::CopyIn { root, .. }
            | Self::Rename { root, .. }
            | Self::Delete { root, .. } => Some(root),
        }
    }
}

impl Shared {
    fn new() -> Self {
        Self::with(Grants::from_env())
    }

    fn with(grants: Grants) -> Self {
        Self { fs: WorkspaceFs::new(), place: Mutex::new(Place::load()), grants }
    }

    fn call(&self, call: FsCall, owner: Option<&str>, scope: Option<&dyn Fn(&str) -> bool>) -> Outcome<FsReply> {
        let json = |value: Outcome<Value>| value.map(FsReply::Json);
        let root = |path: &str| self.root(owner, path);
        match call {
            FsCall::State => json(self.state(owner).json()),
            FsCall::Roots => json(self.roots(owner).json()),
            FsCall::Desktop => json(self.desktop().json()),
            FsCall::List { root: at, path, hidden } => json(self.fs.list_in(root(&at)?, path.as_deref().unwrap_or(""), hidden.unwrap_or(true)).json()),
            FsCall::Preview { root: at, path } => json(WorkspaceFs::preview_in(&root(&at)?, &path).json()),
            FsCall::Download { root: at, path } => WorkspaceFs::raw_in(&root(&at)?, &path).map(|(name, data)| FsReply::File { name, data }),
            FsCall::Locate { path } => json(self.locate(owner, &path, scope)),
            FsCall::OpenPath { root: at, path } => json(self.open_path(&root(&at)?, &path)),
            FsCall::Place { root: at, path, file } => json(self.set_place(&root(&at)?, path, file).json()),
            FsCall::Mkdir { root: at, path, options } => {
                let options: MkdirOptions = options_of("mkdir", options)?;
                json(WorkspaceFs::mkdir_in(&root(&at)?, &path, &options).json())
            }
            FsCall::Stat { root: at, path } => json(WorkspaceFs::stat_in(&root(&at)?, &path).json()),
            FsCall::ReadText { root: at, path } => {
                let (text, modified_ms) = WorkspaceFs::read_text_in(&root(&at)?, &path)?;
                Ok(FsReply::Text { size: text.len() as u64, text, modified_ms })
            }
            FsCall::ReadBytes { root: at, path } => {
                let Contents { data, modified_ms } = WorkspaceFs::read_bytes_in(&root(&at)?, &path)?;
                Ok(FsReply::Bytes { data, modified_ms })
            }
            FsCall::WriteFile { root: at, path, data, options } => {
                let options: WriteOptions = options_of("writeFile", options)?;
                let data = data.ok_or_else(|| Failure::invalid("data must be a string or a Uint8Array"))?;
                json(WorkspaceFs::write_file_in(&root(&at)?, &path, &data, &options).json())
            }
            FsCall::Write { root: at, path, content, expected_modified_ms } => {
                json(WorkspaceFs::write_in(&root(&at)?, &path, content.as_deref().unwrap_or(""), &expected_modified_ms).json())
            }
            FsCall::CopyIn { root: at, dir, source } => {
                let allowed = self.allowed(owner, scope)?;
                json(copy_in(owner, &allowed, &at, &dir, &source))
            }
            FsCall::Rename { root: at, from, to } => json(WorkspaceFs::rename_in(&root(&at)?, &from, &to).json()),
            FsCall::Delete { root: at, path } => {
                WorkspaceFs::remove_in(&root(&at)?, &path)?;
                json(Ok(serde_json::json!({"status": "deleted", "path": path})))
            }
            FsCall::Revoke { root: at } => {
                self.grants.remove(owner.unwrap_or_default(), &at)?;
                Ok(FsReply::Done)
            }
        }
    }

    fn allowed(&self, owner: Option<&str>, scope: Option<&dyn Fn(&str) -> bool>) -> Outcome<Vec<FinderRoot>> {
        Ok(self.roots(owner)?.into_iter().filter(|root| scope.is_none_or(|allows| allows(&root.path))).collect())
    }

    fn desktop(&self) -> Outcome<Desktop> {
        let root = self.fs.desktop()?;
        let listing = self.fs.list_in(self.fs.root(&root)?, "", false)?;
        Ok(Desktop { root, entries: listing.entries, truncated: listing.truncated })
    }

    fn locate(&self, owner: Option<&str>, path: &str, scope: Option<&dyn Fn(&str) -> bool>) -> Outcome<Value> {
        let home = std::env::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
        let expanded = match path.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with('/') || cfg!(windows) && rest.starts_with('\\') => {
                format!("{home}{rest}")
            }
            _ => path.to_owned(),
        };
        #[cfg(windows)]
        let clean = windows_directory(&expanded);
        #[cfg(not(windows))]
        let clean = expanded.is_absolute().then(|| expanded.normalize());
        let clean = clean.ok_or_else(|| Failure::invalid("path must be absolute (or ~/…), or give root and path"))?;
        #[cfg(windows)]
        let relative = |root: &str| path::windows_within(std::path::Path::new(&clean), root);
        #[cfg(not(windows))]
        let relative = |root: &str| clean.within(root).map(|path| path.trim_start_matches('/').to_owned());
        let roots = self.roots(owner)?;
        let (root, relative) = roots
            .iter()
            .filter(|root| scope.is_none_or(|allows| allows(&root.path)))
            .filter_map(|root| relative(&root.path).map(|path| (root, path)))
            .max_by_key(|(root, _)| root.path.len())
            .ok_or_else(|| match scope {
                Some(_) => Failure::http(403, "not inside a workspace allowed for this app"),
                None => Failure::http(404, "not inside any workspace the Finder lists"),
            })?;
        Ok(serde_json::json!({"root": root.path, "path": relative}))
    }

    fn open_path(&self, workspace: &FinderRoot, path: &str) -> Outcome<Value> {
        let resolved = WorkspaceFs::resolve(workspace, path, true)?;
        if resolved.relative.is_empty() {
            return Err(Failure::invalid("a folder cannot be opened in the browser"));
        }
        if resolved.relative.split('/').any(|part| part.starts_with('.')) {
            return Err(Failure::invalid("hidden files and folders are not opened in the browser"));
        }
        WorkspaceFs::raw_in(workspace, &resolved.relative)?;
        Ok(serde_json::json!({"root": workspace.path, "path": resolved.relative, "file": resolved.real}))
    }

    fn set_place(&self, root: &FinderRoot, path: Option<String>, file: Option<String>) -> Outcome<Place> {
        let place = Place { root: Some(root.path.clone()), path: path.unwrap_or_default(), file: file.filter(|f| !f.is_empty()) };
        *self.place.locked() = place.clone();
        place.save();
        Ok(place)
    }
}

fn copy_in(owner: Option<&str>, allowed: &[FinderRoot], at: &str, dir: &str, source: &str) -> Outcome<Value> {
    let to = allowed.iter().find(|root| root.path == at).ok_or_else(|| Failure::invalid("not a Runtime workspace"))?;
    let requested = copy_source::parse(source)?;
    let admitted = copy_source::admit(allowed, &requested, owner)?;
    let entry = WorkspaceFs::copy_into(to, dir, &admitted.name, admitted.file)?;
    if let Some(claim) = admitted.claim {
        claim.commit();
    }
    serde_json::to_value(entry).map_err(Failure::internal)
}

fn options_of<T: Default + serde::de::DeserializeOwned>(method: &str, options: Option<Value>) -> Outcome<T> {
    match options {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value).map_err(|error| Failure::invalid(format!("{method} options: {error}"))),
    }
}

#[derive(Clone)]
pub struct Workspace {
    shared: Arc<Shared>,
    roots: Option<Arc<[String]>>,
    owner: Option<Arc<str>>,
}

impl Workspace {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { shared: Arc::new(Shared::new()), roots: None, owner: None }
    }

    pub fn scoped(&self, roots: Option<Vec<String>>, owner: Option<&str>) -> Self {
        let owner = owner.filter(|owner| Grants::valid_owner(owner)).map(Into::into);
        Self { shared: Arc::clone(&self.shared), roots: roots.map(Into::into), owner }
    }

    fn allows(&self, root: &str) -> bool {
        let Some(roots) = &self.roots else { return true };
        roots.iter().any(|r| r == root) || self.owner.as_deref().is_some_and(|owner| self.shared.grants.of(owner).iter().any(|r| r == root))
    }

    pub fn admit(&self, path: &str) -> Outcome<String> {
        let roots: Vec<FinderRoot> = self.shared.roots(self.owner.as_deref())?.into_iter().filter(|root| self.allows(&root.path)).collect();
        admit::real_inside(&roots, path)
    }

    pub fn grant(&self, path: &str) -> std::result::Result<String, FsError> {
        let Some(owner) = self.owner.as_deref() else {
            return Err(Failure::invalid("folders are granted to an app").into());
        };
        Ok(self.shared.grants.add(owner, path)?)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn shared_fs(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    pub fn call(&self, call: FsCall) -> std::result::Result<FsReply, FsError> {
        let owner = self.owner.as_deref();
        if self.roots.is_some() {
            match call.scope() {
                Some(root) if self.allows(root) => {}
                None if matches!(call, FsCall::Roots | FsCall::Locate { .. } | FsCall::Revoke { .. }) => {}
                what => {
                    let what = what.unwrap_or("its workspaces");
                    return Err(Failure::http(403, format!("this app may not use the files of {what} (not in its manifest's capabilities)")).into());
                }
            }
        }
        if let FsCall::Roots = call {
            let roots: Outcome<Vec<FinderRoot>> = self.shared.roots(owner).map(|roots| roots.into_iter().filter(|root| self.allows(&root.path)).collect());
            return Ok(FsReply::Json(roots.json()?));
        }
        let allows = |root: &str| self.allows(root);
        let scope = self.roots.as_ref().map(|_| &allows as &dyn Fn(&str) -> bool);
        Ok(self.shared.call(call, owner, scope)?)
    }
}

#[napi]
pub struct Finder {
    shared: Arc<Shared>,
}

#[napi]
impl Finder {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { shared: Arc::new(Shared::new()) }
    }

    #[napi]
    pub async fn locate(&self, path: String) -> Result<Value> {
        let shared = Arc::clone(&self.shared);
        blocking(move || Ok(shared.locate(None, &path, None)?)).await
    }

    #[napi]
    pub async fn admit(&self, path: String, roots: Option<Vec<String>>, owner: Option<String>) -> Result<String> {
        blocking(move || Ok(Workspace::new().scoped(roots, owner.as_deref()).admit(&path)?)).await
    }
}

impl FsReply {
    pub const OCTETS: &str = "application/octet-stream";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_outside_the_manifest_is_refused_with_eacces() {
        let workspace = Workspace::new().scoped(Some(vec!["/allowed".into()]), Some("app"));
        let Err(error) = workspace.call(FsCall::List { root: "/elsewhere".into(), path: None, hidden: None }) else { panic!("not refused") };
        assert_eq!((error.status, error.code), (403, "EACCES"));
        assert_eq!(error.message, "this app may not use the files of /elsewhere (not in its manifest's capabilities)");
        let Err(error) = workspace.call(FsCall::State) else { panic!("not refused") };
        assert_eq!((error.status, error.code), (403, "EACCES"));
    }

    fn json(reply: std::result::Result<FsReply, FsError>) -> Value {
        match reply {
            Ok(FsReply::Json(value)) => value,
            Ok(_) => Value::String("not json".into()),
            Err(error) => serde_json::json!({"status": error.status, "code": error.code}),
        }
    }

    #[test]
    fn locate_returns_a_path_relative_to_an_allowed_root() {
        let base = std::env::temp_dir().join(format!("acde-locate-{}", std::process::id()));
        let root = base.join("Notes");
        let file = root.join("folder").join("entry.txt");
        let sibling = base.join("Notes Other").join("entry.txt");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        std::fs::write(&file, "inside").unwrap();
        std::fs::write(&sibling, "outside").unwrap();
        let all = Workspace { shared: Arc::new(Shared::with(Grants::new(None))), roots: None, owner: None };
        let scoped = all.scoped(Some(vec![]), Some("locate-probe"));
        let owner = all.scoped(None, Some("locate-probe"));
        let other = all.scoped(Some(vec![]), Some("other"));
        let root = scoped.grant(root.to_str().unwrap()).unwrap();
        let locate = |workspace: &Workspace, path: &str| json(workspace.call(FsCall::Locate { path: path.to_owned() }));
        let expected = serde_json::json!({"root": root, "path": "folder/entry.txt"});
        assert_eq!(locate(&owner, file.to_str().unwrap()), expected);
        assert_eq!(locate(&scoped, file.to_str().unwrap()), expected);
        assert_eq!(locate(&scoped, &format!("{root}/folder/entry.txt")), expected);
        assert_eq!(locate(&scoped, &root), serde_json::json!({"root": root, "path": ""}));
        assert_eq!(locate(&scoped, sibling.to_str().unwrap())["code"], "EACCES");
        assert_eq!(locate(&scoped, &format!("{root}/../Notes Other/entry.txt"))["code"], "EACCES");
        assert_eq!(locate(&other, file.to_str().unwrap())["code"], "EACCES");
        assert_eq!(locate(&owner, "relative/entry.txt")["code"], "EINVAL");
        _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn locate_matches_windows_roots_ignoring_case_and_separators() {
        let base = std::env::temp_dir().join(format!("acde-locate-case-{}", std::process::id()));
        let root = base.join("Desktop");
        let file = root.join("Folder").join("Entry.txt");
        let sibling = base.join("Desktop2").join("entry.txt");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        std::fs::write(&file, "inside").unwrap();
        std::fs::write(&sibling, "outside").unwrap();
        let all = Workspace { shared: Arc::new(Shared::with(Grants::new(None))), roots: None, owner: None };
        let scoped = all.scoped(Some(vec![]), Some("locate-case"));
        let root = scoped.grant(root.to_str().unwrap()).unwrap();
        let locate = |path: &str| json(scoped.call(FsCall::Locate { path: path.to_owned() }));
        let found = |path: &str| serde_json::json!({"root": root, "path": path});
        let file = file.to_str().unwrap();
        assert_eq!(locate(&file.to_lowercase()), found("folder/entry.txt"));
        assert_eq!(locate(&file.to_uppercase()), found("FOLDER/ENTRY.TXT"));
        assert_eq!(locate(&root.to_lowercase()), found(""));
        assert_eq!(locate(&format!("{}/Folder\\Entry.txt", root.replace('\\', "/").to_uppercase())), found("Folder/Entry.txt"));
        assert_eq!(locate(&sibling.to_str().unwrap().to_lowercase())["code"], "EACCES");
        assert_eq!(locate(&format!("{}2\\entry.txt", root.to_lowercase()))["code"], "EACCES");
        _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_hand_off_stays_inside_the_callers_roots() {
        let base = std::env::temp_dir().join(format!("acde-admit-{}", std::process::id()));
        let root = base.join("Root");
        let outside = base.join("Outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("in.pdf"), "in").unwrap();
        std::fs::write(outside.join("out.pdf"), "out").unwrap();
        let all = Workspace { shared: Arc::new(Shared::with(Grants::new(None))), roots: None, owner: None };
        let with = all.scoped(Some(vec![]), Some("admit-with"));
        with.grant(root.to_str().unwrap()).unwrap();
        let without = all.scoped(Some(vec![]), Some("admit-without"));
        let every_root = all.scoped(None, Some("admit-with"));
        let inside = root.join("in.pdf");
        let real = std::fs::canonicalize(&inside).unwrap();
        let expected = real.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
        assert_eq!(with.admit(inside.to_str().unwrap()).unwrap(), expected);
        assert!(every_root.admit(inside.to_str().unwrap()).is_ok());
        assert_eq!(without.admit(inside.to_str().unwrap()).unwrap_err().status, 403);
        assert_eq!(with.admit(outside.join("out.pdf").to_str().unwrap()).unwrap_err().status, 403);
        assert_eq!(with.admit(root.join("missing.pdf").to_str().unwrap()).unwrap_err().status, 404);
        #[cfg(windows)]
        {
            let link = root.join("Linked");
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside).output().unwrap();
            assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
            assert_eq!(with.admit(link.join("out.pdf").to_str().unwrap()).unwrap_err().status, 403);
            std::fs::remove_dir(&link).unwrap();
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            assert_eq!(with.admit(root.join("linked/out.pdf").to_str().unwrap()).unwrap_err().status, 403);
        }
        _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_granted_folder_is_a_root_of_its_app_only() {
        let base = std::env::temp_dir().join(format!("acde-granted-{}", std::process::id()));
        let picked = base.join("Notes");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::write(picked.join("a.md"), "# a").unwrap();
        let picked = picked.to_string_lossy().into_owned();
        let all = Workspace { shared: Arc::new(Shared::with(Grants::new(None))), roots: None, owner: None };
        let limited = all.scoped(Some(vec![]), Some("vault"));
        let other = all.scoped(None, Some("other"));
        let list = |workspace: &Workspace| json(workspace.call(FsCall::List { root: picked.clone(), path: None, hidden: None }));
        assert_eq!(list(&limited)["code"], "EACCES");
        assert_eq!(json(limited.call(FsCall::Roots)), serde_json::json!([]));
        assert_eq!(limited.grant(&picked).unwrap(), picked);
        assert_eq!(all.grant(&picked).unwrap_err().code, "EINVAL");
        let roots = json(limited.call(FsCall::Roots));
        assert_eq!(
            roots,
            serde_json::json!([{
                "path": picked, "label": "Notes", "source": "granted", "mode": "writable",
                "reason": null, "exists": true
            }])
        );
        assert_eq!(list(&limited)["entries"][0]["name"], "a.md");
        assert_eq!(list(&other)["code"], "EINVAL");
        assert!(json(other.call(FsCall::Roots)).as_array().unwrap().iter().all(|root| root["source"] != "granted"));
        assert_eq!(json(other.call(FsCall::Revoke { root: picked.clone() }))["code"], "ENOENT");
        assert!(matches!(limited.call(FsCall::Revoke { root: picked.clone() }), Ok(FsReply::Done)));
        assert_eq!(list(&limited)["code"], "EACCES");
        assert_eq!(json(all.call(FsCall::Revoke { root: picked.clone() }))["code"], "EINVAL");
        _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn copy_in_takes_sources_from_granted_folders_or_one_drop() {
        let base = std::env::temp_dir().join(format!("acde-copy-in-{}", std::process::id()));
        let vault = base.join("vault");
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(vault.join("docs")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(vault.join("inside.txt"), "inside").unwrap();
        let secret = elsewhere.join("secret.txt");
        std::fs::write(&secret, "outside").unwrap();
        let all = Workspace { shared: Arc::new(Shared::with(Grants::new(None))), roots: None, owner: None };
        let app = all.scoped(Some(vec![]), Some("copy-probe"));
        let root = app.grant(vault.to_str().unwrap()).unwrap();
        let copy = |source: &str| {
            let call = FsCall::CopyIn { root: root.clone(), dir: "docs".into(), source: source.into() };
            json(app.call(call))
        };
        let uri = url::Url::from_file_path(&secret).unwrap();
        assert_eq!(copy(secret.to_str().unwrap())["code"], "EPERM");
        assert_eq!(copy(uri.as_str())["code"], "EPERM");
        assert_eq!(copy(vault.join("inside.txt").to_str().unwrap())["name"], "inside.txt");
        assert_eq!(copy(vault.join("missing.txt").to_str().unwrap())["code"], "ENOENT");
        assert_eq!(copy(elsewhere.join("missing.txt").to_str().unwrap())["code"], "EPERM");
        #[cfg(windows)]
        {
            let vault = vault.to_str().unwrap();
            assert_eq!(copy(&format!("{}/MISSING.txt", vault.to_uppercase()))["code"], "ENOENT");
            assert_eq!(copy(&format!("{}\\missing.txt", vault.replace('\\', "/").to_lowercase()))["code"], "ENOENT");
            assert_eq!(copy(&format!("{}2\\missing.txt", vault.to_lowercase()))["code"], "EPERM");
        }
        acde_model::drop_grant::record(Some("copy-probe"), std::slice::from_ref(&secret));
        assert_eq!(copy(uri.as_str())["name"], "secret.txt");
        assert_eq!(copy(uri.as_str())["code"], "EPERM");
        _ = std::fs::remove_dir_all(base);
    }
}
