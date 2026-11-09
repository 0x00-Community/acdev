use std::collections::HashMap;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use acde_model::{Event, Inbox, Pacer, Waker};
use acde_paint::{Drawn, Painter, Sheet};
use acde_render::{DragImage, SurfaceCommand};
use smithay::backend::allocator::Buffer as _;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::reexports::calloop::channel::{self, Channel};
use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::ping::make_ping;
use smithay::reexports::calloop::{EventLoop, Interest, LoopHandle, LoopSignal, Mode as LoopMode, PostAction};
use smithay::utils::DeviceFd;
use smithay_client_toolkit::compositor::CompositorState;
use smithay_client_toolkit::data_device_manager::DataDeviceManagerState;
use smithay_client_toolkit::data_device_manager::data_device::DataDevice;
use smithay_client_toolkit::data_device_manager::data_source::{CopyPasteSource, DragSource};
use smithay_client_toolkit::dmabuf::DmabufState;
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::registry::RegistryState;
use smithay_client_toolkit::seat::SeatState;
use smithay_client_toolkit::seat::pointer::cursor_shape::CursorShapeManager;
use smithay_client_toolkit::shell::WaylandSurface;
use smithay_client_toolkit::shell::xdg::XdgShell;
use smithay_client_toolkit::shell::xdg::window::{Window, WindowDecorations};
use smithay_client_toolkit::shm::Shm;
use smithay_client_toolkit::subcompositor::SubcompositorState;
use wayland_client::globals::registry_queue_init;
use wayland_client::protocol::{wl_buffer, wl_data_device_manager::DndAction, wl_keyboard, wl_pointer, wl_surface};
use wayland_client::{Connection, Proxy, QueueHandle};
use wayland_protocols::wp::fractional_scale::v1::client::{wp_fractional_scale_manager_v1, wp_fractional_scale_v1};
use wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_buffer_params_v1;
use wayland_protocols::wp::viewporter::client::{wp_viewport, wp_viewporter};

use crate::decoration::{self, DecorationView};
use crate::panel::PanelView;
use crate::protocol::{acde_window, acde_window_manager};

const PANEL_WAIT: Duration = Duration::from_millis(200);
const REFRESH_SLACK: f64 = 0.9;
pub(crate) const TEXT: [&str; 3] = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"];

pub struct Surface {
    window: u32,
    frame: u32,
    events: Arc<Inbox>,
    commands: channel::Sender<Option<SurfaceCommand>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Surface {
    pub fn claim(token: u64, render: acde_render::RenderHandle, frame: u32, app: Option<String>) -> Result<Self, String> {
        let events = Arc::new(Inbox::default());
        let (commands, rx) = channel::channel();
        let (ready, ready_rx) = mpsc::sync_channel(1);
        let inbox = events.clone();
        let thread = std::thread::Builder::new()
            .name("acde-window".into())
            .spawn(move || {
                if let Err(e) = App::run(token, render, frame, app, inbox.clone(), rx, ready.clone()) {
                    log::error!("window: {e}");
                    let _ = ready.send(Err(e));
                }
                inbox.push(Event::named("exit"));
            })
            .map_err(|e| format!("window thread: {e}"))?;
        let window = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "window: the compositor did not confirm this window".to_string())??;
        Ok(Self { window, frame, events, commands, thread: Some(thread) })
    }

    pub fn window(&self) -> u32 {
        self.window
    }

    pub fn content_offset(&self) -> (f64, f64) {
        (0.0, f64::from(self.frame))
    }

    pub fn pump(&self) -> Vec<Event> {
        self.events.drain()
    }

    pub fn has_events(&self) -> bool {
        !self.events.is_empty()
    }

    pub fn set_waker(&self, waker: Option<Waker>) {
        self.events.set_waker(waker);
    }

    pub fn send(&self, command: SurfaceCommand) {
        let _ = self.commands.send(Some(command));
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        self.events.set_waker(None);
        let _ = self.commands.send(None);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(crate) struct Data;

type PageSheets = (Vec<(usize, Sheet, (u32, u32))>, Option<acde_log::Trace>, Vec<(u32, Option<crate::panel::Backdrop>)>);

#[derive(Default)]
pub(crate) struct Buffers {
    list: Vec<wl_buffer::WlBuffer>,
    retired: Vec<wl_buffer::WlBuffer>,
    generation: u64,
}

impl Buffers {
    pub(crate) fn index_of(&self, buffer: &wl_buffer::WlBuffer, generation: u64) -> Option<usize> {
        self.list.iter().position(|b| b == buffer).filter(|_| self.generation == generation)
    }

    pub(crate) fn destroy_retired(&mut self) {
        for old in self.retired.drain(..) {
            old.destroy();
        }
    }

    pub(crate) fn destroy(self) {
        for buffer in self.list.into_iter().chain(self.retired) {
            buffer.destroy();
        }
    }
}

pub(crate) fn show(surface: &wl_surface::WlSurface, viewport: &wp_viewport::WpViewport, buffer: &wl_buffer::WlBuffer, drawn: &Drawn, scale: f64) {
    let (w, h) = drawn.size;
    surface.attach(Some(buffer), 0, 0);
    match &drawn.damage {
        Some(rects) => {
            for r in rects {
                surface.damage_buffer(r.loc.x, r.loc.y, r.size.w, r.size.h);
            }
        }
        None => surface.damage_buffer(0, 0, w as i32, h as i32),
    }
    viewport.set_source(0.0, 0.0, f64::from(w), f64::from(h));
    let (lw, lh) = (f64::from(w) / scale, f64::from(h) / scale);
    viewport.set_destination(lw.round().max(1.0) as i32, lh.round().max(1.0) as i32);
}

pub(crate) struct Drag {
    pub(crate) source: DragSource,
    pub(crate) data: HashMap<String, String>,
    pub(crate) dropped: bool,
    pub(crate) icon: Option<(wl_surface::WlSurface, wl_buffer::WlBuffer)>,
}

pub(crate) struct App {
    pub(crate) registry: RegistryState,
    pub(crate) seat_state: SeatState,
    pub(crate) shm: Shm,
    pub(crate) dmabuf: DmabufState,
    pub(crate) data_devices: Option<DataDeviceManagerState>,
    pub(crate) compositor: CompositorState,
    pub(crate) cursor_shapes: Option<CursorShapeManager>,
    pub(crate) window: Window,
    pub(crate) acde: acde_window::AcdeWindow,
    pub(crate) xdg: XdgShell,
    pub(crate) manager: acde_window_manager::AcdeWindowManager,
    pub(crate) viewporter: wp_viewporter::WpViewporter,
    pub(crate) panels: Vec<PanelView>,
    pub(crate) decoration: Option<DecorationView>,
    pub(crate) page_hints: Vec<([i32; 4], u32)>,
    pub(crate) told_active: bool,
    pub(crate) viewport: wp_viewport::WpViewport,
    pub(crate) _fractional: Option<wp_fractional_scale_v1::WpFractionalScaleV1>,
    pub(crate) render: acde_render::RenderHandle,
    pub(crate) painter: Painter,
    pub(crate) buffers: Buffers,
    pub(crate) events: Arc<Inbox>,
    pub(crate) ready: Option<mpsc::SyncSender<Result<u32, String>>>,
    pub(crate) handle: LoopHandle<'static, App>,
    pub(crate) signal: LoopSignal,
    pub(crate) logical: (u32, u32),
    pub(crate) scale: f64,
    pub(crate) configured: bool,
    pub(crate) active: bool,
    pub(crate) dirty: bool,
    pub(crate) pacer: Pacer,
    pub(crate) frame_pending: bool,
    pub(crate) pointer: Option<wl_pointer::WlPointer>,
    pub(crate) keyboard: Option<wl_keyboard::WlKeyboard>,
    pub(crate) device: Option<DataDevice>,
    pub(crate) serial: u32,
    pub(crate) pointer_serial: u32,
    pub(crate) left: bool,
    pub(crate) clipboard: Option<(CopyPasteSource, String)>,
    /// the app that owns this window (None: the desktop); a file dropped here is a one-shot copyIn grant for it
    pub(crate) app: Option<String>,
    pub(crate) drag: Option<Drag>,
    pub(crate) over: Option<(f64, f64)>,
    pub(crate) presenting: Vec<acde_log::Trace>,
    pub(crate) fenced: std::collections::VecDeque<(u64, bool, acde_paint::Finished)>,
    pub(crate) unshown: Option<acde_render::Frame>,
    pub(crate) unshown_since: Option<std::time::Instant>,
    pub(crate) fences: u64,
    pub(crate) tick_timer: Option<smithay::reexports::calloop::RegistrationToken>,
    pub(crate) outputs: smithay_client_toolkit::output::OutputState,
    pub(crate) shape: Option<wayland_protocols::wp::cursor_shape::v1::client::wp_cursor_shape_device_v1::WpCursorShapeDeviceV1>,
    pub(crate) fractional_scale: bool,
    pub(crate) window_id: u32,
    pub(crate) qh: QueueHandle<App>,
    pub(crate) conn: Connection,
}

impl App {
    fn run(
        token: u64,
        render: acde_render::RenderHandle,
        frame: u32,
        app: Option<String>,
        events: Arc<Inbox>,
        commands: Channel<Option<SurfaceCommand>>,
        ready: mpsc::SyncSender<Result<u32, String>>,
    ) -> Result<(), String> {
        let conn = Connection::connect_to_env().map_err(|e| format!("connect to the compositor: {e}"))?;
        let (globals, queue) = registry_queue_init::<App>(&conn).map_err(|e| format!("registry: {e}"))?;
        let qh = queue.handle();
        let mut lp: EventLoop<'static, App> = EventLoop::try_new().map_err(|e| e.to_string())?;
        let handle = lp.handle();
        WaylandSource::new(conn.clone(), queue).insert(handle.clone()).map_err(|e| e.to_string())?;
        let compositor = CompositorState::bind(&globals, &qh).map_err(|e| format!("wl_compositor: {e}"))?;
        let xdg = XdgShell::bind(&globals, &qh).map_err(|e| format!("xdg_wm_base: {e}"))?;
        let shm = Shm::bind(&globals, &qh).map_err(|e| format!("wl_shm: {e}"))?;
        let manager: acde_window_manager::AcdeWindowManager = globals.bind(&qh, 1..=1, Data).map_err(|e| format!("acde_window_manager: {e}"))?;
        let viewporter: wp_viewporter::WpViewporter = globals.bind(&qh, 1..=1, Data).map_err(|e| format!("wp_viewporter: {e}"))?;
        let fractional: Option<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1> = globals.bind(&qh, 1..=1, Data).ok();
        let surface = compositor.create_surface(&qh);
        let window = xdg.create_window(surface, WindowDecorations::RequestClient, &qh);
        window.set_app_id("acde");
        let acde = manager.get_window(window.wl_surface(), &qh, Data);
        acde.bind((token >> 32) as u32, token as u32);
        let viewport = viewporter.get_viewport(window.wl_surface(), &qh, Data);
        let fractional = fractional.map(|f| f.get_fractional_scale(window.wl_surface(), &qh, Data));
        let decoration = match frame {
            0 => None,
            height => {
                let subcompositor =
                    SubcompositorState::bind(compositor.wl_compositor().clone(), &globals, &qh).map_err(|e| format!("wl_subcompositor: {e}"))?;
                Some(DecorationView::new(window.wl_surface(), &subcompositor, &viewporter, height, &qh))
            }
        };
        window.commit();

        let (render_ping, render_source) = make_ping().map_err(|e| e.to_string())?;
        render.set_waker(Box::new(move || render_ping.ping()));
        handle.insert_source(render_source, |_, _, app| app.on_render()).map_err(|e| e.to_string())?;
        let (paint_ping, paint_source) = make_ping().map_err(|e| e.to_string())?;
        handle.insert_source(paint_source, |_, _, app| app.on_painted()).map_err(|e| e.to_string())?;
        handle
            .insert_source(commands, |event, _, app| {
                if let channel::Event::Msg(command) = event {
                    app.on_command(command);
                }
            })
            .map_err(|e| e.to_string())?;
        let painter = Painter::new(Self::gbm()?, paint_ping)?;

        let mut app = App {
            registry: RegistryState::new(&globals),
            seat_state: SeatState::new(&globals, &qh),
            shm,
            dmabuf: DmabufState::new(&globals, &qh),
            data_devices: DataDeviceManagerState::bind(&globals, &qh).ok(),
            compositor,
            cursor_shapes: CursorShapeManager::bind(&globals, &qh).ok(),
            window,
            acde,
            xdg,
            manager,
            viewporter,
            panels: Vec::new(),
            decoration,
            page_hints: Vec::new(),
            told_active: false,
            viewport,
            _fractional: fractional,
            render,
            painter,
            buffers: Buffers::default(),
            events,
            ready: Some(ready),
            handle,
            signal: lp.get_signal(),
            logical: (0, 0),
            scale: 1.0,
            configured: false,
            active: false,
            dirty: false,
            pacer: Pacer::new(None),
            frame_pending: false,
            pointer: None,
            keyboard: None,
            device: None,
            serial: 0,
            pointer_serial: 0,
            left: false,
            clipboard: None,
            app,
            drag: None,
            over: None,
            presenting: Vec::new(),
            fenced: std::collections::VecDeque::new(),
            unshown: None,
            unshown_since: None,
            fences: 0,
            tick_timer: None,
            outputs: smithay_client_toolkit::output::OutputState::new(&globals, &qh),
            shape: None,
            fractional_scale: false,
            window_id: 0,
            qh: qh.clone(),
            conn: conn.clone(),
        };
        lp.run(None, &mut app, |app| {
            app.activity();
            app.settle_pointer();
        })
        .map_err(|e| e.to_string())
    }

    fn gbm() -> Result<smithay::reexports::gbm::Device<DeviceFd>, String> {
        if let Ok(path) = std::env::var("ACDE_RENDER_NODE") {
            return Self::gbm_at(&path);
        }
        let mut nodes: Vec<String> = std::fs::read_dir("/dev/dri")
            .map(|dir| dir.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.starts_with("renderD") || n.starts_with("card")).collect())
            .unwrap_or_default();
        nodes.sort_by_key(|n| (!n.starts_with("renderD"), n.len(), n.clone()));
        let mut failed = Vec::new();
        for node in nodes {
            let path = format!("/dev/dri/{node}");
            match Self::gbm_at(&path).and_then(|device| Self::allocates(&device).map(|()| device).map_err(|e| format!("{path} {e}"))) {
                Ok(device) => {
                    if !failed.is_empty() {
                        log::info!("web window allocates canvases on {path} ({})", failed.join("; "));
                    }
                    return Ok(device);
                }
                Err(e) => failed.push(e),
            }
        }
        Err(if failed.is_empty() { "no usable device in /dev/dri".into() } else { failed.join("; ") })
    }

    fn gbm_at(path: &str) -> Result<smithay::reexports::gbm::Device<DeviceFd>, String> {
        let file = std::fs::OpenOptions::new().read(true).write(true).open(path).map_err(|e| format!("open {path}: {e}"))?;
        smithay::reexports::gbm::Device::new(DeviceFd::from(OwnedFd::from(file))).map_err(|e| format!("GBM {path}: {e}"))
    }

    fn allocates(device: &smithay::reexports::gbm::Device<DeviceFd>) -> Result<(), String> {
        use smithay::backend::allocator::gbm::{GbmAllocator, GbmBufferFlags};
        use smithay::backend::allocator::{Allocator, Fourcc, Modifier};
        GbmAllocator::new(device.clone(), GbmBufferFlags::RENDERING)
            .create_buffer(64, 64, Fourcc::Abgr8888, &[Modifier::Linear])
            .map(drop)
            .map_err(|e| format!("GBM allocation: {e}"))
    }

    fn surface(&self) -> &wl_surface::WlSurface {
        self.window.wl_surface()
    }

    fn physical(&self) -> (u32, u32) {
        let (w, h) = self.content();
        ((f64::from(w) * self.scale).round() as u32, (f64::from(h) * self.scale).round() as u32)
    }

    pub(crate) fn tell_size(&mut self) {
        if !self.configured {
            return;
        }
        let size = self.physical();
        self.pacer.tell_size(&self.events, size, self.scale);
    }

    fn on_render(&mut self) {
        self.dirty = true;
        self.paint();
    }

    pub(crate) fn paint(&mut self) {
        if !self.configured || !self.painter.ready() {
            return;
        }
        let page = self.page_sheets();
        let decoration = self.decoration_sheet();
        let Some((mut sheets, trace, backdrops)) = page.or_else(|| decoration.is_some().then(|| (Vec::new(), None, Vec::new()))) else { return };
        sheets.extend(decoration);
        match self.painter.draw(sheets, trace) {
            Ok(Some(drawn)) => self.queue_backdrops(drawn, backdrops),
            Ok(None) => {}
            Err(e) => {
                self.redraw_decoration();
                log::warn!("web window: {e}");
            }
        }
        if self.pacer.animating {
            self.ask_frame();
        }
    }

    fn page_sheets(&mut self) -> Option<PageSheets> {
        if !self.dirty {
            return None;
        }
        let frame = match (self.render.frame(), self.unshown.take()) {
            (Some(mut frame), Some(old)) => {
                frame.absorb(old);
                frame
            }
            (Some(frame), None) | (None, Some(frame)) => frame,
            (None, None) => return None,
        };
        self.dirty = false;
        if frame.panels.iter().any(|p| self.panels.iter().any(|v| v.id == p.id && !v.configured)) {
            let first = self.unshown_since.is_none();
            let since = *self.unshown_since.get_or_insert_with(std::time::Instant::now);
            if since.elapsed() < PANEL_WAIT {
                self.unshown = Some(frame);
                if first {
                    let _ = self.handle.insert_source(smithay::reexports::calloop::timer::Timer::from_duration(PANEL_WAIT), |_, _, app| {
                        app.dirty = true;
                        app.paint();
                        smithay::reexports::calloop::timer::TimeoutAction::Drop
                    });
                }
                return None;
            }
        }
        self.unshown_since = None;
        if frame.commit == 0 {
            return None;
        }
        self.pacer.animating = frame.animating;
        self.escapes(&frame.panels);
        let backdrops = Self::backdrops(&frame.panels);
        let mut sheets = vec![(0, Sheet::from(frame.plane), frame.size)];
        sheets.extend(
            frame
                .panels
                .into_iter()
                .filter(|p| self.panels.iter().any(|v| v.id == p.id && v.configured))
                .map(|p| (PanelView::plane(p.id), Sheet::from(p.plane), p.size)),
        );
        Some((sheets, frame.trace, backdrops))
    }

    pub(crate) fn note_refresh(&mut self) {
        let fastest = self
            .outputs
            .outputs()
            .filter_map(|o| self.outputs.info(&o))
            .flat_map(|i| i.modes)
            .filter(|m| m.current && m.refresh_rate > 0)
            .map(|m| m.refresh_rate)
            .max();
        self.pacer.set_refresh(fastest.map(|mhz| Duration::from_secs_f64(REFRESH_SLACK * 1000.0 / f64::from(mhz))));
    }

    pub(crate) fn pace(&mut self) {
        if self.tick_timer.is_some() || self.painter.busy() {
            return;
        }
        let Some(wait) = self.pacer.wait() else { return };
        if wait.is_zero() {
            if let Some(now) = self.pacer.tick(&self.events) {
                self.render.tick(now);
            }
            return;
        }
        let timer = smithay::reexports::calloop::timer::Timer::from_duration(wait);
        self.tick_timer = self
            .handle
            .insert_source(timer, |_, _, app| {
                app.tick_timer = None;
                app.pace();
                smithay::reexports::calloop::timer::TimeoutAction::Drop
            })
            .ok();
    }

    fn on_painted(&mut self) {
        self.tell_size();
        let Some(mut finished) = self.painter.finish() else {
            if self.painter.take_dropped() {
                self.redraw();
            }
            return;
        };
        self.fences += 1;
        let seq = self.fences;
        let fence = finished.fence.take();
        self.fenced.push_back((seq, fence.is_none(), finished));
        if let Some(fence) = fence {
            let source = Generic::new(fence, Interest::READ, LoopMode::OneShot);
            let inserted = self.handle.insert_source(source, move |_, _, app| {
                app.fence_signalled(seq);
                Ok(PostAction::Remove)
            });
            let Err(e) = inserted else { return };
            log::warn!("web window fence: {}", e.error);
            let fence = e.inserted.unwrap();
            let mut fds = [rustix::event::PollFd::new(&fence, rustix::event::PollFlags::IN)];
            let _ = rustix::event::poll(&mut fds, Some(&rustix::event::Timespec { tv_sec: 1, tv_nsec: 0 }));
        }
        self.fence_signalled(seq);
    }

    fn fence_signalled(&mut self, seq: u64) {
        if let Some(slot) = self.fenced.iter_mut().find(|(s, _, _)| *s == seq) {
            slot.1 = true;
        }
        while self.fenced.front().is_some_and(|(_, ready, _)| *ready) {
            if let Some((_, _, f)) = self.fenced.pop_front() {
                self.present(f);
            }
        }
    }

    pub(crate) fn redraw(&mut self) {
        self.render.invalidate();
        self.redraw_decoration();
        self.dirty = true;
        self.paint();
    }

    fn present(&mut self, finished: acde_paint::Finished) {
        let acde_paint::Finished { drawn, took, trace, .. } = finished;
        let (mut main, mut framed) = (None, false);
        for d in drawn {
            match d.plane {
                0 => main = Some(d),
                decoration::PLANE => framed = self.present_decoration(d),
                _ => self.present_panel(d),
            }
        }
        match main {
            Some(d) => self.present_main(d, took, trace),
            None if framed => self.surface().commit(),
            None => {}
        }
        self.pace();
        self.paint();
    }

    fn present_main(&mut self, drawn: Drawn, took: Duration, trace: Option<acde_log::Trace>) {
        let Some(buffer) = self.current_buffer(&drawn) else { return };
        let surface = self.surface().clone();
        show(&surface, &self.viewport, &buffer, &drawn, self.scale);
        self.painter.hold(0, drawn.canvas, true);
        if !self.frame_pending && (self.pacer.animating || self.pacer.want_frame || trace.is_some()) {
            self.frame_pending = true;
            surface.frame(&self.qh, smithay_client_toolkit::compositor::FrameCallbackData(surface.clone()));
        }
        surface.commit();
        self.buffers.destroy_retired();
        log::debug!(target: "perf::raster", "surface owner={} ms={:.3}", self.window_id, took.as_secs_f64() * 1000.0);
        if let Some(trace) = trace {
            self.presenting.push(acde_log::Trace { rastered: acde_log::now_ms(), ..trace });
            self.ask_frame();
        }
    }

    fn buffers_mut(&mut self, plane: usize) -> Option<&mut Buffers> {
        match plane {
            0 => Some(&mut self.buffers),
            decoration::PLANE => self.decoration.as_mut().map(|d| &mut d.buffers),
            _ => self.panels.iter_mut().find(|p| PanelView::plane(p.id) == plane).map(|p| &mut p.buffers),
        }
    }

    pub(crate) fn current_buffer(&mut self, drawn: &Drawn) -> Option<wl_buffer::WlBuffer> {
        let generation = self.painter.generation(drawn.plane);
        if drawn.generation != generation {
            return None;
        }
        if self.buffers_mut(drawn.plane)?.generation != generation {
            let fresh = self.buffers_of(drawn.plane);
            let buffers = self.buffers_mut(drawn.plane)?;
            let old = std::mem::replace(&mut buffers.list, fresh);
            buffers.retired.extend(old);
            buffers.generation = generation;
        }
        let buffer = self.buffers_mut(drawn.plane)?.list.get(drawn.canvas).cloned();
        if buffer.is_none() {
            self.painter.discard(drawn);
            self.painter.take_dropped();
            self.redraw();
        }
        buffer
    }

    fn buffers_of(&self, plane: usize) -> Vec<wl_buffer::WlBuffer> {
        self.painter.canvases(plane).filter_map(|dmabuf| self.wl_buffer(dmabuf)).collect()
    }

    fn wl_buffer(&self, dmabuf: &Dmabuf) -> Option<wl_buffer::WlBuffer> {
        let params = self.dmabuf.create_params(&self.qh).ok()?;
        let modifier: u64 = dmabuf.format().modifier.into();
        for (i, (fd, (offset, stride))) in dmabuf.handles().zip(dmabuf.offsets().zip(dmabuf.strides())).enumerate() {
            params.add(fd, i as u32, offset, stride, modifier);
        }
        let (buffer, _) = params.create_immed(
            dmabuf.width() as i32,
            dmabuf.height() as i32,
            dmabuf.format().code as u32,
            zwp_linux_buffer_params_v1::Flags::empty(),
            &self.qh,
        );
        Some(buffer)
    }

    pub(crate) fn ask_frame(&mut self) {
        if self.frame_pending {
            return;
        }
        self.frame_pending = true;
        let surface = self.surface().clone();
        surface.frame(&self.qh, smithay_client_toolkit::compositor::FrameCallbackData(surface.clone()));
        surface.commit();
    }

    fn on_command(&mut self, command: Option<SurfaceCommand>) {
        use SurfaceCommand as C;
        match command {
            None => self.signal.stop(),
            Some(C::RequestFrame) => {
                self.pacer.want_frame = true;
                self.ask_frame();
            }
            Some(C::SetClipboard(text)) => self.set_clipboard(text),
            Some(C::ReadClipboard(reply)) => self.read_clipboard(reply),
            Some(C::StartDrag(data, icon)) => self.start_drag(data, icon),
            Some(C::Mode(mode)) => match acde_model::Mode::try_from(mode) {
                Ok(mode) => self.acde.request_mode(mode as u32),
                Err(_) => log::warn!("no window mode {mode}"),
            },
            Some(C::GrabHint(rect, edges)) => self.set_page_hint(rect, edges),
            Some(C::Backdrop(rect, [radius, blur, saturate, brightness])) => {
                let [x, y, w, h] = self.page_backdrop(rect);
                self.acde.set_backdrop(x, y, w, h, radius, blur, saturate, brightness);
            }
            Some(C::Activate) => self.acde.request_activate(),
            Some(C::Grab(kind, on)) => match (acde_window::GrabKind::try_from(kind), on) {
                (Ok(kind), true) => self.acde.request_grab(kind),
                (Ok(kind), false) => self.acde.release_grab(kind),
                (Err(()), _) => log::warn!("no grab kind {kind}"),
            },
            Some(C::OpenPanel { id, token, rect }) => self.open_panel(id, token, rect),
            Some(C::PlacePanel { id, rect, input }) => self.place_panel(id, rect, input),
            Some(C::ClosePanel(id)) => self.close_panel(id),
            Some(C::Title(title)) => self.set_title(title),
            Some(C::ImeArea(_)) => {}
        }
    }

    fn set_clipboard(&mut self, text: String) {
        let (Some(manager), Some(device)) = (self.data_devices.as_ref(), self.device.as_ref()) else { return };
        let source = manager.create_copy_paste_source(&self.qh, TEXT);
        source.set_selection(device, self.serial);
        self.clipboard = Some((source, text));
    }

    fn read_clipboard(&mut self, reply: Box<dyn FnOnce(String) + Send>) {
        if let Some((_, text)) = &self.clipboard {
            return reply(text.clone());
        }
        let Some(offer) = self.device.as_ref().and_then(|d| d.data().selection_offer()) else { return reply(String::new()) };
        let mime = offer.with_mime_types(|types| TEXT.iter().find(|t| types.iter().any(|m| m == *t)).map(|t| t.to_string()));
        let Some(pipe) = mime.and_then(|m| offer.receive(m).ok()) else { return reply(String::new()) };
        let _ = self.conn.flush();
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = std::fs::File::from(OwnedFd::from(pipe)).read_to_string(&mut text);
            reply(text);
        });
    }

    fn start_drag(&mut self, data: HashMap<String, String>, icon: Option<DragImage>) {
        if self.data_devices.is_none() || self.device.is_none() {
            return;
        }
        let icon = icon.and_then(|i| self.icon(i));
        let (Some(manager), Some(device)) = (self.data_devices.as_ref(), self.device.as_ref()) else { return };
        let source = manager.create_drag_and_drop_source(&self.qh, data.keys(), DndAction::Copy | DndAction::Move);
        source.start_drag(device, self.window.wl_surface(), icon.as_ref().map(|(s, _)| s), self.pointer_serial);
        if let Some((surface, _)) = &icon {
            surface.commit();
        }
        self.drag = Some(Drag { source, data, dropped: false, icon });
    }

    fn icon(&mut self, image: DragImage) -> Option<(wl_surface::WlSurface, wl_buffer::WlBuffer)> {
        let (w, h) = (i32::try_from(image.width).ok()?, i32::try_from(image.height).ok()?);
        if w == 0 || h == 0 {
            return None;
        }
        let dmabuf = self.painter.icon(image.scene, (image.width, image.height)).inspect_err(|e| log::warn!("drag icon: {e}")).ok()?;
        let buffer = self.wl_buffer(&dmabuf)?;
        let surface = self.compositor.create_surface(&self.qh);
        surface.attach(Some(&buffer), 0, 0);
        if surface.version() >= 5 {
            surface.offset(-image.hotspot.0, -image.hotspot.1);
        }
        surface.damage_buffer(0, 0, w, h);
        Some((surface, buffer))
    }
}
