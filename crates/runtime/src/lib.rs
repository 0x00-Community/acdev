mod atspi;
mod bus;
mod failure;
mod fields;
pub(crate) mod fs;
mod greetd;
mod http;
mod ime;
mod js;
mod network;
mod office;
mod portal;
mod power;
mod pty;
mod rt;
mod sound;
mod sync;
mod system;
mod terminal;
mod unixhttp;
mod voice;
pub use atspi::Accessibility;
pub use bus::DesktopBus;
pub use greetd::{GreetUser, Greetd};
pub use ime::{Ime, ImeCapability};
pub use network::{NetCall, Network, Networks};
pub use office::{OfficeCall, OfficeService};
pub use portal::{Appearance, FileChooser};
pub use power::{Power, PowerCall, PowerHost, backlight_brightness, set_backlight};
pub use fs::{FileBytes, Finder, FsCall, FsError, FsReply, Workspace};
pub use sound::{SoundCall, Sounds};
pub use system::{SysCall, system_call};
pub use terminal::Terminals;
pub use unixhttp::{Deliver, Event as UnixEvent, UnixClient};
pub use voice::Voice;

use napi::{Error, Result, Status};
use serde_json::json;

fn failure(code: &str, message: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        json!({"code":code,"message":message}).to_string(),
    )
}

fn unix_now() -> std::time::Duration {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
}

fn state_file(name: &str) -> Option<std::path::PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".local/state")))?;
    Some(state.join("acde").join(name))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    rt::blocking(work).await.map_err(|_| {
        failure(
            "native_task_failed",
            "native task did not complete; query the original operation",
        )
    })?
}

#[cfg(test)]
fn private_bus(name: &str) -> Option<(std::process::Child, String, std::path::PathBuf)> {
    use std::io::BufRead;
    let dir = std::env::temp_dir().join(format!("acde-{name}-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let config = dir.join("bus.conf");
    let policy = "<policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy>";
    std::fs::write(&config, format!("<busconfig><type>session</type><listen>unix:dir={}</listen><auth>EXTERNAL</auth>{policy}</busconfig>", dir.display())).ok()?;
    let mut daemon = std::process::Command::new("dbus-daemon")
        .arg(format!("--config-file={}", config.display()))
        .arg("--print-address")
        .arg("--nofork")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let mut address = String::new();
    std::io::BufReader::new(daemon.stdout.take()?).read_line(&mut address).ok()?;
    Some((daemon, address.trim().to_string(), dir))
}
