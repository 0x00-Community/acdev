use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) struct Escape;

impl std::fmt::Display for Escape {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("path leaves the workspace through a link")
    }
}

impl std::error::Error for Escape {}

pub(crate) fn escaped(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|e| e.is::<Escape>())
}

fn escape() -> io::Error {
    io::Error::other(Escape)
}

pub(crate) struct Dir {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    _fd: std::os::fd::OwnedFd,
    #[cfg(windows)]
    _pin: std::fs::File,
    path: PathBuf,
}

impl Dir {
    pub(crate) fn child(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
        use std::os::fd::AsFd;
        self._fd.as_fd()
    }

    pub(crate) fn open(real_root: &str, relative: &str) -> io::Result<Dir> {
        #[cfg(test)]
        hook::run();
        Self::open_beneath(real_root, relative)
    }

    #[cfg(target_os = "linux")]
    fn open_beneath(real_root: &str, relative: &str) -> io::Result<Dir> {
        use rustix::fs::{Mode, OFlags, ResolveFlags, open, openat2};
        let flags = OFlags::DIRECTORY | OFlags::PATH | OFlags::CLOEXEC;
        let root = open(real_root, flags, Mode::empty())?;
        let fd = match relative {
            "" | "." => root,
            relative => match openat2(&root, relative, flags, Mode::empty(), ResolveFlags::BENEATH) {
                Ok(fd) => fd,
                Err(rustix::io::Errno::XDEV) => {
                    let real = std::fs::canonicalize(Path::new(real_root).join(relative))?;
                    let inside = real.strip_prefix(real_root).map_err(|_| escape())?;
                    let strict = ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS;
                    openat2(&root, inside, flags, Mode::empty(), strict).map_err(|e| match e {
                        rustix::io::Errno::XDEV | rustix::io::Errno::LOOP => escape(),
                        e => e.into(),
                    })?
                }
                Err(e) => return Err(e.into()),
            },
        };
        use std::os::fd::AsRawFd;
        let path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
        Ok(Dir { _fd: fd, path })
    }

    #[cfg(target_os = "macos")]
    fn open_beneath(real_root: &str, relative: &str) -> io::Result<Dir> {
        use rustix::fs::{Mode, OFlags, open, openat};
        let flags = OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC;
        let mut fd = open(real_root, flags, Mode::empty())?;
        let inside = match relative {
            "" | "." => PathBuf::new(),
            relative => {
                let real = std::fs::canonicalize(Path::new(real_root).join(relative))?;
                real.strip_prefix(real_root).map_err(|_| escape())?.to_path_buf()
            }
        };
        for part in inside.components() {
            fd = openat(&fd, part.as_os_str(), flags, Mode::empty()).map_err(|e| match e {
                rustix::io::Errno::LOOP => escape(),
                e => e.into(),
            })?;
        }
        use std::os::unix::ffi::OsStrExt;
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(rustix::fs::getpath(&fd)?.as_bytes()));
        if !path.starts_with(real_root) {
            return Err(escape());
        }
        Ok(Dir { _fd: fd, path })
    }

    #[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
    fn open_beneath(real_root: &str, relative: &str) -> io::Result<Dir> {
        let path = match relative {
            "" | "." => PathBuf::from(real_root),
            relative => std::fs::canonicalize(Path::new(real_root).join(relative))?,
        };
        if !path.starts_with(real_root) {
            return Err(escape());
        }
        if !std::fs::metadata(&path)?.is_dir() {
            return Err(io::Error::from(io::ErrorKind::NotADirectory));
        }
        Ok(Dir { path })
    }

    #[cfg(windows)]
    fn open_beneath(real_root: &str, relative: &str) -> io::Result<Dir> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE};
        let wanted = match relative {
            "" | "." => PathBuf::from(real_root),
            relative => Path::new(real_root).join(relative.replace('/', "\\")),
        };
        let pin = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&wanted)?;
        if !pin.metadata()?.is_dir() {
            return Err(io::Error::from(io::ErrorKind::NotADirectory));
        }
        let path = final_path(&pin)?;
        if !windows_inside(real_root, &path) {
            return Err(escape());
        }
        Ok(Dir { _pin: pin, path: PathBuf::from(path) })
    }
}

#[cfg(windows)]
pub(crate) fn final_path(file: &std::fs::File) -> io::Result<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, VOLUME_NAME_DOS};
    let mut buffer = vec![0u16; 1024];
    loop {
        let n = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle() as _, buffer.as_mut_ptr(), buffer.len() as u32, VOLUME_NAME_DOS) } as usize;
        if n == 0 {
            return Err(io::Error::last_os_error());
        }
        if n < buffer.len() {
            return Ok(String::from_utf16_lossy(&buffer[..n]));
        }
        buffer.resize(n + 1, 0);
    }
}

#[cfg(windows)]
pub(crate) fn windows_inside(real_root: &str, path: &str) -> bool {
    let trim = |p: &str| p.trim_end_matches('\\').to_lowercase();
    let (root, path) = (trim(real_root), trim(path));
    path == root || path.strip_prefix(&root).is_some_and(|rest| rest.starts_with('\\'))
}

pub(crate) fn rename_no_replace(from: (&Dir, &str), to: (&Dir, &str)) -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use rustix::fs::{RenameFlags, renameat_with};
        renameat_with(from.0.fd(), from.1, to.0.fd(), to.1, RenameFlags::NOREPLACE).map_err(io::Error::from)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
        let wide = |p: PathBuf| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
        let (a, b) = (wide(from.0.child(from.1)), wide(to.0.child(to.1)));
        match unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), MOVEFILE_WRITE_THROUGH) } {
            0 => Err(io::Error::last_os_error()),
            _ => Ok(()),
        }
    }
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
    {
        let target = to.0.child(to.1);
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(from.0.child(from.1), target)
    }
}

#[cfg(test)]
pub(crate) mod hook {
    use std::cell::RefCell;

    thread_local! {
        static BEFORE_OPEN: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
    }

    pub(crate) fn before_open(f: impl FnOnce() + 'static) {
        BEFORE_OPEN.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    }

    pub(super) fn run() {
        if let Some(f) = BEFORE_OPEN.with(|h| h.borrow_mut().take()) {
            f();
        }
    }
}
