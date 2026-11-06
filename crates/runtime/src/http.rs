use ntex::io::Io;
use std::io;

#[cfg(target_os = "linux")]
pub(crate) fn tls() -> Result<openssl::ssl::SslConnector, openssl::error::ErrorStack> {
    let mut ssl = openssl::ssl::SslConnector::builder(openssl::ssl::SslMethod::tls())?;
    _ = ssl.set_alpn_protos(b"\x08http/1.1");
    Ok(ssl.build())
}

#[cfg(target_os = "linux")]
pub(crate) fn client() -> ntex::client::Client {
    thread_local! {
        static CLIENT: ntex::client::Client = ntex::client::Client::builder().openssl(tls().expect("acde runtime: OpenSSL")).build(ntex::SharedCfg::default());
    }
    CLIENT.with(Clone::clone)
}

pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub host: &'a str,
    pub headers: Vec<(&'a str, String)>,
    pub body: Option<&'a [u8]>,
}

impl Request<'_> {
    pub fn encode(&self) -> Vec<u8> {
        let mut head = format!("{} {} HTTP/1.1\r\nHost: {}\r\n", self.method, self.path, self.host);
        if !self.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("connection")) {
            head.push_str("Connection: close\r\n");
        }
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(body) = self.body {
            head.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        let mut request = head.into_bytes();
        request.extend_from_slice(self.body.unwrap_or_default());
        request
    }
}

pub struct Head {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    fn parse<'a>(mut lines: impl Iterator<Item = &'a str>) -> Option<Self> {
        let line = lines.next()?;
        let mut parts = line.splitn(3, ' ');
        let status = parts.next().filter(|version| version.starts_with("HTTP/")).and(parts.next())?;
        let status = status.parse().ok().filter(|s| (100..1000).contains(s))?;
        let reason = parts.next().unwrap_or_default().to_owned();
        let headers = lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned())).collect();
        Some(Self { status, reason, headers })
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    pub async fn read(io: &Io, limit: u64) -> io::Result<Self> {
        let mut lines = Vec::new();
        let mut left = limit;
        loop {
            let line = line(io, left).await?;
            left = left.saturating_sub(line.len() as u64 + 2);
            if line.is_empty() {
                break;
            }
            lines.push(line);
        }
        Self::parse(lines.iter().map(String::as_str)).ok_or_else(|| invalid("bad HTTP status line"))
    }

    pub fn framing(&self, method: &str) -> io::Result<Framing> {
        if method.eq_ignore_ascii_case("HEAD") || matches!(self.status, 100..=199 | 204 | 304) {
            return Ok(Framing::Length(0));
        }
        if let Some(coding) = self.header("transfer-encoding") {
            return match coding.rsplit(',').next().map(str::trim) {
                Some(last) if last.eq_ignore_ascii_case("chunked") => Ok(Framing::Chunked),
                _ => Ok(Framing::Close),
            };
        }
        match self.header("content-length") {
            Some(length) => length.parse().map(Framing::Length).map_err(|_| invalid("bad Content-Length")),
            None => Ok(Framing::Close),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    Length(u64),
    Chunked,
    Close,
}

pub struct Body {
    framing: Framing,
    left: u64,
    chunk_end: bool,
    done: bool,
}

impl Body {
    pub fn new(framing: Framing) -> Self {
        let left = match framing {
            Framing::Length(length) => length,
            _ => 0,
        };
        Self { framing, left, chunk_end: false, done: framing == Framing::Length(0) }
    }

    pub async fn next(&mut self, io: &Io, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        if self.done {
            return Ok(None);
        }
        if self.framing == Framing::Chunked && self.left == 0 {
            if std::mem::take(&mut self.chunk_end) && !line(io, 2).await?.is_empty() {
                return Err(invalid("bad chunk end"));
            }
            let size = line(io, 4096).await?;
            let size = size.split(';').next().map(str::trim).and_then(|s| u64::from_str_radix(s, 16).ok());
            let size = size.ok_or_else(|| invalid("bad chunk size"))?;
            if size == 0 {
                while !line(io, 64 * 1024).await?.is_empty() {}
                self.done = true;
                return Ok(None);
            }
            self.left = size;
        }
        let want = match self.framing {
            Framing::Close => buffer.len(),
            _ => self.left.min(buffer.len() as u64) as usize,
        };
        let read = read(io, &mut buffer[..want]).await?;
        if read == 0 {
            if self.framing == Framing::Close {
                self.done = true;
                return Ok(None);
            }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the connection closed before the end of the response"));
        }
        if self.framing != Framing::Close {
            self.left -= read as u64;
        }
        match self.framing {
            Framing::Length(_) => self.done = self.left == 0,
            Framing::Chunked => self.chunk_end = self.left == 0,
            Framing::Close => {}
        }
        Ok(Some(read))
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

async fn line(io: &Io, limit: u64) -> io::Result<String> {
    let window = usize::try_from(limit).unwrap_or(usize::MAX);
    loop {
        let found = io.with_read_dst(|buf| {
            let end = buf.len().min(window);
            buf[..end].iter().position(|b| *b == b'\n').map(|at| buf.split_to(at + 1))
        });
        if let Some(raw) = found {
            let mut raw = &raw[..raw.len() - 1];
            if raw.last() == Some(&b'\r') {
                raw = &raw[..raw.len() - 1];
            }
            return Ok(String::from_utf8_lossy(raw).into_owned());
        }
        if io.read_dst_size() >= window {
            return Err(invalid("response line too long"));
        }
        if io.read_more().await?.is_none() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the connection closed in the response head"));
        }
    }
}

async fn read(io: &Io, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        let read = io.with_read_dst(|buf| {
            let n = buf.len().min(buffer.len());
            buffer[..n].copy_from_slice(&buf[..n]);
            buf.advance_to(n);
            n
        });
        if read > 0 || buffer.is_empty() || io.read_more().await?.is_none() {
            return Ok(read);
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn take(io: &Io, raw: &mut Vec<u8>) -> io::Result<bool> {
    loop {
        let moved = io.with_read_dst(|buf| {
            raw.extend_from_slice(buf);
            let moved = buf.len();
            buf.clear();
            moved
        });
        if moved > 0 {
            return Ok(true);
        }
        if io.read_more().await?.is_none() {
            return Ok(false);
        }
    }
}

#[derive(Default)]
pub(crate) struct Messages {
    partial: Option<(bool, Vec<u8>)>,
}

pub(crate) enum Incoming {
    Text(String),
    Binary(Vec<u8>),
    Ping(ntex::util::Bytes),
    Close(Option<ntex::ws::CloseReason>),
    Nothing,
}

impl Messages {
    const FRAME: usize = 16 << 20;
    const MESSAGE: usize = 64 << 20;

    pub(crate) fn codec() -> ntex::ws::Codec {
        ntex::ws::Codec::new().max_size(Self::FRAME).set_client_mode()
    }

    pub(crate) async fn next(&mut self, io: &Io, codec: &ntex::ws::Codec) -> Result<Option<Incoming>, String> {
        use ntex::ws::{Frame, Item};
        let frame = loop {
            if let Some(frame) = io.decode(codec).map_err(|e| e.to_string())? {
                break frame;
            }
            if io.read_more().await.map_err(|e| e.to_string())?.is_none() {
                return Ok(None);
            }
        };
        let (text, data) = match frame {
            Frame::Text(data) => (true, data.to_vec()),
            Frame::Binary(data) => (false, data.to_vec()),
            Frame::Ping(data) => return Ok(Some(Incoming::Ping(data))),
            Frame::Pong(_) => return Ok(Some(Incoming::Nothing)),
            Frame::Close(reason) => return Ok(Some(Incoming::Close(reason))),
            Frame::Continuation(Item::FirstText(data)) => {
                self.partial = Some((true, data.to_vec()));
                return Ok(Some(Incoming::Nothing));
            }
            Frame::Continuation(Item::FirstBinary(data)) => {
                self.partial = Some((false, data.to_vec()));
                return Ok(Some(Incoming::Nothing));
            }
            Frame::Continuation(Item::Continue(data)) => {
                self.join(&data)?;
                return Ok(Some(Incoming::Nothing));
            }
            Frame::Continuation(Item::Last(data)) => {
                self.join(&data)?;
                self.partial.take().ok_or("a continuation without a first frame")?
            }
        };
        Ok(Some(if text {
            Incoming::Text(String::from_utf8(data).map_err(|_| "a text message that is not UTF-8".to_owned())?)
        } else {
            Incoming::Binary(data)
        }))
    }

    fn join(&mut self, data: &[u8]) -> Result<(), String> {
        let (_, joined) = self.partial.as_mut().ok_or("a continuation without a first frame")?;
        joined.extend_from_slice(data);
        if joined.len() > Self::MESSAGE {
            return Err("the message is too big".into());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod frames {
    use std::io::Read;

    pub(crate) fn write(fin: bool, opcode: u8, payload: &[u8], mask: bool) -> Vec<u8> {
        let mut frame = vec![if fin { 0x80 } else { 0 } | opcode];
        let bit = if mask { 0x80 } else { 0 };
        match payload.len() {
            n if n < 126 => frame.push(bit | n as u8),
            n if n <= 0xffff => {
                frame.push(bit | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(bit | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        if mask {
            let key = [0x12, 0x34, 0x56, 0x78];
            frame.extend_from_slice(&key);
            frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
        } else {
            frame.extend_from_slice(payload);
        }
        frame
    }

    pub(crate) fn read(reader: &mut impl Read, masked: bool) -> (bool, u8, Vec<u8>) {
        let mut head = [0u8; 2];
        reader.read_exact(&mut head).expect("frame head");
        assert_eq!(head[1] & 0x80 != 0, masked, "masking");
        let length = match head[1] & 0x7f {
            126 => {
                let mut n = [0u8; 2];
                reader.read_exact(&mut n).expect("length");
                u16::from_be_bytes(n) as usize
            }
            127 => {
                let mut n = [0u8; 8];
                reader.read_exact(&mut n).expect("length");
                u64::from_be_bytes(n) as usize
            }
            n => n as usize,
        };
        let mut key = [0u8; 4];
        if masked {
            reader.read_exact(&mut key).expect("mask");
        }
        let mut payload = vec![0u8; length];
        reader.read_exact(&mut payload).expect("payload");
        payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= key[i % 4]);
        (head[0] & 0x80 != 0, head[0] & 0x0f, payload)
    }
}
