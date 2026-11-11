mod backend;
mod capture;
mod composite;
mod effects;
pub use composite::Animate;
mod cursor;
mod drm;
mod env;
mod handlers;
mod dnd;
mod nested;
mod outputs;
mod rdp;
mod stacking;
mod windows;
mod acde_window;
mod acde_shell;
pub use acde_shell::ShellEvent;
mod grabs;
pub use acde_window::Grant;
mod input;
pub use input::{Injected, WheelKind};
mod layers;
mod lock;
mod protocols;
mod timing;

use std::ffi::{OsStr, OsString};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::time::Duration;
use std::thread::JoinHandle;
use std::time::Instant;

use smithay::desktop::{PopupManager, Space, Window};
use smithay::input::{Seat, SeatState};
use smithay::reexports::calloop::channel::{self, Channel};
use smithay::reexports::calloop::{LoopSignal, RegistrationToken};
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::wayland::compositor::CompositorState;
use smithay::wayland::dmabuf::DmabufState;
use smithay::wayland::output::OutputManagerState;
use smithay::wayland::selection::data_device::DataDeviceState;
use smithay::wayland::shell::xdg::XdgShellState;
use smithay::wayland::shm::ShmState;
use smithay::utils::{Logical, Rectangle};

pub use backend::Backend;

pub use acde_model::{Event, Inbox};

pub const SURFACE_IDS: u32 = 1 << 20;

pub const BTN_LEFT: u32 = 0x110;

pub struct Extra(u32);

#[derive(Clone)]
pub struct WindowInfo {
    pub id: u32,
    pub window: Option<u32>,
    pub canvas: u32,
    pub mode: acde_model::Mode,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
    pub focus: bool,
    pub hidden: bool,
    pub pid: Option<u32>,
}

fn table_rect(rect: Rectangle<i32, Logical>) -> acde_model::Rect {
    acde_model::Rect::new(rect.loc.x as f64, rect.loc.y as f64, rect.size.w.max(1) as f64, rect.size.h.max(1) as f64)
}

fn space_rect(rect: acde_model::Rect) -> Rectangle<i32, Logical> {
    Rectangle::new((rect.x as i32, rect.y as i32).into(), (rect.w.max(1.0) as i32, rect.h.max(1.0) as i32).into())
}

#[derive(Default, Clone)]
pub struct CanvasInfo {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

pub enum Command {
    Focus(u32),
    Hide { window: u32, hidden: bool },
    Close(u32),
    Place { window: u32, x: i32, y: i32, width: i32, height: i32 },
    Raise { window: u32, above: Option<u32> },
    SetMode { window: u32, mode: acde_model::Mode },
    List(mpsc::Sender<(Vec<WindowInfo>, Vec<CanvasInfo>)>),
    Grant(u64, Grant),
    Release(u32),
    Stats(bool, mpsc::Sender<Stats>),
    Screenshot(std::path::PathBuf, mpsc::Sender<Result<(u32, u32), String>>),
    Inject(input::Injected),
    Animate(u32, Animate),
    Shortcut { combo: String, scope: acde_model::Scope, owner: u32, reply: mpsc::Sender<Result<(), String>> },
    SetScale { output: String, scale: i32, reply: mpsc::Sender<Result<(), String>> },
    Unshortcut { combo: String, scope: acde_model::Scope, owner: u32 },
    Connect(UnixStream),
    Quit,
}

#[derive(Default, Clone)]
pub struct Stats {
    pub frames: u32,
    pub compose_p50: f64,
    pub compose_p95: f64,
    pub compose_max: f64,
    pub plans: u32,
    pub direct: u32,
}

#[derive(Default)]
pub struct Samples {
    ms: std::collections::VecDeque<f64>,
    pub count: u32,
}

impl Samples {
    const WINDOW: usize = 600;

    pub fn push(&mut self, ms: f64) {
        if self.ms.len() == Self::WINDOW {
            self.ms.pop_front();
        }
        self.ms.push_back(ms);
        self.count += 1;
    }

    pub fn clear(&mut self) {
        self.ms.clear();
    }

    fn summary(&self) -> (f64, f64, f64) {
        let mut v: Vec<f64> = self.ms.iter().copied().collect();
        if v.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        v.sort_by(f64::total_cmp);
        let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        (at(0.5), at(0.95), v[v.len() - 1])
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct NativeId(pub u32);

const QUIT_WAIT: Duration = Duration::from_secs(3);
const DEFERRED_MOVE: Duration = Duration::from_millis(150);

type DeferredMove = (Window, Vec<Rectangle<i32, Logical>>, Instant);

pub struct Handle {
    commands: channel::Sender<Command>,
    socket: OsString,
    thread: Option<JoinHandle<()>>,
}

impl Handle {
    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    pub fn connect(&self, shell: UnixStream) {
        self.send(Command::Connect(shell));
    }

    pub fn socket_name(&self) -> &OsStr {
        &self.socket
    }

    pub fn quit(&mut self) {
        self.send(Command::Quit);
        let Some(thread) = self.thread.take() else { return };
        let deadline = Instant::now() + QUIT_WAIT;
        while !thread.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        match thread.is_finished() {
            true => _ = thread.join(),
            false => log::warn!("合成器线程 {} 秒内没停下", QUIT_WAIT.as_secs()),
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.quit();
    }
}

pub struct Compositor {
    pub start: Instant,
    milestones: std::collections::HashSet<&'static str>,
    pub display: DisplayHandle,
    pub signal: LoopSignal,
    pub space: Space<Window>,
    pub popups: PopupManager,
    pub compositor_state: CompositorState,
    pub xdg_shell: XdgShellState,
    pub shm: ShmState,
    pub dmabuf: DmabufState,
    pub output_manager: OutputManagerState,
    pub seat_state: SeatState<Self>,
    pub data_device: DataDeviceState,
    pub seat: Seat<Self>,
    pub backend: Backend,
    pub shell: acde_shell::ShellLink,
    pub socket: OsString,
    pub table: acde_model::WindowTable,
    pub canvas: Option<acde_model::CanvasId>,
    pub native_ids: std::collections::HashMap<u32, acde_model::WindowId>,
    pub extras: std::collections::HashMap<u32, acde_model::WindowId>,
    pub grants: std::collections::HashMap<u64, Grant>,
    pub pending: Vec<Window>,
    pub desktop: Option<u32>,
    pub protocols: protocols::Protocols,
    pub timing: timing::Timing,
    pub layers: layers::Layers,
    pub lock: lock::Lock,
    drag: Option<dnd::Drag>,
    swallowed: std::collections::HashSet<u32>,
    hidden: std::collections::HashSet<u32>,
    deferred: Vec<DeferredMove>,
    frame_tick: Option<RegistrationToken>,
    last_render: Option<Instant>,
    render_timer: Option<RegistrationToken>,
    pub cursor: cursor::Cursor,
    pub compose_ms: Samples,
    pub motion: composite::Motion,
    pub effects: effects::Effects,
    pub grabs: grabs::InputGrabs,
    pub shortcuts: acde_model::Shortcuts,
    shortcut_names: std::collections::HashMap<acde_model::Combo, String>,
    held_keys: std::collections::HashSet<u32>,
    pub loop_handle: smithay::reexports::calloop::LoopHandle<'static, Self>,
    next_window: u32,
}

impl Compositor {
    pub fn spawn(server: UnixStream) -> Result<Handle, String> {
        let (commands, channel) = channel::channel();
        let (ready, ready_rx) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("acde-compositor".into())
            .spawn(move || {
                if let Err(e) = Self::run(channel, server, &ready) {
                    let _ = ready.send(Err(e));
                }
            })
            .map_err(|e| e.to_string())?;
        let socket = ready_rx.recv().map_err(|_| "合成器线程启动失败".to_string())??;
        Ok(Handle { commands, socket, thread: Some(thread) })
    }

    fn run(
        commands: Channel<Command>,
        shell: UnixStream,
        ready: &mpsc::SyncSender<Result<OsString, String>>,
    ) -> Result<(), String> {
        use smithay::backend::renderer::{ImportDma, ImportEgl, ImportMemWl};
        use smithay::reexports::calloop::generic::Generic;
        use smithay::reexports::calloop::{EventLoop, Interest, Mode as LoopMode, PostAction};
        use smithay::reexports::wayland_server::Display;
        use smithay::wayland::dmabuf::DmabufFeedbackBuilder;
        use smithay::wayland::socket::ListeningSocketSource;

        let mut event_loop: EventLoop<'static, Compositor> = EventLoop::try_new().map_err(|e| e.to_string())?;
        let display: Display<Compositor> = Display::new().map_err(|e| e.to_string())?;
        let dh = display.handle();
        let lh = event_loop.handle();
        let nested = std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
        let (mut backend, node) = match std::env::var("ACDE_BACKEND").as_deref() {
            Ok("drm") => drm::DrmTarget::start(&lh)?,
            Ok("rdp") => rdp::RdpTarget::start(&lh)?,
            Ok("nested") => nested::NestedTarget::start(&lh)?,
            _ if nested => nested::NestedTarget::start(&lh)?,
            _ => drm::DrmTarget::start(&lh)?,
        };

        if let Err(e) = backend.renderer.bind_wl_display(&dh) {
            log::warn!("wl_drm 不可用: {e}");
        }
        let feedback = DmabufFeedbackBuilder::new(node.dev_id(), backend.renderer.dmabuf_formats()).build().map_err(|e| format!("dmabuf feedback: {e}"))?;
        let mut dmabuf = DmabufState::new();
        dmabuf.create_global_with_default_feedback::<Compositor>(&dh, &feedback);

        let outputs: Vec<smithay::output::Output> = match &backend.target {
            backend::Target::Rdp(_) | backend::Target::Nested(_) => vec![backend.output.clone()],
            backend::Target::Drm(drm) => drm.outputs().cloned().collect(),
        };
        let mut space = Space::default();
        for output in &outputs {
            output.create_global::<Compositor>(&dh);
            let loc = output.current_location();
            space.map_output(output, loc);
        }

        let mut seat_state = SeatState::new();
        let mut seat = seat_state.new_wl_seat(&dh, "acde");
        seat.add_keyboard(Default::default(), 200, 25).map_err(|e| format!("键盘: {e}"))?;
        seat.add_pointer();
        let mut shm = ShmState::new::<Compositor>(&dh, vec![]);
        shm.update_formats(backend.renderer.shm_formats());
        backend.dirty = true;

        let socket = match std::env::var("ACDE_SOCKET") {
            Ok(name) => ListeningSocketSource::with_name(&name),
            Err(_) => ListeningSocketSource::new_auto(),
        }
        .map_err(|e| format!("Wayland socket: {e}"))?;
        let socket_name = socket.socket_name().to_os_string();
        lh.insert_source(socket, |stream, _, state| {
            if let Err(e) = state.display.insert_client(stream, std::sync::Arc::new(handlers::ClientState::default())) {
                log::warn!("接入客户端失败: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
        lh.insert_source(Generic::new(display, Interest::READ, LoopMode::Level), |_, display, state| {
            unsafe { display.get_mut().dispatch_clients(state) }.map(|_| PostAction::Continue)
        })
        .map_err(|e| e.to_string())?;
        lh.insert_source(commands, |event, _, state| state.on_channel(event)).map_err(|e| e.to_string())?;

        let mut state = Compositor {
            start: Instant::now(),
            milestones: Default::default(),
            display: dh.clone(),
            signal: event_loop.get_signal(),
            space,
            popups: PopupManager::default(),
            compositor_state: CompositorState::new::<Compositor>(&dh),
            xdg_shell: XdgShellState::new::<Compositor>(&dh),
            shm,
            dmabuf,
            output_manager: OutputManagerState::new_with_xdg_output::<Compositor>(&dh),
            seat_state,
            data_device: DataDeviceState::new::<Compositor>(&dh),
            seat,
            backend,
            shell: Default::default(),
            socket: socket_name.clone(),
            table: Default::default(),
            canvas: None,
            native_ids: Default::default(),
            extras: Default::default(),
            grants: Default::default(),
            pending: Vec::new(),
            desktop: None,
            protocols: protocols::Protocols::new(&dh, node.dev_path()),
            timing: timing::Timing::new(&dh),
            layers: layers::Layers::new(&dh, lh.clone()),
            lock: lock::Lock::new(&dh),
            swallowed: Default::default(),
            hidden: Default::default(),
            deferred: Vec::new(),
            drag: None,
            last_render: None,
            frame_tick: None,
            render_timer: None,
            cursor: cursor::Cursor::default(),
            compose_ms: Samples::default(),
            motion: Default::default(),
            effects: Default::default(),
            grabs: Default::default(),
            shortcuts: Default::default(),
            shortcut_names: Default::default(),
            held_keys: Default::default(),
            loop_handle: lh.clone(),
            next_window: 1,
        };
        let forced = std::env::var("ACDE_SCALE").ok().and_then(|s| s.parse::<f64>().ok()).filter(|s| *s > 0.0);
        let mut x = 0;
        for output in &outputs {
            let scale = outputs::saved_scale(output)
                .map(smithay::output::Scale::Integer)
                .or_else(|| forced.map(smithay::output::Scale::Fractional))
                .or_else(|| integer_scale(output).map(smithay::output::Scale::Integer));
            if let Some(scale) = scale {
                output.change_current_state(None, None, Some(scale), None);
            }
            let loc = (x, output.current_location().y).into();
            output.change_current_state(None, None, None, Some(loc));
            state.space.map_output(output, loc);
            let size = output.physical_properties().size;
            let scale = output.current_scale().fractional_scale();
            let mode = output.current_mode().map(|m| m.size).unwrap_or_default();
            log::info!("输出 {}: {}x{} 物理 {}x{} mm 缩放 {scale} 位置 {loc:?}", output.name(), mode.w, mode.h, size.w, size.h);
            x += (f64::from(mode.w) / scale).ceil() as i32;
        }
        Self::acde_window_global(&dh);
        Self::acde_shell_global(&dh);
        state.insert_shell_client(shell)?;
        state.init_canvas();
        state.emit_output();
        state.export_session_env(&[("WAYLAND_DISPLAY", &socket_name.to_string_lossy()), ("XDG_SESSION_TYPE", "wayland"), ("XDG_CURRENT_DESKTOP", "acde")]);
        let _ = ready.send(Ok(socket_name));

        event_loop
            .run(None, &mut state, |state| {
                state.render();
                state.space.refresh();
                state.popups.cleanup();
                let _ = state.display.flush_clients();
            })
            .map_err(|e| e.to_string())
    }

    fn render(&mut self) {
        if !(self.backend.dirty || self.screens_pending()) || self.backend.presenting || self.render_timer.is_some() {
            return;
        }
        let min = self.frame_duration().mul_f64(0.9);
        if let Some(wait) = self.last_render.map(|t| min.saturating_sub(t.elapsed())).filter(|w| !w.is_zero())
            && self.after(|s| &mut s.render_timer, wait, Self::render)
        {
            return;
        }
        self.last_render = Some(Instant::now());
        let started = Instant::now();
        let frame_target = self.timing.clock.now() + self.frame_duration();
        self.pre_repaint(frame_target);
        match self.backend.target {
            backend::Target::Drm(_) => self.render_drm(),
            backend::Target::Rdp(_) => self.render_rdp(),
            backend::Target::Nested(_) => self.render_nested(),
        }
        if self.backend.presenting {
            self.cancel(|s| &mut s.frame_tick);
            self.milestone("第一帧提交");
        }
        self.compose_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        if self.motion.active() {
            self.backend.damaged();
        }
    }

    pub fn stats(&mut self, reset: bool) -> Stats {
        let (compose_p50, compose_p95, compose_max) = self.compose_ms.summary();
        let stats = Stats { frames: self.compose_ms.count, compose_p50, compose_p95, compose_max, plans: self.motion.plans, direct: self.motion.direct };
        if reset {
            self.compose_ms.clear();
            self.motion.plans = 0;
            self.motion.direct = 0;
        }
        stats
    }

    fn emit(&mut self, event: ShellEvent) {
        self.shell.emit(event);
    }

    fn window_id(window: &Window) -> Option<u32> {
        window.user_data().get::<NativeId>().map(|id| id.0)
    }

    fn managed(&self, id: u32) -> Option<acde_model::WindowId> {
        self.native_ids.get(&id).copied()
    }

    fn managed_of(&self, window: &Window) -> Option<acde_model::WindowId> {
        Self::window_id(window).and_then(|id| self.managed(id))
    }

    fn managed_window(&self, id: u32) -> Option<&acde_model::Window> {
        self.table.window(self.managed(id)?)
    }

    fn native_of(&self, managed: acde_model::WindowId) -> Option<u32> {
        self.native_ids.iter().find(|(_, m)| **m == managed).map(|(id, _)| *id)
    }

    fn next_window_id(&mut self) -> u32 {
        self.next_window += 1;
        self.next_window - 1
    }

    fn extra_id(surface: &WlSurface) -> Option<u32> {
        smithay::wayland::compositor::with_states(surface, |s| s.data_map.get::<Extra>().map(|e| e.0))
    }

    fn window(&self, id: u32) -> Option<Window> {
        self.space.elements().find(|w| Self::window_id(w) == Some(id)).cloned()
    }

    pub fn window_of(&self, surface: &WlSurface) -> Option<Window> {
        use smithay::wayland::seat::WaylandFocus;
        self.space.elements().find(|w| w.wl_surface().as_deref() == Some(surface)).cloned()
    }

    pub(crate) fn native_enter(&mut self, window: &Window, id: u32, mode: acde_model::Mode) {
        if self.native_ids.contains_key(&id) {
            self.native_sync(window, id);
            return;
        }
        let Some(canvas) = self.canvas else { return };
        if let Ok(managed) = self.table.create(canvas, mode, table_rect(window.geometry())) {
            self.native_ids.insert(id, managed);
            self.sync_window_parent(window);
        }
    }

    pub(crate) fn native_sync(&mut self, window: &Window, id: u32) {
        let geo = window.geometry();
        let loc = self.space.element_location(window).unwrap_or(geo.loc);
        self.native_place(id, Rectangle::new(loc, geo.size));
    }

    pub(crate) fn native_place(&mut self, id: u32, rect: Rectangle<i32, Logical>) {
        let Some(managed) = self.managed(id) else { return };
        let _ = self.table.set_rect(managed, table_rect(rect));
    }

    pub(crate) fn extra_enter(&mut self, surface: &WlSurface, rect: Rectangle<i32, Logical>, parent: Option<u32>) {
        let Some(canvas) = self.canvas else { return };
        let parent = parent.and_then(|p| self.managed(p));
        let Ok(managed) = self.table.create_child(canvas, acde_model::Mode::Pinned, table_rect(rect), parent) else { return };
        let id = self.next_window_id();
        self.extras.insert(id, managed);
        smithay::wayland::compositor::with_states(surface, |s| {
            s.data_map.insert_if_missing_threadsafe(|| Extra(id));
        });
    }

    pub(crate) fn extra_place(&mut self, surface: &WlSurface, rect: Rectangle<i32, Logical>) {
        let Some(&managed) = Self::extra_id(surface).and_then(|id| self.extras.get(&id)) else { return };
        let _ = self.table.set_rect(managed, table_rect(rect));
    }

    pub(crate) fn extra_leave(&mut self, surface: &WlSurface) {
        if let Some(managed) = Self::extra_id(surface).and_then(|id| self.extras.remove(&id)) {
            self.motion.forget(managed);
            self.table.remove(managed);
        }
    }

    pub(crate) fn native_leave(&mut self, id: u32) {
        self.shortcuts.forget(id);
        if let Some(window) = self.native_ids.remove(&id) {
            self.motion.forget(window);
            self.table.remove(window);
        }
        if self.desktop == Some(id) {
            self.desktop = None;
        }
    }

    pub(crate) fn native_focus(&mut self, window: Option<&Window>) {
        let Some(canvas) = self.canvas else { return };
        let id = window.and_then(Self::window_id);
        let managed = id.and_then(|id| self.managed(id));
        let _ = self.table.focus(canvas, managed);
        if let Some(managed) = managed.filter(|_| id != self.desktop) {
            let _ = self.table.front(managed);
        }
    }

    fn place_managed(&mut self, id: u32, x: i32, y: i32, width: i32, height: i32) {
        let Some(window) = self.window(id) else { return };
        let Some(mode) = self.managed_window(id).map(|w| w.mode) else { return };
        let size = match mode {
            acde_model::Mode::Free | acde_model::Mode::Pinned => (width.max(1), height.max(1)).into(),
            acde_model::Mode::Fixed => window.geometry().size,
            acde_model::Mode::Fullscreen => return,
        };
        self.place(&window, Rectangle::new((x, y).into(), size));
    }

    fn hide(&mut self, id: u32, hidden: bool) {
        let Some(window) = self.window(id) else { return };
        match hidden {
            true if self.hidden.insert(id) => {
                let focused = self.canvas.and_then(|c| self.table.canvas(c)?.focus) == self.managed(id);
                if focused {
                    let next = self.stack().into_iter().next();
                    self.focus_window(next.as_ref());
                }
            }
            false if self.hidden.remove(&id) => {
                let pinned = self.managed_window(id).is_some_and(|w| w.mode == acde_model::Mode::Pinned);
                if !pinned {
                    self.focus_window(Some(&window));
                }
            }
            _ => return,
        }
        self.backend.damaged();
    }

    fn raise_managed(&mut self, id: u32, above: Option<u32>) {
        let Some(window) = self.managed(id) else { return };
        let above = above.and_then(|a| self.managed(a));
        let _ = self.table.raise(window, above);
        self.backend.damaged();
    }

    pub(crate) fn set_mode_managed(&mut self, id: u32, mode: acde_model::Mode) {
        let (Some(managed), Some(window)) = (self.managed(id), self.window(id)) else { return };
        let was = self.table.window(managed).map(|w| w.mode);
        let full = acde_model::Mode::Fullscreen;
        if mode == full && was != Some(full) && let Some(old) = self.space.element_geometry(&window) {
            window.user_data().get_or_insert(|| handlers::Restore(std::cell::Cell::new(None))).0.set(Some(old));
        }
        if self.table.set_mode(managed, mode).is_err() {
            return;
        }
        if (was == Some(full)) != (mode == full) && Some(id) != self.desktop {
            self.emit(ShellEvent::WindowFullscreen { window: id, fullscreen: mode == full });
        }
        if let Some(toplevel) = window.toplevel() {
            use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel::State;
            toplevel.with_pending_state(|state| match mode {
                acde_model::Mode::Fullscreen => state.states.set(State::Fullscreen),
                _ => state.states.unset(State::Fullscreen),
            });
        }
        let restore = (was == Some(full) && mode != full).then(|| window.user_data().get::<handlers::Restore>().and_then(|r| r.0.take())).flatten();
        let Some(rect) = self.table.window(managed).map(|w| space_rect(w.rect)) else { return };
        self.place(&window, restore.unwrap_or(rect));
        if let Some(surface) = window.toplevel().map(|t| t.wl_surface().clone())
            && let Some(resource) = Self::acde_resource(&surface)
        {
            resource.mode(mode.into());
        }
        self.backend.damaged();
    }

    fn manage_list(&self) -> (Vec<WindowInfo>, Vec<CanvasInfo>) {
        let mut windows = Vec::new();
        if let Some(canvas) = self.canvas {
            for (&id, &managed) in self.native_ids.iter().chain(&self.extras) {
                let Some(w) = self.table.window(managed) else { continue };
                let z = self.table.canvas(canvas).and_then(|c| c.z.iter().position(|&x| x == managed)).map_or(-1, |p| p as i32);
                let focus = self.table.canvas(canvas).and_then(|c| c.focus) == Some(managed);
                let surface = self.window(id).and_then(|w| w.toplevel().map(|t| t.wl_surface().clone()));
                let window = surface.as_ref().and_then(Self::bound).map(|g| g.id);
                let pid = surface.and_then(|s| smithay::reexports::wayland_server::Resource::client(&s)).and_then(|c| c.get_credentials(&self.display).ok()).and_then(|c| u32::try_from(c.pid).ok());
                windows.push(WindowInfo {
                    id,
                    window,
                    canvas: 0,
                    mode: w.mode,
                    x: w.rect.x as i32,
                    y: w.rect.y as i32,
                    width: w.rect.w as u32,
                    height: w.rect.h as u32,
                    z,
                    focus,
                    hidden: self.hidden.contains(&id),
                    pid,
                });
            }
        }
        let canvases = self
            .table
            .canvases()
            .map(|c| CanvasInfo { id: 0, x: c.rect.x as i32, y: c.rect.y as i32, width: c.rect.w as u32, height: c.rect.h as u32, scale: c.scale })
            .collect();
        (windows, canvases)
    }

    fn on_command(&mut self, command: Command) {
        match command {
            Command::Place { window, x, y, width, height } => self.place_managed(window, x, y, width, height),
            Command::Raise { window, above } => self.raise_managed(window, above),
            Command::SetMode { window, mode } => self.set_mode_managed(window, mode),
            Command::List(reply) => {
                let _ = reply.send(self.manage_list());
            }
            Command::Focus(id) => {
                if let Some(window) = self.window(id) {
                    self.focus_window(Some(&window));
                }
            }
            Command::Hide { window, hidden } => self.hide(window, hidden),
            Command::Close(id) => {
                let Some(window) = self.window(id) else { return };
                if let Some(toplevel) = window.toplevel() {
                    toplevel.send_close();
                }
            }
            Command::Grant(token, grant) => {
                self.grants.insert(token, grant);
            }
            Command::Release(id) => self.grants.retain(|_, g| g.id != id),
            Command::Stats(reset, reply) => {
                let _ = reply.send(self.stats(reset));
            }
            Command::Screenshot(path, reply) => self.screenshot(path, reply),
            Command::Inject(event) => self.inject(event),
            Command::Animate(window, spec) => self.animate(window, spec),
            Command::Shortcut { combo, scope, owner, reply } => {
                let _ = reply.send(self.register_shortcut(&combo, scope, owner));
            }
            Command::Unshortcut { combo, scope, owner } => self.unregister_shortcut(&combo, scope, owner),
            Command::SetScale { output, scale, reply } => {
                let _ = reply.send(self.set_output_scale(&output, scale));
            }
            Command::Connect(stream) => {
                if let Err(e) = self.insert_shell_client(stream) {
                    log::warn!("{e}");
                }
            }
            Command::Quit => {
                self.clear_session_env();
                self.signal.stop();
            }
        }
    }

    fn on_channel(&mut self, event: channel::Event<Command>) {
        match event {
            channel::Event::Msg(command) => self.on_command(command),
            channel::Event::Closed => self.signal.stop(),
        }
    }
}

impl Compositor {
    pub fn place(&mut self, window: &Window, rect: Rectangle<i32, Logical>) {
        use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel::State;
        let tiled = [State::TiledLeft, State::TiledRight, State::TiledTop, State::TiledBottom];
        let placed = self.space.element_location(window) == Some(rect.loc)
            && window.toplevel().is_none_or(|t| {
                t.with_pending_state(|state| state.size == Some(rect.size) && (state.states.contains(State::Fullscreen) || tiled.iter().all(|s| state.states.contains(*s))))
            });
        if placed {
            if let Some(id) = Self::window_id(window) {
                self.native_place(id, rect);
            }
            return;
        }
        if let Some(toplevel) = window.toplevel() {
            toplevel.with_pending_state(|state| {
                state.size = Some(rect.size);
                if !state.states.contains(State::Fullscreen) {
                    for s in tiled {
                        state.states.set(s);
                    }
                }
            });
            toplevel.send_pending_configure();
        }
        let resized = window.toplevel().is_some() && window.geometry().size != rect.size;
        match self.deferred.iter_mut().find(|(w, _, _)| w == window) {
            Some((_, wanted, _)) if resized => wanted.push(rect),
            None if resized && self.space.element_location(window).is_some() => self.deferred.push((window.clone(), vec![rect], Instant::now())),
            _ => {
                self.deferred.retain(|(w, _, _)| w != window);
                self.relocate(window, rect.loc);
            }
        }
        if let Some(id) = Self::window_id(window) {
            self.native_place(id, rect);
        }
        self.backend.damaged();
    }

    pub(crate) fn settle(&mut self, window: &Window) {
        let Some(at) = self.deferred.iter().position(|(w, _, _)| w == window) else { return };
        let size = window.geometry().size;
        let wanted = &mut self.deferred[at].1;
        let Some(hit) = wanted.iter().rposition(|r| (size.w - r.size.w).abs() <= 1 && (size.h - r.size.h).abs() <= 1) else { return };
        let loc = wanted[hit].loc;
        wanted.drain(..=hit);
        if wanted.is_empty() {
            self.deferred.swap_remove(at);
        } else {
            self.deferred[at].2 = Instant::now();
        }
        self.relocate(window, loc);
    }

    pub(crate) fn settle_overdue(&mut self) {
        let overdue: Vec<(Window, Rectangle<i32, Logical>)> =
            self.deferred.iter().filter(|(_, _, at)| at.elapsed() > DEFERRED_MOVE).filter_map(|(w, r, _)| Some((w.clone(), *r.last()?))).collect();
        if overdue.is_empty() {
            return;
        }
        self.deferred.retain(|(_, _, at)| at.elapsed() <= DEFERRED_MOVE);
        for (window, rect) in overdue {
            if self.space.element_location(&window).is_none() {
                continue;
            }
            self.relocate(&window, rect.loc);
            if let Some(id) = Self::window_id(&window) {
                self.native_sync(&window, id);
            }
        }
        self.backend.damaged();
    }

    fn relocate(&mut self, window: &Window, loc: smithay::utils::Point<i32, Logical>) {
        let above: Vec<Window> = self.space.elements().skip_while(|w| *w != window).skip(1).cloned().collect();
        self.space.map_element(window.clone(), loc, false);
        for w in &above {
            self.space.raise_element(w, false);
        }
    }

    pub fn export_session_env(&self, vars: &[(&str, &str)]) {
        if !matches!(self.backend.target, backend::Target::Drm(_)) {
            return;
        }
        let mut command = std::process::Command::new("dbus-update-activation-environment");
        command.arg("--systemd").args(vars.iter().map(|(k, v)| format!("{k}={v}")));
        Self::run_and_wait(command);
    }

    fn clear_session_env(&self) {
        if !matches!(self.backend.target, backend::Target::Drm(_)) {
            return;
        }
        let mut unset = std::process::Command::new("systemctl");
        unset.args(["--user", "unset-environment", "WAYLAND_DISPLAY", "DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP"]);
        Self::run_and_wait(unset);
        let mut stop = std::process::Command::new("systemctl");
        stop.args(["--user", "stop", "xdg-desktop-portal.service", "xdg-desktop-portal-gtk.service"]);
        Self::run_and_wait(stop);
    }

    fn run_and_wait(mut command: std::process::Command) {
        let name = command.get_program().to_string_lossy().into_owned();
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => return log::warn!("{name}: {e}"),
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if !status.success() => return log::warn!("{name}: {status}"),
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                Ok(None) => {
                    log::warn!("{name} 3 秒没做完, 不等了");
                    std::thread::spawn(move || child.wait());
                    return;
                }
                Err(e) => return log::warn!("{name}: {e}"),
            }
        }
    }

    pub fn idle_vblank(&mut self) {
        let frame = self.frame_duration();
        self.after(|s| &mut s.frame_tick, frame, |state| {
            if !state.backend.presenting {
                state.on_vblank(None);
            }
        });
    }

    pub fn milestone(&mut self, name: &'static str) {
        if self.milestones.insert(name) {
            let ms = self.start.elapsed().as_secs_f64() * 1000.0;
            log::info!("启动: {name} ms={:.0}", acde_log::now_ms());
            self.emit(ShellEvent::Milestone { title: name, ms });
        }
    }

    pub fn scale(&self) -> f64 {
        self.backend.output.current_scale().fractional_scale()
    }

    fn init_canvas(&mut self) {
        let Some(mode) = self.backend.output.current_mode() else { return };
        let scale = self.scale();
        let rect = acde_model::Rect::new(0.0, 0.0, f64::from(mode.size.w) / scale, f64::from(mode.size.h) / scale);
        self.canvas = Some(self.table.add_canvas(rect, scale));
    }

    pub fn output_event(&self) -> Option<ShellEvent> {
        let output = &self.backend.output;
        let mode = output.current_mode()?;
        let props = output.physical_properties();
        let description = [props.make.as_str(), props.model.as_str()].iter().filter(|s| !s.is_empty() && **s != "acde").copied().collect::<Vec<_>>().join(" ");
        Some(ShellEvent::Output { width: mode.size.w, height: mode.size.h, scale: self.scale(), name: output.name(), description, refresh: mode.refresh })
    }

    pub fn emit_output(&mut self) {
        if let Some(event) = self.output_event() {
            self.emit(event);
        }
    }

    fn set_output_scale(&mut self, name: &str, scale: i32) -> Result<(), String> {
        if !(1..=3).contains(&scale) {
            return Err(format!("缩放只能是 1、2、3, 不是 {scale}"));
        }
        let output = if name.is_empty() { Some(self.backend.output.clone()) } else { self.space.outputs().find(|o| o.name() == name).cloned() };
        let output = output.ok_or_else(|| format!("没有输出 {name}"))?;
        if output.current_scale().fractional_scale() != f64::from(scale) {
            output.change_current_state(None, None, Some(smithay::output::Scale::Integer(scale)), None);
            self.layout_outputs();
            if output == self.backend.output {
                self.rebuild_canvas();
            }
            self.prefer_scale(f64::from(scale));
            log::info!("输出 {}: 缩放改成 {scale}", output.name());
            self.backend.damaged();
            self.emit_output();
        }
        if let Err(e) = outputs::save_scale(&output, scale) {
            log::warn!("记不下输出 {} 的缩放: {e}", output.name());
        }
        Ok(())
    }

    fn layout_outputs(&mut self) {
        let mut all: Vec<smithay::output::Output> = self.space.outputs().cloned().collect();
        all.sort_by_key(|o| o.current_location().x);
        let mut x = 0;
        for output in all {
            let loc = (x, output.current_location().y).into();
            output.change_current_state(None, None, None, Some(loc));
            self.space.map_output(&output, loc);
            let width = output.current_mode().map_or(0, |m| m.size.w);
            x += (f64::from(width) / output.current_scale().fractional_scale()).ceil() as i32;
        }
    }

    fn prefer_scale(&self, scale: f64) {
        use smithay::wayland::fractional_scale::with_fractional_scale;
        for window in self.space.elements() {
            window.with_surfaces(|_, states| with_fractional_scale(states, |f| f.set_preferred_scale(scale)));
        }
    }

    fn rebuild_canvas(&mut self) {
        let Some(old) = self.canvas else { return self.init_canvas() };
        let Some(mode) = self.backend.output.current_mode() else { return };
        let scale = self.scale();
        let rect = acde_model::Rect::new(0.0, 0.0, f64::from(mode.size.w) / scale, f64::from(mode.size.h) / scale);
        let Ok(canvas) = self.table.replace_canvas(old, rect, scale) else { return };
        self.canvas = Some(canvas);
        let ids: Vec<(u32, acde_model::WindowId)> = self.native_ids.iter().map(|(&id, &managed)| (id, managed)).collect();
        for (id, managed) in ids {
            let (Some(window), Some(w)) = (self.window(id), self.table.window(managed)) else { continue };
            let (mode, r) = (w.mode, w.rect);
            let fit = match mode {
                acde_model::Mode::Fullscreen => rect,
                acde_model::Mode::Pinned => continue,
                acde_model::Mode::Fixed => acde_model::Rect::new(r.x.clamp(0.0, (rect.w - r.w).max(0.0)), r.y.clamp(0.0, (rect.h - r.h).max(0.0)), r.w, r.h),
                acde_model::Mode::Free => {
                    let (w, h) = (r.w.min(rect.w), r.h.min(rect.h));
                    acde_model::Rect::new(r.x.clamp(0.0, rect.w - w), r.y.clamp(0.0, rect.h - h), w, h)
                }
            };
            self.place(&window, space_rect(fit));
        }
    }
}

fn integer_scale(output: &smithay::output::Output) -> Option<i32> {
    let mode = output.current_mode()?;
    let mm = output.physical_properties().size.w;
    (mm > 0).then(|| (f64::from(mode.size.w) * 25.4 / f64::from(mm) / 96.0 + 0.3).floor().clamp(1.0, 3.0) as i32).filter(|s| *s > 1)
}
