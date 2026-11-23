mod chooser;
mod doctor;
mod hostnative;
mod platform;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[cfg(target_os = "macos")]
#[global_allocator]
static ALLOCATOR: acde::memory::Alloc = acde::memory::Alloc;

#[cfg(target_os = "macos")]
#[used]
#[unsafe(link_section = "__TEXT,__info_plist")]
static INFO_PLIST: [u8; include_bytes!("Info.plist").len()] = *include_bytes!("Info.plist");

const USAGE: &str = "\
usage: acdev app <id> | desktop <id|dir> [options]
       acdev desktops [--desktop <id>] [--package <dir>]
       acdev sessions <dir> [--package <dir>]
       acdev applications <dir> [--package <dir>] [--exec <program>]
       acdev open [--app <id>] <path|uri>...
       acdev run <file> [args...]
       acdev doctor [--json]
       acdev --version | --help

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

fn hosted(args: &[String], platform: acde::Shared) -> i32 {
    let args = args.to_vec();
    acde_hostwin::run(move || acde::start(acde::Entry::Broker, &args, platform))
}

fn main() {
    acde::log::init();
    let args: Vec<String> = std::env::args().collect();
    let platform: acde::Shared = std::sync::Arc::new(platform::Host);
    let code = match args.get(1).map(String::as_str) {
        Some("--version" | "-V") => {
            println!("{}", acde::version("acdev"));
            0
        }
        Some("--help" | "-h") | None => {
            print!("{USAGE}");
            0
        }
        Some("doctor") => doctor::run(&args[2..]),
        _ => acde::common(&args, &platform).unwrap_or_else(|| hosted(&args[1..], platform)),
    };
    acde::exit(code);
}
