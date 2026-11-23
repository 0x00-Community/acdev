mod change;
mod clipboard;
mod drag;
mod events;
mod input;
mod picture;
mod probe;

use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use acde_wire::acompositor::desktop::acompositor_desktop_v1::{self, AcompositorDesktopV1};
use acde_wire::acompositor::desktop::acompositor_window_v1::{self, AcompositorWindowV1};
use acde_wire::acompositor::inject::acompositor_inject_v1::{self, AcompositorInjectV1};
use rustix::event::{PollFd, PollFlags, poll};
use serde_json::{Value, json};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_buffer, wl_data_device_manager, wl_registry, wl_seat, wl_shm, wl_shm_pool};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum};
use wayland_protocols::ext::data_control::v1::client::{ext_data_control_device_v1, ext_data_control_manager_v1};

const DESKTOP_SINCE: u32 = 11;
const DESKTOP_MOST: u32 = 12;

#[derive(Clone, Debug, PartialEq)]
pub enum Aim {
    Screen,
    Toplevel(u64),
    App(String),
}

#[derive(Default, Clone)]
struct Window {
    toplevel: u64,
    app_id: String,
    vouched: String,
    hidden: bool,
    state: u32,
    geometry: (i32, i32, i32, i32),
    activated: bool,
}

impl Window {
    fn app(&self) -> &str {
        if self.vouched.is_empty() { &self.app_id } else { &self.vouched }
    }
}

#[derive(Default)]
struct State {
    windows: Vec<(AcompositorWindowV1, Window)>,
    capture: picture::Capture,
    drag: drag::Drag,
    clip: clipboard::Clip,
    probe: probe::Probe,
    skipped: u32,
    lost: bool,
}

impl State {
    fn window(&mut self, proxy: &AcompositorWindowV1) -> Option<&mut Window> {
        self.windows.iter_mut().find(|(p, _)| p == proxy).map(|(_, w)| w)
    }

    fn row(&self, toplevel: u64) -> Option<&(AcompositorWindowV1, Window)> {
        self.windows.iter().find(|(_, w)| w.toplevel == toplevel)
    }

    fn of_app(&self, app: &str) -> Option<u64> {
        let mine: Vec<&Window> = self.windows.iter().map(|(_, w)| w).filter(|w| w.app() == app && !w.hidden).collect();
        mine.iter().find(|w| w.activated).or(mine.first()).map(|w| w.toplevel)
    }
}

struct Globals {
    desktop: AcompositorDesktopV1,
    inject: AcompositorInjectV1,
    shm: wl_shm::WlShm,
    drags: wl_data_device_manager::WlDataDeviceManager,
    clipboard: Option<(ext_data_control_manager_v1::ExtDataControlManagerV1, ext_data_control_device_v1::ExtDataControlDeviceV1)>,
}

struct Worker {
    queue: EventQueue<State>,
    qh: QueueHandle<State>,
    state: State,
    globals: Globals,
}

pub enum Job {
    Pointer { x: f64, y: f64 },
    Screen { path: Option<String> },
    Shot { aim: Aim, max: Option<u32> },
    Input { aim: Aim, events: Vec<Value> },
    Window { aim: Aim, change: Value },
    Clipboard { text: Option<String> },
    Drop { aim: Aim, files: Vec<String>, at: Option<(f64, f64)> },
    RenderState,
    Hit { x: f64, y: f64 },
}

type Reply = mpsc::Sender<Result<Value, String>>;

pub struct Screen {
    jobs: mpsc::Sender<(Job, Reply)>,
    wake: UnixStream,
    alive: Arc<AtomicBool>,
}

impl Screen {
    pub fn start(fd: OwnedFd) -> Result<Self, String> {
        let (wake, woken) = UnixStream::pair().map_err(|e| format!("the dev connection: {e}"))?;
        woken.set_nonblocking(true).map_err(|e| format!("the dev connection: {e}"))?;
        let worker = Worker::connect(UnixStream::from(fd))?;
        let (jobs, rx) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        let lost = alive.clone();
        let thread = move || {
            let why = worker.run(&rx, &woken);
            log::warn!("acompositor's dev connection: {why}");
            lost.store(false, Ordering::Release);
        };
        std::thread::Builder::new().name("acdev-agent-screen".into()).spawn(thread).map_err(|e| format!("the screen thread: {e}"))?;
        Ok(Self { jobs, wake, alive })
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn run(&self, job: Job) -> Result<Value, String> {
        let (reply, answer) = mpsc::channel();
        self.jobs.send((job, reply)).map_err(|_| "acompositor's dev connection is gone".to_string())?;
        _ = (&self.wake).write_all(&[1]);
        answer.recv().unwrap_or_else(|_| Err("acompositor's dev connection is gone".into()))
    }
}

impl Worker {
    fn connect(socket: UnixStream) -> Result<Self, String> {
        let conn = Connection::from_socket(socket).map_err(|e| format!("the dev connection: {e}"))?;
        let (globals, queue) = registry_queue_init::<State>(&conn).map_err(|e| format!("the dev connection: {e}"))?;
        let qh = queue.handle();
        let need = |what: &str, e: wayland_client::globals::BindError| format!("the dev connection: {what}: {e}");
        let desktop: AcompositorDesktopV1 = globals.bind(&qh, DESKTOP_SINCE..=DESKTOP_MOST, ()).map_err(|e| need("acompositor_desktop_v1", e))?;
        let inject: AcompositorInjectV1 = globals.bind(&qh, 3..=5, ()).map_err(|e| need("acompositor_inject_v1", e))?;
        let shm: wl_shm::WlShm = globals.bind(&qh, 1..=1, ()).map_err(|e| need("wl_shm", e))?;
        let drags: wl_data_device_manager::WlDataDeviceManager = globals.bind(&qh, 3..=3, ()).map_err(|e| need("wl_data_device_manager", e))?;
        let seat: Option<wl_seat::WlSeat> = globals.bind(&qh, 1..=7, ()).ok();
        let control: Option<ext_data_control_manager_v1::ExtDataControlManagerV1> = globals.bind(&qh, 1..=1, ()).ok();
        let clipboard = control.zip(seat).map(|(control, seat)| {
            let device = control.get_data_device(&seat, &qh, ());
            (control, device)
        });
        let globals = Globals { desktop, inject, shm, drags, clipboard };
        Ok(Self { queue, qh, state: State::default(), globals })
    }

    fn run(mut self, jobs: &mpsc::Receiver<(Job, Reply)>, woken: &UnixStream) -> String {
        loop {
            if let Err(e) = self.queue.flush()
                && !transient(&e)
            {
                return format!("flushing: {e}");
            }
            let Some(guard) = self.queue.prepare_read() else {
                if let Err(e) = self.queue.dispatch_pending(&mut self.state) {
                    return format!("dispatching: {e}");
                }
                continue;
            };
            let (readable, job) = {
                let fd = guard.connection_fd();
                let mut fds = [PollFd::new(&fd, PollFlags::IN), PollFd::new(woken, PollFlags::IN)];
                if poll(&mut fds, None).is_err() {
                    continue;
                }
                (!fds[0].revents().is_empty(), !fds[1].revents().is_empty())
            };
            if readable {
                if let Err(e) = guard.read()
                    && !transient(&e)
                {
                    return format!("reading: {e}");
                }
            } else {
                drop(guard);
            }
            if let Err(e) = self.queue.dispatch_pending(&mut self.state) {
                return format!("dispatching: {e}");
            }
            if job {
                let mut bytes = [0u8; 64];
                while matches!((&*woken).read(&mut bytes), Ok(n) if n > 0) {}
                for (job, reply) in jobs.try_iter() {
                    _ = reply.send(self.job(job));
                }
            }
        }
    }

    fn job(&mut self, job: Job) -> Result<Value, String> {
        match job {
            Job::Pointer { x, y } => {
                self.globals.inject.move_to(x, y);
                self.settle()?;
                Ok(json!({ "x": x, "y": y }))
            }
            Job::Screen { path } => self.screen(path),
            Job::Shot { aim, max } => {
                let toplevel = self.toplevel(&aim)?;
                self.shot(toplevel, max)
            }
            Job::Input { aim, events } => {
                let toplevel = self.toplevel(&aim)?;
                self.input(&events, toplevel)
            }
            Job::Window { aim, change } => match aim {
                Aim::Screen => self.focus_desktop(&change),
                aim => {
                    let toplevel = self.toplevel(&aim)?.ok_or("a window change needs a window")?;
                    self.change_window(&change, toplevel)
                }
            },
            Job::Clipboard { text } => self.clipboard(text.as_deref()),
            Job::Drop { aim, files, at } => {
                let toplevel = self.toplevel(&aim)?;
                self.drop_files(&files, toplevel, at)
            }
            Job::RenderState => self.render_state(),
            Job::Hit { x, y } => self.hit(x, y),
        }
    }

    fn toplevel(&mut self, aim: &Aim) -> Result<Option<u64>, String> {
        self.settle()?;
        match aim {
            Aim::Screen => Ok(None),
            Aim::Toplevel(n) => self.state.row(*n).map(|_| Some(*n)).ok_or_else(|| format!("no window acompositor-{n} on the screen")),
            Aim::App(app) => self.state.of_app(app).map(Some).ok_or_else(|| format!("{app}: no window of its on the screen")),
        }
    }

    fn settle(&mut self) -> Result<(), String> {
        self.queue.roundtrip(&mut self.state).map(drop).map_err(|e| format!("acompositor: {e}"))
    }

    fn wait(&mut self, done: impl Fn(&State) -> bool) -> Result<(), String> {
        while !done(&self.state) {
            self.queue.blocking_dispatch(&mut self.state).map_err(|e| format!("acompositor: {e}"))?;
        }
        Ok(())
    }

    fn geometry(&self, toplevel: Option<u64>) -> Result<Option<(i32, i32, i32, i32)>, String> {
        let Some(n) = toplevel else { return Ok(None) };
        self.state.row(n).map(|(_, w)| Some(w.geometry)).ok_or_else(|| "the window is gone".to_string())
    }
}

impl Dispatch<AcompositorDesktopV1, ()> for State {
    fn event(state: &mut Self, _: &AcompositorDesktopV1, event: acompositor_desktop_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            acompositor_desktop_v1::Event::Window { window } => state.windows.push((window, Window::default())),
            other => events::journal(&other),
        }
    }

    wayland_client::event_created_child!(State, AcompositorDesktopV1, [
        acompositor_desktop_v1::EVT_WINDOW_OPCODE => (AcompositorWindowV1, ()),
    ]);
}

impl Dispatch<AcompositorWindowV1, ()> for State {
    fn event(state: &mut Self, proxy: &AcompositorWindowV1, event: acompositor_window_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use acompositor_window_v1::Event as E;
        if let E::Closed = event {
            state.windows.retain(|(p, _)| p != proxy);
            return proxy.destroy();
        }
        let Some(window) = state.window(proxy) else { return };
        match event {
            E::AppId { app_id } => window.app_id = app_id,
            E::VouchedAppId { app_id } => window.vouched = app_id,
            E::State { state: s, hidden } => {
                window.state = match s {
                    WEnum::Value(v) => v as u32,
                    WEnum::Unknown(v) => v,
                };
                window.hidden = hidden != 0;
            }
            E::Geometry { x, y, width, height } => window.geometry = (x, y, width, height),
            E::Activated { activated } => window.activated = activated != 0,
            E::Identifier { identifier } => window.toplevel = identifier.strip_prefix("acompositor-").and_then(|n| n.parse().ok()).unwrap_or(0),
            _ => {}
        }
    }
}

impl Dispatch<AcompositorInjectV1, ()> for State {
    fn event(state: &mut Self, _: &AcompositorInjectV1, event: acompositor_inject_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            acompositor_inject_v1::Event::TextSkipped { count } => state.skipped += count,
            acompositor_inject_v1::Event::TargetLost => state.lost = true,
            _ => {}
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

macro_rules! no_events {
    ($($proxy:ty),*) => {$(
        impl Dispatch<$proxy, ()> for State {
            fn event(_: &mut Self, _: &$proxy, _: <$proxy as Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
        }
    )*};
}

no_events!(
    wl_shm::WlShm,
    wl_shm_pool::WlShmPool,
    wl_buffer::WlBuffer,
    wl_seat::WlSeat,
    wl_data_device_manager::WlDataDeviceManager,
    ext_data_control_manager_v1::ExtDataControlManagerV1
);

fn transient(e: &wayland_client::backend::WaylandError) -> bool {
    matches!(e, wayland_client::backend::WaylandError::Io(io) if matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted))
}

fn state_name(state: u32) -> &'static str {
    match state {
        1 => "minimized",
        2 => "filled",
        3 => "fullscreen",
        _ => "normal",
    }
}
