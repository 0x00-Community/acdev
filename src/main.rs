mod chooser;
mod doctor;
mod hostnative;
mod platform;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const USAGE: &str = "\
usage: acdebin-dbg app <id> | desktop <id|dir> [options]
       acdebin-dbg desktops [--desktop <id>] [--package <dir>]
       acdebin-dbg sessions <dir> [--package <dir>]
       acdebin-dbg applications <dir> [--package <dir>] [--exec <program>]
       acdebin-dbg open [--app <id>] <path|uri>...
       acdebin-dbg run <file> [args...]
       acdebin-dbg doctor [--json]
       acdebin-dbg --version | --help

app <id> opens one app and desktop <id|dir> a desktop, each in a host window (what acdev dev runs).
doctor checks what that needs here (host files, GPU, display) and exits 1 when something is missing.

Options:
  --desktop <id|dir>   the desktop to start (else ACDE_DESKTOP, else the last one, else the first installed)
  --size <W>x<H>       the size of the desktop's host window (default 1440x900)
  --scale <n>          the scale (default 1)
  --seconds <n>        end after n seconds
  -V, --version        print the version and contract level
  -h, --help           print this help
";

#[cfg(target_os = "linux")]
fn outer() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_some() || acde_hostwin::headless()
}

fn hosted(args: &[String], platform: acdert::Shared) -> i32 {
    let args = args.to_vec();
    acde_hostwin::run(move || acdert::start(acdert::Entry::Broker, &args, platform))
}

fn main() {
    acdert::log::init();
    let args: Vec<String> = std::env::args().collect();
    let platform: acdert::Shared = std::sync::Arc::new(platform::Host);
    let code = match args.get(1).map(String::as_str) {
        Some("--version" | "-V") => {
            println!("{}", acdert::version("acdebin-dbg"));
            0
        }
        Some("--help" | "-h") | None => {
            print!("{USAGE}");
            0
        }
        Some("doctor") => doctor::run(&args[2..]),
        _ => acdert::common(&args, &platform).unwrap_or_else(|| hosted(&args[1..], platform)),
    };
    acdert::exit(code);
}
