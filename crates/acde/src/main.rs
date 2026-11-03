mod app;
#[cfg(target_os = "linux")]
mod audio;
#[cfg(target_os = "linux")]
mod backend;
mod bind;
#[cfg(target_os = "linux")]
mod child;
mod dom;
mod engine;
mod host;
mod modules;
#[cfg(target_os = "linux")]
mod napi;
mod profile;
mod rt;
mod sys;
mod web;
#[cfg(target_os = "linux")]
mod webnative;
#[cfg(target_os = "linux")]
mod webgpu;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

fn session_env() {
    let outer = std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_some();
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
        Some("web") => web::main(&args[2..]),
        Some("app") => app::main(&args[2..]),
        Some("run") if args.len() > 2 => sys::start(sys::Entry::Script(args[2].clone()), &args[3..]),
        Some("desktops" | "sessions" | "applications" | "open") => sys::start(sys::Entry::Broker, &args[1..]),
        _ => {
            session_env();
            sys::start(sys::Entry::Broker, &args[1..])
        }
    };
    acde_log::flush();
    std::process::exit(code);
}
