use super::blank::BlankKind;
use crate::failure::{Failure, Outcome};
use crate::fs::Shared as Finder;
use crate::fs::path::NodePath;
use crate::fs::workspace::{EntryKind, FinderRoot, ModifiedMs, WorkspaceFs};
use rustix::fs::OFlags;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    sync::Arc,
};

pub const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
const EDITABLE: [(&str, &str); 3] = [("docx", "word"), ("xlsx", "cell"), ("pptx", "slide")];
const VIEWABLE: [(&str, &str); 8] =
    [("doc", "word"), ("odt", "word"), ("rtf", "word"), ("xls", "cell"), ("ods", "cell"), ("ppt", "slide"), ("odp", "slide"), ("pdf", "pdf")];

pub struct OfficeFile {
    pub root: FinderRoot,
    pub path: String,
    pub name: String,
    pub ext: String,
    pub document_type: String,
    pub size: u64,
    pub modified_ms: i64,
    pub editable: bool,
    pub read_only_reason: Option<String>,
}

impl OfficeFile {
    pub fn view(&self) -> Value {
        json!({"root": self.root.path, "rootLabel": self.root.label, "path": self.path, "name": self.name, "ext": self.ext,
            "documentType": self.document_type, "size": self.size, "modifiedMs": self.modified_ms, "editable": self.editable,
            "readOnlyReason": self.read_only_reason})
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeEntry {
    name: String,
    kind: String,
    size: u64,
    modified_ms: i64,
    ext: String,
}

pub struct SaveResult {
    pub path: String,
    pub modified_ms: i64,
    pub conflict: bool,
}

pub struct OfficeFiles {
    finder: Arc<Finder>,
}

impl OfficeFiles {
    fn stamp() -> String {
        let now = jiff::Timestamp::from_second(crate::clock::Clock::now().as_secs() as i64).unwrap_or_default();
        now.to_zoned(jiff::tz::TimeZone::system()).strftime("%m-%d %H-%M").to_string()
    }

    pub fn new(finder: Arc<Finder>) -> Self {
        Self { finder }
    }

    fn fs(&self) -> &WorkspaceFs {
        &self.finder.fs
    }

    pub fn extension(path: &str) -> String {
        path.extname().trim_start_matches('.').to_lowercase()
    }

    fn document_type(path: &str) -> Option<String> {
        let ext = Self::extension(path);
        EDITABLE.iter().chain(VIEWABLE.iter()).find(|(e, _)| *e == ext).map(|(_, t)| (*t).to_owned())
    }

    pub fn roots(&self) -> Outcome<Vec<FinderRoot>> {
        self.fs().roots()
    }

    pub fn file(&self, root_path: &str, relative: &str) -> Outcome<OfficeFile> {
        Self::file_in(self.fs().root(root_path)?, relative)
    }

    pub fn file_in(root: FinderRoot, relative: &str) -> Outcome<OfficeFile> {
        let resolved = WorkspaceFs::resolve(&root, relative, true)?;
        let info = fs::metadata(&resolved.real)?;
        if !info.is_file() {
            return Err(Failure::invalid("not a regular file"));
        }
        let ext = Self::extension(&resolved.absolute);
        let Some(document_type) = Self::document_type(&resolved.absolute) else {
            let supported: Vec<&str> = EDITABLE.iter().chain(VIEWABLE.iter()).map(|(e, _)| *e).collect();
            let shown = if ext.is_empty() { "?" } else { &ext };
            return Err(Failure::invalid(format!(".{shown} files do not open in Office; supported: {}", supported.join(", "))));
        };
        if info.len() > MAX_DOCUMENT_BYTES {
            return Err(Failure::http(413, "file exceeds 64 MiB"));
        }
        let reason = (!EDITABLE.iter().any(|(e, _)| *e == ext)).then(|| format!(".{ext} 只能查看；要编辑请另存为 docx、xlsx 或 pptx。"));
        Ok(OfficeFile {
            path: resolved.relative,
            name: resolved.absolute.basename().to_owned(),
            ext,
            document_type,
            size: info.len(),
            modified_ms: info.modified_ms(),
            editable: reason.is_none(),
            read_only_reason: reason,
            root,
        })
    }

    pub fn read(file: &OfficeFile) -> Outcome<Vec<u8>> {
        Ok(WorkspaceFs::raw_in(&file.root, &file.path)?.1)
    }

    pub fn list_in(&self, root: FinderRoot, relative: &str) -> Outcome<(String, Vec<OfficeEntry>, bool)> {
        let listing = self.fs().list_in(root, relative, false)?;
        let entries = listing
            .entries
            .into_iter()
            .filter_map(|entry| match entry.kind {
                EntryKind::Directory => {
                    Some(OfficeEntry { name: entry.name, kind: "directory".into(), size: 0, modified_ms: entry.modified_ms, ext: String::new() })
                }
                EntryKind::File if Self::document_type(&entry.name).is_some() => {
                    let ext = Self::extension(&entry.name);
                    Some(OfficeEntry { name: entry.name, kind: "document".into(), size: entry.size, modified_ms: entry.modified_ms, ext })
                }
                _ => None,
            })
            .collect();
        Ok((listing.path, entries, listing.truncated))
    }

    fn write_new(path: &str, data: &[u8], mode: u32, exact: bool) -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).custom_flags(OFlags::NOFOLLOW.bits() as i32).mode(mode).open(path)?;
        let written = (|| {
            if exact {
                file.set_permissions(fs::Permissions::from_mode(mode))?;
            }
            file.write_all(data)?;
            file.sync_all()
        })();
        if written.is_err() {
            let _ = fs::remove_file(path);
        }
        written
    }

    pub fn create(&self, root_path: &str, directory: &str, kind: BlankKind, name: Option<&str>) -> Outcome<String> {
        let ext = kind.extension();
        let base = crate::js::JsText::js_trim(name.unwrap_or(kind.default_name())).to_owned();
        let base = match base.len().checked_sub(ext.len() + 1) {
            Some(cut) if base.is_char_boundary(cut) && base[cut..].eq_ignore_ascii_case(&format!(".{ext}")) => base[..cut].to_owned(),
            _ => base,
        };
        if base.is_empty() || base.contains(['/', '\\', '\0']) || base.starts_with('.') {
            return Err(Failure::invalid("invalid file name"));
        }
        let root = self.fs().root(root_path)?;
        let folder = WorkspaceFs::resolve(&root, directory, true)?;
        if !fs::metadata(&folder.real)?.is_dir() {
            return Err(Failure::invalid("not a directory"));
        }
        let data = kind.create();
        let name = format!("{base}.{ext}");
        for index in 1..1000 {
            let candidate = folder.relative.join(&WorkspaceFs::numbered(&name, index));
            let target = WorkspaceFs::resolve(&root, &candidate, false)?;
            match Self::write_new(&target.absolute, &data, 0o644, false) {
                Ok(()) => return Ok(candidate),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(Failure::http(409, "too many files with this name"))
    }

    fn unique_path(&self, root: &FinderRoot, path: &str) -> Outcome<String> {
        for index in 1..1000 {
            let candidate = WorkspaceFs::numbered(path, index);
            let target = WorkspaceFs::resolve(root, &candidate, false)?;
            if fs::symlink_metadata(&target.absolute).is_err() {
                return Ok(candidate);
            }
        }
        Err(Failure::http(409, "too many conflict copies"))
    }

    pub fn save(&self, root_path: &str, relative: &str, data: &[u8], expected_ms: i64) -> Outcome<SaveResult> {
        let root = self.fs().root(root_path)?;
        let target = WorkspaceFs::resolve(&root, relative, false)?;
        let current = fs::symlink_metadata(&target.absolute).ok();
        if current.as_ref().is_some_and(|c| !c.is_file()) {
            return Err(Failure::http(409, "the path is no longer a regular file"));
        }
        if let Some(current) = current.filter(|c| c.modified_ms() == expected_ms) {
            let suffix: String = rand::random::<[u8; 6]>().iter().map(|b| format!("{b:02x}")).collect();
            let temporary = target.absolute.dirname().join(&format!(".{}.{suffix}.office-tmp", target.absolute.basename()));
            use std::os::unix::fs::MetadataExt;
            Self::write_new(&temporary, data, current.mode() & 0o777, true)?;
            if let Err(error) = fs::rename(&temporary, &target.absolute) {
                let _ = fs::remove_file(&temporary);
                return Err(error.into());
            }
            let modified_ms = fs::metadata(&target.absolute)?.modified_ms();
            return Ok(SaveResult { path: target.relative, modified_ms, conflict: false });
        }
        let ext = target.relative.extname();
        let copy = format!("{} (冲突副本 {}){ext}", &target.relative[..target.relative.len() - ext.len()], Self::stamp());
        let copy = self.unique_path(&root, &copy)?;
        Self::write_new(&WorkspaceFs::resolve(&root, &copy, false)?.absolute, data, 0o644, false)?;
        let modified_ms = fs::metadata(&WorkspaceFs::resolve(&root, &copy, true)?.real)?.modified_ms();
        Ok(SaveResult { path: copy, modified_ms, conflict: true })
    }
}
