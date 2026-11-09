mod audio;
mod backend;
mod bind;
mod caches;
mod child;
mod chooser;
mod dom;
mod engine;
mod fs;
mod host;
mod hostnative;
mod idb;
mod inspector;
mod modules;
mod napi;
#[cfg(target_os = "linux")]
mod network;
#[cfg(target_os = "linux")]
mod office;
mod offload;
mod picker;
mod profile;
mod rt;
mod storage;
#[cfg(target_os = "linux")]
mod supervise;
mod surface;
mod sys;
#[cfg(unix)]
mod terminal;
mod web;
#[cfg(target_os = "linux")]
mod webgpu;
mod webnative;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[cfg(target_os = "linux")]
fn session_env() {
    let outer = std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_some() || acde_hostwin::headless();
    let backend = std::env::var("ACDE_BACKEND").ok();
    if outer && backend.is_none() {
        return;
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| "/tmp".into());
    let chosen = std::env::var("ACDE_SOCKET").ok().filter(|name| !name.is_empty());
    let Some(name) = chosen.or_else(|| (1..32).map(|n| format!("wayland-{n}")).find(|name| free_socket(&runtime, name))) else {
        return;
    };
    unsafe {
        if backend.is_none() {
            std::env::set_var("ACDE_BACKEND", "drm");
        }
        std::env::set_var("ACDE_SOCKET", &name);
        std::env::set_var("WAYLAND_DISPLAY", &name);
        std::env::set_var("XDG_SESSION_TYPE", "wayland");
        std::env::set_var("XDG_CURRENT_DESKTOP", "acde");
        std::env::remove_var("DISPLAY");
    }
}

fn hosted_session(args: &[String]) -> i32 {
    let args = args.to_vec();
    acde_hostwin::run(move || sys::start(sys::Entry::Broker, &args))
}

#[cfg(target_os = "linux")]
fn session(args: &[String]) -> i32 {
    let debug = matches!(args.first().map(String::as_str), Some("app" | "desktop"));
    let outer = std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_some() || acde_hostwin::headless();
    if debug && outer && std::env::var_os("ACDE_BACKEND").is_none() {
        return hosted_session(args);
    }
    supervise::Supervisor::new(args).run()
}

#[cfg(not(target_os = "linux"))]
fn session(args: &[String]) -> i32 {
    hosted_session(args)
}

#[cfg(target_os = "linux")]
fn free_socket(runtime: &std::path::Path, name: &str) -> bool {
    use rustix::fs::{FlockOperation, flock};
    let lock = runtime.join(format!("{name}.lock"));
    let Ok(file) = std::fs::OpenOptions::new().read(true).open(&lock) else {
        return !runtime.join(name).exists() || !lock.exists();
    };
    flock(&file, FlockOperation::NonBlockingLockExclusive).is_ok()
}

fn main() {
    acde_log::init();
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("run") if args.len() > 2 => sys::start(sys::Entry::Script(args[2].clone()), &args[3..]),
        Some("desktops" | "sessions" | "applications" | "open") => sys::start(sys::Entry::Broker, &args[1..]),
        #[cfg(target_os = "linux")]
        Some("runtime") => sys::start(sys::Entry::Broker, &args[2..]),
        _ => {
            #[cfg(target_os = "linux")]
            session_env();
            session(&args[1..])
        }
    };
    child::stop_all();
    acde_storage::flush_all();
    acde_log::flush();
    std::process::exit(code);
}
