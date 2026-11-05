use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, Write};
#[cfg(unix)]
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::sync::mpsc::{Sender, SyncSender, channel, sync_channel};
use std::time::Duration;

#[cfg(target_os = "linux")]
use rustix::io::Errno;
#[cfg(unix)]
use rustix::process::{self, Signal};

use crate::bind;
use crate::rt::{self, Msg};

struct Spawned {
    on_exit: v8::Global<v8::Function>,
    on_stdout: Option<v8::Global<v8::Function>>,
    input: Option<Sender<Vec<u8>>>,
}

thread_local! {
    static CHILDREN: RefCell<HashMap<u32, Spawned>> = RefCell::new(HashMap::new());
}

type Fork = (Command, SyncSender<std::io::Result<Child>>);

fn fork(command: Command) -> std::io::Result<Child> {
    static FORKER: OnceLock<Sender<Fork>> = OnceLock::new();
    let forker = FORKER.get_or_init(|| {
        let (tx, rx) = channel::<Fork>();
        let started = std::thread::Builder::new().name("acde-fork".into()).spawn(move || {
            for (mut command, reply) in rx {
                let spawned = command.spawn();
                drop(command);
                _ = reply.send(spawned);
            }
        });
        if let Err(e) = started {
            log::error!("cannot start the fork thread: {e}");
        }
        tx
    });
    let (reply, spawned) = sync_channel(1);
    forker.send((command, reply)).map_err(|_| std::io::Error::other("the fork thread is gone"))?;
    spawned.recv().map_err(|_| std::io::Error::other("the fork thread is gone"))?
}

pub fn spawn(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let argv = bind::strings(scope, args.get(0)).unwrap_or_default();
    let Some((program, rest)) = argv.split_first() else {
        return bind::throw_type_error(scope, "spawn: argv is not a non-empty array of strings");
    };
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(1)) else {
        return bind::throw_type_error(scope, "spawn: options is not an object");
    };
    let Ok(on_exit) = v8::Local::<v8::Function>::try_from(args.get(2)) else {
        return bind::throw_type_error(scope, "spawn: onExit is not a function");
    };
    let cwd = text(scope, options, "cwd");
    let prefix = text(scope, options, "prefix").unwrap_or_default();
    let on_stdout = bind::get(scope, options, "onStdout").and_then(|f| v8::Local::<v8::Function>::try_from(f).ok());
    let stdin = bind::get(scope, options, "stdin").is_some_and(|v| v.is_true());
    let env = match bind::get(scope, options, "env") {
        Some(env) => bind::own_string_pairs(scope, env),
        None => Vec::new(),
    };

    let (reader, writer) = match std::io::pipe() {
        Ok(pipe) => pipe,
        Err(e) => return bind::throw_error(scope, &format!("spawn {program}: {e}")),
    };
    let mut command = Command::new(program);
    command.args(rest).env_clear().envs(env).stdin(if stdin { Stdio::piped() } else { Stdio::null() });
    let out = match on_stdout {
        Some(_) => std::io::pipe().map(|(lines, out)| (Some(lines), out)),
        None => writer.try_clone().map(|out| (None, out)),
    };
    let lines = match out {
        Ok((lines, out)) => {
            command.stdout(out).stderr(writer);
            lines
        }
        Err(e) => return bind::throw_error(scope, &format!("spawn {program}: {e}")),
    };
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    detach(&mut command);
    let mut child = match fork(command) {
        Ok(child) => child,
        Err(e) => return bind::throw_error(scope, &format!("spawn {program}: {e}")),
    };
    let pid = child.id();
    adopt(&child);
    _ = std::thread::Builder::new().name("acde-child-out".into()).spawn(move || {
        for line in std::io::BufReader::new(reader).split(b'\n') {
            let Ok(line) = line else { break };
            log::info!("{prefix}{}", String::from_utf8_lossy(&line));
        }
    });
    let tx = rt::current().sender();
    let input = child.stdin.take().map(|mut input| {
        let (feed, fed) = channel::<Vec<u8>>();
        _ = std::thread::Builder::new().name("acde-child-in".into()).spawn(move || {
            for bytes in fed {
                if input.write_all(&bytes).is_err() {
                    break;
                }
            }
        });
        feed
    });
    let read = lines.map(|lines| {
        let (done, read) = sync_channel::<()>(1);
        let tx = tx.clone();
        _ = std::thread::Builder::new().name("acde-child-out".into()).spawn(move || {
            for line in std::io::BufReader::new(lines).split(b'\n') {
                let Ok(line) = line else { break };
                let line = String::from_utf8_lossy(&line).into_owned();
                _ = tx.send(Msg::Task(Box::new(move |scope| stdout_line(scope, pid, &line))));
            }
            _ = done.send(());
        });
        read
    });
    let waiter = std::thread::Builder::new().name("acde-child-wait".into()).spawn(move || {
        let status = child.wait().ok();
        if let Some(read) = read {
            _ = read.recv_timeout(Duration::from_secs(2));
        }
        let (code, signal) = (status.and_then(|s| s.code()), status.and_then(exit_signal));
        forget(pid);
        _ = tx.send(Msg::Task(Box::new(move |scope| exited(scope, pid, code, signal))));
    });
    if let Err(e) = waiter {
        return bind::throw_error(scope, &format!("spawn {program}: {e}"));
    }
    let on_exit = v8::Global::new(scope, on_exit);
    let on_stdout = on_stdout.map(|f| v8::Global::new(scope, f));
    CHILDREN.with(|c| c.borrow_mut().insert(pid, Spawned { on_exit, on_stdout, input }));
    rt::current().keep_alive(true);
    rv.set_uint32(pid);
}

fn stdout_line(scope: &mut v8::PinScope, pid: u32, line: &str) {
    let Some(callback) = CHILDREN.with(|c| c.borrow().get(&pid).and_then(|c| c.on_stdout.clone())) else { return };
    let line = bind::string(scope, line);
    bind::call(scope, callback, &[line.into()]);
}

pub fn write(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let pid = args.get(0).uint32_value(scope).unwrap_or(0);
    let text = bind::arg_string(scope, &args, 1);
    let sent = CHILDREN.with(|c| c.borrow().get(&pid).and_then(|c| c.input.as_ref()).is_some_and(|feed| feed.send(text.into_bytes()).is_ok()));
    rv.set_bool(sent);
}

pub fn end_input(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let pid = args.get(0).uint32_value(scope).unwrap_or(0);
    CHILDREN.with(|c| {
        if let Some(child) = c.borrow_mut().get_mut(&pid) {
            child.input = None;
        }
    });
}

fn exited(scope: &mut v8::PinScope, pid: u32, code: Option<i32>, signal: Option<i32>) {
    let Some(child) = CHILDREN.with(|c| c.borrow_mut().remove(&pid)) else { return };
    rt::current().keep_alive(false);
    let code: v8::Local<v8::Value> = match code {
        Some(code) => v8::Integer::new(scope, code).into(),
        None => v8::null(scope).into(),
    };
    let signal: v8::Local<v8::Value> = match signal {
        Some(signal) => v8::Integer::new(scope, signal).into(),
        None => v8::null(scope).into(),
    };
    bind::call(scope, child.on_exit, &[code, signal]);
}

fn text(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str) -> Option<String> {
    bind::get(scope, obj, name).filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope))
}

static GROUPS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn forget(pid: u32) {
    GROUPS.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| *p != pid);
}

#[cfg(unix)]
fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_: std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(target_os = "linux")]
fn detach(command: &mut Command) {
    let parent = process::getpid();
    unsafe {
        command.pre_exec(move || {
            process::setsid()?;
            process::set_parent_process_death_signal(Some(Signal::TERM))?;
            if process::getppid() != Some(parent) {
                return Err(Errno::SRCH.into());
            }
            Ok(())
        });
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn detach(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            process::setsid()?;
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(target_os = "linux")]
fn adopt(_: &Child) {}

#[cfg(all(unix, not(target_os = "linux")))]
fn adopt(child: &Child) {
    GROUPS.lock().unwrap_or_else(|e| e.into_inner()).push(child.id());
}

#[cfg(windows)]
fn adopt(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    struct Job(windows_sys::Win32::Foundation::HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    static JOB: OnceLock<Option<Job>> = OnceLock::new();
    let job = JOB.get_or_init(|| {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return None;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        let set = unsafe { SetInformationJobObject(handle, JobObjectExtendedLimitInformation, (&raw const limits).cast(), size) };
        (set != 0).then_some(Job(handle))
    });
    if let Some(job) = job {
        unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as _) };
    }
}

pub fn stop_all() {
    #[cfg(all(unix, not(target_os = "linux")))]
    for pid in std::mem::take(&mut *GROUPS.lock().unwrap_or_else(|e| e.into_inner())) {
        if let Some(group) = process::Pid::from_raw(pid as i32) {
            _ = process::kill_process_group(group, Signal::TERM);
        }
    }
}
