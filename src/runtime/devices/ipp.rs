use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

pub const GET_JOBS: u16 = 0x000A;
pub const CANCEL_JOB: u16 = 0x0008;
pub const PAUSE_PRINTER: u16 = 0x0010;
pub const RESUME_PRINTER: u16 = 0x0011;
pub const CUPS_GET_DEFAULT: u16 = 0x4001;
pub const CUPS_GET_PRINTERS: u16 = 0x4002;
pub const CUPS_SET_DEFAULT: u16 = 0x400A;

const OPERATION: u8 = 0x01;
const END: u8 = 0x03;
const INTEGER: u8 = 0x21;
const BOOLEAN: u8 = 0x22;
const ENUM: u8 = 0x23;
const URI: u8 = 0x45;
const NAME: u8 = 0x42;
const KEYWORD: u8 = 0x44;
const CHARSET: u8 = 0x47;
const LANGUAGE: u8 = 0x48;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub enum Ipp {
    Int(i32),
    Bool(bool),
    Text(String),
    Other,
}

pub struct Request {
    operation: u16,
    attributes: Vec<u8>,
}

impl Request {
    pub fn new(operation: u16) -> Self {
        let mut request = Request { operation, attributes: Vec::new() };
        request.put(CHARSET, "attributes-charset", "utf-8".as_bytes());
        request.put(LANGUAGE, "attributes-natural-language", "en".as_bytes());
        request
    }

    fn put(&mut self, tag: u8, name: &str, value: &[u8]) {
        self.attributes.push(tag);
        self.attributes.extend_from_slice(&(name.len() as u16).to_be_bytes());
        self.attributes.extend_from_slice(name.as_bytes());
        self.attributes.extend_from_slice(&(value.len() as u16).to_be_bytes());
        self.attributes.extend_from_slice(value);
    }

    pub fn uri(mut self, name: &str, value: &str) -> Self {
        self.put(URI, name, value.as_bytes());
        self
    }

    pub fn name(mut self, name: &str, value: &str) -> Self {
        self.put(NAME, name, value.as_bytes());
        self
    }

    pub fn int(mut self, name: &str, value: i32) -> Self {
        self.put(INTEGER, name, &value.to_be_bytes());
        self
    }

    pub fn keywords(mut self, name: &str, values: &[&str]) -> Self {
        for (i, value) in values.iter().enumerate() {
            self.put(KEYWORD, if i == 0 { name } else { "" }, value.as_bytes());
        }
        self
    }

    pub fn encode(&self, id: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.attributes.len() + 10);
        out.extend_from_slice(&[2, 0]);
        out.extend_from_slice(&self.operation.to_be_bytes());
        out.extend_from_slice(&id.to_be_bytes());
        out.push(OPERATION);
        out.extend_from_slice(&self.attributes);
        out.push(END);
        out
    }
}

pub type Attributes = Vec<(String, Vec<Ipp>)>;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub groups: Vec<(u8, Attributes)>,
}

impl Response {
    pub fn ok(&self) -> bool {
        self.status < 0x0100
    }

    pub fn of(&self, tag: u8) -> impl Iterator<Item = &Attributes> {
        self.groups.iter().filter(move |(t, _)| *t == tag).map(|(_, a)| a)
    }

    pub fn decode(bytes: &[u8]) -> Result<Response, String> {
        let bad = || "IPP: the response is cut short".to_owned();
        let mut at = 8;
        let status = u16::from_be_bytes([*bytes.get(2).ok_or_else(bad)?, *bytes.get(3).ok_or_else(bad)?]);
        let mut groups: Vec<(u8, Attributes)> = Vec::new();
        let take = |at: &mut usize, n: usize| -> Result<&[u8], String> {
            let slice = bytes.get(*at..*at + n).ok_or_else(bad)?;
            *at += n;
            Ok(slice)
        };
        loop {
            let tag = *bytes.get(at).ok_or_else(bad)?;
            at += 1;
            if tag == END {
                break;
            }
            if tag < 0x10 {
                groups.push((tag, Vec::new()));
                continue;
            }
            let len = take(&mut at, 2)?;
            let name_len = usize::from(u16::from_be_bytes([len[0], len[1]]));
            let name = String::from_utf8_lossy(take(&mut at, name_len)?).into_owned();
            let len = take(&mut at, 2)?;
            let value_len = usize::from(u16::from_be_bytes([len[0], len[1]]));
            let raw = take(&mut at, value_len)?;
            let value = match tag {
                INTEGER | ENUM if raw.len() == 4 => Ipp::Int(i32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])),
                BOOLEAN if raw.len() == 1 => Ipp::Bool(raw[0] != 0),
                0x41..=0x49 => Ipp::Text(String::from_utf8_lossy(raw).into_owned()),
                _ => Ipp::Other,
            };
            let Some((_, attributes)) = groups.last_mut() else { return Err("IPP: an attribute outside any group".into()) };
            if name.is_empty() {
                if let Some((_, values)) = attributes.last_mut() {
                    values.push(value);
                }
            } else {
                attributes.push((name, vec![value]));
            }
        }
        Ok(Response { status, groups })
    }
}

pub fn first<'a>(attributes: &'a Attributes, name: &str) -> Option<&'a Ipp> {
    attributes.iter().find(|(n, _)| n == name).and_then(|(_, v)| v.first())
}

pub fn text(attributes: &Attributes, name: &str) -> String {
    match first(attributes, name) {
        Some(Ipp::Text(s)) => s.clone(),
        _ => String::new(),
    }
}

pub fn int(attributes: &Attributes, name: &str) -> Option<i32> {
    match first(attributes, name) {
        Some(Ipp::Int(n)) => Some(*n),
        _ => None,
    }
}

pub fn boolean(attributes: &Attributes, name: &str) -> Option<bool> {
    match first(attributes, name) {
        Some(Ipp::Bool(b)) => Some(*b),
        _ => None,
    }
}

pub fn texts(attributes: &Attributes, name: &str) -> Vec<String> {
    attributes
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, values)| values.iter().filter_map(|v| if let Ipp::Text(s) = v { Some(s.clone()) } else { None }).collect())
        .unwrap_or_default()
}

pub enum Failure {
    Unreachable(String),
    Unauthorized,
    Status(u16, String),
}

impl Failure {
    pub fn message(self) -> String {
        match self {
            Failure::Unreachable(e) => format!("CUPS is not running: {e}"),
            Failure::Unauthorized => "CUPS: not allowed (needs an administrator)".into(),
            Failure::Status(code, message) if message.is_empty() => format!("CUPS: status 0x{code:04x}"),
            Failure::Status(_, message) => format!("CUPS: {message}"),
        }
    }
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

fn socket() -> Result<Box<dyn Stream>, String> {
    let given = std::env::var("CUPS_SERVER").ok().filter(|s| s.starts_with('/'));
    let paths = given.into_iter().chain(["/run/cups/cups.sock".to_owned(), "/var/run/cups/cups.sock".to_owned()]);
    let mut last = String::from("no socket");
    for path in paths {
        match UnixStream::connect(&path) {
            Ok(stream) => {
                stream.set_read_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
                stream.set_write_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
                return Ok(Box::new(stream));
            }
            Err(e) => last = format!("{path}: {e}"),
        }
    }
    let tcp = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], 631).into(), Duration::from_secs(2)).map_err(|_| last)?;
    tcp.set_read_timeout(Some(TIMEOUT)).map_err(|e| e.to_string())?;
    Ok(Box::new(tcp))
}

pub fn user() -> String {
    if let Some(user) = ["USER", "LOGNAME"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty())) {
        return user;
    }
    let uid = rustix::process::getuid().as_raw();
    std::fs::read_to_string("/etc/passwd")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                let mut fields = line.split(':');
                let name = fields.next()?;
                (fields.nth(1)?.parse::<u32>().ok()? == uid).then(|| name.to_owned())
            })
        })
        .unwrap_or_else(|| uid.to_string())
}

pub fn send(path: &str, request: &Request) -> Result<Response, Failure> {
    let body = request.encode(1);
    match post(path, &body, None)? {
        Posted::Unauthorized => match post(path, &body, Some(&user()))? {
            Posted::Unauthorized => Err(Failure::Unauthorized),
            Posted::Body(bytes) => checked(&bytes),
        },
        Posted::Body(bytes) => checked(&bytes),
    }
}

fn checked(bytes: &[u8]) -> Result<Response, Failure> {
    let response = Response::decode(bytes).map_err(|e| Failure::Status(0x0500, e))?;
    if response.ok() {
        return Ok(response);
    }
    if matches!(response.status, 0x0401..=0x0403) {
        return Err(Failure::Unauthorized);
    }
    let message = response.of(OPERATION).next().map(|a| text(a, "status-message")).unwrap_or_default();
    Err(Failure::Status(response.status, message))
}

enum Posted {
    Unauthorized,
    Body(Vec<u8>),
}

fn post(path: &str, body: &[u8], peer: Option<&str>) -> Result<Posted, Failure> {
    let mut stream = socket().map_err(Failure::Unreachable)?;
    let auth = peer.map(|user| format!("Authorization: PeerCred {user}\r\n")).unwrap_or_default();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\n{auth}Connection: close\r\n\r\n",
        body.len()
    );
    let io = |e: std::io::Error| Failure::Unreachable(e.to_string());
    stream.write_all(head.as_bytes()).map_err(io)?;
    stream.write_all(body).map_err(io)?;
    stream.flush().map_err(io)?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(io)?;
    let (status, body) = http_body(&raw).map_err(|e| Failure::Status(0x0500, e))?;
    match status {
        401 | 403 => Ok(Posted::Unauthorized),
        200 => Ok(Posted::Body(body)),
        other => Err(Failure::Status(0x0500, format!("HTTP {other}"))),
    }
}

pub fn http_body(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("HTTP: no end of headers")?;
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse::<u16>().ok()).ok_or("HTTP: no status")?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else { continue };
        let (key, value) = (key.trim().to_ascii_lowercase(), value.trim());
        if key == "content-length" {
            length = value.parse::<usize>().ok();
        } else if key == "transfer-encoding" && value.eq_ignore_ascii_case("chunked") {
            chunked = true;
        }
    }
    let rest = &raw[end + 4..];
    if chunked {
        let mut body = Vec::new();
        let mut at = 0;
        loop {
            let line_end = rest[at..].windows(2).position(|w| w == b"\r\n").ok_or("HTTP: a chunk is cut short")? + at;
            let size_text = String::from_utf8_lossy(&rest[at..line_end]);
            let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "HTTP: a bad chunk size")?;
            at = line_end + 2;
            if size == 0 {
                break;
            }
            body.extend_from_slice(rest.get(at..at + size).ok_or("HTTP: a chunk is cut short")?);
            at += size + 2;
        }
        return Ok((status, body));
    }
    let body = match length {
        Some(n) => rest.get(..n).ok_or("HTTP: the body is cut short")?.to_vec(),
        None => rest.to_vec(),
    };
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_request() {
        let bytes = Request::new(CUPS_GET_PRINTERS).keywords("requested-attributes", &["printer-name", "printer-state"]).encode(7);
        assert_eq!(&bytes[..8], &[2, 0, 0x40, 0x02, 0, 0, 0, 7]);
        assert_eq!(bytes[8], OPERATION);
        assert_eq!(*bytes.last().unwrap(), END);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("attributes-charset") && text.contains("utf-8") && text.contains("printer-state"));
        assert!(bytes.windows(18).any(|w| w == b"\x44\x00\x00\x00\x0dprinter-state"));
    }

    fn attr(out: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
        out.push(tag);
        out.extend_from_slice(&(name.len() as u16).to_be_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value);
    }

    #[test]
    fn decodes_a_response() {
        let mut out = vec![2, 0, 0, 0, 0, 0, 0, 1, OPERATION];
        attr(&mut out, CHARSET, "attributes-charset", b"utf-8");
        for (name, state) in [("laser", 3), ("ink", 5)] {
            out.push(0x04);
            attr(&mut out, NAME, "printer-name", name.as_bytes());
            attr(&mut out, ENUM, "printer-state", &i32::to_be_bytes(state));
            attr(&mut out, KEYWORD, "printer-state-reasons", b"none");
            attr(&mut out, KEYWORD, "", b"paused");
            attr(&mut out, BOOLEAN, "printer-is-accepting-jobs", &[1]);
            attr(&mut out, 0x34, "media-col", b"");
            attr(&mut out, 0x4A, "", b"media-size");
            attr(&mut out, 0x37, "", b"");
            attr(&mut out, INTEGER, "queued-job-count", &i32::to_be_bytes(2));
        }
        out.push(END);
        let response = Response::decode(&out).unwrap();
        assert!(response.ok());
        let printers: Vec<_> = response.of(0x04).collect();
        assert_eq!(printers.len(), 2);
        assert_eq!(text(printers[1], "printer-name"), "ink");
        assert_eq!(int(printers[1], "printer-state"), Some(5));
        assert_eq!(texts(printers[0], "printer-state-reasons"), ["none", "paused"]);
        assert_eq!(boolean(printers[0], "printer-is-accepting-jobs"), Some(true));
        assert_eq!(int(printers[0], "queued-job-count"), Some(2));
        assert!(Response::decode(&out[..out.len() - 6]).is_err());
    }

    #[test]
    fn reads_http_bodies() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\nContent-Length: 3\r\n\r\nabcdef";
        assert_eq!(http_body(plain).unwrap(), (200, b"abc".to_vec()));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=1\r\nde\r\n0\r\n\r\n";
        assert_eq!(http_body(chunked).unwrap(), (200, b"abcde".to_vec()));
        let denied = b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: PeerCred\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(http_body(denied).unwrap().0, 401);
    }
}
