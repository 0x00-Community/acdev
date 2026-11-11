use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use serde_json::{Value, json};

use super::ws::{Message, Messages};
use super::{Client, Endpoint, VERSION};
use crate::sync::Locked;

const HEAD: usize = 16 << 10;
const HEAD_WAIT: Duration = Duration::from_secs(10);

pub(super) fn accept(endpoint: &'static Endpoint, listener: TcpListener) {
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(e) => {
                log::warn!("devtools: accept: {e}");
                continue;
            }
        };
        let spawned = std::thread::Builder::new().name("acde-devtools-conn".into()).spawn(move || {
            if let Err(e) = serve(endpoint, stream) {
                log::debug!("devtools: connection: {e}");
            }
        });
        if let Err(e) = spawned {
            log::warn!("devtools connection thread: {e}");
        }
    }
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn upgrade(&self) -> Option<&str> {
        let websocket = self.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
        let version = self.header("sec-websocket-version") == Some("13");
        self.header("sec-websocket-key").filter(|_| websocket && version)
    }

    fn token(&self, token: &str) -> bool {
        let query = url::form_urlencoded::parse(self.query.as_bytes()).any(|(name, value)| name == "token" && same(&value, token));
        let bearer = self
            .header("authorization")
            .and_then(|h| h.split_once(' '))
            .is_some_and(|(scheme, value)| scheme.eq_ignore_ascii_case("bearer") && same(value.trim(), token));
        query || bearer
    }
}

fn unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn encode(text: &str) -> String {
    text.bytes().map(|b| if unreserved(b) { char::from(b).to_string() } else { format!("%{b:02X}") }).collect()
}

fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn read_head(reader: &mut impl BufRead) -> io::Result<Option<Request>> {
    let mut lines = Vec::new();
    let mut size = 0;
    loop {
        let mut line = String::new();
        let n = (&mut *reader).take((HEAD - size + 1) as u64).read_line(&mut line)?;
        size += n;
        if n == 0 || size > HEAD {
            return Ok(None);
        }
        let line = line.trim_end_matches(['\r', '\n']).to_owned();
        if line.is_empty() {
            break;
        }
        lines.push(line);
    }
    let mut first = lines.first().map(|l| l.split(' ')).into_iter().flatten();
    let (Some(method), Some(target)) = (first.next(), first.next()) else { return Ok(None) };
    let target = target.split('#').next().unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let headers =
        lines[1..].iter().filter_map(|l| l.split_once(':')).map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned())).collect();
    Ok(Some(Request { method: method.to_owned(), path: path.to_owned(), query: query.to_owned(), headers }))
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

#[derive(Debug, PartialEq)]
enum Route {
    Version,
    List,
    Page(String),
    Browser(String),
    Missing,
}

fn route(path: &str) -> Route {
    let one = |id: &str| (!id.is_empty() && !id.contains('/')).then(|| decode(id)).flatten().filter(|id| !id.is_empty());
    match path {
        "/json/version" => Route::Version,
        "/json" | "/json/list" => Route::List,
        _ => match (path.strip_prefix("/devtools/page/").and_then(one), path.strip_prefix("/devtools/browser/").and_then(one)) {
            (Some(id), _) => Route::Page(id),
            (_, Some(id)) => Route::Browser(id),
            _ => Route::Missing,
        },
    }
}

impl Endpoint {
    fn socket(&self, path: &str) -> String {
        format!("127.0.0.1:{}{path}?token={}", self.port, self.token)
    }

    fn version(&self) -> Value {
        json!({
            "Browser": format!("acdert/{VERSION}"),
            "Protocol-Version": "1.3",
            "User-Agent": format!("acdert/{VERSION}"),
            "webSocketDebuggerUrl": format!("ws://{}", self.socket(&format!("/devtools/browser/{}", self.browser))),
        })
    }

    fn list(&self) -> Value {
        let targets = self.targets.locked().clone();
        targets
            .iter()
            .map(|t| {
                let socket = self.socket(&format!("/devtools/page/{}", encode(&t.id)));
                json!({
                    "description": "",
                    "devtoolsFrontendUrl": format!("devtools://devtools/bundled/inspector.html?ws={}", encode(&socket)),
                    "id": t.id,
                    "title": t.title,
                    "type": t.kind,
                    "url": t.url,
                    "webSocketDebuggerUrl": format!("ws://{socket}"),
                })
            })
            .collect()
    }
}

fn serve(endpoint: &'static Endpoint, mut stream: TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(HEAD_WAIT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let Some(request) = read_head(&mut reader)? else {
        return respond(&mut stream, "400 Bad Request", r#"{"error":"bad request"}"#);
    };
    if !request.token(&endpoint.token) {
        return respond(&mut stream, "401 Unauthorized", r#"{"error":"a token is required"}"#);
    }
    if request.method != "GET" {
        return respond(&mut stream, "405 Method Not Allowed", r#"{"error":"only GET"}"#);
    }
    let target = match route(&request.path) {
        Route::Version => return respond(&mut stream, "200 OK", &endpoint.version().to_string()),
        Route::List => return respond(&mut stream, "200 OK", &endpoint.list().to_string()),
        Route::Missing => return respond(&mut stream, "404 Not Found", r#"{"error":"not found"}"#),
        Route::Browser(id) if id == endpoint.browser => None,
        Route::Browser(_) => return respond(&mut stream, "404 Not Found", r#"{"error":"no such browser"}"#),
        Route::Page(id) => match endpoint.target(&id) {
            Some(target) => Some(target),
            None => return respond(&mut stream, "404 Not Found", &json!({"error": format!("no target {id}")}).to_string()),
        },
    };
    let Some(key) = request.upgrade() else {
        return respond(&mut stream, "400 Bad Request", r#"{"error":"a WebSocket upgrade is required"}"#);
    };
    let accept = ntex::ws::hash_key(key.as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    let answer = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    stream.write_all(answer.as_bytes())?;
    stream.set_read_timeout(None)?;
    session(endpoint, Client::new(target, stream), reader)
}

fn session(endpoint: &'static Endpoint, client: Client, mut reader: impl Read) -> io::Result<()> {
    endpoint.attach(&client);
    let mut messages = Messages::default();
    let result = loop {
        match messages.next(&mut reader) {
            Ok(Message::Text(text)) => handle(endpoint, &client, &text),
            Ok(Message::Ping(payload)) => client.pong(&payload),
            Ok(Message::Binary) => break Ok(()),
            Ok(Message::Close(payload)) => {
                client.answer_close(&payload);
                break Ok(());
            }
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    endpoint.detach(&client);
    client.close();
    result
}

fn handle(endpoint: &Endpoint, client: &Client, text: &str) {
    let Ok(Value::Object(message)) = serde_json::from_str::<Value>(text) else {
        client.send(&json!({"id": null, "error": {"code": -32700, "message": "Message must be a valid JSON"}}).to_string());
        return;
    };
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let mut answer = match message.get("method").and_then(Value::as_str) {
        Some("Browser.getVersion") => json!({"id": id, "result": {
            "protocolVersion": "1.3",
            "product": format!("acdert/{VERSION}"),
            "revision": "",
            "userAgent": format!("acdert/{VERSION}"),
            "jsVersion": "",
        }}),
        Some(_) if endpoint.forwarded(client, text) => return,
        Some(method) => json!({"id": id, "error": {"code": -32601, "message": format!("'{method}' wasn't found")}}),
        None => json!({"id": id, "error": {"code": -32600, "message": "Message must have string 'method' property"}}),
    };
    if let Some(session) = message.get("sessionId") {
        answer["sessionId"] = session.clone();
    }
    client.send(&answer.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_follow_chrome() {
        assert_eq!(route("/json/version"), Route::Version);
        assert_eq!(route("/json"), Route::List);
        assert_eq!(route("/json/list"), Route::List);
        assert_eq!(route("/devtools/page/alpha%237"), Route::Page("alpha#7".into()));
        assert_eq!(route("/devtools/page/desktop"), Route::Page("desktop".into()));
        assert_eq!(route("/devtools/browser/b"), Route::Browser("b".into()));
        assert_eq!(route("/devtools/page/"), Route::Missing);
        assert_eq!(route("/devtools/page/a/b"), Route::Missing);
        assert_eq!(route("/devtools/page/%2"), Route::Missing);
        assert_eq!(route("/json/protocol"), Route::Missing);
    }

    #[test]
    fn names_round_trip_through_a_url() {
        assert_eq!(encode("alpha#7"), "alpha%237");
        assert_eq!(decode(&encode("a b/c?d=e#f")).as_deref(), Some("a b/c?d=e#f"));
        assert_eq!(decode(&encode(&encode("x#1"))).as_deref(), Some("x%231"));
    }

    #[test]
    fn the_token_comes_in_the_query_or_as_a_bearer() {
        let request = |path: &str, headers: &[(&str, &str)]| {
            let head: String = headers.iter().map(|(n, v)| format!("{n}: {v}\r\n")).collect();
            read_head(&mut BufReader::new(format!("GET {path} HTTP/1.1\r\n{head}\r\n").as_bytes())).unwrap().unwrap()
        };
        assert!(request("/json/list?token=abcd", &[]).token("abcd"));
        assert!(request("/devtools/page/x?a=1&token=abcd", &[]).token("abcd"));
        assert!(request("/json/list", &[("Authorization", "Bearer abcd")]).token("abcd"));
        assert!(!request("/json/list", &[]).token("abcd"));
        assert!(!request("/json/list?token=abce", &[]).token("abcd"));
        assert!(!request("/json/list?token=", &[]).token("abcd"));
        assert!(!request("/json/list", &[("Authorization", "Basic abcd")]).token("abcd"));
    }

    #[test]
    fn a_head_is_read_to_its_blank_line() {
        let raw = "GET /json/list?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: WebSocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: k\r\n\r\nrest";
        let mut reader = BufReader::new(raw.as_bytes());
        let request = read_head(&mut reader).unwrap().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str(), request.query.as_str()), ("GET", "/json/list", "x=1"));
        assert_eq!(request.upgrade(), Some("k"));
        let mut rest = String::new();
        reader.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "rest");
        assert!(read_head(&mut BufReader::new(format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(HEAD)).as_bytes())).unwrap().is_none());
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same("abcd", "abcd"));
        assert!(!same("abcd", "abce"));
        assert!(!same("abc", "abcd"));
        assert!(!same("", "abcd"));
    }
}
