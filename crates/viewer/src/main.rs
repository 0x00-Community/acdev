mod display;
mod keys;
mod qmp;
mod window;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use winit::event_loop::EventLoop;

const USAGE: &str = "usage: acdev-viewer --qmp QMP_SOCKET [--title TITLE]   (show a QEMU guest started with -display dbus,p2p=yes)
       acdev-viewer --qmp QMP_SOCKET --outputs N        (no window: switch the guest's displays 1 to N-1 on, then exit)";

struct Stderr;

impl log::Log for Stderr {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        let ours = metadata.target().starts_with("acdev_viewer");
        metadata.level() <= if ours { log::max_level() } else { log::LevelFilter::Warn }
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("acdev-viewer: [{}] {}", record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: Stderr = Stderr;

fn start_logging() {
    let debug = std::env::var_os("ACDEV_VIEWER_DEBUG").is_some();
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(if debug { log::LevelFilter::Debug } else { log::LevelFilter::Info });
}

struct Args {
    qmp: PathBuf,
    title: String,
    outputs: Option<u32>,
}

fn args() -> Result<Args, String> {
    let mut qmp = None;
    let mut title = String::from("acdev");
    let mut outputs = None;
    let mut given = std::env::args().skip(1);
    while let Some(flag) = given.next() {
        match (flag.as_str(), given.next()) {
            ("--qmp", Some(path)) => qmp = Some(PathBuf::from(path)),
            ("--title", Some(text)) => title = text,
            ("--outputs", Some(count)) => outputs = Some(count.parse().map_err(|_| format!("acdev-viewer: --outputs {count}: a count"))?),
            _ => return Err(USAGE.into()),
        }
    }
    Ok(Args { qmp: qmp.ok_or(USAGE)?, title, outputs })
}

#[cfg(target_os = "linux")]
fn on_wslg() -> bool {
    let asked = std::env::var_os("ACDEV_VIEWER_WAYLAND").is_some();
    !asked && std::env::var_os("DISPLAY").is_some() && std::path::Path::new("/mnt/wslg").is_dir()
}

fn switch_on(args: &Args, outputs: u32) -> Result<(), String> {
    let stream = qmp::open_display(&args.qmp).map_err(|e| format!("acdev-viewer: {}: {e}", args.qmp.display()))?;
    display::switch_on(stream, outputs).map_err(|e| format!("acdev-viewer: D-Bus display: {e}"))
}

fn run() -> Result<(), String> {
    let args = args()?;
    if let Some(outputs) = args.outputs {
        return switch_on(&args, outputs);
    }
    let mut builder = EventLoop::<display::Event>::with_user_event();
    #[cfg(target_os = "linux")]
    if on_wslg() {
        log::info!("WSLg: using X11 (its Wayland compositor crashes on this window; ACDEV_VIEWER_WAYLAND=1 to try Wayland)");
        winit::platform::x11::EventLoopBuilderExtX11::with_x11(&mut builder);
    }
    let event_loop = builder.build().map_err(|e| format!("acdev-viewer: event loop: {e}"))?;
    let stream = qmp::open_display(&args.qmp).map_err(|e| format!("acdev-viewer: {}: {e}", args.qmp.display()))?;
    let frame = Arc::new(Mutex::new(display::Frame::default()));
    let display = display::connect(stream, frame.clone(), event_loop.create_proxy()).map_err(|e| format!("acdev-viewer: D-Bus display: {e}"))?;
    let mut viewer = window::Viewer::new(args.title, frame, display.inputs.clone());
    event_loop.run_app(&mut viewer).map_err(|e| format!("acdev-viewer: {e}"))?;
    drop(display);
    Ok(())
}

fn main() -> ExitCode {
    start_logging();
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}
