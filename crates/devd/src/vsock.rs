use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

const AF_VSOCK: i32 = 40;
const SOCK_STREAM: i32 = 1;
const SOCK_CLOEXEC: i32 = 0o2000000;
pub const CID_ANY: u32 = u32::MAX;

#[repr(C)]
struct SockaddrVm {
    family: u16,
    reserved: u16,
    port: u32,
    cid: u32,
    flags: u8,
    zero: [u8; 3],
}

unsafe extern "C" {
    fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
    fn bind(fd: i32, addr: *const SockaddrVm, len: u32) -> i32;
    fn listen(fd: i32, backlog: i32) -> i32;
    fn connect(fd: i32, addr: *const SockaddrVm, len: u32) -> i32;
    fn accept4(fd: i32, addr: *mut SockaddrVm, len: *mut u32, flags: i32) -> i32;
    fn close(fd: i32) -> i32;
}

fn address(cid: u32, port: u32) -> SockaddrVm {
    SockaddrVm { family: AF_VSOCK as u16, reserved: 0, port, cid, flags: 0, zero: [0; 3] }
}

fn open() -> io::Result<i32> {
    let fd = unsafe { socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0) };
    if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(fd) }
}

fn checked(fd: i32, result: i32) -> io::Result<()> {
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    unsafe { close(fd) };
    Err(error)
}

pub struct Listener(OwnedFd);

impl Listener {
    pub fn bind(port: u32) -> io::Result<Self> {
        let fd = open()?;
        let addr = address(CID_ANY, port);
        checked(fd, unsafe { bind(fd, &addr, size_of::<SockaddrVm>() as u32) })?;
        checked(fd, unsafe { listen(fd, 16) })?;
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    pub fn accept(&self) -> io::Result<UnixStream> {
        loop {
            let fd = unsafe { accept4(self.0.as_raw_fd(), std::ptr::null_mut(), std::ptr::null_mut(), SOCK_CLOEXEC) };
            if fd >= 0 {
                return Ok(unsafe { UnixStream::from_raw_fd(fd) });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

pub fn connect_to(cid: u32, port: u32) -> io::Result<UnixStream> {
    let fd = open()?;
    let addr = address(cid, port);
    checked(fd, unsafe { connect(fd, &addr, size_of::<SockaddrVm>() as u32) })?;
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}
