mod display;
mod keys;
mod qmp;
mod window;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use winit::event_loop::EventLoop;

const USAGE: &str = "usage: acdev-viewer --qmp QMP_SOCKET [--title TITLE]   (show a QEMU guest started with -display dbus,p2p=yes)";

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
}

fn args() -> Result<Args, String> {
    let mut qmp = None;
    let mut title = String::from("acdev");
    let mut given = std::env::args().skip(1);
    while let Some(flag) = given.next() {
        match (flag.as_str(), given.next()) {
            ("--qmp", Some(path)) => qmp = Some(PathBuf::from(path)),
            ("--title", Some(text)) => title = text,
            _ => return Err(USAGE.into()),
        }
    }
    Ok(Args { qmp: qmp.ok_or(USAGE)?, title })
}

fn run() -> Result<(), String> {
    let args = args()?;
    let event_loop = EventLoop::with_user_event().build().map_err(|e| format!("acdev-viewer: event loop: {e}"))?;
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
