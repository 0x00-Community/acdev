use std::collections::HashSet;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::Mutex;

use acde_model::Event;

use crate::app::server;
use crate::platform::{Cmd, Proxy};

struct Link {
    writer: Box<dyn Write + Send>,
    pending: HashSet<i64>,
}

static LINK: Mutex<Option<Link>> = Mutex::new(None);

fn link() -> std::sync::MutexGuard<'static, Option<Link>> {
    LINK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(unix)]
fn open(name: &str) -> io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(name)
}

#[cfg(windows)]
fn open(name: &str) -> io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(name) {
            Ok(file) => return Ok(file),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                let wide: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().chain(Some(0)).collect();
                if unsafe { WaitNamedPipeW(wide.as_ptr(), 5000) } == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Err(e) => return Err(e),
        }
    }
}

fn send(writer: &mut dyn Write, line: &str) -> io::Result<()> {
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

pub(crate) fn connect(proxy: Proxy) {
    let Ok(endpoint) = std::env::var("ACDE_DEV") else { return };
    let spawned = std::thread::Builder::new().name("acde-dev".into()).spawn(move || {
        let stream = match open(&endpoint) {
            Ok(s) => s,
            Err(e) => {
                log::error!("acde dev: 连不上 {endpoint}: {e}");
                return;
            }
        };
        match stream.try_clone() {
            Ok(writer) => *link() = Some(Link { writer: Box::new(writer), pending: HashSet::new() }),
            Err(e) => log::error!("acde dev: {e}"),
        }
        let hello = format!(r#"{{"type":"hello","role":"runtime","pid":{}}}"#, std::process::id());
        if let Err(e) = write(&hello) {
            log::error!("acde dev: hello: {e}");
        }
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|n| n > 0) {
            handle(line.trim_end_matches(['\r', '\n']), &proxy);
            line.clear();
        }
        *link() = None;
        log::info!("acde dev 断开了, 结束");
        proxy.send(Cmd::Exit(0));
    });
    if let Err(e) = spawned {
        log::error!("acde dev 线程: {e}");
    }
}

fn write(line: &str) -> Result<(), String> {
    let mut link = link();
    let link = link.as_mut().ok_or("acde dev: not connected")?;
    send(&mut link.writer, line).map_err(|e| format!("acde dev: {e}"))
}

pub fn respond(id: i64, result: Result<&str, &str>) -> Result<(), String> {
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
    let mut guard = link();
    let link = guard.as_mut().ok_or("acde dev: not connected")?;
    if !link.pending.remove(&id) {
        return Err(format!("acde dev: request {id} is not waiting for a response"));
    }
    send(&mut link.writer, &line).map_err(|e| format!("acde dev: {e}"))
}

fn request(message: &serde_json::Value, line: &str) {
    let Some(id) = message.get("id").and_then(serde_json::Value::as_i64) else {
        log::warn!("acde dev: request without an integer id: {line}");
        return;
    };
    let fresh = link().as_mut().is_some_and(|l| l.pending.insert(id));
    if !fresh {
        log::warn!("acde dev: request {id} is already waiting");
        return;
    }
    let Some(server) = server() else {
        let _ = respond(id, Err("the runtime is not running"));
        return;
    };
    if message.get("op").and_then(serde_json::Value::as_str).is_none() {
        let _ = respond(id, Err("request without an op"));
        return;
    }
    server.broker.push(Event { kind: "devrequest".into(), key: Some(line.to_owned()), ..Default::default() });
}

fn handle(line: &str, proxy: &Proxy) {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        log::warn!("acde dev: 看不懂 {line}");
        return;
    };
    match message.get("type").and_then(|t| t.as_str()) {
        Some("reload") => {
            let app = message.get("app").and_then(|a| a.as_str()).map(str::to_owned);
            let hot = message.get("hot").and_then(|s| s.as_bool()).unwrap_or(false);
            log::info!("acde dev: {} {}", if hot { "热替换" } else { "重新加载" }, app.as_deref().unwrap_or("桌面"));
            if let Some(server) = server() {
                server.broker.push(Event { kind: "devreload".into(), key: app, title: hot.then(|| "hot".into()), ..Default::default() });
            }
        }
        Some("request") => request(&message, line),
        Some("quit") => {
            proxy.send(Cmd::Exit(0));
        }
        other => log::warn!("acde dev: 没有 {other:?} 这种消息"),
    }
}
