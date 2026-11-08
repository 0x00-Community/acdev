use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};

use acde_model::Event;

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

pub(crate) fn listen(proxy: Proxy) {
    let Ok(endpoint) = std::env::var("ACDE_DEV") else { return };
    let spawned = std::thread::Builder::new().name("acde-dev".into()).spawn(move || {
        if let Err(e) = accept(&endpoint, &proxy) {
            log::error!("acde dev: cannot listen on {endpoint}: {e}");
        }
    });
    if let Err(e) = spawned {
        log::error!("acde dev thread: {e}");
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
        with_requests(|r| r.waiting.retain(|_, w| !Arc::ptr_eq(&w.writer, &writer)));
        if dev {
            log::info!("acde dev disconnected, exiting");
            proxy.send(Cmd::Exit(0));
        }
    });
    if let Err(e) = spawned {
        log::error!("acde dev connection thread: {e}");
    }
}

#[cfg(unix)]
fn accept(endpoint: &str, proxy: &Proxy) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let listener = std::os::unix::net::UnixListener::bind(endpoint)?;
    std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
    log::info!("acde dev: listening on {endpoint}");
    for stream in listener.incoming() {
        match stream.and_then(|s| Ok((s.try_clone()?, s))) {
            Ok((writer, reader)) => serve(reader, Box::new(writer), proxy.clone()),
            Err(e) => log::warn!("acde dev: accept: {e}"),
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
            log::info!("acde dev: listening on {endpoint}");
            first = false;
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected {
            log::warn!("acde dev: connect: {}", io::Error::last_os_error());
            continue;
        }
        let file = std::fs::File::from(owned);
        match file.try_clone() {
            Ok(writer) => serve(Polled(file), Box::new(writer), proxy.clone()),
            Err(e) => log::warn!("acde dev: {e}"),
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
        return Err("acde dev: a response is one line of JSON".into());
    }
    send(writer, &line).map_err(|e| format!("acde dev: {e}"))
}

pub fn respond(id: i64, result: Result<&str, &str>) -> Result<(), String> {
    let Some(waiting) = with_requests(|r| r.waiting.remove(&id)) else {
        return Err(format!("acde dev: request {id} is not waiting for a response"));
    };
    reply(&waiting.writer, &waiting.id, result)
}

fn request(mut message: serde_json::Value, writer: &Arc<Writer>) {
    let Some(id) = message.get("id").filter(|id| id.is_number() || id.is_string()).cloned() else {
        log::warn!("acde dev: request without an id: {message}");
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
        log::warn!("acde dev: unreadable message {line}");
        return;
    };
    match message.get("type").and_then(|t| t.as_str()) {
        Some("hello") => *dev |= message.get("role").and_then(|r| r.as_str()) == Some("dev"),
        Some("reload") => {
            let app = message.get("app").and_then(|a| a.as_str()).map(str::to_owned);
            let hot = message.get("hot").and_then(|s| s.as_bool()).unwrap_or(false);
            log::info!("acde dev: {} {}", if hot { "hot swap" } else { "reload" }, app.as_deref().unwrap_or("desktop"));
            if let Some(server) = server() {
                server.broker.push(Event { kind: "devreload".into(), key: app, title: hot.then(|| "hot".into()), ..Default::default() });
            }
        }
        Some("request") => request(message, writer),
        Some("quit") => proxy.send(Cmd::Exit(0)),
        other => log::warn!("acde dev: unknown message type {other:?}"),
    }
}
