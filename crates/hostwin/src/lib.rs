mod app;
mod chooser;
mod dev;
mod gpu;
mod keys;
mod notify;
mod present;
mod shell;
mod surface;

pub use acde_model::{Event, Inbox, Waker};
pub use shell::{Grant, Injected, Mode, Shell, WindowInfo};
pub use surface::{DragImage, Shot, Surface};

pub fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    app::run(main)
}

pub fn active() -> bool {
    app::server().is_some()
}

pub fn choose_folder(window: Option<u32>, title: &str) -> Result<Option<std::path::PathBuf>, String> {
    let server = app::server().ok_or("no host windows")?;
    let (reply, picked) = std::sync::mpsc::sync_channel(1);
    server.send(app::Cmd::ChooseFolder { window, title: title.to_owned(), reply });
    picked.recv().map_err(|_| "the folder chooser closed without an answer".to_owned())?
}
