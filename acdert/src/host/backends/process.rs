use std::ffi::{OsStr, c_void};
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

const FOPEN: u8 = 0x01;
const FPIPE: u8 = 0x08;

pub struct Owned(HANDLE);

unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Owned {
    fn new(handle: HANDLE, what: &str) -> io::Result<Self> {
        if handle.is_null() { Err(last_error(what)) } else { Ok(Self(handle)) }
    }

    fn into_file(self) -> File {
        let handle = self.0;
        std::mem::forget(self);
        unsafe { File::from_raw_handle(handle) }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn last_error(what: &str) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(error.kind(), format!("{what}: {error}"))
}

fn check(ok: i32, what: &str) -> io::Result<()> {
    if ok == 0 { Err(last_error(what)) } else { Ok(()) }
}

pub struct Process {
    pub pid: u32,
    process: Owned,
    job: Owned,
}

impl Process {
    pub fn wait(&self, ms: Option<u32>) -> Option<i32> {
        match unsafe { WaitForSingleObject(self.process.0, ms.unwrap_or(INFINITE)) } {
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                (unsafe { GetExitCodeProcess(self.process.0, &mut code) } != 0).then_some(code as i32)
            }
            WAIT_TIMEOUT => None,
            _ => Some(-1),
        }
    }

    pub fn terminate(&self) {
        unsafe { TerminateJobObject(self.job.0, 1) };
    }
}

pub struct Started {
    pub process: Process,
    pub to_backend: File,
    pub from_backend: File,
    pub log: File,
}

pub struct Spec<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: Option<&'a str>,
    pub env: &'a [(String, String)],
}

fn pipe() -> io::Result<(Owned, Owned)> {
    let (mut read, mut write): (HANDLE, HANDLE) = (null_mut(), null_mut());
    let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
    check(unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) }, "CreatePipe")?;
    Ok((Owned(read), Owned(write)))
}

fn private(end: &Owned) -> io::Result<()> {
    check(unsafe { SetHandleInformation(end.0, HANDLE_FLAG_INHERIT, 0) }, "SetHandleInformation")
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '"']) {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

pub fn environment(env: &[(String, String)]) -> Vec<u16> {
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort_by_key(|(key, _)| key.to_uppercase());
    let mut block: Vec<u16> = sorted.iter().flat_map(|(key, value)| wide(&format!("{key}={value}"))).collect();
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    block
}

fn crt_fds(fds: &[(u8, HANDLE)]) -> Vec<u8> {
    let mut block = Vec::with_capacity(size_of::<u32>() + fds.len() * (1 + size_of::<HANDLE>()));
    block.extend_from_slice(&(fds.len() as u32).to_ne_bytes());
    block.extend(fds.iter().map(|(flags, _)| *flags));
    for (_, handle) in fds {
        block.extend_from_slice(&(*handle as usize).to_ne_bytes());
    }
    block
}

struct Attributes {
    list: Vec<usize>,
    handles: Box<[HANDLE]>,
}

impl Attributes {
    fn handles(handles: &[HANDLE]) -> io::Result<Self> {
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        let mut list = Self { list: vec![0usize; size.div_ceil(size_of::<usize>())], handles: handles.into() };
        check(unsafe { InitializeProcThreadAttributeList(list.ptr(), 1, 0, &mut size) }, "InitializeProcThreadAttributeList")?;
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                list.handles.as_ptr() as *const c_void,
                size_of_val(&*list.handles),
                null_mut(),
                null_mut(),
            )
        };
        if updated == 0 {
            let error = last_error("UpdateProcThreadAttribute");
            unsafe { DeleteProcThreadAttributeList(list.ptr()) };
            list.list.clear();
            return Err(error);
        }
        Ok(list)
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        if !self.list.is_empty() {
            unsafe { DeleteProcThreadAttributeList(self.ptr()) };
        }
    }
}

fn job() -> io::Result<Owned> {
    let job = Owned::new(unsafe { CreateJobObjectW(null(), null()) }, "CreateJobObjectW")?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
    check(unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&raw const limits).cast(), size) }, "SetInformationJobObject")?;
    Ok(job)
}

pub fn start(spec: &Spec) -> io::Result<Started> {
    let (child_reads, to_backend) = pipe()?;
    let (from_backend, child_writes) = pipe()?;
    let (log, child_logs) = pipe()?;
    private(&to_backend)?;
    private(&from_backend)?;
    private(&log)?;
    let job = job()?;

    let mut fds = crt_fds(&[
        (0, null_mut()),
        (FOPEN | FPIPE, child_logs.0),
        (FOPEN | FPIPE, child_logs.0),
        (FOPEN | FPIPE, child_reads.0),
        (FOPEN | FPIPE, child_writes.0),
    ]);
    let mut attributes = Attributes::handles(&[child_reads.0, child_writes.0, child_logs.0])?;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdOutput = child_logs.0;
    startup.StartupInfo.hStdError = child_logs.0;
    startup.StartupInfo.cbReserved2 = fds.len() as u16;
    startup.StartupInfo.lpReserved2 = fds.as_mut_ptr();
    startup.lpAttributeList = attributes.ptr();

    let command = std::iter::once(spec.program).chain(spec.args.iter().map(String::as_str)).map(quote).collect::<Vec<_>>().join(" ");
    let mut command = wide(&command);
    let application = wide(spec.program);
    let environment = environment(spec.env);
    let cwd = spec.cwd.map(wide);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            flags,
            environment.as_ptr() as *const c_void,
            cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
            &startup as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut info,
        )
    };
    check(created, &format!("CreateProcessW {}", spec.program))?;
    drop(attributes);
    drop((child_reads, child_writes, child_logs));
    let process = Owned(info.hProcess);
    let thread = Owned(info.hThread);
    if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
        let error = last_error("AssignProcessToJobObject");
        unsafe { TerminateProcess(process.0, 1) };
        return Err(error);
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let error = last_error("ResumeThread");
        unsafe { TerminateJobObject(job.0, 1) };
        return Err(error);
    }
    Ok(Started {
        process: Process { pid: info.dwProcessId, process, job },
        to_backend: to_backend.into_file(),
        from_backend: from_backend.into_file(),
        log: log.into_file(),
    })
}
