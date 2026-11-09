use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LocalFree, STILL_ACTIVE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

pub const SUN_PATH: usize = 108;

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn os_error(what: &str) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(error.kind(), format!("{what}: {error}"))
}

struct Local<T>(*mut T);

impl<T> Drop for Local<T> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0.cast()) };
        }
    }
}

fn from_wide(text: *const u16) -> String {
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
}

pub fn user_sid() -> io::Result<String> {
    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(os_error("OpenProcessToken"));
    }
    let mut size = 0u32;
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size) };
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    let read = unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), size, &mut size) };
    unsafe { CloseHandle(token) };
    if read == 0 {
        return Err(os_error("GetTokenInformation"));
    }
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    let mut text = Local(null_mut::<u16>());
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text.0) } == 0 {
        return Err(os_error("ConvertSidToStringSidW"));
    }
    Ok(from_wide(text.0))
}

pub fn sddl(sid: &str) -> String {
    format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid})")
}

pub fn create_protected(path: &Path, sddl: &str) -> io::Result<()> {
    let text: Vec<u16> = OsStr::new(sddl).encode_wide().chain(Some(0)).collect();
    let mut descriptor = Local(null_mut::<core::ffi::c_void>());
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor.0, null_mut()) } == 0 {
        return Err(os_error("ConvertStringSecurityDescriptorToSecurityDescriptorW"));
    }
    let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
    if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
        return Err(os_error(&format!("cannot create {}", path.display())));
    }
    Ok(())
}

pub fn dacl(path: &Path) -> io::Result<String> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(wide(path).as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), null_mut(), null_mut(), &mut descriptor)
    };
    let descriptor = Local(descriptor);
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let mut text = Local(null_mut::<u16>());
    if unsafe { ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor.0, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text.0, null_mut()) } == 0 {
        return Err(os_error("ConvertSecurityDescriptorToStringSecurityDescriptorW"));
    }
    Ok(from_wide(text.0))
}

pub fn base(xdg_runtime: Option<&OsStr>, local_app_data: Option<&OsStr>) -> Option<PathBuf> {
    let root = xdg_runtime.filter(|dir| !dir.is_empty()).or(local_app_data.filter(|dir| !dir.is_empty()))?;
    Some(Path::new(root).join("acde").join("b"))
}

pub fn fits(dir: &Path) -> bool {
    dir.join("65535.sock").to_string_lossy().len() < SUN_PATH
}

pub fn generation_name() -> String {
    let mut bytes = [0u8; 3];
    _ = getrandom::fill(&mut bytes);
    format!("{}.{:02x}{:02x}{:02x}", std::process::id(), bytes[0], bytes[1], bytes[2])
}

pub fn alive(pid: u32) -> bool {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return unsafe { GetLastError() } == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    }
    let mut code = 0u32;
    let running = unsafe { GetExitCodeProcess(process, &mut code) } != 0 && code == STILL_ACTIVE as u32;
    unsafe { CloseHandle(process) };
    running
}

pub fn sweep(base: &Path, alive: impl Fn(u32) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some((pid, tag)) = name.to_str().and_then(|name| name.split_once('.')) else { continue };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        if tag.len() != 6 || !tag.bytes().all(|b| b.is_ascii_hexdigit()) || pid == std::process::id() || alive(pid) {
            continue;
        }
        if std::fs::remove_dir_all(entry.path()).is_ok() {
            removed.push(entry.path());
        }
    }
    removed
}
