use std::io::{self, BufRead, BufReader, IoSlice, Write};
use std::mem::MaybeUninit;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::path::Path;

use rustix::net::{SendAncillaryBuffer, SendAncillaryMessage, SendFlags, sendmsg};

const FD_NAME: &str = "acdev-viewer";

pub fn open_display(qmp: &Path) -> io::Result<UnixStream> {
    let stream = UnixStream::connect(qmp)?;
    let mut lines = BufReader::new(stream.try_clone()?);
    let mut greeting = String::new();
    lines.read_line(&mut greeting)?;
    if !greeting.contains("\"QMP\"") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("not a QMP greeting: {}", greeting.trim())));
    }
    execute(&stream, &mut lines, r#"{"execute":"qmp_capabilities"}"#)?;
    let (ours, theirs) = UnixStream::pair()?;
    send_with_fd(&stream, &format!(r#"{{"execute":"getfd","arguments":{{"fdname":"{FD_NAME}"}}}}"#), &theirs)?;
    answer(&mut lines)?;
    drop(theirs);
    let add = format!(r#"{{"execute":"add_client","arguments":{{"protocol":"@dbus-display","fdname":"{FD_NAME}"}}}}"#);
    execute(&stream, &mut lines, &add)?;
    Ok(ours)
}

fn execute(mut stream: &UnixStream, lines: &mut BufReader<UnixStream>, command: &str) -> io::Result<()> {
    stream.write_all(format!("{command}\n").as_bytes())?;
    answer(lines)
}

fn send_with_fd(stream: &UnixStream, command: &str, fd: &UnixStream) -> io::Result<()> {
    let line = format!("{command}\n");
    let mut space = [MaybeUninit::<u8>::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    let fds = [fd.as_fd()];
    if !control.push(SendAncillaryMessage::ScmRights(&fds)) {
        return Err(io::Error::other("no room for the descriptor"));
    }
    let sent = sendmsg(stream, &[IoSlice::new(line.as_bytes())], &mut control, SendFlags::empty())?;
    if sent != line.len() {
        return Err(io::Error::new(io::ErrorKind::WriteZero, "getfd was cut short"));
    }
    Ok(())
}

fn answer(lines: &mut BufReader<UnixStream>) -> io::Result<()> {
    loop {
        let mut line = String::new();
        if lines.read_line(&mut line)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "QMP closed"));
        }
        if line.contains("\"return\"") {
            return Ok(());
        }
        if line.contains("\"error\"") {
            return Err(io::Error::other(format!("QMP: {}", line.trim())));
        }
    }
}
