use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole};
use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, ResumeThread, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

pub(crate) struct Master {
    console: HPCON,
    input: Mutex<File>,
}

unsafe impl Send for Master {}
unsafe impl Sync for Master {}

impl Master {
    pub(crate) fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut input = self.input.lock().map_err(|_| io::Error::other("terminal input lock"))?;
        input.write_all(bytes)
    }

    pub(crate) fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let result = unsafe { ResizePseudoConsole(self.console, size(cols, rows)?) };
        (result >= 0).then_some(()).ok_or_else(|| format!("ResizePseudoConsole: HRESULT {result:#x}"))
    }
}

impl Drop for Master {
    fn drop(&mut self) {
        unsafe { ClosePseudoConsole(self.console) };
    }
}

pub(crate) struct Child {
    process: OwnedHandle,
    job: OwnedHandle,
    pub(crate) pid: u32,
}

impl Child {
    pub(crate) fn wait(&self, millis: u32) -> Option<u32> {
        if unsafe { WaitForSingleObject(self.process.as_raw_handle() as HANDLE, millis) } != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.process.as_raw_handle() as HANDLE, &mut code) };
        Some(code)
    }

    pub(crate) fn kill_tree(&self) {
        unsafe { TerminateJobObject(self.job.as_raw_handle() as HANDLE, 1) };
    }
}

fn size(cols: u32, rows: u32) -> Result<COORD, String> {
    let side = |value: u32, name: &str| i16::try_from(value).ok().filter(|v| *v > 0).ok_or_else(|| format!("pty {name} must be 1..32767"));
    Ok(COORD { X: side(cols, "cols")?, Y: side(rows, "rows")? })
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

fn last_error(what: &str) -> String {
    format!("{what}: {}", io::Error::last_os_error())
}

fn pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let (mut read, mut write): (HANDLE, HANDLE) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok(unsafe { (OwnedHandle::from_raw_handle(read as _), OwnedHandle::from_raw_handle(write as _)) })
}

fn environment(extra: &[(&str, &str)]) -> Vec<u16> {
    let mut vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|(k, _)| !extra.iter().any(|(e, _)| e.eq_ignore_ascii_case(k)))
        .collect();
    vars.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    vars.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in vars {
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

pub(crate) fn spawn(command_line: &str, cwd: &Path, extra: &[(&str, &str)], cols: u32, rows: u32) -> Result<(Master, File, Child), String> {
    let coord = size(cols, rows)?;
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let mut console: HPCON = 0;
    let result = unsafe { CreatePseudoConsole(coord, input_read.as_raw_handle() as HANDLE, output_write.as_raw_handle() as HANDLE, 0, &mut console) };
    if result < 0 {
        return Err(format!("CreatePseudoConsole: HRESULT {result:#x}"));
    }
    drop((input_read, output_write));
    let master = Master { console, input: Mutex::new(File::from(input_write)) };
    match start(console, command_line, cwd, extra) {
        Ok(child) => Ok((master, File::from(output_read), child)),
        Err(error) => {
            drop(output_read);
            drop(master);
            Err(error)
        }
    }
}

fn start(console: HPCON, command_line: &str, cwd: &Path, extra: &[(&str, &str)]) -> Result<Child, String> {
    let mut bytes = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
    let mut list = vec![0u8; bytes];
    let attributes = list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut bytes) } == 0 {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let set =
        unsafe { UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize, console as _, size_of::<HPCON>(), null_mut(), null()) };
    if set == 0 {
        let error = last_error("UpdateProcThreadAttribute");
        unsafe { DeleteProcThreadAttributeList(attributes) };
        return Err(error);
    }
    let mut info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    info.lpAttributeList = attributes;
    let mut command = wide(OsStr::new(command_line));
    let directory = wide(cwd.as_os_str());
    let env = environment(extra);
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    let created = unsafe {
        CreateProcessW(null(), command.as_mut_ptr(), null(), null(), 0, flags, env.as_ptr().cast(), directory.as_ptr(), &info.StartupInfo, &mut process)
    };
    let error = (created == 0).then(|| last_error(&format!("CreateProcessW {command_line}")));
    unsafe { DeleteProcThreadAttributeList(attributes) };
    if let Some(error) = error {
        return Err(error);
    }
    let (process_handle, thread) = unsafe { (OwnedHandle::from_raw_handle(process.hProcess as _), OwnedHandle::from_raw_handle(process.hThread as _)) };
    let job = job().inspect_err(|_| unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(process_handle.as_raw_handle() as HANDLE, 1);
    })?;
    if unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, process_handle.as_raw_handle() as HANDLE) } == 0 {
        let error = last_error("AssignProcessToJobObject");
        unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process_handle.as_raw_handle() as HANDLE, 1) };
        return Err(error);
    }
    unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) };
    Ok(Child { process: process_handle, job, pid: process.dwProcessId })
}

fn job() -> Result<OwnedHandle, String> {
    let handle = unsafe { CreateJobObjectW(null(), null()) };
    if handle.is_null() {
        return Err(last_error("CreateJobObjectW"));
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set = unsafe {
        SetInformationJobObject(
            job.as_raw_handle() as HANDLE,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

fn expand(text: &str) -> String {
    let source = wide(OsStr::new(text));
    let needed = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), null_mut(), 0) };
    if needed == 0 {
        return text.to_owned();
    }
    let mut out = vec![0u16; needed as usize];
    let written = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), out.as_mut_ptr(), needed) };
    if written == 0 || written > needed {
        return text.to_owned();
    }
    String::from_utf16_lossy(&out[..written as usize - 1])
}

fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

fn on_path(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(program)).find(|p| p.is_file())
}

pub(crate) fn default_shell() -> String {
    let windows = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    terminal_profile()
        .or_else(|| on_path("pwsh.exe").map(|p| quoted(&p)))
        .or_else(|| Some(windows.join(r"System32\WindowsPowerShell\v1.0\powershell.exe")).filter(|p| p.is_file()).map(|p| quoted(&p)))
        .or_else(|| std::env::var("ComSpec").ok())
        .unwrap_or_else(|| quoted(&windows.join(r"System32\cmd.exe")))
}

fn terminal_profile() -> Option<String> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    let settings = [
        local.join(r"Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"),
        local.join(r"Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json"),
        local.join(r"Microsoft\Windows Terminal\settings.json"),
    ];
    settings.iter().find_map(|path| profile_command(&std::fs::read_to_string(path).ok()?))
}

pub(crate) fn profile_command(settings: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(&json_of(settings)).ok()?;
    let wanted = value.get("defaultProfile")?.as_str()?;
    let profiles = value.get("profiles")?;
    let list = profiles.get("list").unwrap_or(profiles).as_array()?;
    let profile = list.iter().find(|p| p.get("guid").and_then(|g| g.as_str()).is_some_and(|g| g.eq_ignore_ascii_case(wanted)))?;
    let command = profile.get("commandline")?.as_str()?.trim();
    (!command.is_empty()).then(|| expand(command))
}

fn json_of(jsonc: &str) -> String {
    let chars: Vec<char> = jsonc.trim_start_matches('\u{feff}').chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    let mut string = false;
    while i < chars.len() {
        let c = chars[i];
        if string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                string = false;
            }
        } else if c == '"' {
            string = true;
            out.push(c);
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        } else if c == ',' && chars[i + 1..].iter().find(|c| !c.is_whitespace()).is_some_and(|n| *n == '}' || *n == ']') {
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terminal_default_profile_gives_the_command_line() {
        let settings = r#"{
            // comment
            "defaultProfile": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
            "profiles": { "defaults": {}, "list": [
                { "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}", "commandline": "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", },
                /* the default */ { "guid": "{574E775E-4F2A-5B96-AC1E-A2962A402336}", "commandline": "pwsh.exe -NoLogo" },
            ] },
        }"#;
        assert_eq!(profile_command(settings).as_deref(), Some("pwsh.exe -NoLogo"));
        let dynamic = r#"{ "defaultProfile": "{a}", "profiles": [ { "guid": "{a}", "source": "Windows.Terminal.PowershellCore" } ] }"#;
        assert_eq!(profile_command(dynamic), None, "no command line: the next source decides");
    }
}
