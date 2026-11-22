use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use acde::model::{Combo, Event, Inbox, Injected, Mode, Rect, ScreenEdge, WindowState};
use acde::render::FrameButton;

use crate::keys;
use crate::output::compose::{self, Compositor};
use crate::output::gpu::Gpu;
use crate::output::surface::Msg;
use crate::platform::{self, Cmd, Handler, Host, HostEvent, Monitor, Proxy};
use crate::shell::menu::{self, Open};
use crate::shell::{Press, State};

const DESKTOP: [f64; 2] = [1440.0, 900.0];
const MIN_SIZE: (f64, f64) = (160.0, 100.0);

pub(crate) struct Server {
    proxy: OnceLock<Proxy>,
    compositor: OnceLock<Compositor>,
    state: Mutex<State>,
    pub broker: Arc<Inbox>,
    gpu: Mutex<Arc<Gpu>>,
}

static SERVER: OnceLock<Server> = OnceLock::new();

pub(crate) fn server() -> Option<&'static Server> {
    SERVER.get()
}

impl Server {
    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn send(&self, cmd: Cmd) {
        if let Some(proxy) = self.proxy.get() {
            proxy.send(cmd);
        }
    }

    pub fn gpu(&self) -> Arc<Gpu> {
        self.gpu.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_gpu(&self, gpu: Arc<Gpu>) {
        *self.gpu.lock().unwrap_or_else(|e| e.into_inner()) = gpu;
    }

    fn device_changed(&self, host: &dyn Host) {
        let gpu = self.gpu();
        if let Some(compositor) = self.compositor() {
            compositor.release();
        }
        let surface = match host.surface(&gpu.instance) {
            Ok(surface) => surface,
            Err(e) => return crate::output::gpu::give_up(&format!("the host window surface on the new GPU device: {e}")),
        };
        if let Some(compositor) = self.compositor() {
            compositor.device(gpu.clone(), surface);
        }
        let links: Vec<_> = self.state().entries.values().filter_map(|entry| entry.link.clone()).collect();
        for link in links {
            link.send(Msg::Device(gpu.clone()));
        }
    }

    pub fn compositor(&self) -> Option<&Compositor> {
        self.compositor.get()
    }

    pub fn relayout(&self) {
        if let Some(compositor) = self.compositor() {
            compositor.dirty();
        }
    }

    pub fn event(&self, id: u32, event: Event) {
        let inbox = self.state().inbox(id);
        if let Some(inbox) = inbox {
            inbox.push(event);
        }
    }

    pub fn activate(&self, id: u32) {
        let (id, previous) = {
            let mut state = self.state();
            let Some(id) = state.focus_target(id) else { return };
            let raise = state.entries.get(&id).is_some_and(|e| !e.desktop && !e.panel);
            if raise {
                state.raise(id);
            }
            let previous = state.focus.replace(id);
            if previous != Some(id) {
                if let Some(previous) = previous {
                    Self::look(&state, previous, false);
                }
                Self::look(&state, id, true);
            }
            (id, previous)
        };
        if previous != Some(id) {
            if let Some(previous) = previous {
                self.event(previous, Event::named("deactivate"));
            }
            self.event(id, Event::named("activate"));
            self.send(Cmd::FocusMoved);
        }
        self.broker.push(Event { kind: "windowactivate".into(), window: Some(id), ..Default::default() });
        self.relayout();
    }

    pub fn focus_top(&self) {
        let top = {
            let state = self.state();
            state.layers().iter().rev().map(|l| l.id).find(|id| state.entries.get(id).is_some_and(|e| !e.panel && e.mode != Mode::Pinned))
        };
        match top {
            Some(id) => self.activate(id),
            None => {
                let mut state = self.state();
                if let Some(previous) = state.focus.take() {
                    Self::look(&state, previous, false);
                }
                drop(state);
                self.send(Cmd::FocusMoved);
            }
        }
    }

    fn look(state: &State, id: u32, active: bool) {
        if let Some(link) = state.entries.get(&id).filter(|e| e.frame > 0.0).and_then(|e| e.link.as_ref()) {
            link.send(Msg::Active(active));
        }
    }

    pub fn set_theme(&self, theme: acde::render::FrameTheme) {
        let links: Vec<_> = {
            let mut state = self.state();
            state.theme = theme;
            state.entries.values().filter(|e| e.frame > 0.0).filter_map(|e| e.link.clone()).collect()
        };
        for link in links {
            link.send(Msg::Theme(theme));
        }
        self.relayout();
    }

    pub fn refill(&self) {
        let (changed, filled) = self.state().refill();
        let Some(work) = changed else { return };
        for id in filled {
            self.set_rect(id, work);
        }
        self.broker.push(Self::work_event(work));
    }

    fn work_event([x, y, w, h]: [f64; 4]) -> Event {
        Event { kind: "workarea".into(), x: Some(x), y: Some(y), width: Some(w), height: Some(h), ..Default::default() }
    }

    pub fn set_rect(&self, id: u32, rect: [f64; 4]) {
        let resized = {
            let mut state = self.state();
            let Some(entry) = state.entries.get_mut(&id) else { return };
            let before = entry.rect;
            entry.rect = rect;
            let changed = (before[2], before[3]) != (rect[2], rect[3]);
            let link = entry.link.clone().filter(|_| changed && !entry.panel);
            let size = state.entries.get(&id).map(|e| state.content(e));
            link.zip(size).map(|(link, size)| (link, size, state.screen[2]))
        };
        if let Some((link, (w, h), scale)) = resized {
            link.resized(w, h, scale);
        }
        self.relayout();
    }

    pub fn set_refresh(&self, hz: Option<f64>) {
        let Some(links) = self.state().set_refresh(hz) else { return };
        log_refresh(hz);
        for link in links {
            link.send(Msg::Refresh(hz));
        }
    }
}

type Main = Box<dyn FnOnce() -> i32 + Send>;

fn log_refresh(hz: Option<f64>) {
    log::info!("host window: monitor refresh {}", hz.map_or_else(|| "unknown".to_owned(), |hz| format!("{hz} Hz")));
}

struct Drag {
    window: u32,
    edges: u32,
    start: (f64, f64),
    rect: [f64; 4],
}

struct Lock {
    window: u32,
    at: [f64; 2],
    injected: (f64, f64),
}

struct DataDrag {
    source: u32,
    data: HashMap<String, String>,
    over: Option<u32>,
}

#[derive(Default)]
struct App {
    main: Option<Main>,
    pointer: (f64, f64),
    hover: Option<u32>,
    capture: Option<(u32, [f64; 2])>,
    pressed: HashSet<u32>,
    drag: Option<Drag>,
    data_drag: Option<DataDrag>,
    modifiers: u8,
    injected_mods: u8,
    swallowed: HashSet<u32>,
    devtools: crate::dev::DevtoolsKey,
    frame_press: Option<(u32, FrameButton)>,
    menu_press: Option<(u32, usize)>,
    edges: u8,
    focused: bool,
    lock: Option<Lock>,
    cursors: HashMap<u32, &'static str>,
    cursor: Option<&'static str>,
}

enum MenuHit {
    Label(usize),
    Row(usize),
    Outside,
}

pub(crate) fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    let gpu = match Gpu::open() {
        Ok(g) => Arc::new(g),
        Err(e) => {
            log::error!("web layer unavailable: {e}");
            return 1;
        }
    };
    acde::gpu::Gpu::publish(Some(gpu.shared.clone()));
    if let Err(e) = std::thread::Builder::new().name("acde-warm".into()).spawn(acde::render::gpu::warm) {
        log::warn!("offscreen warm-up thread: {e}");
    }
    let server = Server {
        proxy: OnceLock::new(),
        compositor: OnceLock::new(),
        state: Mutex::new(State::default()),
        broker: Arc::new(Inbox::default()),
        gpu: Mutex::new(gpu),
    };
    if SERVER.set(server).is_err() {
        log::error!("host window: already started");
        return 1;
    }
    let app = App { main: Some(Box::new(main)), devtools: crate::dev::DevtoolsKey::from_env(), ..App::default() };
    let code = match platform::run(Box::new(app)) {
        Ok(code) => code,
        Err(e) => {
            log::error!("host window: {e}");
            1
        }
    };
    if let Some(compositor) = SERVER.get().and_then(Server::compositor) {
        compositor.stop();
    }
    code
}

pub(crate) fn size_from_env() -> Option<[f64; 2]> {
    let text = std::env::var("ACDE_SIZE").ok()?;
    let (w, h) = text.split_once('x')?;
    Some([w.trim().parse().ok()?, h.trim().parse().ok()?])
}

impl Handler for App {
    fn size(&mut self, monitor: Option<&Monitor>) -> [f64; 2] {
        size_from_env().unwrap_or_else(|| monitor.map_or(DESKTOP, |m| [DESKTOP[0].min(m.size[0] * 0.9), DESKTOP[1].min(m.size[1] * 0.85)]))
    }

    fn started(&mut self, host: &dyn Host, proxy: Proxy, monitor: Option<Monitor>, size: (u32, u32), scale: f64) {
        let Some(main) = self.main.take() else { return };
        let server = server().expect("hostwin");
        {
            let mut state = server.state();
            state.screen = [(f64::from(size.0) / scale).round(), (f64::from(size.1) / scale).round(), scale];
            state.refresh = monitor.and_then(|m| m.refresh);
            state.controls = host.controls();
            log_refresh(state.refresh);
        }
        let surface = match host.surface(&server.gpu().instance) {
            Ok(surface) => surface,
            Err(e) => {
                log::error!("host window surface: {e}");
                return host.exit(1);
            }
        };
        match compose::start(server.gpu(), surface, size) {
            Ok((compositor, _)) => _ = server.compositor.set(compositor),
            Err(e) => {
                log::error!("{e}");
                return host.exit(1);
            }
        }
        let _ = server.proxy.set(proxy.clone());
        server.refill();
        server.broker.push(Event {
            kind: "output".into(),
            width: Some(f64::from(size.0)),
            height: Some(f64::from(size.1)),
            scale: Some(scale),
            ..Default::default()
        });
        crate::dev::listen(proxy.clone());
        let spawned = std::thread::Builder::new().name("acde".into()).stack_size(64 << 20).spawn(move || {
            let code = main();
            proxy.send(Cmd::Exit(code));
        });
        if let Err(e) = spawned {
            log::error!("Broker thread: {e}");
            host.exit(1);
        }
    }

    fn event(&mut self, host: &dyn Host, event: HostEvent) {
        let Some(server) = server() else { return };
        self.handle(server, host, event);
        self.show_cursor(server, host);
    }
}

impl App {
    fn show_cursor(&mut self, server: &Server, host: &dyn Host) {
        let cursor = match self.hover {
            Some(window) if self.drag.is_none() && Self::open_menu(server).is_none() => self.cursors.get(&window).copied().unwrap_or("default"),
            _ => "default",
        };
        if self.cursor.replace(cursor) != Some(cursor) {
            host.set_cursor(cursor);
        }
    }

    fn handle(&mut self, server: &Server, host: &dyn Host, event: HostEvent) {
        match event {
            HostEvent::Resized { size, scale } => self.resized(server, size, scale),
            HostEvent::CloseRequested => server.broker.push(Event { kind: "windowcloserequest".into(), window: Some(0), ..Default::default() }),
            HostEvent::Focused(focused) => {
                self.focused = focused;
                if !focused {
                    self.unlock(server, host, true);
                }
                let focus = server.state().focus;
                if let Some(id) = focus {
                    server.event(id, Event::named(if focused { "activate" } else { "deactivate" }));
                }
                if !focused {
                    if let Some((id, _)) = Self::open_menu(server) {
                        Self::set_menu(server, id, None);
                    }
                    self.menu_press = None;
                    self.modifiers = 0;
                    self.devtools.blur();
                }
            }
            HostEvent::PointerMove(..) if self.lock.is_some() => {}
            HostEvent::PointerMove(x, y) => self.moved(server, x, y),
            HostEvent::Motion(dx, dy) => self.locked_motion(server, dx, dy),
            HostEvent::PointerLeave if self.lock.is_some() => {}
            HostEvent::PointerLeave => {
                self.edges(server, 0);
                if self.capture.is_none()
                    && let Some(hover) = self.hover.take()
                {
                    Self::hover(server, hover, None);
                    server.event(hover, Event::named("pointerleave"));
                }
            }
            HostEvent::Button(keys::BUTTON_LEFT, true) if self.lock.is_none() && self.pressed.is_empty() && self.host_hint(server, host) => {}
            HostEvent::Button(button, pressed) => self.button(server, button, pressed),
            HostEvent::Wheel(dx, dy) => self.wheel(server, dx, dy),
            HostEvent::Modifiers(mods) => self.modifiers = mods,
            HostEvent::Key { evdev, pressed, text } => {
                if self.lock.is_some() && evdev == keys::ESC {
                    if pressed {
                        self.swallowed.insert(evdev);
                        self.unlock(server, host, true);
                        return;
                    }
                }
                self.key(server, evdev, pressed, text)
            }
            HostEvent::ImePreedit(text) => self.focused(server, Event { kind: "imepreedit".into(), key: Some(text), ..Default::default() }),
            HostEvent::ImeCommit(text) => self.focused(server, Event { kind: "imecommit".into(), key: Some(text), ..Default::default() }),
            HostEvent::Dropped(paths) => self.dropped(server, self.pointer, &paths),
            HostEvent::State(to) => Self::host_state(server, to),
            HostEvent::Output { size, scale, work: [x, y, w, h] } => {
                let (width, height) = (Some(f64::from(size.0)), Some(f64::from(size.1)));
                server.broker.push(Event { kind: "hostoutput".into(), width, height, scale: Some(scale), ..Default::default() });
                let area = Event { kind: "hostworkarea".into(), x: Some(x), y: Some(y), width: Some(w), height: Some(h), ..Default::default() };
                server.broker.push(area);
            }
            HostEvent::Refresh(hz) => server.set_refresh(hz),
            HostEvent::Cmd(Cmd::HostState(to)) => host.set_state(to),
            HostEvent::Cmd(Cmd::HostSize(size)) => {
                if let Some(now) = host.set_size(size) {
                    let scale = server.state().screen[2];
                    self.resized(server, now, scale);
                }
            }
            HostEvent::Redraw => server.relayout(),
            HostEvent::Cmd(Cmd::Title(title)) => host.set_title(&title),
            HostEvent::Cmd(Cmd::ImeArea(rect)) => host.set_ime_area(rect),
            HostEvent::Cmd(Cmd::Inject(Injected::Key { code: keys::ESC, pressed: true })) if self.lock.is_some() => {
                self.swallowed.insert(keys::ESC);
                self.unlock(server, host, true);
            }
            HostEvent::Cmd(Cmd::Inject(event)) => self.inject(server, event),
            HostEvent::Cmd(Cmd::PointerLock { window, on: true }) => self.lock(server, host, window),
            HostEvent::Cmd(Cmd::PointerLock { window, on: false }) => {
                if self.lock.as_ref().is_some_and(|lock| lock.window == window) {
                    self.unlock(server, host, false);
                }
            }
            HostEvent::Cmd(Cmd::Cursor { window, cursor }) => _ = self.cursors.insert(window, cursor),
            HostEvent::Cmd(Cmd::FocusMoved) => {
                let focus = server.state().focus;
                if self.lock.as_ref().is_some_and(|lock| focus != Some(lock.window)) {
                    self.unlock(server, host, true);
                }
            }
            HostEvent::Cmd(Cmd::StartDrag { window, data }) => self.start_data_drag(server, window, data),
            HostEvent::Cmd(Cmd::Drop { window, at, paths }) => self.simulated_drop(server, window, at, &paths),
            HostEvent::Cmd(Cmd::ChooseFolder { title, reply }) => host.choose_folder(&title, reply),
            HostEvent::Cmd(Cmd::OpenFiles { request, reply }) => host.open_files(request, reply),
            HostEvent::Cmd(Cmd::SaveFile { request, reply }) => host.save_file(request, reply),
            HostEvent::Cmd(Cmd::Approve { title, message, reply }) => host.approve(&title, &message, reply),
            HostEvent::Cmd(Cmd::Resize { size, reply }) => {
                let scale = server.state().screen[2];
                let answer = host.resize(size, scale).map(|now| {
                    if let Some(physical) = now {
                        self.resized(server, physical, scale);
                    }
                });
                let _ = reply.send(answer);
            }
            HostEvent::Cmd(Cmd::Device) => server.device_changed(host),
            HostEvent::Cmd(Cmd::Exit(code)) => host.exit(code),
        }
    }
}

impl App {
    fn resized(&mut self, server: &Server, size: (u32, u32), scale: f64) {
        let screen = [(f64::from(size.0) / scale).round(), (f64::from(size.1) / scale).round()];
        let (resized, links) = {
            let mut state = server.state();
            let resized = state.resize(screen, scale);
            let links: Vec<_> = if resized.rescaled {
                state.entries.iter().filter(|(_, e)| !e.panel).filter_map(|(_, e)| e.link.clone().map(|l| (l, state.content(e)))).collect()
            } else {
                Vec::new()
            };
            (resized, links)
        };
        if let Some(compositor) = server.compositor() {
            compositor.resized(size);
        }
        for (link, (w, h)) in links {
            link.resized(w, h, scale);
        }
        for (id, rect) in resized.rects {
            server.set_rect(id, rect);
        }
        let output = Event { kind: "output".into(), width: Some(f64::from(size.0)), height: Some(f64::from(size.1)), scale: Some(scale), ..Default::default() };
        server.broker.push_all(resized.work.map(Server::work_event).into_iter().chain([output]));
    }

    fn host_state(server: &Server, to: WindowState) {
        let changed = {
            let mut state = server.state();
            let Some(id) = state.host_entry() else { return };
            let Some(e) = state.entries.get_mut(&id).filter(|e| e.state != to) else { return };
            (id, std::mem::replace(&mut e.state, to))
        };
        let (id, from) = changed;
        if to == WindowState::Minimized {
            server.focus_top();
        } else if from == WindowState::Minimized {
            server.activate(id);
        }
        server.relayout();
        crate::output::surface::announce(id, to, from);
    }

    fn lock(&mut self, server: &Server, host: &dyn Host, window: u32) {
        let reply = |granted: bool| Event { kind: "pointerlock".into(), code: Some(u32::from(granted)), title: Some("request".into()), ..Default::default() };
        if self.lock.as_ref().is_some_and(|lock| lock.window == window) {
            return server.event(window, reply(true));
        }
        let origin = {
            let state = server.state();
            let busy = self.drag.is_some() || self.data_drag.is_some() || state.entries.values().any(|e| e.menu_open.is_some());
            state.entries.get(&window).filter(|e| e.shown() && !busy && self.focused && state.focus == Some(window)).map(|e| [e.rect[0], e.rect[1] + e.frame])
        };
        let Some([ox, oy]) = origin else { return server.event(window, reply(false)) };
        if self.lock.is_some() {
            self.unlock(server, host, true);
        }
        if !host.lock_pointer(true) {
            return server.event(window, reply(false));
        }
        self.lock = Some(Lock { window, at: [self.pointer.0 - ox, self.pointer.1 - oy], injected: self.pointer });
        server.event(window, reply(true));
    }

    fn unlock(&mut self, server: &Server, host: &dyn Host, tell: bool) {
        let Some(lock) = self.lock.take() else { return };
        host.lock_pointer(false);
        if !self.pressed.is_empty() {
            self.capture = Some((lock.window, [self.pointer.0 - lock.at[0], self.pointer.1 - lock.at[1]]));
        }
        if tell {
            server.event(lock.window, Event { kind: "pointerlock".into(), code: Some(0), title: Some("lost".into()), ..Default::default() });
        }
    }

    fn locked_motion(&self, server: &Server, dx: f64, dy: f64) {
        let Some(lock) = &self.lock else { return };
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        let [x, y] = lock.at;
        server.event(lock.window, Event { kind: "pointermove".into(), x: Some(x), y: Some(y), delta_x: Some(dx), delta_y: Some(dy), ..Default::default() });
    }

    fn locked_button(&mut self, server: &Server, button: u32, pressed: bool) {
        let Some(lock) = &self.lock else { return };
        let changed = if pressed { self.pressed.insert(button) } else { self.pressed.remove(&button) };
        if self.pressed.is_empty() {
            self.capture = None;
        }
        if !changed {
            return;
        }
        let [x, y] = lock.at;
        let kind = if pressed { "pointerdown" } else { "pointerup" };
        server.event(lock.window, Event { kind: kind.into(), x: Some(x), y: Some(y), button: Some(button), ..Default::default() });
    }

    fn inject(&mut self, server: &Server, event: Injected) {
        match event {
            Injected::Move(x, y) if self.lock.is_some() => {
                let Some(lock) = &mut self.lock else { return };
                let (dx, dy) = (x - lock.injected.0, y - lock.injected.1);
                lock.injected = (x, y);
                self.locked_motion(server, dx, dy);
            }
            Injected::Motion(dx, dy) if self.lock.is_some() => self.locked_motion(server, dx, dy),
            Injected::Move(x, y) => self.moved(server, x, y),
            Injected::Motion(dx, dy) => self.moved(server, self.pointer.0 + dx, self.pointer.1 + dy),
            Injected::Button { button, pressed } => self.button(server, button, pressed),
            Injected::Wheel { dx, dy, .. } => self.wheel(server, dx, dy),
            Injected::Key { code, pressed } => {
                let bit = keys::combo_bit(code);
                if pressed {
                    self.injected_mods |= bit;
                } else {
                    self.injected_mods &= !bit;
                }
                let shift = (self.modifiers | self.injected_mods) & Combo::SHIFT != 0;
                let text = pressed.then(|| keys::us_text(code, shift)).flatten();
                self.key(server, code, pressed, text);
            }
        }
    }

    fn wheel(&self, server: &Server, dx: f64, dy: f64) {
        if (dx == 0.0 && dy == 0.0) || Self::open_menu(server).is_some() {
            return;
        }
        if let Some((target, [ox, oy])) = self.target(server) {
            let (x, y) = (self.pointer.0 - ox, self.pointer.1 - oy);
            if let Some(link) = server.state().entries.get(&target).and_then(|e| e.link.clone()) {
                link.send(crate::output::surface::Msg::Scroll(x, y, dx, dy));
            }
            server.event(target, Event { kind: "wheel".into(), x: Some(x), y: Some(y), delta_x: Some(dx), delta_y: Some(dy), ..Default::default() });
        }
    }

    fn target(&self, server: &Server) -> Option<(u32, [f64; 2])> {
        if let Some(lock) = &self.lock {
            return Some((lock.window, [self.pointer.0 - lock.at[0], self.pointer.1 - lock.at[1]]));
        }
        self.capture.or_else(|| server.state().hit(self.pointer.0, self.pointer.1).filter(|hit| !hit.bar && !hit.blocked).map(|hit| (hit.target, hit.origin)))
    }

    fn focused(&self, server: &Server, event: Event) {
        let focus = server.state().focus;
        if let Some(id) = focus {
            server.event(id, event);
        }
    }

    fn edges(&mut self, server: &Server, edges: u8) {
        for (edge, entered) in ScreenEdge::changes(self.edges, edges) {
            let kind = if entered { "edgeenter" } else { "edgeleave" };
            server.broker.push(Event { kind: kind.into(), key: Some(edge.as_str().into()), title: Some("host".into()), ..Default::default() });
        }
        self.edges = edges;
    }

    fn moved(&mut self, server: &Server, x: f64, y: f64) {
        self.pointer = (x, y);
        let [_, _, w, h] = server.state().screen_rect();
        self.edges(server, ScreenEdge::touched(x, y, Rect::new(0.0, 0.0, w, h), |_, _| false));
        if let Some(drag) = &self.drag {
            let rect = Self::dragged(drag, (x, y));
            server.set_rect(drag.window, rect);
            return;
        }
        if let Some((id, open)) = Self::open_menu(server) {
            let next = match self.menu_hit(server, id) {
                MenuHit::Label(index) if index != open.index => Some(Open { index, hover: None }),
                MenuHit::Row(row) => Some(Open { hover: Some(row), ..open }),
                MenuHit::Label(_) => Some(open),
                MenuHit::Outside => Some(Open { hover: None, ..open }),
            };
            Self::set_menu(server, id, next);
            return;
        }
        let Some((target, [ox, oy])) = self.target(server) else {
            if let Some(hover) = self.hover.take() {
                Self::hover(server, hover, None);
                server.event(hover, Event::named("pointerleave"));
            }
            return;
        };
        if self.hover != Some(target)
            && let Some(hover) = self.hover.replace(target)
        {
            Self::hover(server, hover, None);
            server.event(hover, Event::named("pointerleave"));
        }
        Self::hover(server, target, Some((x - ox, y - oy)));
        server.event(target, Event { kind: "pointermove".into(), x: Some(x - ox), y: Some(y - oy), ..Default::default() });
        self.data_drag_over(server);
    }

    fn hover(server: &Server, window: u32, at: Option<(f64, f64)>) {
        if let Some(link) = server.state().entries.get(&window).and_then(|e| e.link.clone()) {
            link.send(Msg::Pointer(at));
        }
    }

    fn start_data_drag(&mut self, server: &Server, window: u32, data: HashMap<String, String>) {
        let pressing = self.pressed.contains(&keys::BUTTON_LEFT) && self.capture.is_some_and(|(target, _)| target == window);
        if !pressing {
            server.event(window, Event { kind: "dragend".into(), button: Some(0), ..Default::default() });
            return;
        }
        self.data_drag = Some(DataDrag { source: window, data, over: None });
        self.data_drag_over(server);
    }

    fn data_drag_over(&mut self, server: &Server) {
        let Some(drag) = &mut self.data_drag else { return };
        let (x, y) = self.pointer;
        let hit = server.state().hit(x, y).filter(|hit| !hit.bar && !hit.blocked && hit.target != drag.source);
        let now = hit.as_ref().map(|hit| hit.target);
        if drag.over != now
            && let Some(left) = drag.over.take()
        {
            server.event(left, Event::named("dndleave"));
        }
        let Some(hit) = hit else { return };
        let (lx, ly) = (x - hit.origin[0], y - hit.origin[1]);
        if drag.over.is_none() {
            drag.over = Some(hit.target);
            server.event(
                hit.target,
                Event { kind: "dndenter".into(), x: Some(lx), y: Some(ly), mime: Some(drag.data.keys().cloned().collect()), ..Default::default() },
            );
        } else {
            server.event(hit.target, Event { kind: "dndmove".into(), x: Some(lx), y: Some(ly), ..Default::default() });
        }
    }

    fn drop_data_drag(&mut self, server: &Server) -> bool {
        let Some(drag) = self.data_drag.take() else { return false };
        let Some(over) = drag.over else { return false };
        let (x, y) = self.pointer;
        let Some(hit) = server.state().hit(x, y).filter(|hit| hit.target == over && !hit.blocked) else {
            server.event(over, Event::named("dndleave"));
            return false;
        };
        server
            .event(over, Event { kind: "dnddrop".into(), x: Some(x - hit.origin[0]), y: Some(y - hit.origin[1]), data: Some(drag.data), ..Default::default() });
        server.event(drag.source, Event { kind: "dragend".into(), button: Some(1), ..Default::default() });
        true
    }

    fn dragged(drag: &Drag, (x, y): (f64, f64)) -> [f64; 4] {
        let [rx, ry, rw, rh] = drag.rect;
        let r = Rect::new(rx, ry, rw, rh).dragged(drag.edges, x - drag.start.0, y - drag.start.1, MIN_SIZE);
        [r.x, r.y, r.w, r.h]
    }

    fn open_menu(server: &Server) -> Option<(u32, Open)> {
        server.state().entries.iter().find_map(|(id, e)| e.menu_open.map(|o| (*id, o)))
    }

    fn set_menu(server: &Server, id: u32, open: Option<Open>) {
        let mut state = server.state();
        let Some(e) = state.entries.get_mut(&id) else { return };
        let open = open.filter(|o| o.index < e.menus.len());
        if e.menu_open == open {
            return;
        }
        if open.is_none_or(|o| e.menu_open.is_none_or(|was| was.index != o.index)) {
            e.menu_place = None;
        }
        e.menu_open = open;
        e.tell_menu();
    }

    fn menu_hit(&self, server: &Server, id: u32) -> MenuHit {
        let state = server.state();
        let Some(e) = state.entries.get(&id) else { return MenuHit::Outside };
        let (x, y) = (self.pointer.0 - e.rect[0], self.pointer.1 - e.rect[1]);
        if let Some(index) = menu::at(&e.menu_labels, x, y) {
            return MenuHit::Label(index);
        }
        match e.menu_place.as_ref().and_then(|place| menu::at(&place.rows, x, y)) {
            Some(row) => MenuHit::Row(row),
            None => MenuHit::Outside,
        }
    }

    fn select_menu(server: &Server, id: u32, index: usize, row: usize) {
        let picked = {
            let state = server.state();
            state.entries.get(&id).and_then(|e| {
                let menu = e.menus.get(index)?;
                let item = menu.items.get(row).filter(|i| i.usable())?;
                Some((menu.id.clone(), item.id.clone()))
            })
        };
        let Some((menu, item)) = picked else { return };
        Self::set_menu(server, id, None);
        server.broker.push(Event { kind: "menuselect".into(), window: Some(id), key: Some(menu), title: Some(item), ..Default::default() });
    }

    fn menu_pressed(&mut self, server: &Server) -> bool {
        if let Some((id, open)) = Self::open_menu(server) {
            match self.menu_hit(server, id) {
                MenuHit::Row(row) => self.menu_press = Some((id, row)),
                MenuHit::Label(index) if index != open.index => Self::set_menu(server, id, Some(Open { index, hover: None })),
                MenuHit::Label(_) | MenuHit::Outside => Self::set_menu(server, id, None),
            }
            return true;
        }
        let Some(hit) = server.state().hit(self.pointer.0, self.pointer.1).filter(|hit| hit.bar && !hit.blocked) else { return false };
        let MenuHit::Label(index) = self.menu_hit(server, hit.entry) else { return false };
        server.activate(hit.target);
        Self::set_menu(server, hit.entry, Some(Open { index, hover: None }));
        true
    }

    fn menu_released(&mut self, server: &Server) -> bool {
        let Some((id, row)) = self.menu_press.take() else { return false };
        if let MenuHit::Row(now) = self.menu_hit(server, id)
            && now == row
            && let Some((_, open)) = Self::open_menu(server)
        {
            Self::select_menu(server, id, open.index, row);
        }
        true
    }

    fn menu_key(&mut self, server: &Server, evdev: u32, pressed: bool) -> bool {
        let Some((id, open)) = Self::open_menu(server) else { return false };
        if !pressed || keys::is_modifier(evdev) {
            return true;
        }
        let step = {
            let state = server.state();
            state.entries.get(&id).map_or(menu::Step::Close, |e| menu::key(&e.menus, open, menu::key_of(evdev)))
        };
        match step {
            menu::Step::Stay(open) => Self::set_menu(server, id, Some(open)),
            menu::Step::Close => Self::set_menu(server, id, None),
            menu::Step::Select(index, row) => Self::select_menu(server, id, index, row),
        }
        true
    }

    fn frame_pressed(server: &Server, id: u32, pressed: FrameButton) {
        let fullscreen = server.state().entries.get(&id).is_some_and(|e| e.mode == Mode::Fullscreen || e.state == WindowState::Fullscreen);
        match pressed {
            FrameButton::Close => server.event(id, Event { kind: "framebutton".into(), key: Some(pressed.key(fullscreen).into()), ..Default::default() }),
            FrameButton::Minimize => crate::output::surface::request_state(id, Some(WindowState::Minimized)),
            FrameButton::Fullscreen if fullscreen => crate::output::surface::request_state(id, None),
            FrameButton::Fullscreen => crate::output::surface::request_state(id, Some(WindowState::Fullscreen)),
        }
    }

    fn frame_button(&self, server: &Server, id: u32) -> Option<FrameButton> {
        let state = server.state();
        let e = state.entries.get(&id)?;
        (e.frame > 0.0).then(|| e.bar(state.theme, state.focus == Some(id)).button_at(self.pointer.0 - e.rect[0], self.pointer.1 - e.rect[1])).flatten()
    }

    fn host_hint(&mut self, server: &Server, host: &dyn Host) -> bool {
        let (x, y) = self.pointer;
        let (id, edges, double) = {
            let mut state = server.state();
            let Some(hit) = state.hit(x, y).filter(|hit| !hit.blocked) else { return false };
            let Some(e) = state.entries.get(&hit.entry).filter(|e| e.host) else { return false };
            let Some(edges) = crate::shell::pointer::edges_at(&e.grab_hints(&state.theme), x - e.rect[0], y - e.rect[1]) else { return false };
            let target = state.double_click.target(Mode::Free, e.state);
            let double = edges == 0 && state.clicks.press(hit.entry, acde::log::now_ms(), [x, y], platform::click_settings()) >= 2;
            if double || edges != 0 {
                state.clicks.reset();
            }
            (hit.entry, edges, double.then_some(target))
        };
        server.activate(id);
        match double {
            Some(to) => {
                if to.is_some() {
                    host.set_state(to);
                }
                true
            }
            None => host.drag(edges),
        }
    }

    fn left_press(&mut self, server: &Server, entry: u32) -> bool {
        let (x, y) = self.pointer;
        let press = server.state().press(entry, [x, y], acde::log::now_ms(), platform::click_settings());
        match press {
            Press::Plain => false,
            Press::Drag(edges, rect) => {
                self.drag = Some(Drag { window: entry, edges, start: self.pointer, rect });
                true
            }
            Press::Double(to) => {
                if let Some(to) = to {
                    crate::output::surface::request_state(entry, Some(to));
                }
                true
            }
        }
    }

    fn button(&mut self, server: &Server, button: u32, pressed: bool) {
        if self.lock.is_some() {
            return self.locked_button(server, button, pressed);
        }
        let (x, y) = self.pointer;
        if pressed {
            if self.pressed.is_empty() && self.menu_press.is_none() && self.menu_pressed(server) {
                return;
            }
            if self.pressed.is_empty() {
                let hit = server.state().hit(x, y);
                let Some(hit) = hit else { return };
                server.activate(hit.target);
                if hit.blocked {
                    return;
                }
                if button == keys::BUTTON_LEFT && self.left_press(server, hit.entry) {
                    return;
                }
                if hit.bar {
                    if button == keys::BUTTON_LEFT {
                        self.frame_press = self.frame_button(server, hit.entry).map(|b| (hit.entry, b));
                    }
                    return;
                }
                self.capture = Some((hit.target, hit.origin));
            }
            if self.drag.is_some() {
                return;
            }
            self.pressed.insert(button);
        } else {
            if self.drag.is_some() && button == keys::BUTTON_LEFT {
                self.drag = None;
                return;
            }
            if self.menu_released(server) {
                return;
            }
            if button == keys::BUTTON_LEFT
                && let Some((id, pressed)) = self.frame_press.take()
            {
                if self.frame_button(server, id) == Some(pressed) {
                    Self::frame_pressed(server, id, pressed);
                }
                return;
            }
            if !self.pressed.remove(&button) {
                return;
            }
            if button == keys::BUTTON_LEFT && self.drop_data_drag(server) {
                if self.pressed.is_empty() {
                    self.capture = None;
                }
                return;
            }
        }
        let Some((target, [ox, oy])) = self.capture else { return };
        server.event(
            target,
            Event {
                kind: (if pressed { "pointerdown" } else { "pointerup" }).into(),
                x: Some(x - ox),
                y: Some(y - oy),
                button: Some(button),
                ..Default::default()
            },
        );
        if self.pressed.is_empty() {
            self.capture = None;
        }
    }

    fn shortcut(&self, server: &Server, evdev: u32) -> Option<Event> {
        let state = server.state();
        let combo = Combo { mods: self.modifiers | self.injected_mods, key: evdev };
        let binding = state.shortcuts.find(combo, state.focus)?;
        let name = state.shortcuts.name(binding).unwrap_or_default().to_owned();
        Some(Event { kind: "shortcut".into(), window: Some(binding.owner), key: Some(name), title: Some(binding.scope.as_str().into()), ..Default::default() })
    }

    fn key(&mut self, server: &Server, evdev: u32, pressed: bool, text: Option<String>) {
        match self.devtools.key(evdev, pressed, self.modifiers | self.injected_mods) {
            crate::dev::DevtoolsPress::Pass => {}
            crate::dev::DevtoolsPress::Swallow => return,
            crate::dev::DevtoolsPress::Open => {
                let window = server.state().focus;
                return server.broker.push(Event { kind: "devtools".into(), window, ..Default::default() });
            }
            crate::dev::DevtoolsPress::Meter => {
                crate::output::hud::toggle();
                return server.relayout();
            }
        }
        if self.menu_key(server, evdev, pressed) {
            return;
        }
        if pressed && !keys::is_modifier(evdev) {
            if let Some(shortcut) = self.shortcut(server, evdev) {
                self.swallowed.insert(evdev);
                server.broker.push(shortcut);
                return;
            }
        } else if !pressed && self.swallowed.remove(&evdev) {
            return;
        }
        let text = text.filter(|t| t.chars().next().is_some_and(|c| !c.is_control()));
        self.focused(server, Event { kind: (if pressed { "keydown" } else { "keyup" }).into(), code: Some(evdev), key: text, ..Default::default() });
    }

    fn simulated_drop(&self, server: &Server, window: u32, at: Option<[f64; 2]>, paths: &[std::path::PathBuf]) {
        let point = {
            let state = server.state();
            state.entries.get(&window).filter(|e| e.shown()).map(|e| {
                let [x, y, w, h] = e.rect;
                let [dx, dy] = at.unwrap_or([w / 2.0, (h - e.frame) / 2.0]);
                (x + dx, y + e.frame + dy)
            })
        };
        match point {
            Some((x, y)) => self.dropped(server, (x, y), paths),
            None => log::warn!("simulated drop: window {window} is not on screen"),
        }
    }

    fn dropped(&self, server: &Server, (x, y): (f64, f64), paths: &[std::path::PathBuf]) {
        let hit = server.state().hit(x, y).filter(|hit| !hit.blocked);
        let Some(hit) = hit else { return };
        let (lx, ly) = (x - hit.origin[0], y - hit.origin[1]);
        server.event(hit.target, Event { kind: "dndenter".into(), x: Some(lx), y: Some(ly), mime: Some(vec!["Files".into()]), ..Default::default() });
        let files = Some(paths.iter().map(|p| p.display().to_string()).collect());
        server.event(hit.target, Event { kind: "dnddrop".into(), x: Some(lx), y: Some(ly), data: Some(HashMap::new()), files, ..Default::default() });
    }
}
