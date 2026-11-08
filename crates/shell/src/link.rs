use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, poll};

use acde_model::{Mode, Scope};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};

use crate::compositor::{Event, Inbox, Stats};
use crate::napi_shell::WindowRow;

pub(crate) mod protocol {
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

use protocol::acde_shell::{self, AcdeShell};
use protocol::acde_shell_list::{self, AcdeShellList};
use protocol::acde_shell_result::{self, AcdeShellResult};
use protocol::acde_shell_stats::{self, AcdeShellStats};

const REPLY_WAIT: Duration = Duration::from_millis(500);

pub struct Link {
    conn: Connection,
    shell: AcdeShell,
    pub(crate) qh: QueueHandle<Reader>,
    stop: Option<OwnedFd>,
    reader: Option<JoinHandle<()>>,
}

pub(crate) struct Reader {
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

struct ListReply {
    rows: Mutex<Vec<WindowRow>>,
    tx: Sender<Vec<WindowRow>>,
}

pub type Answer = Result<(u32, u32), String>;

impl Link {
    pub fn connect(stream: UnixStream, inbox: Arc<Inbox>) -> Result<Self, String> {
        let conn = Connection::from_socket(stream).map_err(|e| format!("acde_shell: {e}"))?;
        let (globals, mut queue) = registry_queue_init::<Reader>(&conn).map_err(|e| format!("acde_shell registry: {e}"))?;
        let qh = queue.handle();
        let shell: AcdeShell = globals.bind(&qh, 1..=1, ()).map_err(|e| format!("acde_shell: {e}"))?;
        conn.flush().map_err(|e| format!("acde_shell: {e}"))?;
        let (stopped, stop) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).map_err(|e| format!("acde_shell: {e}"))?;
        let mut reader = Reader { inbox };
        let thread = std::thread::Builder::new()
            .name("acde-shell-link".into())
            .spawn(move || {
                if let Err(e) = reader.run(&mut queue, &stopped) {
                    log::warn!("acde_shell connection lost: {e}");
                }
                reader.inbox.push(Event::named("exit"));
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { conn, shell, qh, stop: Some(stop), reader: Some(thread) })
    }

    pub fn send<R>(&self, f: impl FnOnce(&AcdeShell) -> R) -> R {
        let result = f(&self.shell);
        if let Err(e) = self.conn.flush() {
            log::warn!("acde_shell: {e}");
        }
        result
    }

    pub fn answer(&self, make: impl FnOnce(&AcdeShell, Sender<Answer>)) -> Receiver<Answer> {
        let (tx, rx) = mpsc::channel();
        self.send(|s| make(s, tx));
        rx
    }

    pub fn wait(&self, make: impl FnOnce(&AcdeShell, Sender<Answer>)) -> Answer {
        self.answer(make).recv_timeout(REPLY_WAIT).map_err(|e| e.to_string())?
    }

    pub fn list(&self) -> Vec<WindowRow> {
        let (tx, rx) = mpsc::channel();
        self.send(|s| s.list(&self.qh, ListReply { rows: Mutex::default(), tx }));
        rx.recv_timeout(REPLY_WAIT).unwrap_or_default()
    }

    pub fn stats(&self, reset: bool) -> Stats {
        let (tx, rx) = mpsc::channel();
        self.send(|s| s.stats(reset.into(), &self.qh, tx));
        rx.recv_timeout(REPLY_WAIT).unwrap_or_default()
    }

    pub fn quit(&mut self) {
        drop(self.stop.take());
        if let Some(reader) = self.reader.take() {
            _ = reader.join();
        }
        self.send(AcdeShell::quit);
    }
}

fn some(v: i32) -> Option<u32> {
    u32::try_from(v).ok()
}

impl From<acde_shell::Event> for Event {
    fn from(event: acde_shell::Event) -> Self {
        use acde_shell::Event as E;
        let on = |kind: &str, window: Option<u32>| Event { window, ..Event::named(kind) };
        match event {
            E::Output { width, height, scale } => {
                Event { width: Some(width.into()), height: Some(height.into()), scale: Some(scale), ..Event::named("output") }
            }
            E::WindowOpen { window, title, app_id } => Event { title, app_id, ..on("windowopen", Some(window)) },
            E::WindowClose { window } => on("windowclose", some(window)),
            E::WindowTitle { window, title, app_id } => Event { title, app_id, ..on("windowtitle", some(window)) },
            E::WindowFullscreen { window, fullscreen } => on(if fullscreen != 0 { "windowfullscreen" } else { "windowunfullscreen" }, Some(window)),
            E::WindowMinimize { window } => on("windowminimize", some(window)),
            E::WindowActivate { window } => on("windowactivate", some(window)),
            E::WindowAnimated { window } => on("windowanimated", Some(window)),
            E::Shortcut { owner, key, scope } => {
                let title = Scope::try_from(scope).ok().map(|s| s.as_str().to_owned());
                Event { key, title, ..on("shortcut", Some(owner)) }
            }
            E::WindowGone { window, x, y, width, height } => {
                Event { x: Some(x.into()), y: Some(y.into()), width: Some(width.into()), height: Some(height.into()), ..on("windowgone", some(window)) }
            }
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
            E::Window { id, window, canvas, mode, x, y, width, height, z, focus, hidden, pid } => rows.push(WindowRow {
                id,
                window: some(window),
                canvas,
                mode: Mode::try_from(mode).unwrap_or(Mode::Free).as_str().into(),
                x,
                y,
                width,
                height,
                z,
                focus: focus != 0,
                hidden: hidden != 0,
                pid: some(pid),
            }),
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
