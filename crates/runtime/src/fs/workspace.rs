use super::path::NodePath;
use crate::failure::{Failure, Outcome};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::Locale;
use rustix::fs::OFlags;
use serde::Serialize;
use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt},
    path::Path,
};

const MAX_ENTRIES: usize = 5000;
const MAX_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_RAW_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 384 * 1024;
const IMAGES: [&str; 6] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootMode {
    Writable,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootSource {
    Desktop,
    Downloads,
    Default,
}

#[derive(Clone, Serialize)]
pub struct FinderRoot {
    pub path: String,
    pub label: String,
    pub source: RootSource,
    pub mode: RootMode,
    pub reason: Option<String>,
    pub exists: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinderEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    Text,
    Image,
    Binary,
    TooLarge,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinderPreview {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: i64,
    pub kind: PreviewKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Serialize)]
pub struct Listing {
    pub root: FinderRoot,
    pub path: String,
    pub entries: Vec<FinderEntry>,
    pub truncated: bool,
}

pub struct Resolved {
    pub absolute: String,
    pub real: String,
    pub relative: String,
}

pub trait ModifiedMs {
    fn modified_ms(&self) -> i64;
}
impl ModifiedMs for Metadata {
    fn modified_ms(&self) -> i64 {
        (self.mtime() as f64 * 1e3 + self.mtime_nsec() as f64 / 1e6).floor() as i64
    }
}

impl FinderEntry {
    pub fn read(absolute: &str, name: &str) -> Outcome<Self> {
        let info = fs::symlink_metadata(absolute)?;
        let kind = info.file_type().into();
        Ok(Self {
            name: name.to_owned(),
            kind,
            size: info.len(),
            modified_ms: info.modified_ms(),
            target: (kind == EntryKind::Symlink).then(|| {
                fs::read_link(absolute).map_or_else(|_| "?".into(), |t| t.to_string_lossy().into_owned())
            }),
        })
    }
}

impl From<fs::FileType> for EntryKind {
    fn from(kind: fs::FileType) -> Self {
        match () {
            _ if kind.is_dir() => Self::Directory,
            _ if kind.is_file() => Self::File,
            _ if kind.is_symlink() => Self::Symlink,
            _ => Self::Other,
        }
    }
}

pub struct WorkspaceFs {
    collator: CollatorBorrowed<'static>,
    home: String,
}

impl WorkspaceFs {
    pub fn new() -> Self {
        Self { collator: Self::collator(), home: std::env::var("HOME").unwrap_or_else(|_| "/".into()) }
    }

    fn collator() -> CollatorBorrowed<'static> {
        let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .into_iter()
            .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
            .and_then(|value| {
                let tag = value.split(['.', '@']).next().unwrap_or("").replace('_', "-");
                (tag != "C" && tag != "POSIX").then(|| tag.parse::<Locale>().ok()).flatten()
            })
            .unwrap_or(Locale::UNKNOWN);
        Collator::try_new((&locale).into(), CollatorOptions::default())
            .or_else(|_| Collator::try_new(Default::default(), CollatorOptions::default()))
            .expect("compiled root collation data")
    }

    fn user_dir(&self, name: &str, fallback: &str) -> String {
        let home = self.home.as_str();
        let key = format!("XDG_{name}_DIR");
        let dir = std::env::var(&key).ok().filter(|dir| !dir.is_empty()).or_else(|| {
            let text = fs::read(home.join(".config").join("user-dirs.dirs")).ok()?;
            let prefix = format!("{key}=\"");
            String::from_utf8_lossy(&text).split(['\n', '\r']).find_map(|line| {
                let rest = line.strip_prefix(prefix.as_str())?;
                let (value, _) = rest.split_once('"')?;
                (!value.is_empty()).then(|| value.to_owned())
            })
        });
        let dir = dir.unwrap_or_else(|| format!("$HOME/{fallback}"));
        let path = match dir.strip_prefix("$HOME") {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
            _ => dir,
        };
        match path.is_absolute() && path.normalize() != home {
            true => path.normalize(),
            false => home.join(fallback),
        }
    }

    pub fn desktop(&self) -> Outcome<String> {
        let desktop = self.user_dir("DESKTOP", "Desktop");
        if !Path::new(&desktop).exists() {
            DirBuilder::new().recursive(true).mode(0o755).create(&desktop)?;
        }
        Ok(desktop)
    }

    pub fn downloads(&self) -> Option<String> {
        Some(self.user_dir("DOWNLOAD", "Downloads")).filter(|dir| Path::new(dir).exists())
    }

    pub fn roots(&self) -> Outcome<Vec<FinderRoot>> {
        let fallback = self.home.join("agentos-work");
        let work = Some(fallback).filter(|path| Path::new(path).exists());
        let desktop = self.desktop()?;
        let root = |path: String, label: &str, source: RootSource| FinderRoot {
            path,
            label: label.into(),
            source,
            mode: RootMode::Writable,
            reason: None,
            exists: true,
        };
        let downloads = self.downloads().filter(|dir| *dir != desktop && work.as_ref() != Some(dir));
        let down = downloads.map(|path| root(path, "下载", RootSource::Downloads));
        let work = work.filter(|path| *path != desktop).map(|path| root(path, "~/agentos-work", RootSource::Default));
        Ok([root(desktop, "桌面", RootSource::Desktop)].into_iter().chain(down).chain(work).collect())
    }

    pub fn root(&self, path: &str) -> Outcome<FinderRoot> {
        self.roots()?.into_iter().find(|item| item.path == path).ok_or_else(|| Failure::invalid("not a Runtime workspace"))
    }

    fn realpath(path: &str) -> std::io::Result<String> {
        fs::canonicalize(path).map(|real| real.to_string_lossy().into_owned())
    }

    pub fn resolve(root: &FinderRoot, relative: &str, must_exist: bool) -> Outcome<Resolved> {
        if relative.contains('\0') || relative.is_absolute() {
            return Err(Failure::invalid("path must be relative to the workspace"));
        }
        let normal = if relative.is_empty() { "." } else { relative }.normalize();
        let clean = normal.trim_end_matches('/');
        let clean = if clean.is_empty() { "." } else { clean };
        if clean == ".." || clean.starts_with("../") {
            return Err(Failure::invalid("path escapes the workspace"));
        }
        let absolute = if clean == "." { root.path.clone() } else { root.path.join(clean) };
        let real_root = Self::realpath(&root.path)?;
        let inside = |path: &str| {
            path == real_root || path.strip_prefix(real_root.as_str()).is_some_and(|rest| rest.starts_with('/'))
        };
        let mut real = absolute.clone();
        if must_exist {
            real = Self::realpath(&absolute).map_err(|_| Failure::http(404, "no such file or directory"))?;
            if !inside(&real) {
                return Err(Failure::invalid("path leaves the workspace through a symlink"));
            }
        } else {
            if clean == "." {
                return Err(Failure::invalid("the workspace root itself cannot be replaced"));
            }
            if !inside(&Self::realpath(absolute.dirname()).unwrap_or_default()) {
                return Err(Failure::invalid("parent directory is missing or outside the workspace"));
            }
        }
        let relative = if clean == "." { String::new() } else { clean.to_owned() };
        Ok(Resolved { absolute, real, relative })
    }

    pub fn list(&self, root_path: &str, relative: &str, hidden: bool) -> Outcome<Listing> {
        self.list_in(self.root(root_path)?, relative, hidden)
    }

    pub fn list_in(&self, root: FinderRoot, relative: &str, hidden: bool) -> Outcome<Listing> {
        let Resolved { absolute, real, relative } = Self::resolve(&root, relative, true)?;
        if !fs::metadata(&real)?.is_dir() {
            return Err(Failure::invalid("not a directory"));
        }
        let mut names: Vec<_> = fs::read_dir(&real)?
            .map(|entry| entry.map(|e| e.file_name()))
            .collect::<std::io::Result<_>>()?;
        names.sort();
        let names: Vec<String> = names
            .iter()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| hidden || !name.starts_with('.'))
            .collect();
        let mut entries = names
            .iter()
            .take(MAX_ENTRIES)
            .map(|name| FinderEntry::read(&absolute.join(name), name))
            .collect::<Outcome<Vec<_>>>()?;
        entries.sort_by(|a, b| {
            let dir = |e: &FinderEntry| e.kind == EntryKind::Directory;
            dir(b).cmp(&dir(a)).then_with(|| self.collator.compare(&a.name, &b.name))
        });
        Ok(Listing { root, path: relative, entries, truncated: names.len() > MAX_ENTRIES })
    }

    fn open_nofollow(real: &str) -> std::io::Result<File> {
        OpenOptions::new().read(true).custom_flags(OFlags::NOFOLLOW.bits() as i32).open(real)
    }

    pub fn preview(&self, root_path: &str, relative: &str) -> Outcome<FinderPreview> {
        Self::preview_in(&self.root(root_path)?, relative)
    }

    pub fn preview_in(root: &FinderRoot, relative: &str) -> Outcome<FinderPreview> {
        let Resolved { absolute, real, relative } = Self::resolve(root, relative, true)?;
        let info = fs::metadata(&real)?;
        if !info.is_file() {
            return Err(Failure::invalid("not a regular file"));
        }
        let size = info.len();
        let preview = |kind, content, truncated| FinderPreview {
            path: relative.clone(),
            name: absolute.basename().to_owned(),
            size,
            modified_ms: info.modified_ms(),
            kind,
            content,
            truncated,
        };
        if IMAGES.contains(&absolute.extname().to_lowercase().as_str()) {
            let kind = if size <= MAX_RAW_BYTES { PreviewKind::Image } else { PreviewKind::TooLarge };
            return Ok(preview(kind, None, None));
        }
        let file = Self::open_nofollow(&real)?;
        let mut buffer = vec![0; size.min(MAX_PREVIEW_BYTES) as usize];
        let read = file.read_at(&mut buffer, 0)?;
        buffer.truncate(read);
        if buffer.contains(&0) {
            return Ok(preview(PreviewKind::Binary, None, None));
        }
        let content = match String::from_utf8(buffer) {
            Ok(text) => text,
            Err(_) if size <= MAX_PREVIEW_BYTES => return Ok(preview(PreviewKind::Binary, None, None)),
            Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
        };
        let content = content.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(content);
        Ok(preview(PreviewKind::Text, Some(content), Some(size > MAX_PREVIEW_BYTES)))
    }

    pub fn raw(&self, root_path: &str, relative: &str) -> Outcome<(String, Vec<u8>)> {
        Self::raw_in(&self.root(root_path)?, relative)
    }

    pub fn raw_in(root: &FinderRoot, relative: &str) -> Outcome<(String, Vec<u8>)> {
        let Resolved { absolute, real, .. } = Self::resolve(root, relative, true)?;
        let info = fs::metadata(&real)?;
        if !info.is_file() {
            return Err(Failure::invalid("not a regular file"));
        }
        if info.len() > MAX_RAW_BYTES {
            return Err(Failure::http(413, "file exceeds 64 MiB"));
        }
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut Self::open_nofollow(&real)?, &mut data)?;
        Ok((absolute.basename().to_owned(), data))
    }

    pub fn mkdir(&self, root_path: &str, relative: &str) -> Outcome<FinderEntry> {
        let Resolved { absolute, .. } = self.resolve_at(root_path, relative, false)?;
        DirBuilder::new().mode(0o755).create(&absolute)?;
        FinderEntry::read(&absolute, absolute.basename())
    }

    pub fn write(&self, root_path: &str, relative: &str, content: &str, expected: &str) -> Outcome<FinderEntry> {
        if content.len() > MAX_WRITE_BYTES {
            return Err(Failure::http(413, "content exceeds 384 KiB"));
        }
        let Resolved { absolute, .. } = self.resolve_at(root_path, relative, false)?;
        let current = fs::symlink_metadata(&absolute).ok();
        match &current {
            Some(_) if expected == "new" => return Err(Failure::exists("file already exists")),
            None if expected == "new" => {}
            Some(info) if info.is_file() => {
                if info.modified_ms().to_string() != expected {
                    return Err(Failure::conflict("file changed since it was opened; reload before saving"));
                }
            }
            _ => return Err(Failure::conflict("file no longer exists or is not a regular file")),
        }
        let mut options = OpenOptions::new();
        options.write(true).custom_flags(OFlags::NOFOLLOW.bits() as i32).mode(0o644);
        match current {
            Some(_) => options.truncate(true),
            None => options.create_new(true),
        };
        let mut file = options.open(&absolute)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        FinderEntry::read(&absolute, absolute.basename())
    }

    pub fn numbered(name: &str, n: u32) -> String {
        if n <= 1 {
            return name.to_owned();
        }
        let ext = name.extname();
        format!("{} {n}{ext}", &name[..name.len() - ext.len()])
    }

    pub fn copy_in(&self, root_path: &str, dir: &str, source: &str) -> Outcome<FinderEntry> {
        let source = match source.strip_prefix("file://") {
            Some(rest) => url::Url::parse(&format!("file://{rest}")).ok().and_then(|u| u.to_file_path().ok()).ok_or_else(|| Failure::invalid("not a file:// URI of this machine"))?,
            None => std::path::PathBuf::from(source),
        };
        if !source.is_absolute() {
            return Err(Failure::invalid("source must be an absolute path or a file:// URI"));
        }
        let info = fs::metadata(&source).map_err(|_| Failure::http(404, "source file not found"))?;
        if !info.is_file() {
            return Err(Failure::invalid("only regular files can be copied in"));
        }
        let Resolved { absolute, real, .. } = self.resolve_at(root_path, dir, true)?;
        if !fs::metadata(&real)?.is_dir() {
            return Err(Failure::invalid("not a directory"));
        }
        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| Failure::invalid("source has no file name"))?;
        let mut reader = File::open(&source)?;
        for n in 1..10_000 {
            let candidate = Self::numbered(&name, n);
            let target = absolute.join(&candidate);
            let created = OpenOptions::new().write(true).create_new(true).custom_flags(OFlags::NOFOLLOW.bits() as i32).mode(0o644).open(&target);
            let mut file = match created {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            };
            if let Err(error) = std::io::copy(&mut reader, &mut file).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&target);
                return Err(error.into());
            }
            return FinderEntry::read(&target, &candidate);
        }
        Err(Failure::exists("no free name for the copy"))
    }

    pub fn rename(&self, root_path: &str, from: &str, to: &str) -> Outcome<FinderEntry> {
        let root = self.root(root_path)?;
        let source = Self::resolve(&root, from, true)?;
        let target = Self::resolve(&root, to, false)?;
        if source.relative.is_empty() {
            return Err(Failure::invalid("the workspace root cannot be renamed"));
        }
        if fs::symlink_metadata(&target.absolute).is_ok() {
            return Err(Failure::exists("target already exists"));
        }
        fs::rename(&source.absolute, &target.absolute)?;
        FinderEntry::read(&target.absolute, target.absolute.basename())
    }

    pub fn remove(&self, root_path: &str, relative: &str) -> Outcome<()> {
        let Resolved { absolute, relative, .. } = self.resolve_at(root_path, relative, false)?;
        if relative.is_empty() {
            return Err(Failure::invalid("the workspace root cannot be deleted"));
        }
        let info = fs::symlink_metadata(&absolute).map_err(|_| Failure::http(404, "no such file or directory"))?;
        match info.is_dir() {
            true => fs::remove_dir(&absolute)?,
            false => fs::remove_file(&absolute)?,
        }
        Ok(())
    }

    fn resolve_at(&self, root_path: &str, relative: &str, must_exist: bool) -> Outcome<Resolved> {
        Self::resolve(&self.root(root_path)?, relative, must_exist)
    }
}
