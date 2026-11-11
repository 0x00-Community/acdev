use std::io::{Read, Write};
use std::os::fd::{AsFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::FileType;
use rustix::io::{Errno, FdFlags, fcntl_getfd, fcntl_setfd};

use crate::var::Var;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ready {
    Readable,
    Stopped,
}

pub struct Fd;

impl Fd {
    const STDIO: i32 = 2;

    fn wait(fd: BorrowedFd<'_>, flags: PollFlags, timeout: Option<Duration>) -> Result<bool, Errno> {
        let timeout = timeout.map(|t| Timespec { tv_sec: t.as_secs().try_into().unwrap_or(i64::MAX), tv_nsec: t.subsec_nanos().into() });
        let mut fds = [PollFd::new(&fd, flags)];
        poll(&mut fds, timeout.as_ref()).map(|n| n > 0)
    }

    pub fn readable(fd: impl AsFd, timeout: Option<Duration>) -> Result<bool, Errno> {
        Self::wait(fd.as_fd(), PollFlags::IN, timeout)
    }

    pub fn writable(fd: impl AsFd, timeout: Option<Duration>) -> Result<bool, Errno> {
        Self::wait(fd.as_fd(), PollFlags::OUT, timeout)
    }

    pub fn until_stopped(fd: impl AsFd, stop: impl AsFd) -> Result<Ready, Errno> {
        loop {
            let mut fds = [PollFd::new(&fd, PollFlags::IN), PollFd::new(&stop, PollFlags::IN)];
            match poll(&mut fds, None) {
                Ok(_) if !fds[1].revents().is_empty() => return Ok(Ready::Stopped),
                Ok(_) => return Ok(Ready::Readable),
                Err(Errno::INTR) => {}
                Err(e) => return Err(e),
            }
        }
    }

    pub fn read_string(fd: OwnedFd) -> std::io::Result<String> {
        let mut text = String::new();
        std::fs::File::from(fd).read_to_string(&mut text).map(|_| text)
    }

    pub fn write_all(fd: OwnedFd, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::File::from(fd).write_all(bytes)
    }

    pub fn pipe() -> Result<(OwnedFd, OwnedFd), Errno> {
        rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)
    }

    pub fn inherited_socket(var: Var) -> Option<Result<UnixStream, String>> {
        let value = var.get()?;
        let name = var.name();
        let fail = |why: &str| format!("{name}={value}: {why}");
        Some((|| {
            let raw: i32 = value.parse().map_err(|_| fail("不是 fd"))?;
            if raw <= Self::STDIO {
                return Err(fail("不是 fd"));
            }
            let borrowed = unsafe { BorrowedFd::borrow_raw(raw) };
            let flags = fcntl_getfd(borrowed).map_err(|e| fail(&e.to_string()))?;
            if flags.contains(FdFlags::CLOEXEC) {
                return Err(fail("已经被拿走了"));
            }
            if !rustix::fs::fstat(borrowed).is_ok_and(|s| FileType::from_raw_mode(s.st_mode) == FileType::Socket) {
                return Err(fail("不是 socket"));
            }
            fcntl_setfd(borrowed, FdFlags::CLOEXEC).map_err(|e| fail(&e.to_string()))?;
            Ok(unsafe { UnixStream::from_raw_fd(raw) })
        })())
    }
}
