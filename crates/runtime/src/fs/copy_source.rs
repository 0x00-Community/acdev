use super::workspace::{FinderRoot, WorkspaceFs};
use crate::failure::{Failure, Outcome};
use acde_model::drop_grant::{self, Claim};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

pub(super) struct Source {
    pub file: File,
    pub name: String,
    pub claim: Option<Claim<'static>>,
}

pub(super) fn parse(source: &str) -> Outcome<PathBuf> {
    let path = match source.strip_prefix("file://") {
        Some(rest) => url::Url::parse(&format!("file://{rest}"))
            .ok()
            .and_then(|u| u.to_file_path().ok())
            .ok_or_else(|| Failure::invalid("not a file:// URI of this machine"))?,
        None => PathBuf::from(source),
    };
    if !path.is_absolute() {
        return Err(Failure::invalid("source must be an absolute path or a file:// URI"));
    }
    Ok(path)
}

pub(super) fn admit(allowed: &[FinderRoot], requested: &Path, owner: Option<&str>) -> Outcome<Source> {
    let real = fs::canonicalize(requested).map_err(|error| missing(allowed, requested, &error))?;
    let inside = allowed.iter().any(|root| fs::canonicalize(&root.path).is_ok_and(|top| real.starts_with(&top)));
    let claim = match inside {
        true => None,
        false => Some(drop_grant::claim(owner, &real).ok_or_else(refused)?),
    };
    if !fs::metadata(&real)?.is_file() {
        return Err(Failure::invalid("only regular files can be copied in"));
    }
    let file = WorkspaceFs::no_follow(OpenOptions::new().read(true), &real, true)?;
    if !opened_as(&file, &real) {
        return Err(Failure::http(403, "the source changed while it was being opened"));
    }
    let file_name = requested.file_name().ok_or_else(|| Failure::invalid("source has no file name"))?;
    let name = file_name.to_string_lossy().into_owned();
    Ok(Source { file, name, claim })
}

fn missing(allowed: &[FinderRoot], requested: &Path, error: &std::io::Error) -> Failure {
    match error.kind() == ErrorKind::NotFound && lexically_inside(allowed, requested) {
        true => Failure::http(404, "source file not found"),
        false => refused(),
    }
}

fn lexically_inside(allowed: &[FinderRoot], requested: &Path) -> bool {
    let plain = !requested.components().any(|part| part == Component::ParentDir);
    plain && allowed.iter().any(|root| requested.starts_with(&root.path))
}

fn refused() -> Failure {
    Failure::http(403, "this app may copy in only files from its folders or files dropped onto its window")
}

fn opened_as(file: &File, real: &Path) -> bool {
    match opened_path(file) {
        Some(opened) => same_path(&opened, real),
        None => fs::canonicalize(real).is_ok_and(|now| now == real),
    }
}

#[cfg(windows)]
fn same_path(a: &Path, b: &Path) -> bool {
    let text = |path: &Path| path.to_string_lossy().trim_start_matches(r"\\?\").to_ascii_lowercase();
    text(a) == text(b)
}

#[cfg(not(windows))]
fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

#[cfg(windows)]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, VOLUME_NAME_DOS};
    let handle = file.as_raw_handle() as _;
    let mut buffer = vec![0u16; 512];
    loop {
        let size = buffer.len() as u32;
        let length = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), size, VOLUME_NAME_DOS) } as usize;
        match length {
            0 => return None,
            n if n < buffer.len() => return Some(PathBuf::from(OsString::from_wide(&buffer[..n]))),
            n => buffer.resize(n + 1, 0),
        }
    }
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn opened_path(_: &File) -> Option<PathBuf> {
    None
}
