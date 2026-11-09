use std::path::{Component, Path, PathBuf, Prefix};

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    Refused(String),
    Failed(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    Web(String),
    File(PathBuf),
}

const URL_MAX: usize = 8192;

const EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico", "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus",
    "wma", "mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv", "txt", "md", "csv", "log", "json", "docx", "xlsx", "pptx", "odt", "ods", "odp",
];

impl Target {
    pub fn parse(target: &str) -> Result<Target, OpenError> {
        let lower = target.get(..8).unwrap_or(target).to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Target::web(target);
        }
        Target::file(Path::new(target))
    }

    fn web(url: &str) -> Result<Target, OpenError> {
        let refused = |why: &str| Err(OpenError::Refused(format!("not handed to the system: {why}")));
        if url.len() > URL_MAX {
            return refused("the link is too long");
        }
        if url.bytes().any(|b| !(0x21..0x7f).contains(&b) || matches!(b, b'"' | b'\\' | b'<' | b'>' | b'`')) {
            return refused("the link has characters a URL never has unescaped");
        }
        let rest = &url[url.find("://").map_or(url.len(), |at| at + 3)..];
        if rest.is_empty() || rest.starts_with(['/', '?', '#']) {
            return refused("the link has no host");
        }
        Ok(Target::Web(url.to_owned()))
    }

    fn file(path: &Path) -> Result<Target, OpenError> {
        let refused = |why: String| Err(OpenError::Refused(format!("{} is not handed to the system: {why}", path.display())));
        if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
            return refused("not an absolute path".into());
        }
        if let Some(why) = Target::odd_component(path) {
            return refused(why.into());
        }
        let extension = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if !EXTENSIONS.contains(&extension.as_str()) {
            return refused(format!("only documents and media open in system apps, not .{extension} files"));
        }
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_file() => Ok(Target::File(path.components().collect())),
            Ok(_) => refused("not a regular file".into()),
            Err(e) => refused(e.to_string()),
        }
    }

    fn odd_component(path: &Path) -> Option<&'static str> {
        for component in path.components() {
            match component {
                Component::Prefix(prefix) if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(..)) => return Some("a device or verbatim path"),
                Component::ParentDir | Component::CurDir => return Some("the path is not normalized"),
                Component::Normal(name) if cfg!(windows) && name.to_string_lossy().contains(':') => return Some("a named stream"),
                _ => {}
            }
        }
        None
    }

    fn text(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Target::Web(url) => url.into(),
            Target::File(path) => path.to_string_lossy(),
        }
    }
}

pub fn open(target: &str, headless: bool) -> Result<(), OpenError> {
    let target = Target::parse(target)?;
    if headless {
        log::info!("open with the system default app (ACDE_HEADLESS, not opened): {}", target.text());
        return Ok(());
    }
    log::info!("open with the system default app: {}", target.text());
    system(&target)
}

#[cfg(windows)]
fn system(target: &Target) -> Result<(), OpenError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |text: &std::ffi::OsStr| text.encode_wide().chain([0]).collect::<Vec<u16>>();
    let file = match target {
        Target::Web(url) => wide(std::ffi::OsStr::new(url)),
        Target::File(path) => wide(path.as_os_str()),
    };
    let verb = wide(std::ffi::OsStr::new("open"));
    let com = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
    let code = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) } as isize;
    if com >= 0 {
        unsafe { CoUninitialize() };
    }
    if code > 32 { Ok(()) } else { Err(OpenError::Failed(format!("ShellExecuteW {}: error {code}", target.text()))) }
}

#[cfg(target_os = "macos")]
fn system(target: &Target) -> Result<(), OpenError> {
    use std::process::{Command, Stdio};
    let mut command = Command::new("/usr/bin/open");
    match target {
        Target::Web(url) => command.arg(url),
        Target::File(path) => command.arg(path),
    };
    let out = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).output().map_err(|e| OpenError::Failed(format!("open: {e}")))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(OpenError::Failed(format!("open {}: {} {}", target.text(), out.status, String::from_utf8_lossy(&out.stderr).trim())))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system(_: &Target) -> Result<(), OpenError> {
    Err(OpenError::Failed(format!("host windows on {} do not hand anything to system apps", std::env::consts::OS)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(target: &str) -> bool {
        matches!(Target::parse(target), Err(OpenError::Refused(_)))
    }

    #[test]
    fn only_plain_http_links_pass() {
        assert_eq!(Target::parse("https://example.com/a?b=c#d"), Ok(Target::Web("https://example.com/a?b=c#d".into())));
        assert_eq!(Target::parse("HTTP://example.com/"), Ok(Target::Web("HTTP://example.com/".into())));
        for url in [
            "https://example.com/\" -osint -url \"file:///C:/x.exe",
            "https://example.com/a b",
            "https://example.com/\r\nx",
            "https://例子.com/",
            "https:///etc/passwd",
            "https://",
            "http://?x",
            "https://example.com\\..\\x",
        ] {
            assert!(refused(url), "{url:?}");
        }
        assert!(refused(&format!("https://example.com/{}", "a".repeat(URL_MAX))));
    }

    #[test]
    fn other_schemes_are_files_and_refused() {
        for target in ["file:///C:/Windows/notepad.exe", "javascript:alert(1)", "ms-settings:", "mailto:a@b.c", "vbscript:x", "relative/doc.pdf", ""] {
            assert!(refused(target), "{target:?}");
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("acde-handoff-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_documents_and_media_files_pass() {
        let dir = scratch("files");
        for name in ["report.pdf", "Photo.JPG", "notes.txt", "deck.pptx"] {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            assert_eq!(Target::parse(&path.to_string_lossy()), Ok(Target::File(path.clone())), "{name}");
        }
        for name in [
            "setup.exe",
            "run.bat",
            "script.ps1",
            "link.lnk",
            "page.url",
            "app.hta",
            "macro.docm",
            "tool.js",
            "noext",
            "x.pdf.exe",
            "old.doc",
            "old.xls",
            "old.ppt",
            "page.html",
            "page.htm",
            "image.svg",
            "text.rtf",
        ] {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            assert!(refused(&path.to_string_lossy()), "{name}");
        }
        assert!(refused(&dir.join("missing.pdf").to_string_lossy()));
        std::fs::create_dir_all(dir.join("folder.pdf")).unwrap();
        assert!(refused(&dir.join("folder.pdf").to_string_lossy()));
        assert!(refused(&format!("{}/../x.pdf", dir.display())));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_device_paths_and_streams_are_refused() {
        let dir = scratch("streams");
        let path = dir.join("doc.pdf");
        std::fs::write(&path, b"x").unwrap();
        assert!(refused(&format!(r"\\?\{}", path.display())));
        assert!(refused(r"\\.\C:\doc.pdf"));
        assert!(refused(&format!("{}:hidden.pdf", path.display())));
        let slashes = path.to_string_lossy().replace('\\', "/");
        assert_eq!(Target::parse(&slashes), Ok(Target::File(path.clone())));
        assert!(matches!(Target::parse(&slashes), Ok(Target::File(p)) if !p.to_string_lossy().contains('/')));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_refused() {
        let dir = scratch("links");
        let real = dir.join("real.pdf");
        std::fs::write(&real, b"x").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("link.pdf")).unwrap();
        assert!(refused(&dir.join("link.pdf").to_string_lossy()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn headless_checks_but_does_not_open() {
        assert_eq!(open("https://example.com/", true), Ok(()));
        assert!(matches!(open("javascript:alert(1)", true), Err(OpenError::Refused(_))));
    }
}
