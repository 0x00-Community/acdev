#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const USAGE: &str = "\
usage: acdert [options]
       acdert desktops [--desktop <id>] [--package <dir>]
       acdert sessions <dir> [--package <dir>]
       acdert applications <dir> [--package <dir>] [--exec <program>]
       acdert open [--app <id>] <path|uri>...
       acdert run <file> [args...]
       acdert --version | --help

Without a command acdert runs the session (on Linux without WAYLAND_DISPLAY or DISPLAY: the screen through DRM/KMS).
Apps and desktops in a host window (what acde dev runs) are acde-dbg's.

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

#[cfg(target_os = "linux")]
fn session_env() {
    let outer = ["WAYLAND_DISPLAY", "DISPLAY"].iter().any(|name| std::env::var_os(name).is_some())
        || std::env::var("ACDE_HEADLESS").is_ok_and(|v| !v.is_empty() && v != "0");
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

#[cfg(target_os = "linux")]
fn free_socket(runtime: &std::path::Path, name: &str) -> bool {
    use rustix::fs::{FlockOperation, flock};
    let lock = runtime.join(format!("{name}.lock"));
    let Ok(file) = std::fs::OpenOptions::new().read(true).open(&lock) else {
        return !runtime.join(name).exists() || !lock.exists();
    };
    flock(&file, FlockOperation::NonBlockingLockExclusive).is_ok()
}

#[cfg(target_os = "linux")]
fn session(args: &[String], platform: acdert::Shared) -> i32 {
    match args.get(1).map(String::as_str) {
        Some("runtime") => acdert::start(acdert::Entry::Broker, &args[2..], platform),
        _ => {
            session_env();
            acdert::Supervisor::new(&args[1..]).run()
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn session(_: &[String], _: acdert::Shared) -> i32 {
    log::error!("the session runs on Linux; apps and desktops in a host window are acde-dbg's");
    2
}

fn main() {
    acde_log::init();
    let args: Vec<String> = std::env::args().collect();
    let platform: acdert::Shared = cfg_select! {
        target_os = "linux" => std::sync::Arc::new(acdert::Session),
        _ => std::sync::Arc::new(acdert::Headless),
    };
    let code = match args.get(1).map(String::as_str) {
        Some("--version" | "-V") => {
            println!("{}", acdert::version("acdert"));
            0
        }
        Some("--help" | "-h") => {
            print!("{USAGE}");
            0
        }
        _ => acdert::common(&args, &platform).unwrap_or_else(|| session(&args, platform)),
    };
    acdert::exit(code);
}
