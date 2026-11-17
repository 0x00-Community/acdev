use super::{DRAIN, Registry, Session, Utf8Stream};
use crate::runtime::conpty;
use crate::runtime::sync::Locked;
use serde_json::json;
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::{
        Arc, Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) type Master = conpty::Master;

const POLL: Duration = Duration::from_millis(50);

pub(super) struct Process {
    child: conpty::Child,
    output: File,
}

pub(super) struct Spawned {
    pub(super) master: Master,
    pub(super) pid: u32,
    pub(super) process: Process,
}

pub(super) fn root() -> String {
    std::env::var("SystemDrive").map_or_else(|_| r"C:\".into(), |drive| format!(r"{drive}\"))
}

pub(super) fn spawn(home: &str, cols: u32, rows: u32) -> Result<Spawned, String> {
    let shell = conpty::default_shell();
    let (master, output, child) = conpty::spawn(&shell, Path::new(home), &[("COLORTERM", "truecolor")], cols, rows)
        .inspect_err(|reason| log::warn!("could not start {shell}: {reason}"))?;
    Ok(Spawned { master, pid: child.pid, process: Process { child, output } })
}

pub(super) fn resize(master: &Master, cols: u32, rows: u32) -> Result<(), String> {
    master.resize(cols, rows)
}

pub(super) fn release(master: Arc<Master>) {
    if Arc::strong_count(&master) == 1 {
        _ = std::thread::Builder::new().name("terminal-close".into()).spawn(move || drop(master));
    }
}

pub(super) fn run(registry: &Registry, session: &Session, process: Process) {
    let Process { child, mut output } = process;
    let drained = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let drained = &drained;
        scope.spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            let mut decoder = Utf8Stream::default();
            while let Ok(read @ 1..) = output.read(&mut buffer) {
                session.emit(vec![Session::output(decoder.push(&buffer[..read]))]);
            }
            session.emit(vec![Session::output(decoder.end())]);
            drained.store(true, Ordering::Release);
            session.wake();
        });
        watch(registry, session, &child, drained);
    });
}

fn watch(registry: &Registry, session: &Session, child: &conpty::Child, drained: &AtomicBool) {
    let mut exited: Option<(Instant, u32)> = None;
    loop {
        let (closed, ended, removal, kill, input) = {
            let mut state = session.state();
            (state.closed, state.ended, state.deadlines.removal, state.deadlines.kill, std::mem::take(&mut state.input))
        };
        if closed && ended {
            return;
        }
        if !input.is_empty()
            && let Some(master) = session.master()
        {
            _ = master.write(&input);
        }
        let now = Instant::now();
        if exited.is_none()
            && let Some(code) = child.wait(0)
        {
            exited = Some((now, code));
            let master = session.master.locked().take();
            if let Some(master) = master {
                release(master);
            }
        }
        if let Some((at, code)) = exited.filter(|_| !ended)
            && (drained.load(Ordering::Acquire) || now >= at + DRAIN)
        {
            session.end(registry, String::new(), json!({"type": "exit", "code": code as i32, "signal": null}));
        }
        if removal.is_some_and(|at| now >= at) {
            registry.close(session);
        }
        if kill.is_some_and(|at| now >= at) {
            session.state().deadlines.kill = None;
            if !session.state().ended {
                child.kill_tree();
            }
        }
        let next = [removal, kill, exited.map(|(at, _)| at + DRAIN)].into_iter().flatten().min();
        session.wake.wait(next.map_or(POLL, |at| at.saturating_duration_since(Instant::now()).min(POLL)));
    }
}

pub(super) struct Wake {
    woken: Mutex<bool>,
    ready: Condvar,
}

impl Wake {
    pub(super) fn new() -> std::io::Result<Self> {
        Ok(Self { woken: Mutex::new(false), ready: Condvar::new() })
    }

    pub(super) fn signal(&self) {
        *self.woken.locked() = true;
        self.ready.notify_all();
    }

    fn wait(&self, timeout: Duration) {
        let woken = self.woken.locked();
        let (mut woken, _) = self.ready.wait_timeout_while(woken, timeout, |woken| !*woken).unwrap_or_else(PoisonError::into_inner);
        *woken = false;
    }
}

#[cfg(test)]
mod tests {
    use super::super::Terminals;
    use super::super::tests::{Seen, WAIT, failed, invalid, missing, open};
    use super::*;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};

    fn alive(pid: u32) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let running = unsafe { WaitForSingleObject(handle, 0) } != 0;
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        running
    }

    fn grandchild(text: &str) -> Option<u32> {
        let rest = &text[text.find("GRANDCHILD-")? + "GRANDCHILD-".len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        rest[digits.len()..].starts_with('-').then(|| digits.parse().ok()).flatten()
    }

    #[test]
    fn a_session_on_a_pseudo_console() {
        let t = Terminals::new();
        let id = open(&t);
        let s = Seen::follow(&t, &id);
        assert_eq!(t.input(id.clone(), "echo he\"\"llo-42\r".into()).unwrap(), json!({"ok": true}));
        s.until("echo", WAIT, |log| log.0.contains("llo-42"));
        assert_eq!(t.resize(id.clone(), 100.0, 30.0).unwrap(), json!({"cols": 100, "rows": 30}));
        assert_eq!(failed(t.resize(id.clone(), 100.0, 1.0)), invalid("rows must be an integer in [2, 1000]"));
        t.input(id.clone(), "exit 7\r".into()).unwrap();
        assert_eq!(s.exited(), json!({"type": "exit", "code": 7, "signal": null}));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(failed(t.input(id, "x".into())), missing());
    }

    #[test]
    fn closing_ends_the_whole_tree() {
        use base64::Engine as _;
        let script = "$p = Start-Process ping.exe -ArgumentList '-n','600','127.0.0.1' -PassThru -WindowStyle Hidden; 'GRANDCHILD-' + $p.Id + '-'";
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let t = Terminals::new();
        let id = open(&t);
        let s = Seen::follow(&t, &id);
        t.input(id.clone(), format!("powershell -NoProfile -EncodedCommand {encoded}\r")).unwrap();
        s.until("grandchild started", Duration::from_secs(20), |log| grandchild(&log.0).is_some());
        let grandchild = grandchild(&s.text()).unwrap();
        assert!(alive(grandchild));
        let at = Instant::now();
        assert_eq!(t.close(id.clone()), json!({"closed": &id}));
        assert_eq!(s.exited()["type"], "exit");
        assert!(at.elapsed() < Duration::from_secs(5), "ended {:?} after closing", at.elapsed());
        let gone = Instant::now() + Duration::from_secs(2);
        while alive(grandchild) {
            assert!(Instant::now() < gone, "process {grandchild} outlived its terminal");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
