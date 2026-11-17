use std::io::{self, Read, Write};

pub const MAX: usize = 16 << 20;

pub const VERSION: u8 = b'V';
pub const PUSH: u8 = b'P';
pub const DATA: u8 = b'D';
pub const END: u8 = b'E';
pub const DONE: u8 = b'Z';
pub const RUN: u8 = b'R';
pub const KILL: u8 = b'K';
pub const OK: u8 = b'O';
pub const ERROR: u8 = b'X';
pub const PID: u8 = b'I';
pub const STDOUT: u8 = b'1';
pub const STDERR: u8 = b'2';
pub const EXIT: u8 = b'Q';

pub const DETACH: u8 = 1;

pub struct Frame {
    pub kind: u8,
    pub body: Vec<u8>,
}

pub fn read(from: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut head = [0u8; 4];
    match from.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(head) as usize;
    if len == 0 || len > MAX {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("a frame of {len} bytes")));
    }
    let mut all = vec![0u8; len];
    from.read_exact(&mut all)?;
    let kind = all[0];
    all.remove(0);
    Ok(Some(Frame { kind, body: all }))
}

pub fn write(to: &mut impl Write, kind: u8, body: &[u8]) -> io::Result<()> {
    let len = u32::try_from(body.len() + 1).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too long"))?;
    let mut out = Vec::with_capacity(body.len() + 5);
    out.extend_from_slice(&len.to_le_bytes());
    out.push(kind);
    out.extend_from_slice(body);
    to.write_all(&out)?;
    to.flush()
}

pub fn strings(body: &[u8]) -> Vec<String> {
    body.split(|b| *b == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect()
}

pub fn u32_at(body: &[u8], at: usize) -> Option<u32> {
    body.get(at..at + 4).map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}
