use crate::failure::Failure;
use crate::js::JsText;
use ntex::io::Io;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::sync::Arc;

const MAX_CALLBACK_BYTES: usize = 1024 * 1024;
const MAX_HEAD_BYTES: usize = 64 * 1024;

pub trait Handlers: Send + Sync {
    fn file(&self, ticket: &str, authorization: Option<&str>) -> Result<(String, Vec<u8>), Failure>;
    fn callback(&self, ticket: &str, authorization: Option<&str>, body: &[u8]) -> Result<(), Failure>;
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

pub fn listen(path: &str) -> std::io::Result<async_io::Async<UnixListener>> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        use std::os::unix::fs::DirBuilderExt;
        if let Some(above) = parent.parent().filter(|above| !above.as_os_str().is_empty()) {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(above)?;
        }
        match std::fs::DirBuilder::new().mode(0o711).create(parent) {
            Ok(()) => std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o711))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = async_io::Async::new(UnixListener::bind(path)?)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    Ok(listener)
}

pub async fn serve(listener: async_io::Async<UnixListener>, handlers: Arc<dyn Handlers>) {
    crate::rt::local(move || async move {
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(io) = stream.into_inner().and_then(|stream| ntex::rt::from_unix_stream(stream, ntex::SharedCfg::default())) else {
                continue;
            };
            let handlers = Arc::clone(&handlers);
            drop(ntex::rt::spawn(async move { connection(io, handlers).await }));
        }
    })
    .await;
}

async fn read(io: &Io) -> Option<Request> {
    let mut raw = Vec::new();
    let head_end = loop {
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if raw.len() > MAX_HEAD_BYTES {
            return None;
        }
        crate::http::take(io, &mut raw).await.ok().filter(|more| *more)?;
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let mut body = raw.split_off(head_end + 4);
    if let Some(length) = header("content-length").and_then(|l| l.parse::<usize>().ok()) {
        if length > MAX_CALLBACK_BYTES {
            return Some(Request { method, path: target, authorization: header("authorization"), body: vec![0; MAX_CALLBACK_BYTES + 1] });
        }
        while body.len() < length {
            crate::http::take(io, &mut body).await.ok().filter(|more| *more)?;
        }
        body.truncate(length);
    }
    let path = target.split('?').next().unwrap_or("/").to_owned();
    Some(Request { method, path, authorization: header("authorization"), body })
}

async fn reply(io: &Io, status: u16, headers: &[(&str, String)], body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let mut answer = head.into_bytes();
    answer.extend_from_slice(body);
    if io.encode_slice(&answer).is_ok() {
        let _ = io.shutdown().await;
    }
}

async fn json(io: &Io, status: u16, value: Value) {
    let body = value.to_string();
    let headers =
        [("Content-Type", "application/json; charset=utf-8".to_owned()), ("Cache-Control", "no-store".to_owned()), ("Content-Length", body.len().to_string())];
    reply(io, status, &headers, body.as_bytes()).await;
}

fn ticket<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let ticket = path.strip_prefix(prefix)?;
    (!ticket.is_empty() && ticket.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))).then_some(ticket)
}

async fn connection(io: Io, handlers: Arc<dyn Handlers>) {
    let Some(request) = read(&io).await else { return };
    let file = ticket(&request.path, "/office/file/").map(str::to_owned);
    let callback = ticket(&request.path, "/office/callback/").map(str::to_owned);
    let what = if file.is_some() {
        "/office/file"
    } else if callback.is_some() {
        "/office/callback"
    } else {
        request.path.as_str()
    };
    let what = what.to_owned();
    let method = request.method.clone();
    let outcome: Result<Option<(String, Vec<u8>)>, Failure> = match (file, callback, request.method.as_str()) {
        (Some(ticket), _, "GET" | "HEAD") => {
            let handlers = Arc::clone(&handlers);
            let auth = request.authorization.clone();
            crate::rt::blocking(move || handlers.file(&ticket, auth.as_deref()).map(Some))
                .await
                .unwrap_or_else(|_| Err(Failure::internal("bridge task failed")))
        }
        (_, Some(_), "POST") if request.body.len() > MAX_CALLBACK_BYTES => Err(Failure::http(413, "callback body too large")),
        (_, Some(ticket), "POST") => {
            let handlers = Arc::clone(&handlers);
            let (auth, body) = (request.authorization.clone(), request.body);
            crate::rt::blocking(move || handlers.callback(&ticket, auth.as_deref(), &body).map(|()| None))
                .await
                .unwrap_or_else(|_| Err(Failure::internal("bridge task failed")))
        }
        _ => return json(&io, 404, json!({"error": 1, "message": "not found"})).await,
    };
    match outcome {
        Ok(Some((name, data))) => {
            let headers = [
                ("Content-Type", "application/octet-stream".to_owned()),
                ("Content-Length", data.len().to_string()),
                ("Content-Disposition", format!("attachment; filename*=UTF-8''{}", name.uri_component())),
                ("Cache-Control", "no-store".to_owned()),
            ];
            let body = if method == "HEAD" { &[][..] } else { &data[..] };
            reply(&io, 200, &headers, body).await;
        }
        Ok(None) => json(&io, 200, json!({"error": 0})).await,
        Err(failure) => {
            let message = if failure.status == 500 { "internal error".to_owned() } else { failure.message.clone() };
            log::warn!("{method} {what}: {} {message}", failure.status);
            json(&io, failure.status, json!({"error": 1, "message": message})).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    struct Stub;

    impl Handlers for Stub {
        fn file(&self, ticket: &str, authorization: Option<&str>) -> Result<(String, Vec<u8>), Failure> {
            match (ticket, authorization) {
                ("t1", Some("Bearer x")) => Ok(("报告 1.docx".into(), b"PK\x03\x04data".to_vec())),
                _ => Err(Failure::http(403, "refused")),
            }
        }

        fn callback(&self, _: &str, _: Option<&str>, body: &[u8]) -> Result<(), Failure> {
            if body == br#"{"status":1}"# { Ok(()) } else { Err(Failure::http(400, "bad callback")) }
        }
    }

    fn ask(path: &std::path::Path, request: &str) -> String {
        let mut stream = std::os::unix::net::UnixStream::connect(path).expect("connect");
        stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    }

    #[test]
    fn files_callbacks_and_the_rest() {
        let dir = std::env::temp_dir().join(format!("acde-bridge-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("run/bridge.sock");
        let listener = listen(path.to_str().unwrap()).expect("listen");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o666);
        assert_eq!(std::fs::metadata(dir.join("run")).unwrap().permissions().mode() & 0o777, 0o711);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let task = crate::rt::spawn_abortable(serve(listener, Arc::new(Stub)));
        let answer = ask(&path, "GET /office/file/t1?x=1 HTTP/1.1\r\nAuthorization: Bearer x\r\n\r\n");
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
        assert!(answer.contains("Content-Length: 8\r\n") && answer.ends_with("\r\n\r\nPK\x03\x04data"), "{answer}");
        assert!(answer.contains("filename*=UTF-8''%E6%8A%A5%E5%91%8A%201.docx"), "{answer}");
        let answer = ask(&path, "HEAD /office/file/t1 HTTP/1.1\r\nAuthorization: Bearer x\r\n\r\n");
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n") && answer.ends_with("\r\n\r\n"), "{answer}");
        assert!(ask(&path, "GET /office/file/t2 HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 403 Forbidden\r\n"));
        let callback = r#"{"status":1}"#;
        let answer = ask(&path, &format!("POST /office/callback/t1 HTTP/1.1\r\nContent-Length: {}\r\n\r\n{callback}", callback.len()));
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n") && answer.ends_with(r#"{"error":0}"#), "{answer}");
        let answer = ask(&path, &format!("POST /office/callback/t1 HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_CALLBACK_BYTES + 1));
        assert!(answer.starts_with("HTTP/1.1 413 "), "{answer}");
        assert!(ask(&path, "GET /elsewhere HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404 Not Found\r\n"));
        task.abort();
        _ = std::fs::remove_dir_all(&dir);
    }
}
