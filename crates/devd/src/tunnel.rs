use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;

use crate::frame;

pub struct Sockets(Vec<String>);

impl Sockets {
    pub const DEFAULTS: [&str; 1] = ["/run/user/*/acde/dev.sock"];
    const USERS: &str = "/run/user";
    const MANAGER: &str = "acde/dev.sock";

    pub fn new(patterns: Vec<String>) -> Self {
        Self(patterns)
    }

    pub fn defaults() -> Self {
        Self(Self::DEFAULTS.map(str::to_owned).to_vec())
    }

    pub fn admits(&self, path: &Path) -> bool {
        path.to_str().is_some_and(|path| self.0.iter().any(|pattern| matches(pattern, path)))
    }

    fn listed(&self) -> String {
        self.0.join(", ")
    }

    fn manager() -> io::Result<PathBuf> {
        let at = |uid: &str| Path::new(Self::USERS).join(uid).join(Self::MANAGER);
        if let Some(path) = active_uid().map(|uid| at(&uid)).filter(|path| path.exists()) {
            return Ok(path);
        }
        let found: Vec<PathBuf> = std::fs::read_dir(Self::USERS)
            .map(|dir| dir.flatten().map(|entry| entry.path().join(Self::MANAGER)).filter(|path| path.exists()).collect())
            .unwrap_or_default();
        match found.as_slice() {
            [one] => Ok(one.clone()),
            [] => Err(io::Error::new(io::ErrorKind::NotFound, format!("no session manager debug socket ({}/*/{})", Self::USERS, Self::MANAGER))),
            _ => Err(io::Error::new(io::ErrorKind::NotFound, "several sessions have a debug socket and logind names no active one")),
        }
    }
}

fn active_uid() -> Option<String> {
    let said = |args: &[&str]| {
        let out = Command::new("loginctl").args(args).output().ok().filter(|out| out.status.success())?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|text| !text.is_empty())
    };
    let session = said(&["show-seat", "seat0", "--property=ActiveSession", "--value"])?;
    said(&["show-session", &session, "--property=User", "--value"])
}

fn matches(pattern: &str, path: &str) -> bool {
    let (wanted, given): (Vec<&str>, Vec<&str>) = (pattern.split('/').collect(), path.split('/').collect());
    wanted.len() == given.len() && wanted.iter().zip(&given).all(|(w, g)| segment(w.as_bytes(), g.as_bytes()))
}

fn segment(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((b'*', rest)) => (0..=text.len()).any(|skip| segment(rest, &text[skip..])),
        Some((c, rest)) => text.split_first().is_some_and(|(t, more)| t == c && segment(rest, more)),
    }
}

pub fn socket(body: &[u8], sockets: &Sockets, reader: UnixStream, writer: UnixStream) -> io::Result<()> {
    if body.is_empty() {
        let path = Sockets::manager()?;
        let target = UnixStream::connect(&path).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
        return relay(reader, writer, target);
    }
    let asked = String::from_utf8_lossy(body).into_owned();
    if !Path::new(&asked).is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{asked} is not an absolute path")));
    }
    let path = std::fs::canonicalize(&asked).map_err(|e| io::Error::new(e.kind(), format!("{asked}: {e}")))?;
    if !sockets.admits(&path) {
        let why = format!("{} is not a socket acdevd tunnels to (allowed: {})", path.display(), sockets.listed());
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, why));
    }
    let target = UnixStream::connect(&path).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
    relay(reader, writer, target)
}

pub fn tcp(body: &[u8], reader: UnixStream, writer: UnixStream) -> io::Result<()> {
    let port = match body {
        [low, high] => u16::from_le_bytes([*low, *high]),
        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "a tcp tunnel wants a u16 port")),
    };
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| io::Error::new(e.kind(), format!("127.0.0.1:{port}: {e}")))?;
    stream.set_nodelay(true)?;
    relay(reader, writer, UnixStream::from(OwnedFd::from(stream)))
}

fn relay(reader: UnixStream, mut writer: UnixStream, target: UnixStream) -> io::Result<()> {
    frame::write(&mut writer, frame::OK, &[])?;
    let target_read = target.try_clone()?;
    let closing = (reader.try_clone()?, target.try_clone()?);
    let up = thread::spawn(move || {
        copy(reader, &target);
        let _ = target.shutdown(Shutdown::Both);
    });
    copy(target_read, &writer);
    let _ = closing.0.shutdown(Shutdown::Both);
    let _ = closing.1.shutdown(Shutdown::Both);
    let _ = up.join();
    Ok(())
}

pub fn copy(mut from: impl Read, mut to: impl Write) {
    let mut buffer = [0u8; 64 * 1024];
    while let Ok(read) = from.read(&mut buffer) {
        if read == 0 || to.write_all(&buffer[..read]).and_then(|()| to.flush()).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serve::{Settings, handle};
    use std::os::unix::net::UnixListener;

    const KEY: &[u8] = b"s3cret";

    fn scratch(name: &str) -> PathBuf {
        let dir = crate::serve::scratch_path(&format!("tunnel-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn open(dir: &Path, key: Option<&[u8]>, kind: u8, body: &[u8]) -> (UnixStream, thread::JoinHandle<io::Result<()>>) {
        let (mut host, guest) = UnixStream::pair().unwrap();
        let pattern = format!("{}/*/acde/dev.sock", dir.display());
        let settings = Settings { logs: dir.join("logs"), key: key.map(<[u8]>::to_vec), sockets: Sockets::new(vec![pattern]) };
        let server = thread::spawn(move || handle(guest, &settings));
        if let Some(key) = key {
            frame::write(&mut host, frame::AUTH, key).unwrap();
        }
        frame::write(&mut host, kind, body).unwrap();
        (host, server)
    }

    fn echo(mut stream: impl Read + Write) {
        let mut buffer = [0u8; 64];
        while let Ok(read) = stream.read(&mut buffer) {
            if read == 0 || stream.write_all(&buffer[..read].to_ascii_uppercase()).is_err() {
                break;
            }
        }
    }

    fn round_trip(host: &mut UnixStream) -> Vec<u8> {
        let reply = frame::read(host).unwrap().unwrap();
        assert_eq!(reply.kind, frame::OK, "{}", String::from_utf8_lossy(&reply.body));
        host.write_all(b"ping").unwrap();
        let mut back = [0u8; 4];
        host.read_exact(&mut back).unwrap();
        back.to_vec()
    }

    #[test]
    fn a_socket_tunnel_carries_bytes_both_ways_until_one_side_closes() {
        let dir = scratch("socket");
        let path = dir.join("1000/acde/dev.sock");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&path).unwrap();
        let manager = thread::spawn(move || echo(listener.accept().unwrap().0));
        let (mut host, server) = open(&dir, Some(KEY), frame::SOCKET, path.to_str().unwrap().as_bytes());
        assert_eq!(round_trip(&mut host), b"PING");
        host.shutdown(Shutdown::Both).unwrap();
        manager.join().unwrap();
        server.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_socket_outside_the_allowed_patterns_is_refused() {
        let dir = scratch("refused");
        let path = dir.join("elsewhere.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        let (mut host, server) = open(&dir, Some(KEY), frame::SOCKET, path.to_str().unwrap().as_bytes());
        let reply = frame::read(&mut host).unwrap().unwrap();
        assert_eq!(reply.kind, frame::ERROR);
        assert!(String::from_utf8_lossy(&reply.body).contains("is not a socket acdevd tunnels to"));
        assert!(server.join().unwrap().is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_tunnel_needs_the_key() {
        let dir = scratch("keyless");
        let (mut host, server) = open(&dir, None, frame::TCP, &1u16.to_le_bytes());
        let reply = frame::read(&mut host).unwrap().unwrap();
        assert_eq!(reply.kind, frame::ERROR);
        assert!(String::from_utf8_lossy(&reply.body).contains("a tunnel needs a key"));
        assert!(server.join().unwrap().is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_tcp_tunnel_reaches_a_local_port() {
        let dir = scratch("tcp");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = thread::spawn(move || echo(listener.accept().unwrap().0));
        let (mut host, server) = open(&dir, Some(KEY), frame::TCP, &port.to_le_bytes());
        assert_eq!(round_trip(&mut host), b"PING");
        host.shutdown(Shutdown::Both).unwrap();
        target.join().unwrap();
        server.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_star_stays_within_one_path_part() {
        let sockets = Sockets::defaults();
        assert!(sockets.admits(Path::new("/run/user/1000/acde/dev.sock")));
        assert!(!sockets.admits(Path::new("/run/user/1000/x/acde/dev.sock")));
        assert!(!sockets.admits(Path::new("/run/acde/other.sock")));
    }
}
