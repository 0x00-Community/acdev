#![cfg(target_os = "linux")]

mod abi;
mod ring;
mod waiter;

use std::cell::{Cell, RefCell};
use std::ffi::CString;
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::ptr::NonNull;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{Mode, OFlags, open};
use rustix::ioctl::{Ioctl, IoctlOutput, Opcode, Setter, ioctl, opcode};
use rustix::mm::{MapFlags, ProtFlags, mmap, munmap};

pub use abi::{Events, Kind};
use ring::Ring;
pub use waiter::Waiter;

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub name: String,
    pub mem_limit: u64,
    pub stack_size: u32,
    pub ring_size: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Message {
    pub kind: Kind,
    pub flags: u16,
    pub len: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Full;

pub struct Isolate {
    fd: OwnedFd,
    area: NonNull<abi::Area>,
    size: usize,
    to_window: Ring,
    to_engine: Ring,
    replies: Ring,
    /// Parts of a message from the engine that has not ended yet.
    partial: RefCell<Vec<u8>>,
    /// Events taken while waiting for room for a reply, for the next wait.
    stash: Cell<u32>,
}

unsafe impl Send for Isolate {}

impl Isolate {
    pub fn create(options: &Options) -> io::Result<Self> {
        let dev = open("/dev/jsrt", OFlags::RDWR | OFlags::CLOEXEC, Mode::empty())?;
        let name = CString::new(options.name.as_str()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let create = abi::Create {
            size: size_of::<abi::Create>() as u32,
            flags: 0,
            name: if options.name.is_empty() {
                0
            } else {
                name.as_ptr() as u64
            },
            mem_limit: options.mem_limit,
            stack_size: options.stack_size,
            ring_size: options.ring_size,
        };
        let raw = unsafe { ioctl(&dev, CreateIoctl(create)) }?;
        Self::map(unsafe { OwnedFd::from_raw_fd(raw) })
    }

    fn map(fd: OwnedFd) -> io::Result<Self> {
        let page = rustix::param::page_size();
        let first = unsafe { mmap(std::ptr::null_mut(), page, ProtFlags::READ, MapFlags::SHARED, &fd, 0)? };
        let size = unsafe { (*(first as *const abi::Area)).size } as usize;
        unsafe { munmap(first, page)? };
        let base = unsafe {
            mmap(
                std::ptr::null_mut(),
                size,
                ProtFlags::READ | ProtFlags::WRITE,
                MapFlags::SHARED,
                &fd,
                0,
            )?
        };
        let area = NonNull::new(base as *mut abi::Area).ok_or_else(|| io::Error::from(io::ErrorKind::Other))?;
        let header = unsafe { area.as_ref() };
        if header.magic != abi::AREA_MAGIC || (header.replies.size == 0) {
            unsafe { munmap(base, size)? };
            return Err(io::Error::new(io::ErrorKind::Unsupported, "jsrt: unknown area layout"));
        }
        let at = |r: &abi::RingHeader| Ring::new(r, unsafe { (base as *mut u8).add(r.offset as usize) }, r.size);
        let (to_window, to_engine, replies) = (at(&header.to_window), at(&header.to_engine), at(&header.replies));
        Ok(Self {
            fd,
            area,
            size,
            to_window,
            to_engine,
            replies,
            partial: RefCell::new(Vec::new()),
            stash: Cell::new(0),
        })
    }

    pub fn eval(&self, source: &str, name: &str, module: bool) -> io::Result<()> {
        let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let eval = abi::Eval {
            size: size_of::<abi::Eval>() as u32,
            flags: if module { abi::EVAL_MODULE } else { 0 },
            source: source.as_ptr() as u64,
            source_len: source.len() as u64,
            name: name.as_ptr() as u64,
        };
        unsafe {
            ioctl(
                &self.fd,
                Setter::<{ opcode::write::<abi::Eval>(abi::MAGIC, 0x61) }, _>::new(eval),
            )
        }?;
        Ok(())
    }

    /// The next whole message: one record, or its parts put together.
    pub fn recv(&self, buf: &mut Vec<u8>) -> Option<Message> {
        loop {
            let (kind, flags) = self.to_window.take(buf)?;
            let mut partial = self.partial.borrow_mut();
            if kind == abi::PART {
                partial.extend_from_slice(buf);
                continue;
            }
            if !partial.is_empty() {
                partial.extend_from_slice(buf);
                std::mem::swap(buf, &mut *partial);
                partial.clear();
                if partial.capacity() > 1 << 20 {
                    *partial = Vec::new();
                }
            }
            return Some(Message {
                kind: Kind::from(kind),
                flags,
                len: buf.len(),
            });
        }
    }

    pub fn pending(&self) -> bool {
        self.to_window.ready()
    }

    pub fn send(&self, kind: Kind, flags: u16, data: &[u8]) -> Result<(), Full> {
        self.to_engine.put(kind.into(), flags, &[data])
    }

    /// A message of any length to the engine, from `*sent` on (see
    /// [`Ring::put_from`]): call again with the same data after Full.
    pub fn send_from(&self, kind: Kind, flags: u16, data: &[u8], sent: &mut usize) -> Result<(), Full> {
        self.to_engine.put_from(kind.into(), flags, data, sent)
    }

    /// Answers the oldest call. The engine waits for it and takes a long
    /// one's parts as they come: this waits for room meanwhile.
    pub fn reply(&self, data: &[u8]) -> io::Result<()> {
        let mut sent = 0;
        while self.replies.put_from(Kind::Reply.into(), 0, data, &mut sent).is_err() {
            self.kick()?;
            let mut fds = [PollFd::new(&self.fd, PollFlags::IN)];
            poll(&mut fds, Some(&Timespec { tv_sec: 1, tv_nsec: 0 }))?;
            let mut word = [0u8; 4];
            match rustix::io::read(&self.fd, &mut word) {
                Ok(0) => return Err(io::Error::from(io::ErrorKind::BrokenPipe)),
                Ok(_) => {
                    let events = u32::from_ne_bytes(word);
                    self.stash.set(self.stash.get() | events);
                    if Events::from_bits(events).contains(Events::EXIT) {
                        return Err(io::Error::from(io::ErrorKind::BrokenPipe));
                    }
                }
                Err(rustix::io::Errno::AGAIN) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    pub fn kick(&self) -> io::Result<()> {
        rustix::io::write(&self.fd, &1u32.to_ne_bytes())?;
        Ok(())
    }

    pub fn wait(&self, timeout: Option<Duration>) -> io::Result<Option<Events>> {
        let timeout = timeout.map(|t| Timespec {
            tv_sec: t.as_secs() as _,
            tv_nsec: t.subsec_nanos() as _,
        });
        let stashed = self.stash.replace(0);
        let mut fds = [PollFd::new(&self.fd, PollFlags::IN)];
        let zero = Timespec { tv_sec: 0, tv_nsec: 0 };
        if poll(&mut fds, if stashed != 0 { Some(&zero) } else { timeout.as_ref() })? == 0 {
            return Ok(Some(Events::from_bits(stashed)));
        }
        let mut word = [0u8; 4];
        match rustix::io::read(&self.fd, &mut word) {
            Ok(0) => Ok(None),
            Ok(_) => Ok(Some(Events::from_bits(stashed | u32::from_ne_bytes(word)))),
            Err(rustix::io::Errno::AGAIN) => Ok(Some(Events::from_bits(stashed))),
            Err(e) => Err(e.into()),
        }
    }

    pub fn exit_code(&self) -> i32 {
        let area = unsafe { self.area.as_ref() };
        unsafe { (*(&raw const area.exit_code).cast::<std::sync::atomic::AtomicI32>()).load(Ordering::Acquire) }
    }

    pub fn raw_fd(&self) -> i32 {
        self.fd.as_raw_fd()
    }
}

impl AsFd for Isolate {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.fd.as_fd()
    }
}

impl Drop for Isolate {
    fn drop(&mut self) {
        unsafe {
            let _ = munmap(self.area.as_ptr().cast(), self.size);
        }
    }
}

struct CreateIoctl(abi::Create);

unsafe impl Ioctl for CreateIoctl {
    type Output = i32;
    const IS_MUTATING: bool = false;

    fn opcode(&self) -> Opcode {
        opcode::write::<abi::Create>(abi::MAGIC, 0x60)
    }

    fn as_ptr(&mut self) -> *mut std::ffi::c_void {
        (&raw mut self.0).cast()
    }

    unsafe fn output_from_ptr(out: IoctlOutput, _: *mut std::ffi::c_void) -> rustix::io::Result<i32> {
        Ok(out)
    }
}
