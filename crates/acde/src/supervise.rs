use std::collections::VecDeque;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};

use acde_shell::compositor::{Compositor, Handle};
use rustix::event::{PollFd, PollFlags, poll};
use rustix::io::{Errno, FdFlags, fcntl_setfd};
use rustix::process::{Pid, PidfdFlags, Signal, kill_process, pidfd_open, set_parent_process_death_signal};
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

pub struct Supervisor<'a> {
    args: &'a [String],
    compositor: Option<Handle>,
    crashes: VecDeque<Instant>,
    child: Arc<AtomicI32>,
    stopping: Arc<AtomicBool>,
}

enum Ended {
    Exited(i32),
    Crashed(i32),
}

impl<'a> Supervisor<'a> {
    pub const SHELL_FD: &'static str = "ACDE_SHELL_FD";
    const CRASH_WINDOW: Duration = Duration::from_secs(60);
    const CRASH_LIMIT: usize = 3;

    pub fn new(args: &'a [String]) -> Self {
        Self { args, compositor: None, crashes: VecDeque::new(), child: Arc::default(), stopping: Arc::default() }
    }

    pub fn run(self) -> i32 {
        match crate::jsruntime::Runtime::choose() {
            crate::jsruntime::Runtime::Shared => self.run_shared(),
            crate::jsruntime::Runtime::Own => self.run_own(),
        }
    }

    /// AgentOS: the session's runtime part is an isolate of the kernel's shared runtime (`/dev/jsruntime`); this
    /// process keeps only the compositor. The runtime dying (the kernel restarts it) opens the session again, as a
    /// crashed child would be restarted.
    fn run_shared(mut self) -> i32 {
        let (stop_read, stop_write) = match rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC) {
            Ok(pipe) => pipe,
            Err(e) => return self.fail(format!("stop pipe: {e}")),
        };
        self.on_signals(move || _ = rustix::io::write(&stop_write, b"s"));
        let name = format!("acde-session-{}", rustix::process::getuid().as_raw());
        let code = loop {
            let (ours, theirs) = match UnixStream::pair() {
                Ok(pair) => pair,
                Err(e) => break self.fail(format!("acde_shell 连接: {e}")),
            };
            match &self.compositor {
                Some(handle) => handle.connect(ours),
                None => match Compositor::spawn(ours) {
                    Ok(handle) => self.compositor = Some(handle),
                    Err(e) => break self.fail(format!("合成器: {e}")),
                },
            }
            let session = match crate::jsruntime::Session::open(&name) {
                Ok(session) => session,
                Err(e) => break self.fail(format!("/dev/jsruntime: AC_JS_OPEN: {e}")),
            };
            if let Err(e) = session.hand_over(self.args, &theirs) {
                break self.fail(format!("/dev/jsruntime: 交给 runtime: {e}"));
            }
            drop(theirs);
            log::info!("会话交给了系统的 jsruntime ({name})");
            match session.wait(stop_read.as_fd()) {
                crate::jsruntime::Ended::Exited(code) => break code,
                crate::jsruntime::Ended::Died(errno) if self.restart() => log::warn!("系统的 jsruntime 断了 (errno {errno}), 重新打开"),
                crate::jsruntime::Ended::Died(errno) => break self.fail(format!("系统的 jsruntime 断了 (errno {errno})")),
            }
        };
        if let Some(mut handle) = self.compositor.take() {
            handle.quit();
        }
        code
    }

    fn run_own(mut self) -> i32 {
        self.forward_signals();
        let code = loop {
            let (ours, theirs) = match UnixStream::pair() {
                Ok(pair) => pair,
                Err(e) => break self.fail(format!("acde_shell 连接: {e}")),
            };
            let pending = match &self.compositor {
                Some(handle) => {
                    handle.connect(ours);
                    None
                }
                None => Some(ours),
            };
            let child = match self.spawn(theirs) {
                Ok(child) => child,
                Err(e) => break self.fail(format!("acde runtime: {e}")),
            };
            match self.watch(child, pending) {
                Ended::Crashed(code) if self.restart() => log::warn!("acde runtime 崩了 ({code}), 重启"),
                Ended::Crashed(code) | Ended::Exited(code) => break code,
            }
        };
        if let Some(mut handle) = self.compositor.take() {
            handle.quit();
        }
        code
    }

    fn fail(&self, message: String) -> i32 {
        log::error!("{message}");
        1
    }

    fn forward_signals(&self) {
        let child = self.child.clone();
        self.on_signal_numbers(move |signal| {
            let (Some(pid), Some(signal)) = (Pid::from_raw(child.load(Ordering::Acquire)), Signal::from_named_raw(signal)) else { return };
            _ = kill_process(pid, signal);
        });
    }

    fn on_signals(&self, f: impl Fn() + Send + 'static) {
        self.on_signal_numbers(move |_| f());
    }

    /// SIGINT / SIGTERM / SIGHUP: the session is stopping; `f` passes it on to the runtime.
    fn on_signal_numbers(&self, f: impl Fn(i32) + Send + 'static) {
        let Ok(mut signals) = Signals::new([SIGINT, SIGTERM, SIGHUP]) else {
            return log::warn!("收不到 SIGINT / SIGTERM / SIGHUP, 不转给 acde runtime");
        };
        let stopping = self.stopping.clone();
        let started = std::thread::Builder::new().name("acde-signals".into()).spawn(move || {
            for signal in signals.forever() {
                stopping.store(true, Ordering::Release);
                f(signal);
            }
        });
        if let Err(e) = started {
            log::warn!("信号线程: {e}");
        }
    }

    fn spawn(&self, theirs: UnixStream) -> std::io::Result<Child> {
        let exe = std::env::current_exe()?;
        let fd = theirs.as_raw_fd();
        let mut command = Command::new(exe);
        command.arg("runtime").args(self.args).env(Self::SHELL_FD, fd.to_string()).process_group(0);
        unsafe {
            command.pre_exec(move || {
                fcntl_setfd(std::os::fd::BorrowedFd::borrow_raw(fd), FdFlags::empty())?;
                set_parent_process_death_signal(Some(Signal::TERM))?;
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(theirs);
        self.child.store(child.id() as i32, Ordering::Release);
        Ok(child)
    }

    fn watch(&mut self, mut child: Child, mut pending: Option<UnixStream>) -> Ended {
        let pidfd = pidfd_open(Pid::from_child(&child), PidfdFlags::empty()).inspect_err(|e| log::warn!("pidfd: {e}, 合成器直接起")).ok();
        if let Some(stream) = pending.take_if(|ours| pidfd.as_ref().is_none_or(|pidfd| !Self::exited_first(pidfd, ours.as_fd()))) {
            match Compositor::spawn(stream) {
                Ok(handle) => self.compositor = Some(handle),
                Err(e) => log::error!("合成器: {e}"),
            }
        }
        drop(pending);
        let status = child.wait();
        self.child.store(0, Ordering::Release);
        match status {
            Ok(status) => self.ended(status),
            Err(e) => Ended::Exited(self.fail(format!("acde runtime: {e}"))),
        }
    }

    fn exited_first(pidfd: &OwnedFd, ours: std::os::fd::BorrowedFd<'_>) -> bool {
        loop {
            let mut fds = [PollFd::new(pidfd, PollFlags::IN), PollFd::new(&ours, PollFlags::IN)];
            match poll(&mut fds, None) {
                Ok(_) => return !fds[0].revents().is_empty() || fds[1].revents().intersects(PollFlags::HUP | PollFlags::ERR),
                Err(Errno::INTR) => {}
                Err(_) => return true,
            }
        }
    }

    fn ended(&self, status: ExitStatus) -> Ended {
        match (status.code(), status.signal()) {
            (Some(code), _) => Ended::Exited(code),
            (None, Some(signal)) if self.stopping.load(Ordering::Acquire) => Ended::Exited(128 + signal),
            (None, signal) => Ended::Crashed(128 + signal.unwrap_or(0)),
        }
    }

    fn restart(&mut self) -> bool {
        let now = Instant::now();
        self.crashes.retain(|t| now.duration_since(*t) < Self::CRASH_WINDOW);
        self.crashes.push_back(now);
        self.compositor.is_some() && self.crashes.len() <= Self::CRASH_LIMIT
    }
}
