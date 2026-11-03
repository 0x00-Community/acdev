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

#[napi]
pub struct Finder {
    shared: Arc<Shared>,
}

#[napi]
impl Finder {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { shared: Arc::new(Shared { fs: WorkspaceFs::new(), place: Mutex::new(Place::load()) }) }
    }

    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Shared) -> Outcome<T> + Send + 'static,
    ) -> Result<T> {
        let shared = Arc::clone(&self.shared);
        blocking(move || work(&shared).map_err(Into::into)).await
    }

    #[napi]
    pub async fn state(&self) -> Result<Value> {
        self.run(|s| s.state().json()).await
    }
    #[napi]
    pub async fn roots(&self) -> Result<Value> {
        self.run(|s| s.fs.roots().json()).await
    }
    #[napi]
    pub async fn desktop(&self) -> Result<Value> {
        self.run(|s| {
            let root = s.fs.desktop()?;
            let listing = s.fs.list(&root, "", false)?;
            Ok(Desktop { root, entries: listing.entries, truncated: listing.truncated }).json()
        })
        .await
    }
    #[napi]
    pub async fn list(&self, root: String, path: Option<String>, hidden: Option<bool>) -> Result<Value> {
        self.run(move |s| s.fs.list(&root, path.as_deref().unwrap_or(""), hidden.unwrap_or(true)).json())
            .await
    }
    #[napi]
    pub async fn preview(&self, root: String, path: String) -> Result<Value> {
        self.run(move |s| s.fs.preview(&root, &path).json()).await
    }
    #[napi]
    pub async fn download(&self, root: String, path: String) -> Result<FileBytes> {
        let (name, data) = self.run(move |s| s.fs.raw(&root, &path)).await?;
        Ok(FileBytes { name, content_type: "application/octet-stream".to_owned(), data: data.into() })
    }
    #[napi]
    pub async fn locate(&self, path: String) -> Result<Value> {
        self.run(move |s| {
            let home = std::env::var("HOME").unwrap_or_default();
            let expanded = match path.strip_prefix('~') {
                Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
                _ => path.clone(),
            };
            if !expanded.is_absolute() {
                return Err(Failure::invalid("path must be absolute (or ~/…), or give root and path"));
            }
            let clean = expanded.normalize();
            let inside = |root: &str| clean == root || clean.starts_with(&if root.ends_with('/') { root.to_owned() } else { format!("{root}/") });
            let mut roots: Vec<FinderRoot> =
                s.fs.roots()?.into_iter().filter(|r| inside(&r.path)).collect();
            roots.sort_by_key(|r| std::cmp::Reverse(r.path.len()));
            let root = roots.into_iter().next().ok_or_else(|| Failure::http(404, "not inside any workspace the Finder lists"))?;
            let relative = clean.strip_prefix(root.path.as_str()).unwrap_or("").trim_start_matches('/').to_owned();
            Ok(serde_json::json!({"root": root.path, "path": relative}))
        })
        .await
    }

    #[napi]
    pub async fn open_path(&self, root: String, path: String) -> Result<Value> {
        self.run(move |s| {
            let workspace = s.fs.root(&root)?;
            let resolved = WorkspaceFs::resolve(&workspace, &path, true)?;
            if resolved.relative.is_empty() {
                return Err(Failure::invalid("a folder cannot be opened in the browser"));
            }
            if resolved.relative.split('/').any(|part| part.starts_with('.')) {
                return Err(Failure::invalid("hidden files and folders are not opened in the browser"));
            }
            WorkspaceFs::raw_in(&workspace, &resolved.relative)?;
            Ok(serde_json::json!({"root": workspace.path, "path": resolved.relative, "file": resolved.real}))
        })
        .await
    }

    #[napi]
    pub async fn place(&self, root: String, path: Option<String>, file: Option<String>) -> Result<Value> {
        self.run(move |s| {
            s.fs.root(&root)?;
            let place = Place { root: Some(root), path: path.unwrap_or_default(), file: file.filter(|f| !f.is_empty()) };
            *s.place.locked() = place.clone();
            place.save();
            Ok(place).json()
        })
        .await
    }
    #[napi]
    pub async fn mkdir(&self, root: String, path: String) -> Result<Value> {
        self.run(move |s| s.fs.mkdir(&root, &path).json()).await
    }
    #[napi]
    pub async fn write(
        &self,
        root: String,
        path: String,
        content: Option<String>,
        expected_modified_ms: String,
    ) -> Result<Value> {
        self.run(move |s| s.fs.write(&root, &path, content.as_deref().unwrap_or(""), &expected_modified_ms).json())
            .await
    }
    #[napi]
    pub async fn copy_in(&self, root: String, dir: String, source: String) -> Result<Value> {
        self.run(move |s| s.fs.copy_in(&root, &dir, &source).json()).await
    }
    #[napi]
    pub async fn rename(&self, root: String, from: String, to: String) -> Result<Value> {
        self.run(move |s| s.fs.rename(&root, &from, &to).json()).await
    }
    #[napi(js_name = "delete")]
    pub async fn remove(&self, root: String, path: String) -> Result<Value> {
        self.run(move |s| {
            s.fs.remove(&root, &path)?;
            Ok(serde_json::json!({"status": "deleted", "path": path})).json()
        })
        .await
    }
}

impl Finder {
    pub(crate) fn shared(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }
}
