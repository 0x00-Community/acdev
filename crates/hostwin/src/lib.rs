mod app;
#[cfg(not(windows))]
mod clipimage;
mod dev;
mod keys;
mod output;
mod platform;
mod shell;
mod system;

pub use acde::model::{DoubleClick, Event, FileFilter, Inbox, InjectEvent, Injected, Mode, OpenRequest, SaveRequest, Waker, WindowState};
pub use dev::event as dev_event;
pub use dev::respond as dev_respond;
pub use output::surface::{Shot, Surface};
pub use shell::{Animate, Grant, Shell, WindowInfo};
#[cfg(windows)]
pub use system::assoc::Handler as FileHandler;
use system::handoff;
pub use system::handoff::OpenError;

pub fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    app::run(main)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn notify(title: &str, body: &str, subtitle: &str) -> Result<(), String> {
    if platform::headless() {
        log::info!("notification (ACDE_HEADLESS, not shown): {title:?} {subtitle:?} {body:?}");
        return Ok(());
    }
    system::notify::show(title, body, subtitle)
}

pub fn open_default(target: &str) -> Result<(), OpenError> {
    handoff::open(target, platform::headless())
}

#[cfg(windows)]
pub fn content_type(extension: &str) -> Option<String> {
    system::assoc::content_type(extension)
}

#[cfg(windows)]
pub fn file_handlers(extension: &str) -> Result<Vec<FileHandler>, String> {
    system::assoc::handlers(extension)
}

#[cfg(windows)]
pub fn open_with(handler: &str, path: &str) -> Result<(), OpenError> {
    system::assoc::open_with(handler, path, platform::headless())
}

pub fn headless() -> bool {
    platform::headless()
}

pub fn active() -> bool {
    app::server().is_some()
}

struct Answers<T>(std::sync::Mutex<std::collections::VecDeque<Option<T>>>);

impl<T> Answers<T> {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(std::collections::VecDeque::new()))
    }

    fn push(&self, answer: Option<T>) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push_back(answer);
    }

    fn take(&self) -> Option<Option<T>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
    }
}

static FOLDERS: Answers<std::path::PathBuf> = Answers::new();
static OPENED: Answers<Vec<std::path::PathBuf>> = Answers::new();
static SAVED: Answers<std::path::PathBuf> = Answers::new();

pub fn clipboard_text() -> String {
    platform::clipboard_read(acde::render::ClipboardEntry::TEXT).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default()
}

pub fn set_clipboard_text(text: String) {
    platform::clipboard_set(vec![acde::render::ClipboardEntry::text(text)]);
}

pub fn answer_folder(answer: Option<std::path::PathBuf>) {
    FOLDERS.push(answer);
}

pub fn answer_open(answer: Option<Vec<std::path::PathBuf>>) {
    OPENED.push(answer);
}

pub fn answer_save(answer: Option<std::path::PathBuf>) {
    SAVED.push(answer);
}

pub fn preset_folder() -> Option<Option<std::path::PathBuf>> {
    FOLDERS.take()
}

pub fn preset_open() -> Option<Option<Vec<std::path::PathBuf>>> {
    OPENED.take()
}

pub fn preset_save() -> Option<Option<std::path::PathBuf>> {
    SAVED.take()
}

fn ask<T>(cmd: impl FnOnce(std::sync::mpsc::SyncSender<Result<T, String>>) -> platform::Cmd, what: &str) -> Result<T, String> {
    let server = app::server().ok_or("no host windows")?;
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    server.send(cmd(reply));
    answer.recv().map_err(|_| format!("the {what} closed without an answer"))?
}

pub fn choose_folder(title: &str) -> Result<Option<std::path::PathBuf>, String> {
    ask(|reply| platform::Cmd::ChooseFolder { title: title.to_owned(), reply }, "folder chooser")
}

pub fn open_files(request: OpenRequest) -> Result<Option<Vec<std::path::PathBuf>>, String> {
    ask(|reply| platform::Cmd::OpenFiles { request, reply }, "file chooser")
}

pub fn save_file(request: SaveRequest) -> Result<Option<std::path::PathBuf>, String> {
    ask(|reply| platform::Cmd::SaveFile { request, reply }, "save chooser")
}

pub fn approve(title: &str, message: &str) -> Result<Option<bool>, String> {
    if platform::headless() {
        return Ok(None);
    }
    ask(|reply| platform::Cmd::Approve { title: title.to_owned(), message: message.to_owned(), reply }, "approval dialog")
}

pub fn dismiss_approval() {
    platform::dismiss_approval();
}
