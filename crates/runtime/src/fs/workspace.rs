use super::path::NodePath;
use crate::failure::{Errno, Failure, Outcome};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::Locale;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::Path,
    time::UNIX_EPOCH,
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
    Unavailable,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootSource {
    Desktop,
    Downloads,
    Default,
    Granted,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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

#[derive(Serialize)]
pub struct Stat {
    #[serde(flatten)]
    pub entry: FinderEntry,
    pub path: String,
}

pub struct Contents {
    pub data: Vec<u8>,
    pub modified_ms: i64,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Create {
    #[default]
    Always,
    New,
    Never,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOptions {
    #[serde(default)]
    pub create: Create,
    pub if_modified_ms: Option<f64>,
    #[serde(default)]
    pub mkdirs: bool,
}

#[derive(Default, Deserialize)]
pub struct MkdirOptions {
    #[serde(default)]
    pub recursive: bool,
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
        self.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |since| since.as_millis() as i64)
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
            target: (kind == EntryKind::Symlink).then(|| fs::read_link(absolute).map_or_else(|_| "?".into(), |t| t.to_string_lossy().into_owned())),
        })
    }
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
            Self::Symlink => "symlink",
            Self::Other => "other",
        }
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
        Self { collator: Self::collator(), home: std::env::home_dir().map_or_else(|| "/".into(), |h| h.to_string_lossy().into_owned()) }
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
            DirBuilder::new().recursive(true).create(&desktop)?;
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

    pub fn granted(path: &str) -> FinderRoot {
        let exists = Path::new(path).is_dir();
        let label = match path.basename() {
            "" => path,
            name => name,
        };
        FinderRoot {
            path: path.to_owned(),
            label: label.to_owned(),
            source: RootSource::Granted,
            mode: if exists { RootMode::Writable } else { RootMode::Unavailable },
            reason: (!exists).then(|| "the folder no longer exists".to_owned()),
            exists,
        }
    }

    pub fn root(&self, path: &str) -> Outcome<FinderRoot> {
        self.roots()?.into_iter().find(|item| item.path == path).ok_or_else(|| Failure::invalid("not a Runtime workspace"))
    }

    fn realpath(path: &str) -> std::io::Result<String> {
        fs::canonicalize(path).map(|real| real.to_string_lossy().into_owned())
    }

    fn clean(relative: &str) -> Outcome<String> {
        if relative.contains('\0') || relative.is_absolute() {
            return Err(Failure::invalid("path must be relative to the workspace"));
        }
        let normal = if relative.is_empty() { "." } else { relative }.normalize();
        let clean = normal.trim_end_matches('/');
        let clean = if clean.is_empty() { "." } else { clean };
        if clean == ".." || clean.starts_with("../") {
            return Err(Failure::invalid("path escapes the workspace"));
        }
        Ok(clean.to_owned())
    }

    fn inside(real_root: &str, path: &str) -> bool {
        path == real_root || real_root == "/" || path.strip_prefix(real_root).is_some_and(|rest| rest.starts_with('/'))
    }

    pub fn resolve(root: &FinderRoot, relative: &str, must_exist: bool) -> Outcome<Resolved> {
        let clean = Self::clean(relative)?;
        let clean = clean.as_str();
        let absolute = if clean == "." { root.path.clone() } else { root.path.join(clean) };
        let real_root = Self::realpath(&root.path)?;
        let inside = |path: &str| Self::inside(&real_root, path);
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

    pub fn list_in(&self, root: FinderRoot, relative: &str, hidden: bool) -> Outcome<Listing> {
        let Resolved { absolute, real, relative } = Self::resolve(&root, relative, true)?;
        if !fs::metadata(&real)?.is_dir() {
            return Err(Failure::invalid("not a directory"));
        }
        let mut names: Vec<String> = fs::read_dir(&real)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| hidden || !Self::is_hidden(entry))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut entries = names.iter().take(MAX_ENTRIES).map(|name| FinderEntry::read(&absolute.join(name), name)).collect::<Outcome<Vec<_>>>()?;
        entries.sort_by(|a, b| {
            let dir = |e: &FinderEntry| e.kind == EntryKind::Directory;
            dir(b).cmp(&dir(a)).then_with(|| self.collator.compare(&a.name, &b.name))
        });
        Ok(Listing { root, path: relative, entries, truncated: names.len() > MAX_ENTRIES })
    }

    fn is_hidden(entry: &fs::DirEntry) -> bool {
        if entry.file_name().to_string_lossy().starts_with('.') {
            return true;
        }
        cfg_select! {
            windows => {
                use std::os::windows::fs::MetadataExt;
                use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM};
                entry.metadata().is_ok_and(|m| m.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0)
            }
            _ => false,
        }
    }

    fn open_nofollow(real: &str) -> std::io::Result<File> {
        Self::no_follow(OpenOptions::new().read(true), real, false)
    }

    fn no_follow(options: &mut OpenOptions, path: impl AsRef<Path>, nonblock: bool) -> std::io::Result<File> {
        cfg_select! {
            unix => {
                use rustix::fs::OFlags;
                use std::os::unix::fs::OpenOptionsExt;
                let flags = if nonblock { OFlags::NOFOLLOW | OFlags::NONBLOCK } else { OFlags::NOFOLLOW };
                options.custom_flags(flags.bits() as i32).mode(0o644).open(path)
            }
            windows => {
                use std::os::windows::fs::OpenOptionsExt;
                _ = nonblock;
                let file = options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
                if file.metadata()?.file_type().is_symlink() {
                    return Err(std::io::Error::other("refusing to follow a symlink"));
                }
                Ok(file)
            }
        }
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
        let mut file = Self::open_nofollow(&real)?;
        let mut buffer = vec![0; size.min(MAX_PREVIEW_BYTES) as usize];
        let read = file.read(&mut buffer)?;
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

    pub fn raw_in(root: &FinderRoot, relative: &str) -> Outcome<(String, Vec<u8>)> {
        let (absolute, contents) = Self::contents(root, relative)?;
        Ok((absolute.basename().to_owned(), contents.data))
    }

    fn contents(root: &FinderRoot, relative: &str) -> Outcome<(String, Contents)> {
        let Resolved { absolute, real, .. } = Self::resolve(root, relative, true)?;
        if !fs::metadata(&real)?.is_file() {
            return Err(Failure::invalid("not a regular file"));
        }
        let file = Self::no_follow(OpenOptions::new().read(true), &real, true)?;
        let info = file.metadata()?;
        if !info.is_file() {
            return Err(Failure::invalid("not a regular file"));
        }
        let too_large = || Failure::http(413, "file exceeds 64 MiB");
        if info.len() > MAX_RAW_BYTES {
            return Err(too_large());
        }
        let mut data = Vec::with_capacity(info.len() as usize);
        file.take(MAX_RAW_BYTES + 1).read_to_end(&mut data)?;
        if data.len() as u64 > MAX_RAW_BYTES {
            return Err(too_large());
        }
        Ok((absolute, Contents { data, modified_ms: info.modified_ms() }))
    }

    pub fn stat_in(root: &FinderRoot, relative: &str) -> Outcome<Stat> {
        let Resolved { absolute, relative, .. } = Self::resolve(root, relative, true)?;
        Ok(Stat { entry: FinderEntry::read(&absolute, absolute.basename())?, path: relative })
    }

    pub fn read_bytes_in(root: &FinderRoot, relative: &str) -> Outcome<Contents> {
        Self::contents(root, relative).map(|(_, contents)| contents)
    }

    pub fn read_text_in(root: &FinderRoot, relative: &str) -> Outcome<(String, i64)> {
        let Contents { data, modified_ms } = Self::read_bytes_in(root, relative)?;
        let text = String::from_utf8(data).map_err(|_| Failure::invalid("file is not valid UTF-8 text").with(Errno::Ilseq))?;
        Ok((text, modified_ms))
    }

    pub fn write_file_in(root: &FinderRoot, relative: &str, data: &[u8], options: &WriteOptions) -> Outcome<FinderEntry> {
        if data.len() as u64 > MAX_RAW_BYTES {
            return Err(Failure::http(413, "content exceeds 64 MiB"));
        }
        if options.create == Create::New && options.if_modified_ms.is_some() {
            return Err(Failure::invalid("ifModifiedMs cannot go with create: 'new'"));
        }
        if options.mkdirs && options.create != Create::Never {
            let parent = Self::clean(relative)?.dirname().to_owned();
            if parent != "." {
                Self::make_dirs(root, &parent)?;
            }
        }
        let Resolved { absolute, .. } = Self::resolve(root, relative, false)?;
        let mut open = OpenOptions::new();
        open.write(true);
        match (options.create, options.if_modified_ms) {
            (Create::New, _) => open.create_new(true),
            (Create::Always, None) => open.create(true),
            _ => &mut open,
        };
        let mut file = Self::no_follow(&mut open, &absolute, true).map_err(|error| match (error.kind(), options.create, options.if_modified_ms) {
            (ErrorKind::AlreadyExists, ..) => Failure::exists("file already exists"),
            (ErrorKind::NotFound, _, Some(_)) => Failure::conflict("file no longer exists or is not a regular file"),
            _ => error.into(),
        })?;
        let info = file.metadata()?;
        if !info.is_file() {
            return Err(Failure::invalid("not a regular file"));
        }
        if let Some(expected) = options.if_modified_ms
            && info.modified_ms() as f64 != expected
        {
            return Err(Failure::conflict("file changed since it was opened; reload before saving"));
        }
        file.set_len(0)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        FinderEntry::read(&absolute, absolute.basename())
    }

    pub fn mkdir_in(root: &FinderRoot, relative: &str, options: &MkdirOptions) -> Outcome<FinderEntry> {
        let absolute = match options.recursive {
            true => Self::make_dirs(root, relative)?,
            false => {
                let Resolved { absolute, .. } = Self::resolve(root, relative, false)?;
                DirBuilder::new().create(&absolute)?;
                absolute
            }
        };
        FinderEntry::read(&absolute, absolute.basename())
    }

    fn child_path(dir: &str, name: &str) -> Outcome<String> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
            return Err(Failure::invalid("not a valid file name"));
        }
        Ok(match Self::clean(dir)?.as_str() {
            "." => name.to_owned(),
            dir => format!("{dir}/{name}"),
        })
    }

    pub fn children_in(root: &FinderRoot, relative: &str) -> Outcome<Vec<(String, EntryKind)>> {
        let Resolved { real, .. } = Self::resolve(root, relative, true)?;
        if !fs::metadata(&real)?.is_dir() {
            return Err(Failure::invalid("not a directory"));
        }
        let mut children = Vec::new();
        for entry in fs::read_dir(&real)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else { continue };
            children.push((name, entry.file_type()?.into()));
        }
        Ok(children)
    }

    pub fn child_in(root: &FinderRoot, dir: &str, name: &str, create: Option<EntryKind>) -> Outcome<Option<EntryKind>> {
        let Resolved { absolute, .. } = Self::resolve(root, &Self::child_path(dir, name)?, false)?;
        match fs::symlink_metadata(&absolute) {
            Ok(info) => Ok(Some(info.file_type().into())),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let made = match create {
                    None | Some(EntryKind::Other | EntryKind::Symlink) => return Ok(None),
                    Some(EntryKind::File) => Self::no_follow(OpenOptions::new().write(true).create_new(true), &absolute, false).map(drop),
                    Some(EntryKind::Directory) => DirBuilder::new().create(&absolute),
                };
                match made {
                    Ok(()) => Ok(create),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(Some(fs::symlink_metadata(&absolute)?.file_type().into())),
                    Err(error) => Err(error.into()),
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn remove_child_in(root: &FinderRoot, dir: &str, name: &str, recursive: bool) -> Outcome<bool> {
        let Resolved { absolute, .. } = Self::resolve(root, &Self::child_path(dir, name)?, false)?;
        let info = match fs::symlink_metadata(&absolute) {
            Ok(info) => info,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        match (info.is_dir(), recursive) {
            (true, true) => fs::remove_dir_all(&absolute)?,
            (true, false) => fs::remove_dir(&absolute)?,
            (false, _) => fs::remove_file(&absolute)?,
        }
        Ok(true)
    }

    fn make_dirs(root: &FinderRoot, relative: &str) -> Outcome<String> {
        let clean = Self::clean(relative)?;
        let real_root = Self::realpath(&root.path)?;
        let mut at = root.path.clone();
        if clean == "." {
            return Ok(at);
        }
        let parts: Vec<&str> = clean.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            at = at.join(part);
            let last = index + 1 == parts.len();
            let blocked = || match last {
                true => Failure::exists("a file with that name already exists"),
                false => Failure::invalid("not a directory"),
            };
            match fs::symlink_metadata(&at) {
                Ok(info) if info.is_dir() => {}
                Ok(info) if info.file_type().is_symlink() => {
                    let real = Self::realpath(&at).map_err(|_| Failure::invalid("a symlink on the path points nowhere"))?;
                    if !Self::inside(&real_root, &real) {
                        return Err(Failure::invalid("path leaves the workspace through a symlink"));
                    }
                    if !fs::metadata(&real)?.is_dir() {
                        return Err(blocked());
                    }
                }
                Ok(_) => return Err(blocked()),
                Err(error) if error.kind() == ErrorKind::NotFound => match DirBuilder::new().create(&at) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::AlreadyExists && fs::metadata(&at).is_ok_and(|info| info.is_dir()) => {}
                    Err(error) => return Err(error.into()),
                },
                Err(error) => return Err(error.into()),
            }
        }
        Ok(at)
    }

    pub fn write_in(root: &FinderRoot, relative: &str, content: &str, expected: &str) -> Outcome<FinderEntry> {
        if content.len() > MAX_WRITE_BYTES {
            return Err(Failure::http(413, "content exceeds 384 KiB"));
        }
        let options = match expected {
            "new" => WriteOptions { create: Create::New, ..WriteOptions::default() },
            _ => {
                let Resolved { absolute, .. } = Self::resolve(root, relative, false)?;
                if !fs::symlink_metadata(&absolute).is_ok_and(|info| info.is_file()) {
                    return Err(Failure::conflict("file no longer exists or is not a regular file"));
                }
                let expected = expected.parse::<i64>().map_err(|_| Failure::conflict("file changed since it was opened; reload before saving"))?;
                WriteOptions { if_modified_ms: Some(expected as f64), ..WriteOptions::default() }
            }
        };
        Self::write_file_in(root, relative, content.as_bytes(), &options)
    }

    pub fn numbered(name: &str, n: u32) -> String {
        if n <= 1 {
            return name.to_owned();
        }
        let ext = name.extname();
        format!("{} {n}{ext}", &name[..name.len() - ext.len()])
    }

    pub fn copy_into(root: &FinderRoot, dir: &str, source: &str) -> Outcome<FinderEntry> {
        let source = match source.strip_prefix("file://") {
            Some(rest) => url::Url::parse(&format!("file://{rest}"))
                .ok()
                .and_then(|u| u.to_file_path().ok())
                .ok_or_else(|| Failure::invalid("not a file:// URI of this machine"))?,
            None => std::path::PathBuf::from(source),
        };
        if !source.is_absolute() {
            return Err(Failure::invalid("source must be an absolute path or a file:// URI"));
        }
        let info = fs::metadata(&source).map_err(|_| Failure::http(404, "source file not found"))?;
        if !info.is_file() {
            return Err(Failure::invalid("only regular files can be copied in"));
        }
        let Resolved { absolute, real, .. } = Self::resolve(root, dir, true)?;
        if !fs::metadata(&real)?.is_dir() {
            return Err(Failure::invalid("not a directory"));
        }
        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| Failure::invalid("source has no file name"))?;
        let mut reader = File::open(&source)?;
        for n in 1..10_000 {
            let candidate = Self::numbered(&name, n);
            let target = absolute.join(&candidate);
            let created = Self::no_follow(OpenOptions::new().write(true).create_new(true), &target, false);
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

    pub fn rename_in(root: &FinderRoot, from: &str, to: &str) -> Outcome<FinderEntry> {
        let source = Self::resolve(root, from, true)?;
        let target = Self::resolve(root, to, false)?;
        if source.relative.is_empty() {
            return Err(Failure::invalid("the workspace root cannot be renamed"));
        }
        if fs::symlink_metadata(&target.absolute).is_ok() {
            return Err(Failure::exists("target already exists"));
        }
        fs::rename(&source.absolute, &target.absolute)?;
        FinderEntry::read(&target.absolute, target.absolute.basename())
    }

    pub fn remove_in(root: &FinderRoot, relative: &str) -> Outcome<()> {
        let Resolved { absolute, relative, .. } = Self::resolve(root, relative, false)?;
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
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, symlink};
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Scratch {
        dir: String,
        root: FinderRoot,
    }

    impl Scratch {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let base = std::env::temp_dir().join(format!("acde-ws-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            let dir = base.to_string_lossy().into_owned();
            fs::create_dir_all(dir.join("root")).unwrap();
            let root =
                FinderRoot { path: dir.join("root"), label: "root".into(), source: RootSource::Default, mode: RootMode::Writable, reason: None, exists: true };
            Self { dir, root }
        }

        fn at(&self, relative: &str) -> String {
            self.root.path.join(relative)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn code<T>(outcome: Outcome<T>) -> (u16, &'static str) {
        match outcome {
            Ok(_) => (0, "ok"),
            Err(failure) => (failure.status, failure.errno.as_str()),
        }
    }

    fn write(options: &str) -> WriteOptions {
        serde_json::from_str(options).unwrap()
    }

    #[test]
    fn stat_reports_the_entry_and_its_clean_path() {
        let s = Scratch::new();
        fs::create_dir(s.at("notes")).unwrap();
        fs::write(s.at("notes/a.md"), "hello").unwrap();
        symlink("a.md", s.at("notes/link.md")).unwrap();
        let stat = WorkspaceFs::stat_in(&s.root, "notes/./a.md").unwrap();
        assert_eq!((stat.path.as_str(), stat.entry.name.as_str(), stat.entry.size), ("notes/a.md", "a.md", 5));
        assert!(stat.entry.kind == EntryKind::File);
        let link = WorkspaceFs::stat_in(&s.root, "notes/link.md").unwrap();
        assert!(link.entry.kind == EntryKind::Symlink && link.entry.target.as_deref() == Some("a.md"));
        let root = WorkspaceFs::stat_in(&s.root, "").unwrap();
        assert!(root.path.is_empty() && root.entry.kind == EntryKind::Directory && root.entry.name == "root");
        assert_eq!(code(WorkspaceFs::stat_in(&s.root, "nope")), (404, "ENOENT"));
        assert_eq!(code(WorkspaceFs::stat_in(&s.root, "../")), (400, "EINVAL"));
    }

    #[test]
    fn reads_follow_the_root_rules() {
        let s = Scratch::new();
        fs::write(s.dir.join("secret"), "outside").unwrap();
        symlink(s.dir.join("secret"), s.at("out")).unwrap();
        fs::create_dir(s.at("dir")).unwrap();
        assert_eq!(code(WorkspaceFs::read_text_in(&s.root, "out")), (400, "EINVAL"));
        assert_eq!(code(WorkspaceFs::read_bytes_in(&s.root, "/etc/hosts")), (400, "EINVAL"));
        assert_eq!(code(WorkspaceFs::read_text_in(&s.root, "dir")), (400, "EINVAL"));
        assert_eq!(code(WorkspaceFs::read_text_in(&s.root, "missing")), (404, "ENOENT"));
    }

    #[test]
    fn read_text_is_the_whole_file_beyond_the_preview() {
        let s = Scratch::new();
        let big = format!("\u{feff}{}", "é".repeat(200 * 1024));
        fs::write(s.at("big.txt"), &big).unwrap();
        let (text, modified) = WorkspaceFs::read_text_in(&s.root, "big.txt").unwrap();
        assert_eq!(text.len(), big.len());
        assert!(text == big && text.len() as u64 > MAX_PREVIEW_BYTES);
        assert_eq!(modified, fs::metadata(s.at("big.txt")).unwrap().modified_ms());
        fs::write(s.at("bad.txt"), [b'a', 0xff, b'b']).unwrap();
        assert_eq!(code(WorkspaceFs::read_text_in(&s.root, "bad.txt")), (400, "EILSEQ"));
        let bytes = WorkspaceFs::read_bytes_in(&s.root, "bad.txt").unwrap();
        assert_eq!(bytes.data, [b'a', 0xff, b'b']);
    }

    #[test]
    fn reads_stop_at_the_raw_limit() {
        let s = Scratch::new();
        let file = File::create(s.at("huge.bin")).unwrap();
        file.set_len(MAX_RAW_BYTES + 1).unwrap();
        assert_eq!(code(WorkspaceFs::read_bytes_in(&s.root, "huge.bin")), (413, "EFBIG"));
        let data = vec![0u8; MAX_RAW_BYTES as usize + 1];
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "x.bin", &data, &WriteOptions::default())), (413, "EFBIG"));
        assert!(!Path::new(&s.at("x.bin")).exists());
    }

    #[test]
    fn write_file_creates_overwrites_and_detects_conflicts() {
        let s = Scratch::new();
        let entry = WorkspaceFs::write_file_in(&s.root, "a.bin", &[0, 1, 2, 255], &WriteOptions::default()).unwrap();
        assert_eq!((entry.name.as_str(), entry.size), ("a.bin", 4));
        assert_eq!(fs::read(s.at("a.bin")).unwrap(), [0, 1, 2, 255]);
        let entry = WorkspaceFs::write_file_in(&s.root, "a.bin", b"xy", &WriteOptions::default()).unwrap();
        assert_eq!((entry.size, fs::read(s.at("a.bin")).unwrap()), (2, b"xy".to_vec()));
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "a.bin", b"z", &write(r#"{"create":"new"}"#))), (409, "EEXIST"));
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "b.bin", b"z", &write(r#"{"create":"never"}"#))), (404, "ENOENT"));
        assert!(!Path::new(&s.at("b.bin")).exists());
        let now = entry.modified_ms;
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "a.bin", b"z", &write(&format!(r#"{{"ifModifiedMs":{}}}"#, now - 1000)))), (409, "ECONFLICT"));
        assert_eq!(fs::read(s.at("a.bin")).unwrap(), b"xy");
        let ok = WorkspaceFs::write_file_in(&s.root, "a.bin", b"saved", &write(&format!(r#"{{"ifModifiedMs":{now},"create":"never"}}"#))).unwrap();
        assert_eq!(ok.size, 5);
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "gone.bin", b"z", &write(r#"{"ifModifiedMs":1}"#))), (409, "ECONFLICT"));
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "c.bin", b"z", &write(r#"{"ifModifiedMs":1,"create":"new"}"#))), (400, "EINVAL"));
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "", b"z", &WriteOptions::default())), (400, "EINVAL"));
    }

    #[test]
    fn write_file_keeps_the_inode_and_refuses_links_and_folders() {
        let s = Scratch::new();
        fs::write(s.at("keep.txt"), "old").unwrap();
        let inode = fs::metadata(s.at("keep.txt")).unwrap().ino();
        WorkspaceFs::write_file_in(&s.root, "keep.txt", b"new", &WriteOptions::default()).unwrap();
        assert_eq!(fs::metadata(s.at("keep.txt")).unwrap().ino(), inode);
        fs::write(s.dir.join("secret"), "outside").unwrap();
        symlink(s.dir.join("secret"), s.at("link")).unwrap();
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "link", b"x", &WriteOptions::default())), (400, "EINVAL"));
        assert_eq!(fs::read_to_string(s.dir.join("secret")).unwrap(), "outside");
        fs::create_dir(s.at("folder")).unwrap();
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "folder", b"x", &WriteOptions::default())), (400, "EINVAL"));
        symlink(&s.dir, s.at("away")).unwrap();
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "away/x", b"x", &WriteOptions::default())), (400, "EINVAL"));
        assert!(!Path::new(&s.dir.join("x")).exists());
    }

    #[test]
    fn write_file_mkdirs_creates_the_parents() {
        let s = Scratch::new();
        assert_eq!(code(WorkspaceFs::write_file_in(&s.root, "a/b/c.md", b"x", &WriteOptions::default())), (400, "EINVAL"));
        WorkspaceFs::write_file_in(&s.root, "a/b/c.md", b"x", &write(r#"{"mkdirs":true}"#)).unwrap();
        assert_eq!(fs::read(s.at("a/b/c.md")).unwrap(), b"x");
        assert!(serde_json::from_str::<WriteOptions>(r#"{"create":"sometimes"}"#).is_err());
        assert!(serde_json::from_str::<WriteOptions>(r#"{"ifModifiedMs":"12"}"#).is_err());
        assert!(serde_json::from_str::<WriteOptions>(r#"{"other":1}"#).is_ok());
    }

    #[test]
    fn mkdir_recursive() {
        let s = Scratch::new();
        let recursive = MkdirOptions { recursive: true };
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "x/y", &MkdirOptions::default())), (400, "EINVAL"));
        let entry = WorkspaceFs::mkdir_in(&s.root, "x/y/z", &recursive).unwrap();
        assert!(entry.name == "z" && entry.kind == EntryKind::Directory);
        assert!(Path::new(&s.at("x/y/z")).is_dir());
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "x/y/z", &recursive)), (0, "ok"));
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "x/y/z", &MkdirOptions::default())), (409, "EEXIST"));
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "", &recursive)), (0, "ok"));
        fs::write(s.at("x/file"), "").unwrap();
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "x/file", &recursive)), (409, "EEXIST"));
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "x/file/deeper", &recursive)), (400, "EINVAL"));
        symlink(s.at("x"), s.at("inside")).unwrap();
        WorkspaceFs::mkdir_in(&s.root, "inside/w", &recursive).unwrap();
        assert!(Path::new(&s.at("x/w")).is_dir());
        symlink(&s.dir, s.at("away")).unwrap();
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "away/w", &recursive)), (400, "EINVAL"));
        assert!(!Path::new(&s.dir.join("w")).exists());
        assert_eq!(code(WorkspaceFs::mkdir_in(&s.root, "../w", &recursive)), (400, "EINVAL"));
    }

    #[test]
    fn copy_into_keeps_or_numbers_the_name() {
        let s = Scratch::new();
        let src = s.dir.join("src dir");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir(s.at("docs")).unwrap();
        fs::write(s.at("docs/plain.txt"), "x").unwrap();
        let image = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255];
        fs::write(src.join("截图 1.png"), image).unwrap();
        fs::write(src.join(".env"), "A=1\n").unwrap();
        fs::write(src.join("README"), "readme\n").unwrap();
        let copy = |dir: &str, source: &str| WorkspaceFs::copy_into(&s.root, dir, source);
        let entry = copy("docs", &src.join("截图 1.png")).unwrap();
        assert_eq!((entry.name.as_str(), entry.kind, entry.size), ("截图 1.png", EntryKind::File, image.len() as u64));
        assert_eq!(fs::read(s.at("docs/截图 1.png")).unwrap(), image);
        let uri = url::Url::from_file_path(src.join("截图 1.png")).unwrap();
        assert_eq!(copy("docs", uri.as_str()).unwrap().name, "截图 1 2.png");
        assert_eq!(copy("docs", &src.join("截图 1.png")).unwrap().name, "截图 1 3.png");
        for name in [".env", "README"] {
            assert_eq!(copy("", &src.join(name)).unwrap().name, name);
            assert_eq!(copy("", &src.join(name)).unwrap().name, format!("{name} 2"));
        }
        assert_eq!(fs::read_to_string(s.at("docs/plain.txt")).unwrap(), "x");
        File::create(src.join("big.bin")).unwrap().set_len(70 << 20).unwrap();
        assert_eq!(copy("", &src.join("big.bin")).unwrap().size, 70 << 20);
        let failed = |outcome: Outcome<FinderEntry>| outcome.err().map(|f| (f.status, f.message));
        let failed = |dir: &str, source: &str| failed(copy(dir, source));
        assert_eq!(failed("", &src.join("nope.png")), Some((404, "source file not found".into())));
        assert_eq!(failed("", &src), Some((400, "only regular files can be copied in".into())));
        assert_eq!(failed("", "relative.png"), Some((400, "source must be an absolute path or a file:// URI".into())));
        assert_eq!(failed("", "file://elsewhere/x.png"), Some((400, "not a file:// URI of this machine".into())));
        assert_eq!(failed("docs/plain.txt", &src.join("README")), Some((400, "not a directory".into())));
        assert_eq!(failed("../", &src.join("README")), Some((400, "path escapes the workspace".into())));
        assert_eq!(failed("nope", &src.join("README")), Some((404, "no such file or directory".into())));
        assert!(!Path::new(&s.at("nope")).exists());
    }
}
