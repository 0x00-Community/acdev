use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use acde::gpu::wgpu;

use crate::app::server;
use crate::platform::Cmd;

const LOST_EXIT: i32 = 1;
const PANIC_EXIT: i32 = 101;
const EXIT_WAIT: Duration = Duration::from_secs(5);
const RETRIES: [Duration; 5] = [Duration::from_millis(500), Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(3), Duration::from_secs(4)];

static FAILED: AtomicBool = AtomicBool::new(false);
static RECOVERING: AtomicBool = AtomicBool::new(false);

pub(crate) struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub shared: Arc<acde::gpu::Gpu>,
}

impl Gpu {
    pub fn open() -> Result<Self, String> {
        let (instance, adapter, shared) = acde::gpu::Gpu::open("acde host")?;
        _ = shared.set_compositor(std::sync::Arc::new(acde::vello::VelloCompositor));
        log::info!("web layer uses {} ({:?}, {:?})", shared.info.name, shared.info.device_type, shared.info.backend);
        shared.on_lost(recover);
        Ok(Self { instance, adapter, shared })
    }
}

fn recover(message: &str) {
    if FAILED.load(Ordering::SeqCst) || RECOVERING.swap(true, Ordering::SeqCst) {
        return;
    }
    log::error!("host window: the GPU device was lost ({message}), opening a new one");
    let message = message.to_owned();
    let lost = message.clone();
    let spawned = std::thread::Builder::new().name("acde-gpu-recover".into()).spawn(move || match retry(&RETRIES, std::thread::sleep, Gpu::open) {
        Ok(gpu) => {
            RECOVERING.store(false, Ordering::SeqCst);
            install(gpu);
        }
        Err((tries, last)) => give_up(&format!("the GPU device was lost ({lost}) and {tries} attempts to open a new one failed, the last with: {last}")),
    });
    if spawned.is_err() {
        give_up(&format!("the GPU device was lost ({message})"));
    }
}

fn install(gpu: Gpu) {
    let gpu = Arc::new(gpu);
    acde::gpu::Gpu::replace(gpu.shared.clone());
    log::info!("host window: recovered on a new GPU device");
    let Some(server) = server() else { return };
    server.set_gpu(gpu);
    server.send(Cmd::Device);
}

fn retry<T>(delays: &[Duration], mut sleep: impl FnMut(Duration), mut open: impl FnMut() -> Result<T, String>) -> Result<T, (usize, String)> {
    let mut last = String::new();
    for (attempt, delay) in delays.iter().enumerate() {
        sleep(*delay);
        match open() {
            Ok(opened) => return Ok(opened),
            Err(e) => {
                log::warn!("host window: opening a new GPU device failed (attempt {}): {e}", attempt + 1);
                last = e;
            }
        }
    }
    Err((delays.len(), last))
}

pub(crate) fn give_up(why: &str) {
    fail(why, LOST_EXIT);
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
    acde::log::flush();
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
        acde::log::init();
        true
    }

    #[test]
    fn device_loss_opens_a_new_device_and_keeps_running() {
        let (code, log) = child("lose_the_device");
        assert_eq!(code, Some(0), "{log}");
        assert!(log.contains("host window: the GPU device was lost"), "{log}");
        assert!(log.contains("host window: recovered on a new GPU device"), "{log}");
        assert!(log.contains("still running on a new device"), "{log}");
    }

    #[test]
    fn retry_waits_before_each_attempt_and_stops_at_the_first_device() {
        let mut slept = Vec::new();
        let mut attempts = 0;
        let opened = retry(
            &RETRIES,
            |d| slept.push(d),
            || {
                attempts += 1;
                if attempts == 3 { Ok("device") } else { Err(format!("adapter busy {attempts}")) }
            },
        );
        assert_eq!(opened, Ok("device"));
        assert_eq!(slept, RETRIES[..3]);
    }

    #[test]
    fn retry_reports_the_attempts_and_the_last_error_when_all_fail() {
        let mut attempts = 0;
        let opened: Result<(), _> = retry(
            &RETRIES,
            |_| {},
            || {
                attempts += 1;
                Err(format!("no adapter {attempts}"))
            },
        );
        assert_eq!(opened, Err((RETRIES.len(), format!("no adapter {}", RETRIES.len()))));
    }

    #[test]
    fn render_thread_panic_exits_with_a_logged_reason() {
        let (code, log) = child("panic_on_a_render_thread");
        assert_eq!(code, Some(PANIC_EXIT), "{log}");
        assert!(log.contains("host window: render thread acde-compose panicked"), "{log}");
        assert!(!log.contains("still running"), "{log}");
    }

    #[test]
    #[ignore = "run by device_loss_opens_a_new_device_and_keeps_running in a child process"]
    fn lose_the_device() {
        if !in_child() {
            return;
        }
        let gpu = Gpu::open().expect("a GPU");
        acde::gpu::Gpu::publish(Some(gpu.shared.clone()));
        gpu.shared.destroy();
        let _ = gpu.shared.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(HANG) });
        let deadline = std::time::Instant::now() + HANG;
        while !acde::gpu::Gpu::get().flatten().is_some_and(|now| !Arc::ptr_eq(&now, &gpu.shared)) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let now = acde::gpu::Gpu::get().flatten().expect("a published device");
        assert!(!Arc::ptr_eq(&now, &gpu.shared) && !now.gone(), "the lost device was not replaced");
        now.submit([now.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default()).finish()]);
        log::info!("still running on a new device");
        acde::log::flush();
        std::process::exit(0);
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
