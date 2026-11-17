use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};

use acdert::model::Event;

use crate::app::server;
use crate::platform::{Cmd, Proxy};

type Writer = Mutex<Box<dyn Write + Send>>;

struct Waiting {
    writer: Arc<Writer>,
    id: serde_json::Value,
}

#[derive(Default)]
struct Requests {
    next: i64,
    waiting: HashMap<i64, Waiting>,
    devs: Vec<Arc<Writer>>,
}

static REQUESTS: Mutex<Option<Requests>> = Mutex::new(None);

fn with_requests<T>(f: impl FnOnce(&mut Requests) -> T) -> T {
    let mut guard = REQUESTS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Requests::default))
}

fn send(writer: &Writer, line: &str) -> io::Result<()> {
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

const QUIT_WAIT: std::time::Duration = std::time::Duration::from_secs(6);

fn quit(proxy: &Proxy) {
    let Some(server) = server() else { return proxy.send(Cmd::Exit(0)) };
    server.broker.push(Event { kind: "quit".into(), ..Default::default() });
    let later = proxy.clone();
    let spawned = std::thread::Builder::new().name("acde-dev-quit".into()).spawn(move || {
        std::thread::sleep(QUIT_WAIT);
        log::warn!("acdev dev: the session did not end within {} s of quit, exiting", QUIT_WAIT.as_secs());
        later.send(Cmd::Exit(0));
    });
    if spawned.is_err() {
        proxy.send(Cmd::Exit(0));
    }
}

pub(crate) fn listen(proxy: Proxy) {
    let Ok(endpoint) = std::env::var("ACDE_DEV") else { return };
    let spawned = std::thread::Builder::new().name("acde-dev".into()).spawn(move || {
        if let Err(e) = accept(&endpoint, &proxy) {
            log::error!("acdev dev: cannot listen on {endpoint}: {e}");
        }
    });
    if let Err(e) = spawned {
        log::error!("acdev dev thread: {e}");
    }
}

fn serve<S: io::Read + Send + 'static>(reader: S, writer: Box<dyn Write + Send>, proxy: Proxy) {
    let spawned = std::thread::Builder::new().name("acde-dev-conn".into()).spawn(move || {
        let writer: Arc<Writer> = Arc::new(Mutex::new(writer));
        let mut dev = false;
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|n| n > 0) {
            handle(line.trim_end_matches(['\r', '\n']), &writer, &mut dev, &proxy);
            line.clear();
        }
        with_requests(|r| {
            r.waiting.retain(|_, w| !Arc::ptr_eq(&w.writer, &writer));
            r.devs.retain(|w| !Arc::ptr_eq(w, &writer));
        });
        if dev {
            log::info!("acdev dev disconnected, exiting");
            quit(&proxy);
        }
    });
    if let Err(e) = spawned {
        log::error!("acdev dev connection thread: {e}");
    }
}

#[cfg(unix)]
fn accept(endpoint: &str, proxy: &Proxy) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let listener = std::os::unix::net::UnixListener::bind(endpoint)?;
    std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
    log::info!("acdev dev: listening on {endpoint}");
    for stream in listener.incoming() {
        match stream.and_then(|s| Ok((s.try_clone()?, s))) {
            Ok((writer, reader)) => serve(reader, Box::new(writer), proxy.clone()),
            Err(e) => log::warn!("acdev dev: accept: {e}"),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn accept(endpoint: &str, proxy: &Proxy) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, GetLastError, INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let wide = |s: &str| -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect() };
    let name = wide(endpoint);
    let sddl = wide("D:P(A;;GA;;;OW)");
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    let mut first = true;
    let result = loop {
        let flags = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                flags,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                1 << 16,
                1 << 16,
                0,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            break Err(io::Error::last_os_error());
        }
        if first {
            log::info!("acdev dev: listening on {endpoint}");
            first = false;
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected {
            log::warn!("acdev dev: connect: {}", io::Error::last_os_error());
            continue;
        }
        let file = std::fs::File::from(owned);
        match file.try_clone() {
            Ok(writer) => serve(Polled(file), Box::new(writer), proxy.clone()),
            Err(e) => log::warn!("acdev dev: {e}"),
        }
    };
    unsafe { LocalFree(descriptor) };
    result
}

#[cfg(windows)]
struct Polled(std::fs::File);

#[cfg(windows)]
impl io::Read for Polled {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE;
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;
        loop {
            let mut available = 0u32;
            let peeked = unsafe { PeekNamedPipe(self.0.as_raw_handle(), std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut available, std::ptr::null_mut()) };
            if peeked == 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) { Ok(0) } else { Err(error) };
            }
            if available > 0 {
                let n = buf.len().min(available as usize);
                return self.0.read(&mut buf[..n]);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

fn reply(writer: &Writer, id: &serde_json::Value, result: Result<&str, &str>) -> Result<(), String> {
    let id = serde_json::to_string(id).map_err(|e| e.to_string())?;
    let line = match result {
        Ok(json) => format!(r#"{{"type":"response","id":{id},"ok":true,"result":{json}}}"#),
        Err(message) => {
            let message = serde_json::to_string(message).map_err(|e| e.to_string())?;
            format!(r#"{{"type":"response","id":{id},"ok":false,"error":{message}}}"#)
        }
    };
    if line.contains('\n') {
        return Err("acdev dev: a response is one line of JSON".into());
    }
    send(writer, &line).map_err(|e| format!("acdev dev: {e}"))
}

pub fn respond(id: i64, result: Result<&str, &str>) -> Result<(), String> {
    let Some(waiting) = with_requests(|r| r.waiting.remove(&id)) else {
        return Err(format!("acdev dev: request {id} is not waiting for a response"));
    };
    reply(&waiting.writer, &waiting.id, result)
}

/// Sends an event to every connection that said hello as acde dev (the dev channel's `{"type":"event"}` line).
/// Returns how many connections it reached.
pub fn event(message: &str) -> Result<usize, String> {
    let value = serde_json::from_str::<serde_json::Value>(message).map_err(|e| format!("acdev dev: an event is JSON: {e}"))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("event") || value.get("event").and_then(serde_json::Value::as_str).is_none() {
        return Err("acdev dev: an event is an object with type \"event\" and an event name".into());
    }
    let line = value.to_string();
    let devs = with_requests(|r| r.devs.clone());
    let mut reached = 0;
    for writer in &devs {
        match send(writer, &line) {
            Ok(()) => reached += 1,
            Err(e) => log::warn!("acdev dev: event: {e}"),
        }
    }
    Ok(reached)
}

/// F12 in a dev session opens DevTools instead of reaching the page: each press is reported once (repeats and the
/// release are swallowed), and F12 with a modifier, or any F12 outside dev mode, goes to the page as before.
#[derive(Default)]
pub(crate) struct DevtoolsKey {
    on: bool,
    held: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DevtoolsPress {
    Pass,
    Swallow,
    Open,
}

impl DevtoolsKey {
    pub(crate) const F12: u32 = 88;

    pub(crate) fn from_env() -> Self {
        Self { on: std::env::var_os("ACDE_DEV").is_some(), held: false }
    }

    pub(crate) fn key(&mut self, evdev: u32, pressed: bool, modifiers: u8) -> DevtoolsPress {
        if !self.on || evdev != Self::F12 {
            return DevtoolsPress::Pass;
        }
        if !pressed {
            return if std::mem::take(&mut self.held) { DevtoolsPress::Swallow } else { DevtoolsPress::Pass };
        }
        if self.held {
            return DevtoolsPress::Swallow;
        }
        if modifiers != 0 {
            return DevtoolsPress::Pass;
        }
        self.held = true;
        DevtoolsPress::Open
    }

    /// The host window lost the focus: the F12 that opened DevTools is usually released in the browser it brought
    /// forward, so its release never comes here; without this the next press would count as a repeat.
    pub(crate) fn blur(&mut self) {
        self.held = false;
    }
}

fn request(mut message: serde_json::Value, writer: &Arc<Writer>) {
    let Some(id) = message.get("id").filter(|id| id.is_number() || id.is_string()).cloned() else {
        log::warn!("acdev dev: request without an id: {message}");
        return;
    };
    if message.get("op").and_then(serde_json::Value::as_str).is_none() {
        let _ = reply(writer, &id, Err("request without an op"));
        return;
    }
    let Some(server) = server() else {
        let _ = reply(writer, &id, Err("the runtime is not running"));
        return;
    };
    let n = with_requests(|r| {
        r.next += 1;
        r.waiting.insert(r.next, Waiting { writer: writer.clone(), id });
        r.next
    });
    message["id"] = n.into();
    server.broker.push(Event { kind: "devrequest".into(), key: Some(message.to_string()), ..Default::default() });
}

fn handle(line: &str, writer: &Arc<Writer>, dev: &mut bool, proxy: &Proxy) {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        log::warn!("acdev dev: unreadable message {line}");
        return;
    };
    match message.get("type").and_then(|t| t.as_str()) {
        Some("hello") => {
            if !*dev && message.get("role").and_then(|r| r.as_str()) == Some("dev") {
                *dev = true;
                with_requests(|r| r.devs.push(writer.clone()));
            }
        }
        Some("reload") => {
            let app = message.get("app").and_then(|a| a.as_str()).map(str::to_owned);
            let hot = message.get("hot").and_then(|s| s.as_bool()).unwrap_or(false);
            log::info!("acdev dev: {} {}", if hot { "hot swap" } else { "reload" }, app.as_deref().unwrap_or("desktop"));
            if let Some(server) = server() {
                server.broker.push(Event { kind: "devreload".into(), key: app, title: hot.then(|| "hot".into()), ..Default::default() });
            }
        }
        Some("request") => request(message, writer),
        Some("quit") => quit(proxy),
        other => log::warn!("acdev dev: unknown message type {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{DevtoolsKey, DevtoolsPress};
    use acdert::model::Combo;

    const F12: u32 = DevtoolsKey::F12;

    #[test]
    fn one_press_opens_once_and_its_repeats_and_release_never_reach_the_page() {
        let mut key = DevtoolsKey { on: true, held: false };
        assert_eq!(key.key(F12, true, 0), DevtoolsPress::Open);
        assert_eq!(key.key(F12, true, 0), DevtoolsPress::Swallow);
        assert_eq!(key.key(F12, true, Combo::SHIFT), DevtoolsPress::Swallow);
        assert_eq!(key.key(F12, false, 0), DevtoolsPress::Swallow);
        assert_eq!(key.key(F12, true, 0), DevtoolsPress::Open);
        assert_eq!(key.key(F12, false, Combo::CTRL), DevtoolsPress::Swallow);
    }

    #[test]
    fn a_release_lost_to_the_browser_does_not_eat_the_next_press() {
        let mut key = DevtoolsKey { on: true, held: false };
        assert_eq!(key.key(F12, true, 0), DevtoolsPress::Open);
        key.blur();
        assert_eq!(key.key(F12, true, 0), DevtoolsPress::Open);
        assert_eq!(key.key(F12, false, 0), DevtoolsPress::Swallow);
        assert_eq!(key.key(F12, false, 0), DevtoolsPress::Pass);
    }

    #[test]
    fn f12_with_a_modifier_other_keys_and_any_key_outside_dev_mode_pass() {
        let mut key = DevtoolsKey { on: true, held: false };
        for modifier in [Combo::CTRL, Combo::SHIFT, Combo::ALT, Combo::SUPER] {
            assert_eq!(key.key(F12, true, modifier), DevtoolsPress::Pass);
            assert_eq!(key.key(F12, false, modifier), DevtoolsPress::Pass);
        }
        assert_eq!(key.key(87, true, 0), DevtoolsPress::Pass);
        assert_eq!(key.key(87, false, 0), DevtoolsPress::Pass);
        let mut off = DevtoolsKey::default();
        assert_eq!(off.key(F12, true, 0), DevtoolsPress::Pass);
        assert_eq!(off.key(F12, false, 0), DevtoolsPress::Pass);
    }
}
