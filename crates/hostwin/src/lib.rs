mod app;
mod gpu;
mod keys;
mod present;
mod shell;
mod surface;

pub use acde_model::{Event, Inbox, Waker};
pub use shell::{Grant, Mode, Shell, WindowInfo};
pub use surface::{DragImage, Surface};

pub fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    app::run(main)
}

pub fn active() -> bool {
    app::server().is_some()
}
