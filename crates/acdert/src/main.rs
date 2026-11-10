mod audio;
mod backend;
#[cfg(windows)]
mod backends;
mod bind;
mod caches;
mod capture;
mod child;
mod chooser;
mod dom;
mod encoding;
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

const USAGE: &str = "\
usage: acdert [app <id> | desktop <id|dir>] [options]
       acdert desktops [--desktop <id>] [--package <dir>]
       acdert sessions <dir> [--package <dir>]
       acdert applications <dir> [--package <dir>] [--exec <program>]
       acdert open [--app <id>] <path|uri>...
       acdert run <file> [args...]
       acdert --version | --help

Without a command acdert runs the session (on Linux without WAYLAND_DISPLAY or DISPLAY: the screen through DRM/KMS).
app <id> opens one app and desktop <id|dir> a desktop, each in a host window (what acde dev runs).

Options:
  --desktop <id|dir>   the desktop to start (else ACDE_DESKTOP, else the last one, else the first installed)
  --size <W>x<H>       the screen size of the session (default 1440x900)
  --scale <n>          the scale of the session (default 1)
  --launch <command>   start a program in the session (repeatable)
  --seconds <n>        end after n seconds
  --stats              print the compositor's statistics at exit
  --greeter            the login screen (greetd's greeter)
  -V, --version        print the version and contract level
  -h, --help           print this help
";

const API_LEVEL: u32 = api_level(include_str!("../../../web/packages/acde-api/src/runtime/level.js"));

const fn api_level(source: &str) -> u32 {
    let bytes = source.as_bytes();
    let (mut i, mut level, mut digits) = (0, 0u32, 0);
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            level = level * 10 + (bytes[i] - b'0') as u32;
            digits += 1;
        } else if digits > 0 {
            break;
        }
        i += 1;
    }
    assert!(level > 0, "acde-api src/runtime/level.js defines no positive API_LEVEL");
    level
}

fn main() {
    acde_log::init();
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("--version" | "-V") => {
            println!("acdert {} (contract level {API_LEVEL})", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("--help" | "-h") => {
            print!("{USAGE}");
            0
        }
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
