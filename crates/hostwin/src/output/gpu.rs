use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use acde_gpu::wgpu;

use crate::app::server;
use crate::platform::Cmd;

const LOST_EXIT: i32 = 1;
const PANIC_EXIT: i32 = 101;
const EXIT_WAIT: Duration = Duration::from_secs(5);

static FAILED: AtomicBool = AtomicBool::new(false);

pub(crate) struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub shared: Arc<acde_gpu::Gpu>,
}

impl Gpu {
    pub fn open() -> Result<Self, String> {
        let (instance, adapter, shared) = acde_gpu::Gpu::open("acde host")?;
        _ = shared.set_compositor(std::sync::Arc::new(acde_vello::VelloCompositor));
        log::info!("web layer uses {} ({:?}, {:?})", shared.info.name, shared.info.device_type, shared.info.backend);
        shared.on_lost(|message| fail(&format!("the GPU device was lost ({message})"), LOST_EXIT));
        Ok(Self { instance, adapter, shared })
    }
}

pub(crate) fn guarded(f: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        let thread = std::thread::current();
        fail(&format!("render thread {} panicked", thread.name().unwrap_or("-")), PANIC_EXIT);
    }
}

fn fail(why: &str, code: i32) {
    if FAILED.swap(true, Ordering::SeqCst) {
        return;
    }
    log::error!("host window: {why}, exiting");
    let Some(server) = server() else { exit(code) };
    server.send(Cmd::Exit(code));
    let late = std::thread::Builder::new().name("acde-exit".into()).spawn(move || {
        std::thread::sleep(EXIT_WAIT);
        log::error!("host window: did not exit within {EXIT_WAIT:?}, exiting now");
        exit(code);
    });
    if late.is_err() {
        exit(code);
    }
}

fn exit(code: i32) -> ! {
    acde_log::flush();
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHILD: &str = "ACDE_HOSTWIN_TEST_CHILD";
    const HANG: Duration = Duration::from_secs(20);

    fn child(name: &str) -> (Option<i32>, String) {
        let exe = std::env::current_exe().expect("the test binary");
        let test = format!("output::gpu::tests::{name}");
        let out =
            std::process::Command::new(exe).args(["--exact", test.as_str(), "--ignored", "--nocapture"]).env(CHILD, "1").output().expect("the child test");
        (out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned())
    }

    fn in_child() -> bool {
        if std::env::var_os(CHILD).is_none() {
            return false;
        }
        acde_log::init();
        true
    }

    #[test]
    fn device_loss_exits_with_a_logged_reason() {
        let (code, log) = child("lose_the_device");
        assert_eq!(code, Some(LOST_EXIT), "{log}");
        assert!(log.contains("host window: the GPU device was lost"), "{log}");
        assert!(!log.contains("still running"), "{log}");
    }

    #[test]
    fn render_thread_panic_exits_with_a_logged_reason() {
        let (code, log) = child("panic_on_a_render_thread");
        assert_eq!(code, Some(PANIC_EXIT), "{log}");
        assert!(log.contains("host window: render thread acde-compose panicked"), "{log}");
        assert!(!log.contains("still running"), "{log}");
    }

    #[test]
    #[ignore = "run by device_loss_exits_with_a_logged_reason in a child process"]
    fn lose_the_device() {
        if !in_child() {
            return;
        }
        let gpu = Gpu::open().expect("a GPU");
        gpu.shared.destroy();
        let _ = gpu.shared.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(HANG) });
        std::thread::sleep(HANG);
        log::error!("still running after losing the device");
    }

    #[test]
    #[ignore = "run by render_thread_panic_exits_with_a_logged_reason in a child process"]
    fn panic_on_a_render_thread() {
        if !in_child() {
            return;
        }
        let thread = std::thread::Builder::new().name("acde-compose".into()).spawn(|| guarded(|| panic!("forced"))).expect("a thread");
        let _ = thread.join();
        std::thread::sleep(HANG);
        log::error!("still running after a render thread panicked");
    }
}
