use super::beneath::Dir;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, ErrorKind, Write};

pub(crate) fn version(file: &File) -> io::Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = file.metadata()?;
        Ok(format!("{}-{}.{:09}-{}.{}", info.size(), info.mtime(), info.mtime_nsec(), info.dev(), info.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let join = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
        let size = join(info.nFileSizeHigh, info.nFileSizeLow);
        let written = join(info.ftLastWriteTime.dwHighDateTime, info.ftLastWriteTime.dwLowDateTime);
        let index = join(info.nFileIndexHigh, info.nFileIndexLow);
        Ok(format!("{size}-{written}-{}.{index}", info.dwVolumeSerialNumber))
    }
}

pub(crate) enum Saved {
    Replaced,
    InPlace,
}

pub(crate) fn save(dir: &Dir, name: &str, data: &[u8], mut original: File, info: &Metadata) -> io::Result<Saved> {
    let temp = format!(".{name}.{}.acde-save", uuid::Uuid::new_v4().simple());
    let mut file = match super::workspace::WorkspaceFs::no_follow(OpenOptions::new().write(true).create_new(true), dir.child(&temp), false) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            original.set_len(0)?;
            original.write_all(data)?;
            original.sync_all()?;
            return Ok(Saved::InPlace);
        }
        Err(error) => return Err(error),
    };
    drop(original);
    let written = file.write_all(data).and_then(|()| keep(&file, info)).and_then(|()| file.sync_all()).and_then(|()| interrupted());
    drop(file);
    let replaced = written.and_then(|()| replace(dir, &temp, name));
    if let Err(error) = replaced {
        _ = std::fs::remove_file(dir.child(&temp));
        return Err(error);
    }
    Ok(Saved::Replaced)
}

#[cfg(unix)]
pub(super) fn keep(file: &File, info: &Metadata) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    file.set_permissions(info.permissions())?;
    _ = rustix::fs::fchown(file, Some(rustix::fs::Uid::from_raw(info.uid())), Some(rustix::fs::Gid::from_raw(info.gid())));
    Ok(())
}

#[cfg(windows)]
pub(super) fn keep(_: &File, _: &Metadata) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(super) fn replace(dir: &Dir, temp: &str, name: &str) -> io::Result<()> {
    std::fs::rename(dir.child(temp), dir.child(name))?;
    File::open(dir.path())?.sync_all()
}

#[cfg(windows)]
pub(super) fn replace(dir: &Dir, temp: &str, name: &str) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{REPLACEFILE_IGNORE_MERGE_ERRORS, ReplaceFileW};
    let wide = |name: &str| dir.child(name).as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (target, source) = (wide(name), wide(temp));
    let flags = REPLACEFILE_IGNORE_MERGE_ERRORS;
    match unsafe { ReplaceFileW(target.as_ptr(), source.as_ptr(), std::ptr::null(), flags, std::ptr::null(), std::ptr::null()) } {
        0 => Err(io::Error::last_os_error()),
        _ => Ok(()),
    }
}

#[cfg(not(test))]
fn interrupted() -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
fn interrupted() -> io::Result<()> {
    match hook::INTERRUPT.with(|i| i.replace(false)) {
        true => Err(io::Error::other("interrupted by the test")),
        false => Ok(()),
    }
}

#[cfg(test)]
pub(crate) mod hook {
    use std::cell::Cell;

    thread_local! {
        pub(super) static INTERRUPT: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn interrupt_next_save() {
        INTERRUPT.with(|i| i.set(true));
    }
}
