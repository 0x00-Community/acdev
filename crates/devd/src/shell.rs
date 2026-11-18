use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use crate::frame;

unsafe extern "C" {
    fn posix_openpt(flags: i32) -> i32;
    fn grantpt(fd: i32) -> i32;
    fn unlockpt(fd: i32) -> i32;
    fn ptsname_r(fd: i32, buf: *mut u8, len: usize) -> i32;
    fn ioctl(fd: i32, request: u64, ...) -> i32;
    fn setsid() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
}

const O_RDWR: i32 = 0o2;
const O_NOCTTY: i32 = 0o400;
const O_CLOEXEC: i32 = 0o2000000;
const TIOCSWINSZ: u64 = 0x5414;
const TIOCSCTTY: u64 = 0x540E;
const SIGHUP: i32 = 1;
const SIG_DFL: usize = 0;
const DRAIN: Duration = Duration::from_millis(500);

#[repr(C)]
struct Winsize {
    rows: u16,
    cols: u16,
    xpixel: u16,
    ypixel: u16,
}

pub struct Request {
    pub rows: u16,
    pub cols: u16,
    pub term: String,
    pub argv: Vec<String>,
}

impl Request {
    pub fn parse(body: &[u8]) -> io::Result<Self> {
        let size = |at: usize| body.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
        let (Some(rows), Some(cols)) = (size(0), size(2)) else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a shell without a size"));
        };
        let mut words = frame::strings(&body[4..]).into_iter();
        let term = words.next().unwrap_or_else(|| "dumb".into());
        Ok(Self { rows, cols, term, argv: words.collect() })
    }
}

fn os_error<T>(result: i32, ok: T) -> io::Result<T> {
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(ok) }
}

fn resize(master: &File, rows: u16, cols: u16) -> io::Result<()> {
    let size = Winsize { rows, cols, xpixel: 0, ypixel: 0 };
    os_error(unsafe { ioctl(master.as_raw_fd(), TIOCSWINSZ, &size as *const Winsize) }, ())
}

fn open_pty() -> io::Result<(File, File)> {
    let fd = unsafe { posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC) };
    os_error(fd, ())?;
    let master = unsafe { File::from_raw_fd(fd) };
    os_error(unsafe { grantpt(fd) }, ())?;
    os_error(unsafe { unlockpt(fd) }, ())?;
    let mut name = [0u8; 128];
    let failed = unsafe { ptsname_r(fd, name.as_mut_ptr(), name.len()) };
    if failed != 0 {
        return Err(io::Error::from_raw_os_error(failed));
    }
    let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
    let path = String::from_utf8_lossy(&name[..end]).into_owned();
    let slave = OpenOptions::new().read(true).write(true).custom_flags(O_NOCTTY).open(path)?;
    Ok((master, slave))
}

struct Root {
    shell: String,
    home: String,
}

fn root() -> Root {
    let line =
        std::fs::read_to_string("/etc/passwd").ok().and_then(|text| text.lines().find(|line| line.starts_with("root:")).map(str::to_owned)).unwrap_or_default();
    let fields: Vec<&str> = line.split(':').collect();
    let shell = fields.get(6).filter(|shell| std::path::Path::new(shell).exists()).map_or("/bin/sh", |shell| shell);
    Root { shell: shell.into(), home: fields.get(5).map_or("/root", |home| home).into() }
}

fn command(request: &Request, slave: &File) -> io::Result<Command> {
    let root = root();
    let mut command = match request.argv.split_first() {
        Some((program, args)) => {
            let mut command = Command::new(program);
            command.args(args);
            command
        }
        None => {
            let mut command = Command::new(&root.shell);
            command.arg("-l");
            command
        }
    };
    command
        .env("TERM", &request.term)
        .env("HOME", &root.home)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?));
    if std::fs::read_dir(&root.home).is_ok() {
        command.current_dir(&root.home);
    }
    unsafe {
        command.pre_exec(|| {
            signal(SIGHUP, SIG_DFL);
            os_error(setsid(), ())?;
            os_error(ioctl(0, TIOCSCTTY, 0), ())
        });
    }
    Ok(command)
}

pub fn run(body: &[u8], mut reader: UnixStream, writer: UnixStream) -> io::Result<()> {
    let request = Request::parse(body)?;
    let (master, slave) = open_pty()?;
    resize(&master, request.rows, request.cols)?;
    let mut child = command(&request, &slave)?.spawn()?;
    drop(slave);
    let pid = child.id();
    let out = Arc::new(Mutex::new(writer));
    frame::write(&mut *out.lock().unwrap(), frame::PID, &pid.to_le_bytes())?;
    let (drained, done) = mpsc::channel();
    let mut source = master.try_clone()?;
    let pump_out = out.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 64 * 1024];
        while let Ok(read) = source.read(&mut buffer) {
            if read == 0 || frame::write(&mut *pump_out.lock().unwrap(), frame::STDOUT, &buffer[..read]).is_err() {
                break;
            }
        }
        let _ = drained.send(());
    });
    let finished = Arc::new(AtomicBool::new(false));
    let waiter_finished = finished.clone();
    let waiter_out = out.clone();
    let waiter = thread::spawn(move || -> io::Result<()> {
        let status = child.wait()?;
        waiter_finished.store(true, Ordering::SeqCst);
        let _ = done.recv_timeout(DRAIN);
        unsafe { kill(-(pid as i32), SIGHUP) };
        let code = status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
        let mut out = waiter_out.lock().unwrap();
        let sent = frame::write(&mut *out, frame::EXIT, &code.to_le_bytes());
        let _ = out.shutdown(Shutdown::Both);
        sent
    });
    let mut input = master;
    while let Ok(Some(frame)) = frame::read(&mut reader) {
        let applied = match frame.kind {
            frame::DATA => input.write_all(&frame.body),
            frame::RESIZE => match frame::u32_at(&frame.body, 0) {
                Some(size) => resize(&input, size as u16, (size >> 16) as u16),
                None => Ok(()),
            },
            _ => Ok(()),
        };
        if applied.is_err() {
            break;
        }
    }
    if !finished.load(Ordering::SeqCst) {
        crate::serve::end_group(pid, SIGHUP, &finished);
    }
    waiter.join().unwrap_or(Ok(()))
}
