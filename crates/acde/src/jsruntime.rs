//! acde on AgentOS (Dopame): the JavaScript runtime is the system's one, started and supervised by the kernel
//! (ackernel's `/dev/jsruntime`, `Documentation/userspace-api/ac/index.rst`). A session does not start its own
//! `acde runtime` child: it opens an isolate (`AC_JS_OPEN`) and hands the runtime its acde_shell connection, its
//! arguments and its environment over the isolate's channel; the runtime (`acde jsruntime`, what the administrator
//! configures with `AC_JS_CONFIGURE`) registers (`AC_JS_REGISTER`), accepts the isolate and runs the session's Broker in
//! it, bound to the thread that runs it (`AC_JS_MIGRATE`). The kernel keeps the isolate's CPU, memory and liveness.
//!
//! The channel (`SOCK_SEQPACKET`, acde's own protocol): the session sends one [`Hello`] (JSON) with the acde_shell
//! socket as `SCM_RIGHTS`; the runtime answers [`Bye`] with the exit code when the session's Broker ends; the session
//! may send [`Stop`] to end it (SIGINT / SIGTERM / SIGHUP).

use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::Path;

use rustix::event::{PollFd, PollFlags, poll};
use rustix::io::Errno;
use rustix::ioctl::{NoArg, Setter, Updater, ioctl};
use rustix::net::{RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, SendAncillaryBuffer, SendAncillaryMessage, SendFlags};
use serde::{Deserialize, Serialize};

const DEVICE: &str = "/dev/jsruntime";
const MAGIC: u8 = 0xAC;

/// Is this the AgentOS distribution (Dopame)? Its os-release says `NAME="Dopame"` (`LOGO=dopame`) over its base.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Distro {
    AgentOs,
    Other,
}

impl Distro {
    pub fn detect() -> Self {
        let text = std::fs::read_to_string("/etc/os-release").or_else(|_| std::fs::read_to_string("/usr/lib/os-release")).unwrap_or_default();
        let value = |key: &str| text.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix('=')).map(|v| v.trim().trim_matches('"').to_ascii_lowercase());
        if value("NAME").as_deref() == Some("dopame") || value("LOGO").as_deref() == Some("dopame") || value("ID").as_deref() == Some("agentos") {
            Distro::AgentOs
        } else {
            Distro::Other
        }
    }
}

/// Where a session's runtime part runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Runtime {
    /// AgentOS with ackernel: the kernel's shared runtime.
    Shared,
    /// Anywhere else: an `acde runtime` child of this process (and, inside another desktop, a window of it).
    Own,
}

impl Runtime {
    /// Decided before any JavaScript loads: AgentOS with `/dev/jsruntime` delegates; AgentOS without it says so.
    pub fn choose() -> Self {
        match (Distro::detect(), Path::new(DEVICE).exists()) {
            (Distro::AgentOs, true) => Runtime::Shared,
            (Distro::AgentOs, false) => {
                log::warn!("AgentOS without {DEVICE} (not ackernel, or CONFIG_AC_JSRUNTIME off): acde starts its own runtime");
                Runtime::Own
            }
            (Distro::Other, _) => Runtime::Own,
        }
    }
}

mod uapi {
    //! `<linux/ac/jsruntime.h>`.

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Limits {
        pub mem_soft: u64,
        pub mem_hard: u64,
        pub cpu_weight: u32,
        pub cpu_quota_us: u32,
        pub cpu_period_us: u32,
        pub watchdog_ms: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct Open {
        pub name: u64,
        pub name_len: u32,
        pub flags: u32,
        pub limits: Limits,
        pub fd: i32,
        pub channel: i32,
        pub id: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct Accept {
        pub id: u64,
        pub status: i32,
        pub fd: i32,
        pub channel: i32,
        pub pid: i32,
        pub uid: u32,
        pub name_len: u32,
        pub name: u64,
        pub limits: Limits,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Record {
        pub seq: u64,
        pub time_ns: u64,
        pub isolate: u64,
        pub event: u32,
        pub pad: u32,
        pub value: u64,
    }

    pub const OPEN: rustix::ioctl::Opcode = rustix::ioctl::opcode::read_write::<Open>(super::MAGIC, 0x69);
    pub const ACCEPT: rustix::ioctl::Opcode = rustix::ioctl::opcode::read_write::<Accept>(super::MAGIC, 0x6a);
    pub const REGISTER: rustix::ioctl::Opcode = rustix::ioctl::opcode::none(super::MAGIC, 0x68);
    pub const MIGRATE: rustix::ioctl::Opcode = rustix::ioctl::opcode::write::<i32>(super::MAGIC, 0x64);

    const _: () = assert!(size_of::<Open>() == 64 && size_of::<Accept>() == 72 && size_of::<Record>() == 40 && size_of::<Limits>() == 32);
}

/// `enum ac_js_event`, as read from a record.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Event {
    Open,
    Close,
    Kill,
    Dead,
    Other(u32),
}

impl From<u32> for Event {
    fn from(code: u32) -> Self {
        match code {
            8 => Event::Open,
            9 => Event::Close,
            10 => Event::Kill,
            11 => Event::Dead,
            other => Event::Other(other),
        }
    }
}

/// The session's opening message.
#[derive(Serialize, Deserialize)]
struct Hello {
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
}

/// The runtime's last message: the Broker's exit code.
#[derive(Serialize, Deserialize)]
struct Bye {
    exit: i32,
}

/// The session asks the runtime to end it.
#[derive(Serialize, Deserialize)]
struct Stop {
    stop: bool,
}

fn device() -> io::Result<OwnedFd> {
    Ok(std::fs::OpenOptions::new().read(true).write(true).open(DEVICE)?.into())
}

fn read_record(fd: BorrowedFd<'_>) -> io::Result<uapi::Record> {
    let mut record = uapi::Record::default();
    // SAFETY: Record is plain old data; read() fills at most its size.
    let bytes = unsafe { std::slice::from_raw_parts_mut((&raw mut record).cast::<MaybeUninit<u8>>(), size_of::<uapi::Record>()) };
    loop {
        match rustix::io::read(fd, &mut *bytes) {
            Ok((filled, _)) if filled.len() == size_of::<uapi::Record>() => return Ok(record),
            Ok(_) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short record")),
            Err(Errno::INTR) => {}
            Err(e) => return Err(e.into()),
        }
    }
}

fn send(channel: BorrowedFd<'_>, message: &impl Serialize, fd: Option<BorrowedFd<'_>>) -> io::Result<()> {
    let bytes = serde_json::to_vec(message).map_err(io::Error::other)?;
    let fds = fd.into_iter().collect::<Vec<_>>();
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    if !fds.is_empty() {
        control.push(SendAncillaryMessage::ScmRights(&fds));
    }
    rustix::net::sendmsg(channel, &[io::IoSlice::new(&bytes)], &mut control, SendFlags::NOSIGNAL)?;
    Ok(())
}

fn receive(channel: BorrowedFd<'_>) -> io::Result<(Vec<u8>, Option<OwnedFd>)> {
    let mut buffer = vec![0u8; 256 * 1024];
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = RecvAncillaryBuffer::new(&mut space);
    let got = rustix::net::recvmsg(channel, &mut [io::IoSliceMut::new(&mut buffer)], &mut control, RecvFlags::CMSG_CLOEXEC)?;
    let mut fd = None;
    for message in control.drain() {
        if let RecvAncillaryMessage::ScmRights(fds) = message {
            fd = fds.into_iter().next();
        }
    }
    buffer.truncate(got.bytes);
    Ok((buffer, fd))
}

/// The session's side: an isolate of the shared runtime, its handle and its channel.
pub struct Session {
    handle: OwnedFd,
    channel: OwnedFd,
}

/// How the session's runtime part ended.
pub enum Ended {
    /// The Broker ended with this code.
    Exited(i32),
    /// The runtime died (errno): the kernel restarts it.
    Died(i32),
}

impl Session {
    /// `AC_JS_OPEN`: blocks until the runtime accepts it (or refuses).
    pub fn open(name: &str) -> io::Result<Self> {
        let device = device()?;
        let mut open = uapi::Open { name: name.as_ptr() as u64, name_len: name.len() as u32, ..Default::default() };
        // SAFETY: `open` matches struct ac_js_open; `name` outlives the call.
        unsafe { ioctl(&device, Updater::<{ uapi::OPEN }, uapi::Open>::new(&mut open)) }?;
        // SAFETY: the kernel installed both fds for us (O_CLOEXEC); nothing else owns them.
        Ok(Self { handle: unsafe { OwnedFd::from_raw_fd(open.fd) }, channel: unsafe { OwnedFd::from_raw_fd(open.channel) } })
    }

    /// Hands the runtime this session: its arguments, environment and the acde_shell connection.
    pub fn hand_over(&self, args: &[String], shell: &UnixStream) -> io::Result<()> {
        let env = std::env::vars().collect();
        let cwd = std::env::current_dir().ok().map(|d| d.to_string_lossy().into_owned());
        send(self.channel.as_fd(), &Hello { args: args.to_vec(), env, cwd }, Some(shell.as_fd()))
    }

    /// Asks the runtime to end the session (it answers with its exit code when the Broker is done).
    pub fn stop(&self) {
        _ = send(self.channel.as_fd(), &Stop { stop: true }, None);
    }

    /// Waits for the end: the runtime's `Bye`, or the isolate dead without one. `stop` is a fd that becomes
    /// readable when the session is asked to stop (a signal).
    pub fn wait(&self, stop: BorrowedFd<'_>) -> Ended {
        let mut code = None;
        let mut stopping = false;
        loop {
            let mut fds = [PollFd::new(&self.handle, PollFlags::IN), PollFd::new(&self.channel, PollFlags::IN), PollFd::new(&stop, PollFlags::IN)];
            match poll(&mut fds, None) {
                Ok(_) => {}
                Err(Errno::INTR) => continue,
                Err(e) => return Ended::Died(e.raw_os_error()),
            }
            if !stopping && !fds[2].revents().is_empty() {
                stopping = true;
                self.stop();
            }
            if !fds[1].revents().is_empty()
                && let Ok((bytes, _)) = receive(self.channel.as_fd())
                && let Ok(bye) = serde_json::from_slice::<Bye>(&bytes)
            {
                code = Some(bye.exit);
            }
            if fds[0].revents().intersects(PollFlags::IN | PollFlags::HUP) {
                match read_record(self.handle.as_fd()) {
                    Ok(record) if Event::from(record.event) == Event::Dead => {
                        return match (code, record.value as i32) {
                            (Some(code), _) => Ended::Exited(code),
                            (None, 0) => Ended::Exited(0),
                            (None, errno) => Ended::Died(errno),
                        };
                    }
                    Ok(_) => {}
                    Err(_) if fds[0].revents().contains(PollFlags::HUP) => return code.map_or(Ended::Died(libc_econnreset()), Ended::Exited),
                    Err(_) => {}
                }
            }
        }
    }
}

const fn libc_econnreset() -> i32 {
    104
}

/// `acde jsruntime`: the system's runtime. Registers, then serves one session at a time (a session's environment is
/// the process's while it runs); exits when that session ends, and the kernel starts it again for the next.
pub fn serve() -> i32 {
    let session = match device() {
        Ok(fd) => fd,
        Err(e) => {
            log::error!("{DEVICE}: {e}");
            return 1;
        }
    };
    // SAFETY: AC_JS_REGISTER takes no argument.
    if let Err(e) = unsafe { ioctl(&session, NoArg::<{ uapi::REGISTER }>::new()) } {
        log::error!("AC_JS_REGISTER: {e} (only the runtime the kernel started, or CAP_SYS_ADMIN)");
        return 1;
    }
    log::info!("jsruntime: registered");
    let mut serving: Option<u64> = None;
    loop {
        let record = match read_record(session.as_fd()) {
            Ok(record) => record,
            Err(e) => {
                log::error!("jsruntime: {e}");
                return 1;
            }
        };
        match Event::from(record.event) {
            Event::Open if serving.is_some() => {
                let mut refuse = uapi::Accept { id: record.isolate, status: -(Errno::BUSY.raw_os_error()), ..Default::default() };
                // SAFETY: matches struct ac_js_accept.
                _ = unsafe { ioctl(&session, Updater::<{ uapi::ACCEPT }, uapi::Accept>::new(&mut refuse)) };
            }
            Event::Open => match accept(session.as_fd(), record.isolate) {
                Ok(()) => serving = Some(record.isolate),
                Err(e) => log::warn!("jsruntime: isolate {}: {e}", record.isolate),
            },
            Event::Close | Event::Kill if serving == Some(record.isolate) => {
                log::info!("jsruntime: session {} ends ({:?})", record.isolate, Event::from(record.event));
                end_session();
            }
            _ => {}
        }
    }
}

/// Ends the running session: the Broker's own SIGTERM path (its `onSignal`), in this process.
fn end_session() {
    _ = rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::TERM);
}

fn accept(session: BorrowedFd<'_>, id: u64) -> io::Result<()> {
    let mut name = [0u8; 256];
    let mut accept = uapi::Accept { id, name: name.as_mut_ptr() as u64, name_len: name.len() as u32, ..Default::default() };
    // SAFETY: matches struct ac_js_accept; `name` is a writable buffer of `name_len` bytes.
    unsafe { ioctl(session, Updater::<{ uapi::ACCEPT }, uapi::Accept>::new(&mut accept)) }?;
    // SAFETY: the kernel installed both fds for us.
    let (isolate, channel) = unsafe { (OwnedFd::from_raw_fd(accept.fd), OwnedFd::from_raw_fd(accept.channel)) };
    let label = String::from_utf8_lossy(&name[..(accept.name_len as usize).min(name.len())]).into_owned();
    log::info!("jsruntime: session {id} ({label}) from pid {} uid {}", accept.pid, accept.uid);
    let mut ready = [PollFd::new(&channel, PollFlags::IN)];
    poll(&mut ready, Some(&rustix::event::Timespec { tv_sec: 10, tv_nsec: 0 }))?;
    let (bytes, shell) = receive(channel.as_fd())?;
    let hello: Hello = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let shell = shell.ok_or_else(|| io::Error::other("no acde_shell connection in the hello"))?;
    let shell_fd: RawFd = shell.as_raw_fd();
    // SAFETY: the session's environment becomes the process's before the Broker's thread starts; one session per process.
    unsafe {
        for (key, _) in std::env::vars_os() {
            std::env::remove_var(key);
        }
        for (key, value) in &hello.env {
            std::env::set_var(key, value);
        }
        std::env::set_var(crate::supervise::Supervisor::SHELL_FD, shell_fd.to_string());
    }
    if let Some(cwd) = &hello.cwd {
        _ = std::env::set_current_dir(cwd);
    }
    // The Broker takes the fd by number (Session::open in crates/shell checks it is not CLOEXEC yet, then sets it).
    rustix::io::fcntl_setfd(&shell, rustix::io::FdFlags::empty())?;
    std::mem::forget(shell);
    std::thread::Builder::new()
        .name("acde-broker".into())
        .stack_size(8 << 20)
        .spawn(move || {
            let tid = rustix::thread::gettid().as_raw_nonzero().get();
            // SAFETY: AC_JS_MIGRATE takes the tid of the thread that runs the isolate.
            if let Err(e) = unsafe { ioctl(&isolate, Setter::<{ uapi::MIGRATE }, i32>::new(tid)) } {
                log::warn!("AC_JS_MIGRATE: {e}");
            }
            let code = crate::sys::start(crate::sys::Entry::Broker, &hello.args);
            _ = send(channel.as_fd(), &Bye { exit: code }, None);
            drop(isolate);
            log::info!("jsruntime: session ended ({code}); exiting for the kernel to start the next");
            acde_log::flush();
            std::process::exit(0);
        })?;
    Ok(())
}
