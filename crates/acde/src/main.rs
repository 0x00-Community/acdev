mod app;
#[cfg(target_os = "linux")]
mod audio;
#[cfg(target_os = "linux")]
mod backend;
mod bind;
mod budget;
#[cfg(target_os = "linux")]
mod child;
#[cfg(target_os = "linux")]
mod desk;
mod dom;
mod engine;
#[cfg(target_os = "linux")]
mod fs;
mod host;
mod modules;
#[cfg(target_os = "linux")]
mod napi;
mod profile;
mod rt;
mod sys;
#[cfg(target_os = "linux")]
mod isolate;
#[cfg(target_os = "linux")]
mod network;
mod system;
mod devices;
mod bluetooth;
#[cfg(target_os = "linux")]
mod sound;
#[cfg(target_os = "linux")]
mod office;
#[cfg(target_os = "linux")]
mod power;
#[cfg(target_os = "linux")]
mod offload;
#[cfg(target_os = "linux")]
mod jsruntime;
#[cfg(target_os = "linux")]
mod supervise;
#[cfg(target_os = "linux")]
mod terminal;
#[cfg(target_os = "linux")]
mod own;
#[cfg(target_os = "linux")]
mod surface;
#[cfg(target_os = "linux")]
mod webgpu;
mod wire;
#[cfg(target_os = "linux")]
mod kernel;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

/// The session's display: its own Wayland socket. Inside another desktop (WAYLAND_DISPLAY set) acde shows itself in
/// a window of that desktop (the nested backend), which is told the host's display as `ACDE_HOST_DISPLAY`.
fn session_env() {
    let host = std::env::var("WAYLAND_DISPLAY").ok().filter(|d| !d.is_empty());
    let mut backend = std::env::var("ACDE_BACKEND").ok();
    if backend.is_none() && std::env::var_os("ACDE_SOCKET").is_none() && let Some(host) = &host {
        // SAFETY: still single-threaded, before anything reads the environment.
        unsafe {
            std::env::set_var("ACDE_HOST_DISPLAY", host);
            std::env::set_var("ACDE_BACKEND", "nested");
        }
        backend = Some("nested".into());
    }
    let outer = host.is_some() || std::env::var_os("DISPLAY").is_some();
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

#[cfg(target_os = "linux")]
fn session(args: &[String]) -> i32 {
    supervise::Supervisor::new(args).run()
}

#[cfg(not(target_os = "linux"))]
fn session(args: &[String]) -> i32 {
    sys::start(sys::Entry::Broker, args)
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
        Some("app") => app::main(&args[2..]),
        Some("run") if args.len() > 2 => sys::start(sys::Entry::Script(args[2].clone()), &args[3..]),
        Some("desktops" | "sessions" | "applications" | "open") => sys::start(sys::Entry::Broker, &args[1..]),
        #[cfg(target_os = "linux")]
        Some("runtime") => sys::start(sys::Entry::Broker, &args[2..]),
        #[cfg(target_os = "linux")]
        Some("jsruntime") => jsruntime::serve(),
        _ => {
            session_env();
            session(&args[1..])
        }
    };
    acde_log::flush();
    std::process::exit(code);
}
