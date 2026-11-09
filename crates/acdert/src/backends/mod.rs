mod process;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use acde_runtime::channel::{self, Mux};

use crate::bind::{self, IntoJs};
use crate::rt::{self, Msg};
use process::{Process, Spec};

const TRANSPORT: &[&str] = &["ACDE_APP_CHANNEL", "ACDE_APP_SOCKETS", "ACDE_APP_CONTROL"];
const SYSTEM: &[&str] = &["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "USERNAME", "PATHEXT", "ComSpec"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Channel,
    Sockets,
}

struct Running {
    app: String,
    mode: Mode,
    process: Process,
    mux: Arc<Mux>,
}

static RUNNING: LazyLock<Mutex<HashMap<u32, Arc<Running>>>> = LazyLock::new(Mutex::default);

thread_local! {
    static EXITS: RefCell<HashMap<u32, v8::Global<v8::Function>>> = RefCell::default();
}

fn running() -> MutexGuard<'static, HashMap<u32, Arc<Running>>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn environment(given: Vec<(String, String)>, transport: &[(&str, String)], system: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = given.into_iter().filter(|(key, _)| !TRANSPORT.iter().any(|t| same(t, key))).collect();
    env.extend(transport.iter().map(|(key, value)| (key.to_string(), value.clone())));
    for key in SYSTEM {
        if !env.iter().any(|(have, _)| same(have, key))
            && let Some(value) = system(key)
        {
            env.push((key.to_string(), value));
        }
    }
    env
}

fn finish(pid: u32) {
    let Some(running) = running().remove(&pid) else { return };
    if running.mode == Mode::Channel {
        channel::unregister(&running.app, &running.mux);
    }
    running.mux.close("the backend has exited");
    running.process.terminate();
}

pub fn spawn(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let argv = bind::strings(scope, args.get(0)).unwrap_or_default();
    let Some((program, rest)) = argv.split_first() else {
        return bind::throw_type_error(scope, "spawnBackend: argv is not a non-empty array of strings");
    };
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(1)) else {
        return bind::throw_type_error(scope, "spawnBackend: options is not an object");
    };
    let Ok(on_exit) = v8::Local::<v8::Function>::try_from(args.get(2)) else {
        return bind::throw_type_error(scope, "spawnBackend: onExit is not a function");
    };
    let Some(app) = bind::get_string(scope, options, "app").filter(|app| !app.is_empty()) else {
        return bind::throw_type_error(scope, "spawnBackend: options.app is missing");
    };
    let mode = match bind::get_string(scope, options, "mode").as_deref() {
        Some("channel") => Mode::Channel,
        Some("sockets") => Mode::Sockets,
        _ => return bind::throw_type_error(scope, "spawnBackend: options.mode is 'channel' or 'sockets'"),
    };
    let sockets = bind::get_string(scope, options, "sockets");
    if mode == Mode::Sockets && sockets.is_none() {
        return bind::throw_type_error(scope, "spawnBackend: options.sockets is missing");
    }
    let cwd = bind::get_string(scope, options, "cwd");
    let prefix = bind::get_string(scope, options, "prefix").unwrap_or_default();
    let given = bind::get(scope, options, "env").map(|env| bind::own_string_pairs(scope, env)).unwrap_or_default();
    let transport = match (mode, &sockets) {
        (Mode::Channel, _) => vec![("ACDE_APP_CHANNEL", "fd".to_owned())],
        (Mode::Sockets, sockets) => vec![("ACDE_APP_SOCKETS", sockets.clone().unwrap_or_default()), ("ACDE_APP_CONTROL", "fd".to_owned())],
    };
    let env = environment(given, &transport, |key| std::env::var(key).ok());
    let started = process::start(&Spec { program, args: rest, cwd: cwd.as_deref(), env: &env });
    let started = match started {
        Ok(started) => started,
        Err(e) => return bind::throw_error(scope, &format!("spawn {program}: {e}")),
    };
    let pid = started.process.pid;
    let mux = match Mux::start(started.to_backend, started.from_backend) {
        Ok(mux) => mux,
        Err(e) => {
            started.process.terminate();
            return bind::throw_error(scope, &format!("spawn {program}: {e}"));
        }
    };
    if mode == Mode::Channel {
        channel::register(&app, mux.clone());
    }
    _ = crate::child::each_line(started.log, move |line| log::info!("{prefix}{line}"));
    let backend = Arc::new(Running { app, mode, process: started.process, mux });
    running().insert(pid, backend.clone());
    let tx = rt::current().sender();
    let waiter = std::thread::Builder::new().name("acde-backend-wait".into()).spawn(move || {
        let code = backend.process.wait(None);
        drop(backend);
        finish(pid);
        _ = tx.send(Msg::Task(Box::new(move |scope| exited(scope, pid, code))));
    });
    if let Err(e) = waiter {
        finish(pid);
        return bind::throw_error(scope, &format!("spawn {program}: {e}"));
    }
    let on_exit = v8::Global::new(scope, on_exit);
    EXITS.with(|exits| exits.borrow_mut().insert(pid, on_exit));
    rt::current().keep_alive(true);
    rv.set_uint32(pid);
}

fn exited(scope: &mut v8::PinScope, pid: u32, code: Option<i32>) {
    let Some(on_exit) = EXITS.with(|exits| exits.borrow_mut().remove(&pid)) else { return };
    rt::current().keep_alive(false);
    let (code, signal) = (code.js(scope), None::<i32>.js(scope));
    bind::call(scope, on_exit, &[code, signal]);
}
