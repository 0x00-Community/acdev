mod app;
#[cfg(not(windows))]
mod chooser;
mod compose;
mod dev;
mod gpu;
mod keys;
mod notify;
mod platform;
mod present;
mod shell;
mod surface;

pub use acde_model::{Event, Inbox, InjectEvent, Injected, Mode, Waker};
pub use dev::respond as dev_respond;
pub use shell::{Grant, Shell, WindowInfo};
pub use surface::{Shot, Surface};

pub fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    app::run(main)
}

pub fn notify(title: &str, body: &str, subtitle: &str) -> Result<(), String> {
    if platform::headless() {
        log::info!("通知 (ACDE_HEADLESS, 不弹出): {title:?} {subtitle:?} {body:?}");
        return Ok(());
    }
    notify::show(title, body, subtitle)
}

pub fn headless() -> bool {
    platform::headless()
}

pub fn active() -> bool {
    app::server().is_some()
}

pub fn choose_folder(_window: Option<u32>, title: &str) -> Result<Option<std::path::PathBuf>, String> {
    let server = app::server().ok_or("no host windows")?;
    let (reply, picked) = std::sync::mpsc::sync_channel(1);
    server.send(platform::Cmd::ChooseFolder { title: title.to_owned(), reply });
    picked.recv().map_err(|_| "the folder chooser closed without an answer".to_owned())?
}
