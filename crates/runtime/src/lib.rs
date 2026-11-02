mod atspi;
mod bus;
mod clock;
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
mod pty;
mod rt;
mod sync;
mod terminal;
mod unixhttp;
mod voice;
pub use atspi::Accessibility;
pub use bus::DesktopBus;
pub use greetd::{GreetUser, Greetd};
pub use ime::{Ime, ImeCapability};
pub use network::Network;
pub use office::Office;
pub use portal::{Appearance, FileChooser};
pub use fs::{FileBytes, Finder};
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
