pub(crate) mod path;
pub(crate) mod workspace;

use path::NodePath;
use workspace::{FinderEntry, FinderPreview, FinderRoot, WorkspaceFs};

use crate::blocking;
use crate::failure::{Failure, Outcome};
use crate::sync::Locked;
use napi::bindgen_prelude::Buffer;
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
        let tmp = file.with_extension("json.tmp");
        let written = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| {
            std::fs::write(&tmp, serde_json::to_vec(self).unwrap_or_default())?;
            std::fs::rename(&tmp, &file)
        });
        if let Err(error) = written {
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
}

impl Shared {
    fn place(&self) -> Place {
        self.place.locked().clone()
    }

    fn state(&self) -> Outcome<State> {
        let (fs, place) = (&self.fs, self.place());
        let roots = fs.roots()?;
        let wanted = place.root.as_deref();
        let root = roots
            .iter()
            .find(|item| Some(item.path.as_str()) == wanted)
            .or_else(|| roots.first())
            .cloned();
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

#[napi(object)]
pub struct FileBytes {
    pub name: String,
    pub content_type: String,
    pub data: Buffer,
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
    Mkdir { root: String, path: String },
    Write { root: String, path: String, content: Option<String>, expected_modified_ms: String },
    CopyIn { root: String, dir: String, source: String },
    Rename { root: String, from: String, to: String },
    Delete { root: String, path: String },
}

pub enum FsReply {
    Json(Value),
    File { name: String, data: Vec<u8> },
}

pub enum FsError {
    Refused(String),
    Failed(String),
}

impl FsCall {
    fn scope(&self) -> Option<&str> {
        match self {
            Self::State | Self::Roots | Self::Desktop => None,
            Self::Locate { path } => Some(path),
            Self::List { root, .. }
            | Self::Preview { root, .. }
            | Self::Download { root, .. }
            | Self::OpenPath { root, .. }
            | Self::Place { root, .. }
            | Self::Mkdir { root, .. }
            | Self::Write { root, .. }
            | Self::CopyIn { root, .. }
            | Self::Rename { root, .. }
            | Self::Delete { root, .. } => Some(root),
        }
    }
}

impl Shared {
    fn new() -> Self {
        Self { fs: WorkspaceFs::new(), place: Mutex::new(Place::load()) }
    }

    fn call(&self, call: FsCall) -> Outcome<FsReply> {
        let json = |value: Outcome<Value>| value.map(FsReply::Json);
        match call {
            FsCall::State => json(self.state().json()),
            FsCall::Roots => json(self.fs.roots().json()),
            FsCall::Desktop => json(self.desktop().json()),
            FsCall::List { root, path, hidden } => json(self.fs.list(&root, path.as_deref().unwrap_or(""), hidden.unwrap_or(true)).json()),
            FsCall::Preview { root, path } => json(self.fs.preview(&root, &path).json()),
            FsCall::Download { root, path } => self.fs.raw(&root, &path).map(|(name, data)| FsReply::File { name, data }),
            FsCall::Locate { path } => json(self.locate(&path)),
            FsCall::OpenPath { root, path } => json(self.open_path(&root, &path)),
            FsCall::Place { root, path, file } => json(self.set_place(root, path, file).json()),
            FsCall::Mkdir { root, path } => json(self.fs.mkdir(&root, &path).json()),
            FsCall::Write { root, path, content, expected_modified_ms } => json(self.fs.write(&root, &path, content.as_deref().unwrap_or(""), &expected_modified_ms).json()),
            FsCall::CopyIn { root, dir, source } => json(self.fs.copy_in(&root, &dir, &source).json()),
            FsCall::Rename { root, from, to } => json(self.fs.rename(&root, &from, &to).json()),
            FsCall::Delete { root, path } => {
                self.fs.remove(&root, &path)?;
                json(Ok(serde_json::json!({"status": "deleted", "path": path})))
            }
        }
    }

    fn desktop(&self) -> Outcome<Desktop> {
        let root = self.fs.desktop()?;
        let listing = self.fs.list(&root, "", false)?;
        Ok(Desktop { root, entries: listing.entries, truncated: listing.truncated })
    }

    fn locate(&self, path: &str) -> Outcome<Value> {
        let home = std::env::var("HOME").unwrap_or_default();
        let expanded = match path.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
            _ => path.to_owned(),
        };
        if !expanded.is_absolute() {
            return Err(Failure::invalid("path must be absolute (or ~/…), or give root and path"));
        }
        let clean = expanded.normalize();
        let inside = |root: &str| clean == root || clean.starts_with(&if root.ends_with('/') { root.to_owned() } else { format!("{root}/") });
        let mut roots: Vec<FinderRoot> = self.fs.roots()?.into_iter().filter(|r| inside(&r.path)).collect();
        roots.sort_by_key(|r| std::cmp::Reverse(r.path.len()));
        let root = roots.into_iter().next().ok_or_else(|| Failure::http(404, "not inside any workspace the Finder lists"))?;
        let relative = clean.strip_prefix(root.path.as_str()).unwrap_or("").trim_start_matches('/').to_owned();
        Ok(serde_json::json!({"root": root.path, "path": relative}))
    }

    fn open_path(&self, root: &str, path: &str) -> Outcome<Value> {
        let workspace = self.fs.root(root)?;
        let resolved = WorkspaceFs::resolve(&workspace, path, true)?;
        if resolved.relative.is_empty() {
            return Err(Failure::invalid("a folder cannot be opened in the browser"));
        }
        if resolved.relative.split('/').any(|part| part.starts_with('.')) {
            return Err(Failure::invalid("hidden files and folders are not opened in the browser"));
        }
        WorkspaceFs::raw_in(&workspace, &resolved.relative)?;
        Ok(serde_json::json!({"root": workspace.path, "path": resolved.relative, "file": resolved.real}))
    }

    fn set_place(&self, root: String, path: Option<String>, file: Option<String>) -> Outcome<Place> {
        self.fs.root(&root)?;
        let place = Place { root: Some(root), path: path.unwrap_or_default(), file: file.filter(|f| !f.is_empty()) };
        *self.place.locked() = place.clone();
        place.save();
        Ok(place)
    }
}

#[derive(Clone)]
pub struct Workspace {
    shared: Arc<Shared>,
    roots: Option<Arc<[String]>>,
}

impl Workspace {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { shared: Arc::new(Shared::new()), roots: None }
    }

    pub fn scoped(&self, roots: Option<Vec<String>>) -> Self {
        Self { shared: Arc::clone(&self.shared), roots: roots.map(Into::into) }
    }

    pub(crate) fn shared_fs(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    pub fn call(&self, call: FsCall) -> std::result::Result<FsReply, FsError> {
        if let Some(roots) = &self.roots {
            match call.scope() {
                Some(root) if roots.iter().any(|r| r == root) => {}
                what => return Err(FsError::Refused(format!("the files of {}", what.unwrap_or("its workspaces")))),
            }
        }
        self.shared.call(call).map_err(|failure| FsError::Failed(serde_json::to_string(&failure).unwrap_or(failure.message)))
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

    async fn run(&self, call: FsCall) -> Result<FsReply> {
        let shared = Arc::clone(&self.shared);
        blocking(move || shared.call(call).map_err(Into::into)).await
    }

    async fn json(&self, call: FsCall) -> Result<Value> {
        match self.run(call).await? {
            FsReply::Json(value) => Ok(value),
            FsReply::File { .. } => Err(Failure::internal("a file where JSON was expected").into()),
        }
    }

    #[napi]
    pub async fn state(&self) -> Result<Value> {
        self.json(FsCall::State).await
    }
    #[napi]
    pub async fn roots(&self) -> Result<Value> {
        self.json(FsCall::Roots).await
    }
    #[napi]
    pub async fn desktop(&self) -> Result<Value> {
        self.json(FsCall::Desktop).await
    }
    #[napi]
    pub async fn list(&self, root: String, path: Option<String>, hidden: Option<bool>) -> Result<Value> {
        self.json(FsCall::List { root, path, hidden }).await
    }
    #[napi]
    pub async fn preview(&self, root: String, path: String) -> Result<Value> {
        self.json(FsCall::Preview { root, path }).await
    }
    #[napi]
    pub async fn download(&self, root: String, path: String) -> Result<FileBytes> {
        match self.run(FsCall::Download { root, path }).await? {
            FsReply::File { name, data } => Ok(FileBytes { name, content_type: FsReply::OCTETS.to_owned(), data: data.into() }),
            FsReply::Json(_) => Err(Failure::internal("JSON where a file was expected").into()),
        }
    }
    #[napi]
    pub async fn locate(&self, path: String) -> Result<Value> {
        self.json(FsCall::Locate { path }).await
    }
    #[napi]
    pub async fn open_path(&self, root: String, path: String) -> Result<Value> {
        self.json(FsCall::OpenPath { root, path }).await
    }
    #[napi]
    pub async fn place(&self, root: String, path: Option<String>, file: Option<String>) -> Result<Value> {
        self.json(FsCall::Place { root, path, file }).await
    }
    #[napi]
    pub async fn mkdir(&self, root: String, path: String) -> Result<Value> {
        self.json(FsCall::Mkdir { root, path }).await
    }
    #[napi]
    pub async fn write(&self, root: String, path: String, content: Option<String>, expected_modified_ms: String) -> Result<Value> {
        self.json(FsCall::Write { root, path, content, expected_modified_ms }).await
    }
    #[napi]
    pub async fn copy_in(&self, root: String, dir: String, source: String) -> Result<Value> {
        self.json(FsCall::CopyIn { root, dir, source }).await
    }
    #[napi]
    pub async fn rename(&self, root: String, from: String, to: String) -> Result<Value> {
        self.json(FsCall::Rename { root, from, to }).await
    }
    #[napi(js_name = "delete")]
    pub async fn remove(&self, root: String, path: String) -> Result<Value> {
        self.json(FsCall::Delete { root, path }).await
    }
}

impl FsReply {
    pub const OCTETS: &str = "application/octet-stream";
}
