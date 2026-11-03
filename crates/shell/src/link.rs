use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, poll};

use acde_model::{Easing, Mode, Scope};
use smithay::backend::input::AxisSource;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};

use crate::compositor::{Animate, CanvasInfo, Event, Grant, Inbox, Injected, Stats, WindowInfo};

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

const REPLY_WAIT: Duration = Duration::from_millis(500);

pub struct Link {
    conn: Connection,
    shell: AcdeShell,
    qh: QueueHandle<Reader>,
    stop: Option<OwnedFd>,
    reader: Option<JoinHandle<()>>,
}

struct Reader {
    inbox: Arc<Inbox>,
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
    pub fn connect(stream: UnixStream, inbox: Arc<Inbox>) -> Result<Self, String> {
        let conn = Connection::from_socket(stream).map_err(|e| format!("acde_shell: {e}"))?;
        let (globals, mut queue) = registry_queue_init::<Reader>(&conn).map_err(|e| format!("acde_shell registry: {e}"))?;
        let qh = queue.handle();
        let shell: AcdeShell = globals.bind(&qh, 1..=1, ()).map_err(|e| format!("acde_shell: {e}"))?;
        conn.flush().map_err(|e| format!("acde_shell: {e}"))?;
        let (stopped, stop) = rustix::pipe::pipe().map_err(|e| format!("acde_shell: {e}"))?;
        let mut reader = Reader { inbox };
        let thread = std::thread::Builder::new()
            .name("acde-shell-link".into())
            .spawn(move || {
                if let Err(e) = reader.run(&mut queue, &stopped) {
                    log::warn!("acde_shell 连接断了: {e}");
                }
                reader.inbox.push(Event::named("exit"));
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { conn, shell, qh, stop: Some(stop), reader: Some(thread) })
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

    pub fn quit(&mut self) {
        drop(self.stop.take());
        if let Some(reader) = self.reader.take() {
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

impl WireScope {
    fn name(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Desktop => "desktop",
            Self::App => "app",
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

impl From<acde_shell::Event> for Event {
    fn from(event: acde_shell::Event) -> Self {
        use acde_shell::Event as E;
        let on = |kind: &str, window: Option<u32>| Event { window, ..Event::named(kind) };
        match event {
            E::Output { width, height, scale } => Event { width: Some(width.into()), height: Some(height.into()), scale: Some(scale), ..Event::named("output") },
            E::WindowOpen { window, title, app_id } => Event { title, app_id, ..on("windowopen", Some(window)) },
            E::WindowClose { window } => on("windowclose", some(window)),
            E::WindowTitle { window, title, app_id } => Event { title, app_id, ..on("windowtitle", some(window)) },
            E::WindowFullscreen { window, fullscreen } => on(if fullscreen != 0 { "windowfullscreen" } else { "windowunfullscreen" }, Some(window)),
            E::WindowMinimize { window } => on("windowminimize", some(window)),
            E::WindowActivate { window } => on("windowactivate", some(window)),
            E::WindowAnimated { window } => on("windowanimated", Some(window)),
            E::Shortcut { owner, key, scope } => {
                let title = scope.into_result().ok().map(|s| s.name().to_owned());
                Event { key, title, ..on("shortcut", Some(owner)) }
            }
            E::WindowGone { window, x, y, width, height } => Event {
                x: Some(x.into()),
                y: Some(y.into()),
                width: Some(width.into()),
                height: Some(height.into()),
                ..on("windowgone", some(window))
            },
            E::WindowMinSize { window, width, height } => Event { width: Some(width.into()), height: Some(height.into()), ..on("windowminsize", some(window)) },
            E::WindowParent { window, parent } => Event { parent: some(parent), ..on("windowparent", Some(window)) },
            E::Milestone { title, time_ms } => Event { title: Some(title), time: Some(time_ms), ..Event::named("milestone") },
            E::InputTarget { window, x, y, button } => Event { x: Some(x), y: Some(y), button: Some(button), ..on("inputtarget", some(window)) },
        }
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for Reader {
    fn event(_: &mut Self, _: &WlRegistry, _: <WlRegistry as Proxy>::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<AcdeShell, ()> for Reader {
    fn event(state: &mut Self, _: &AcdeShell, event: acde_shell::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        state.inbox.push(event.into());
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
