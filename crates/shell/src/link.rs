use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, poll};

use acde_model::{Easing, Mode, Scope};
use smithay::backend::input::AxisSource;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::protocol::wl_seat::{self, WlSeat};
use wayland_protocols::ext::idle_notify::v1::client::ext_idle_notification_v1::{self, ExtIdleNotificationV1};
use wayland_protocols::ext::idle_notify::v1::client::ext_idle_notifier_v1::{self, ExtIdleNotifierV1};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};

use crate::compositor::{Animate, CanvasInfo, Compositor, Grant, Handle, Injected, Stats, WindowInfo};

mod protocol {
    #![allow(dead_code, non_upper_case_globals, non_camel_case_types, unused_imports, clippy::all)]

    use wayland_client;
    use wayland_client::protocol::*;

    mod interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../model/protocol/acde-shell.xml");
    }

    use self::interfaces::*;

    wayland_scanner::generate_client_code!("../model/protocol/acde-shell.xml");
}

use protocol::acde_shell::{self, AcdeShell, Animated, Easing as WireEasing, Mode as WireMode, Scope as WireScope, WheelSource};
use protocol::acde_shell_list::{self, AcdeShellList};
use protocol::acde_shell_result::{self, AcdeShellResult};
use protocol::acde_shell_stats::{self, AcdeShellStats};

pub(crate) const REPLY_WAIT: Duration = Duration::from_millis(500);

pub struct Link {
    conn: Connection,
    shell: AcdeShell,
    qh: QueueHandle<Reader>,
    stop: Mutex<Option<OwnedFd>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    idle: Mutex<Idle>,
    idle_round: Arc<AtomicU32>,
}

struct Idle {
    notifier: Option<ExtIdleNotifierV1>,
    seat: Option<WlSeat>,
    watches: Vec<ExtIdleNotificationV1>,
}

struct IdleWatch {
    round: Arc<AtomicU32>,
    mine: u32,
    index: u32,
}

/// Where the reader thread hands the compositor's events.
pub type Sink = Box<dyn Fn(Notice) + Send>;

struct Reader {
    sink: Sink,
}

/// What the compositor tells the runtime, typed as it comes off the wire.
#[derive(Clone, Debug)]
pub enum Notice {
    Output { width: u32, height: u32, scale: f64, name: String, description: String, refresh: u32 },
    Open { window: u32, title: Option<String>, app_id: Option<String> },
    Close { window: u32 },
    Title { window: u32, title: Option<String>, app_id: Option<String> },
    Fullscreen { window: u32, on: bool },
    Minimize { window: u32 },
    Activate { window: u32 },
    Animated { window: u32 },
    /// A registered shortcut was pressed; `scope` is where it was registered, `owner` the app window for app scope.
    Shortcut { owner: u32, key: String, scope: Option<Scope> },
    /// A window left the table; its last rect (canvas coordinates).
    Gone { window: u32, rect: [i32; 4] },
    MinSize { window: u32, width: u32, height: u32 },
    Parent { window: u32, parent: Option<u32> },
    Milestone { title: String, time_ms: f64 },
    InputTarget { window: Option<u32>, x: f64, y: f64, button: u32 },
    /// The seat has had no input for the `index`th timeout of [`Link::set_idle`] (`idle`), or has again.
    Idle { index: u32, idle: bool },
    /// The connection ended (the compositor quit or died).
    Exit,
}

/// The runtime's end of the session: the acde_shell link, and the compositor itself when it runs in this process.
pub struct Session {
    pub link: Link,
    pub compositor: Option<Handle>,
}

impl Session {
    const SHELL_FD: &str = "ACDE_SHELL_FD";

    /// Takes the acde_shell connection the main process handed down (`ACDE_SHELL_FD`), or starts the compositor here.
    pub fn open(sink: Sink) -> Result<Self, String> {
        let (compositor, stream) = match std::env::var(Self::SHELL_FD) {
            Ok(fd) => (None, Self::inherited(&fd)?),
            Err(_) => {
                let (client, server) = UnixStream::pair().map_err(|e| e.to_string())?;
                (Some(Compositor::spawn(server)?), client)
            }
        };
        Ok(Self { link: Link::connect(stream, sink)?, compositor })
    }

    /// The Wayland socket clients connect to.
    pub fn socket_name(&self) -> String {
        match &self.compositor {
            Some(handle) => handle.socket_name().to_string_lossy().into_owned(),
            None => std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        }
    }

    pub fn quit(&mut self) {
        self.link.quit();
        if let Some(handle) = self.compositor.as_mut() {
            handle.quit();
        }
    }

    fn inherited(fd: &str) -> Result<UnixStream, String> {
        use rustix::io::{FdFlags, fcntl_getfd, fcntl_setfd};
        use std::os::fd::{BorrowedFd, FromRawFd};
        let raw: i32 = fd.parse().map_err(|_| format!("{}={fd}: 不是 fd", Self::SHELL_FD))?;
        // SAFETY: an fd number above stdio that the parent left open for us; checked to be a socket before it is owned.
        let borrowed = (raw > 2).then(|| unsafe { BorrowedFd::borrow_raw(raw) }).ok_or_else(|| format!("{}={fd}: 不是 fd", Self::SHELL_FD))?;
        let flags = fcntl_getfd(borrowed).map_err(|e| format!("{}={fd}: {e}", Self::SHELL_FD))?;
        if flags.contains(FdFlags::CLOEXEC) {
            return Err(format!("{}={fd}: 已经被拿走了", Self::SHELL_FD));
        }
        if !rustix::fs::fstat(borrowed).is_ok_and(|s| rustix::fs::FileType::from_raw_mode(s.st_mode) == rustix::fs::FileType::Socket) {
            return Err(format!("{}={fd}: 不是 socket", Self::SHELL_FD));
        }
        fcntl_setfd(borrowed, FdFlags::CLOEXEC).map_err(|e| format!("{}={fd}: {e}", Self::SHELL_FD))?;
        // SAFETY: checked above; nothing else owns it (CLOEXEC marks it taken).
        Ok(unsafe { OwnedFd::from_raw_fd(raw) }.into())
    }
}

impl Reader {
    fn run(&mut self, queue: &mut EventQueue<Self>, stop: &OwnedFd) -> Result<(), String> {
        loop {
            queue.dispatch_pending(self).map_err(|e| e.to_string())?;
            queue.flush().map_err(|e| e.to_string())?;
            let Some(guard) = queue.prepare_read() else { continue };
            let fd = guard.connection_fd();
            let mut fds = [PollFd::new(&fd, PollFlags::IN), PollFd::new(stop, PollFlags::IN)];
            match poll(&mut fds, None) {
                Ok(_) if !fds[1].revents().is_empty() => return Ok(()),
                Ok(_) => _ = guard.read().map_err(|e| e.to_string())?,
                Err(rustix::io::Errno::INTR) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

type Rows = (Vec<WindowInfo>, Vec<CanvasInfo>);

struct ListReply {
    rows: Mutex<Rows>,
    tx: Sender<Rows>,
}

type Answer = Result<(u32, u32), String>;

impl Link {
    fn connect(stream: UnixStream, sink: Sink) -> Result<Self, String> {
        let conn = Connection::from_socket(stream).map_err(|e| format!("acde_shell: {e}"))?;
        let (globals, mut queue) = registry_queue_init::<Reader>(&conn).map_err(|e| format!("acde_shell registry: {e}"))?;
        let qh = queue.handle();
        let shell: AcdeShell = globals.bind(&qh, 1..=1, ()).map_err(|e| format!("acde_shell: {e}"))?;
        let idle = Idle { notifier: globals.bind(&qh, 1..=1, ()).ok(), seat: globals.bind(&qh, 1..=1, ()).ok(), watches: Vec::new() };
        conn.flush().map_err(|e| format!("acde_shell: {e}"))?;
        let (stopped, stop) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).map_err(|e| format!("acde_shell: {e}"))?;
        let mut reader = Reader { sink };
        let thread = std::thread::Builder::new()
            .name("acde-shell-link".into())
            .spawn(move || {
                if let Err(e) = reader.run(&mut queue, &stopped) {
                    log::warn!("acde_shell 连接断了: {e}");
                }
                (reader.sink)(Notice::Exit);
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { conn, shell, qh, stop: Mutex::new(Some(stop)), reader: Mutex::new(Some(thread)), idle: Mutex::new(idle), idle_round: Arc::default() })
    }

    fn sent(&self) {
        if let Err(e) = self.conn.flush() {
            log::warn!("acde_shell: {e}");
        }
    }

    fn answer(&self, make: impl FnOnce(&AcdeShell, Sender<Answer>)) -> Receiver<Answer> {
        let (tx, rx) = mpsc::channel();
        make(&self.shell, tx);
        self.sent();
        rx
    }

    pub fn grant(&self, token: u64, g: Grant) {
        let [x, y, w, h] = g.rect.unwrap_or_default();
        let [sw, sh] = g.size.unwrap_or_default();
        self.shell.grant((token >> 32) as u32, token as u32, g.id, g.desktop.into(), g.mode.into(), x, y, w, h, sw, sh);
        self.sent();
    }

    pub fn release(&self, window: u32) {
        self.shell.release(window);
        self.sent();
    }

    pub fn focus(&self, window: u32) {
        self.shell.focus(window);
        self.sent();
    }

    pub fn hide(&self, window: u32, hidden: bool) {
        self.shell.hide(window, hidden.into());
        self.sent();
    }

    pub fn close(&self, window: u32) {
        self.shell.close(window);
        self.sent();
    }

    pub fn place(&self, window: u32, [x, y, w, h]: [i32; 4]) {
        self.shell.place(window, x, y, w, h);
        self.sent();
    }

    pub fn raise(&self, window: u32, above: Option<u32>) {
        self.shell.raise(window, above.and_then(|a| i32::try_from(a).ok()).unwrap_or(-1));
        self.sent();
    }

    pub fn set_mode(&self, window: u32, mode: Mode) {
        self.shell.set_mode(window, mode.into());
        self.sent();
    }

    pub fn list(&self) -> Rows {
        let (tx, rx) = mpsc::channel();
        self.shell.list(&self.qh, ListReply { rows: Mutex::default(), tx });
        self.sent();
        rx.recv_timeout(REPLY_WAIT).unwrap_or_default()
    }

    pub fn stats(&self, reset: bool) -> Stats {
        let (tx, rx) = mpsc::channel();
        self.shell.stats(reset.into(), &self.qh, tx);
        self.sent();
        rx.recv_timeout(REPLY_WAIT).unwrap_or_default()
    }

    pub fn screenshot(&self, path: String) -> Receiver<Answer> {
        self.answer(|s, tx| _ = s.screenshot(path, &self.qh, tx))
    }

    pub fn inject(&self, event: Injected) {
        match event {
            Injected::Move(p) => self.shell.inject_move(p.x, p.y),
            Injected::Motion(p) => self.shell.inject_motion(p.x, p.y),
            Injected::Button { button, pressed } => self.shell.inject_button(button, pressed.into()),
            Injected::Wheel { delta, source } => self.shell.inject_wheel(delta.x, delta.y, source.into()),
            Injected::Key { code, pressed } => self.shell.inject_key(code, pressed.into()),
        }
        self.sent();
    }

    pub fn animate(&self, window: u32, a: Animate) {
        let mut given = Animated::empty();
        let mut take = |flag: Animated, v: Option<f64>| {
            given.set(flag, v.is_some());
            v.unwrap_or(0.0)
        };
        let (opacity, scale, dx, dy) = (take(Animated::Opacity, a.opacity), take(Animated::Scale, a.scale), take(Animated::Dx, a.dx), take(Animated::Dy, a.dy));
        given.set(Animated::Easing, a.easing.is_some());
        let easing = a.easing.map_or(WireEasing::Ease, WireEasing::from);
        self.shell.animate(window, given, opacity, scale, dx, dy, a.duration_ms as u32, a.delay_ms as u32, easing);
        self.sent();
    }

    pub fn shortcut(&self, combo: String, scope: Scope, owner: u32) -> Result<(), String> {
        let rx = self.answer(|s, tx| _ = s.shortcut(combo, scope.into(), owner, &self.qh, tx));
        rx.recv_timeout(REPLY_WAIT).map_err(|e| e.to_string())?.map(drop)
    }

    pub fn set_scale(&self, output: String, scale: i32) -> Result<(), String> {
        let rx = self.answer(|s, tx| _ = s.set_scale(output, scale, &self.qh, tx));
        rx.recv_timeout(REPLY_WAIT).map_err(|e| e.to_string())?.map(drop)
    }

    pub fn unshortcut(&self, combo: String, scope: Scope, owner: u32) {
        self.shell.unshortcut(combo, scope.into(), owner);
        self.sent();
    }

    pub fn launch<'a>(&self, argv: &[String], cwd: Option<&str>, env: impl IntoIterator<Item = (&'a String, &'a String)>) -> Result<u32, String> {
        let mut args = Vec::new();
        for a in argv {
            args.extend_from_slice(a.as_bytes());
            args.push(0);
        }
        let mut vars = Vec::new();
        for (k, v) in env {
            vars.extend_from_slice(k.as_bytes());
            vars.push(b'=');
            vars.extend_from_slice(v.as_bytes());
            vars.push(0);
        }
        let cwd = cwd.unwrap_or_default().to_owned();
        let rx = self.answer(|s, tx| _ = s.launch(args, cwd, vars, &self.qh, tx));
        rx.recv_timeout(REPLY_WAIT).map_err(|e| e.to_string())?.map(|(pid, _)| pid)
    }

    pub fn set_screens(&self, on: bool) {
        self.shell.set_screens(on.into());
        self.sent();
    }

    /// Watches the seat's idleness (ext-idle-notify, so idle-inhibit holds it off): one watch per timeout (ms), each
    /// a [`Notice::Idle`] with its index. Replaces the watches given before; none stops watching.
    pub fn set_idle(&self, timeouts: &[u32]) -> Result<(), String> {
        let mut idle = self.idle.lock().map_err(|e| e.to_string())?;
        let mine = self.idle_round.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        for watch in idle.watches.drain(..) {
            watch.destroy();
        }
        let result = match (&idle.notifier, &idle.seat) {
            (Some(notifier), Some(seat)) => {
                let made: Vec<_> = timeouts
                    .iter()
                    .zip(0..)
                    .map(|(&ms, index)| notifier.get_idle_notification(ms, seat, &self.qh, IdleWatch { round: self.idle_round.clone(), mine, index }))
                    .collect();
                idle.watches = made;
                Ok(())
            }
            _ if timeouts.is_empty() => Ok(()),
            _ => Err("合成器没有 ext_idle_notifier_v1 或 wl_seat".to_owned()),
        };
        drop(idle);
        self.sent();
        result
    }

    /// Stops the reader thread, then asks the compositor to quit.
    pub fn quit(&self) {
        drop(self.stop.lock().ok().and_then(|mut s| s.take()));
        if let Some(reader) = self.reader.lock().ok().and_then(|mut r| r.take()) {
            _ = reader.join();
        }
        self.shell.quit();
        self.sent();
    }
}

fn some(v: i32) -> Option<u32> {
    u32::try_from(v).ok()
}

impl From<Mode> for WireMode {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Fullscreen => Self::Fullscreen,
            Mode::Free => Self::Free,
            Mode::Fixed => Self::Fixed,
            Mode::Pinned => Self::Pinned,
        }
    }
}

impl From<WireMode> for Mode {
    fn from(mode: WireMode) -> Self {
        match mode {
            WireMode::Fullscreen => Self::Fullscreen,
            WireMode::Free => Self::Free,
            WireMode::Fixed => Self::Fixed,
            WireMode::Pinned => Self::Pinned,
        }
    }
}

impl From<Scope> for WireScope {
    fn from(scope: Scope) -> Self {
        match scope {
            Scope::Session => Self::Session,
            Scope::Desktop => Self::Desktop,
            Scope::App => Self::App,
        }
    }
}

impl From<WireScope> for Scope {
    fn from(scope: WireScope) -> Self {
        match scope {
            WireScope::Session => Scope::Session,
            WireScope::Desktop => Scope::Desktop,
            WireScope::App => Scope::App,
        }
    }
}

impl From<Easing> for WireEasing {
    fn from(easing: Easing) -> Self {
        match easing {
            Easing::Linear => Self::Linear,
            Easing::Ease => Self::Ease,
            Easing::EaseIn => Self::EaseIn,
            Easing::EaseOut => Self::EaseOut,
            Easing::EaseInOut => Self::EaseInOut,
        }
    }
}

impl From<AxisSource> for WheelSource {
    fn from(source: AxisSource) -> Self {
        match source {
            AxisSource::Finger => Self::Finger,
            AxisSource::Continuous => Self::Continuous,
            _ => Self::Wheel,
        }
    }
}

impl Notice {
    /// The event as a notice; `None` for a window event about no window (-1 on the wire).
    fn of(event: acde_shell::Event) -> Option<Self> {
        use acde_shell::Event as E;
        Some(match event {
            E::Output { width, height, scale, name, description, refresh } => Notice::Output { width: width as u32, height: height as u32, scale, name, description, refresh: refresh.max(0) as u32 },
            E::WindowOpen { window, title, app_id } => Notice::Open { window, title, app_id },
            E::WindowClose { window } => Notice::Close { window: some(window)? },
            E::WindowTitle { window, title, app_id } => Notice::Title { window: some(window)?, title, app_id },
            E::WindowFullscreen { window, fullscreen } => Notice::Fullscreen { window, on: fullscreen != 0 },
            E::WindowMinimize { window } => Notice::Minimize { window: some(window)? },
            E::WindowActivate { window } => Notice::Activate { window: some(window)? },
            E::WindowAnimated { window } => Notice::Animated { window },
            E::Shortcut { owner, key, scope } => Notice::Shortcut { owner, key: key.unwrap_or_default(), scope: scope.into_result().ok().map(Scope::from) },
            E::WindowGone { window, x, y, width, height } => Notice::Gone { window: some(window)?, rect: [x, y, width, height] },
            E::WindowMinSize { window, width, height } => Notice::MinSize { window: some(window)?, width: width as u32, height: height as u32 },
            E::WindowParent { window, parent } => Notice::Parent { window, parent: some(parent) },
            E::Milestone { title, time_ms } => Notice::Milestone { title, time_ms },
            E::InputTarget { window, x, y, button } => Notice::InputTarget { window: some(window), x, y, button },
        })
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for Reader {
    fn event(_: &mut Self, _: &WlRegistry, _: <WlRegistry as Proxy>::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<WlSeat, ()> for Reader {
    fn event(_: &mut Self, _: &WlSeat, _: wl_seat::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ExtIdleNotifierV1, ()> for Reader {
    fn event(_: &mut Self, _: &ExtIdleNotifierV1, _: ext_idle_notifier_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ExtIdleNotificationV1, IdleWatch> for Reader {
    fn event(state: &mut Self, _: &ExtIdleNotificationV1, event: ext_idle_notification_v1::Event, watch: &IdleWatch, _: &Connection, _: &QueueHandle<Self>) {
        if watch.round.load(Ordering::Relaxed) != watch.mine {
            return;
        }
        let idle = match event {
            ext_idle_notification_v1::Event::Idled => true,
            ext_idle_notification_v1::Event::Resumed => false,
            _ => return,
        };
        (state.sink)(Notice::Idle { index: watch.index, idle });
    }
}

impl Dispatch<AcdeShell, ()> for Reader {
    fn event(state: &mut Self, _: &AcdeShell, event: acde_shell::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let Some(notice) = Notice::of(event) {
            (state.sink)(notice);
        }
    }
}

impl Dispatch<AcdeShellList, ListReply> for Reader {
    fn event(_: &mut Self, _: &AcdeShellList, event: acde_shell_list::Event, reply: &ListReply, _: &Connection, _: &QueueHandle<Self>) {
        use acde_shell_list::Event as E;
        let Ok(mut rows) = reply.rows.lock() else { return };
        match event {
            E::Window { id, window, canvas, mode, x, y, width, height, z, focus, hidden, pid } => rows.0.push(WindowInfo {
                id,
                window: some(window),
                canvas,
                mode: mode.into_result().map_or(Mode::Free, Mode::from),
                x,
                y,
                width,
                height,
                z,
                focus: focus != 0,
                hidden: hidden != 0,
                pid: some(pid),
            }),
            E::Canvas { id, x, y, width, height, scale } => rows.1.push(CanvasInfo { id, x, y, width, height, scale }),
            E::Done => _ = reply.tx.send(std::mem::take(&mut *rows)),
        }
    }
}

impl Dispatch<AcdeShellStats, Sender<Stats>> for Reader {
    fn event(_: &mut Self, _: &AcdeShellStats, event: acde_shell_stats::Event, tx: &Sender<Stats>, _: &Connection, _: &QueueHandle<Self>) {
        let acde_shell_stats::Event::Done { frames, compose_p50, compose_p95, compose_max, plans, direct } = event;
        _ = tx.send(Stats { frames, compose_p50, compose_p95, compose_max, plans, direct });
    }
}

impl Dispatch<AcdeShellResult, Sender<Answer>> for Reader {
    fn event(_: &mut Self, _: &AcdeShellResult, event: acde_shell_result::Event, tx: &Sender<Answer>, _: &Connection, _: &QueueHandle<Self>) {
        _ = tx.send(match event {
            acde_shell_result::Event::Done { first, second } => Ok((first, second)),
            acde_shell_result::Event::Failed { message } => Err(message),
        });
    }
}
