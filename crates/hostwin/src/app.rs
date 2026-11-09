use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use acde_model::{Combo, Event, Inbox, Injected, Mode, Rect, WindowState};
use acde_render::FrameButton;

use crate::keys;
use crate::output::compose::{self, Compositor};
use crate::output::gpu::Gpu;
use crate::platform::{self, Cmd, Handler, Host, HostEvent, Monitor, Proxy};
use crate::shell::State;

const DESKTOP: [f64; 2] = [1440.0, 900.0];
const MIN_SIZE: (f64, f64) = (160.0, 100.0);

pub(crate) struct Server {
    proxy: OnceLock<Proxy>,
    compositor: OnceLock<Compositor>,
    state: Mutex<State>,
    pub broker: Arc<Inbox>,
    pub gpu: Arc<Gpu>,
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
            let id = state.modal_child(id).unwrap_or(id);
            let raise = state.entries.get(&id).is_some_and(|e| !e.desktop && !e.panel);
            if raise {
                state.raise(id);
            }
            (id, state.focus.replace(id))
        };
        if previous != Some(id) {
            if let Some(previous) = previous {
                self.event(previous, Event::named("deactivate"));
            }
            self.event(id, Event::named("activate"));
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
            None => self.state().focus = None,
        }
    }

    pub fn refill(&self) {
        let (changed, filled) = self.state().refill();
        let Some(work) = changed else { return };
        for id in filled {
            self.set_rect(id, work);
        }
        let [x, y, w, h] = work;
        self.broker.push(Event { kind: "workarea".into(), x: Some(x), y: Some(y), width: Some(w), height: Some(h), ..Default::default() });
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
}

type Main = Box<dyn FnOnce() -> i32 + Send>;

struct Drag {
    window: u32,
    edges: u32,
    start: (f64, f64),
    rect: [f64; 4],
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
    frame_press: Option<(u32, FrameButton)>,
}

pub(crate) fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    let gpu = match Gpu::open() {
        Ok(g) => Arc::new(g),
        Err(e) => {
            log::error!("web layer unavailable: {e}");
            return 1;
        }
    };
    acde_gpu::Gpu::publish(Some(gpu.shared.clone()));
    let server = Server { proxy: OnceLock::new(), compositor: OnceLock::new(), state: Mutex::new(State::default()), broker: Arc::new(Inbox::default()), gpu };
    if SERVER.set(server).is_err() {
        log::error!("host window: already started");
        return 1;
    }
    let app = App { main: Some(Box::new(main)), ..App::default() };
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

fn size_from_env() -> Option<[f64; 2]> {
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
        }
        let surface = match host.surface(&server.gpu.instance) {
            Ok(surface) => surface,
            Err(e) => {
                log::error!("host window surface: {e}");
                return host.exit(1);
            }
        };
        match compose::start(server.gpu.clone(), surface, size) {
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
        match event {
            HostEvent::Resized { size, scale } => self.resized(server, size, scale),
            HostEvent::CloseRequested => server.broker.push(Event { kind: "windowcloserequest".into(), window: Some(0), ..Default::default() }),
            HostEvent::Focused(focused) => {
                let focus = server.state().focus;
                if let Some(id) = focus {
                    server.event(id, Event::named(if focused { "activate" } else { "deactivate" }));
                }
                if !focused {
                    self.modifiers = 0;
                }
            }
            HostEvent::PointerMove(x, y) => self.moved(server, x, y),
            HostEvent::PointerLeave => {
                if self.capture.is_none()
                    && let Some(hover) = self.hover.take()
                {
                    server.event(hover, Event::named("pointerleave"));
                }
            }
            HostEvent::Button(button, pressed) => self.button(server, button, pressed),
            HostEvent::Wheel(dx, dy) => self.wheel(server, dx, dy),
            HostEvent::Modifiers(mods) => self.modifiers = mods,
            HostEvent::Key { evdev, pressed, text } => self.key(server, evdev, pressed, text),
            HostEvent::ImePreedit(text) => self.focused(server, Event { kind: "imepreedit".into(), key: Some(text), ..Default::default() }),
            HostEvent::ImeCommit(text) => self.focused(server, Event { kind: "imecommit".into(), key: Some(text), ..Default::default() }),
            HostEvent::Dropped(paths) => self.dropped(server, &paths),
            HostEvent::Redraw => server.relayout(),
            HostEvent::Cmd(Cmd::Title(title)) => host.set_title(&title),
            HostEvent::Cmd(Cmd::ImeArea(rect)) => host.set_ime_area(rect),
            HostEvent::Cmd(Cmd::Inject(event)) => self.inject(server, event),
            HostEvent::Cmd(Cmd::StartDrag { window, data }) => self.start_data_drag(server, window, data),
            HostEvent::Cmd(Cmd::ChooseFolder { title, reply }) => host.choose_folder(&title, reply),
            HostEvent::Cmd(Cmd::OpenFiles { request, reply }) => host.open_files(request, reply),
            HostEvent::Cmd(Cmd::SaveFile { request, reply }) => host.save_file(request, reply),
            HostEvent::Cmd(Cmd::Exit(code)) => host.exit(code),
        }
    }
}

fn drop_owner(state: &State, target: u32) -> Option<Option<String>> {
    let entry = state.entries.get(&target)?;
    match (entry.desktop, &entry.app) {
        (true, _) => Some(None),
        (false, app) => app.clone().map(Some),
    }
}

impl App {
    fn resized(&mut self, server: &Server, size: (u32, u32), scale: f64) {
        let screen = [(f64::from(size.0) / scale).round(), (f64::from(size.1) / scale).round()];
        let (full, links) = {
            let mut state = server.state();
            let rescaled = state.screen[2] != scale;
            state.screen = [screen[0], screen[1], scale];
            let (whole, work) = (state.screen_rect(), state.work_area());
            let full: Vec<(u32, [f64; 4])> = state
                .entries
                .iter()
                .filter_map(|(&id, e)| match e.state {
                    _ if id == 0 || e.mode == Mode::Fullscreen || e.state == WindowState::Fullscreen => Some((id, whole)),
                    WindowState::Filled => Some((id, work)),
                    _ => None,
                })
                .collect();
            let links: Vec<_> = if rescaled {
                state.entries.iter().filter(|(_, e)| !e.panel).filter_map(|(_, e)| e.link.clone().map(|l| (l, state.content(e)))).collect()
            } else {
                Vec::new()
            };
            (full, links)
        };
        if let Some(compositor) = server.compositor() {
            compositor.resized(size);
        }
        for (link, (w, h)) in links {
            link.resized(w, h, scale);
        }
        for (id, rect) in full {
            server.set_rect(id, rect);
        }
        server.broker.push(Event {
            kind: "output".into(),
            width: Some(f64::from(size.0)),
            height: Some(f64::from(size.1)),
            scale: Some(scale),
            ..Default::default()
        });
    }

    fn inject(&mut self, server: &Server, event: Injected) {
        match event {
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
        if dx == 0.0 && dy == 0.0 {
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
        self.capture.or_else(|| server.state().hit(self.pointer.0, self.pointer.1).filter(|hit| !hit.bar && !hit.blocked).map(|hit| (hit.target, hit.origin)))
    }

    fn focused(&self, server: &Server, event: Event) {
        let focus = server.state().focus;
        if let Some(id) = focus {
            server.event(id, event);
        }
    }

    fn moved(&mut self, server: &Server, x: f64, y: f64) {
        self.pointer = (x, y);
        if let Some(drag) = &self.drag {
            let rect = Self::dragged(drag, (x, y));
            server.set_rect(drag.window, rect);
            return;
        }
        let Some((target, [ox, oy])) = self.target(server) else {
            if let Some(hover) = self.hover.take() {
                server.event(hover, Event::named("pointerleave"));
            }
            return;
        };
        if self.hover != Some(target)
            && let Some(hover) = self.hover.replace(target)
        {
            server.event(hover, Event::named("pointerleave"));
        }
        server.event(target, Event { kind: "pointermove".into(), x: Some(x - ox), y: Some(y - oy), ..Default::default() });
        self.data_drag_over(server);
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
        (e.frame > 0.0).then(|| e.bar().button_at(self.pointer.0 - e.rect[0], self.pointer.1 - e.rect[1])).flatten()
    }

    fn grab(&self, server: &Server, entry: u32) -> Option<Drag> {
        let state = server.state();
        let e = state.entries.get(&entry)?;
        if e.desktop || e.panel || e.owner.is_some() || !e.state.moves() {
            return None;
        }
        let (x, y) = (self.pointer.0 - e.rect[0], self.pointer.1 - e.rect[1]);
        let edges = e.grab_hints().iter().rev().find(|([hx, hy, hw, hh], _)| x >= *hx && y >= *hy && x < hx + hw && y < hy + hh).map(|(_, edges)| *edges)?;
        let allowed = match e.mode {
            Mode::Free => true,
            Mode::Fixed => edges == 0,
            Mode::Fullscreen | Mode::Pinned => false,
        };
        allowed.then_some(Drag { window: entry, edges, start: self.pointer, rect: e.rect })
    }

    fn button(&mut self, server: &Server, button: u32, pressed: bool) {
        let (x, y) = self.pointer;
        if pressed {
            if self.pressed.is_empty() {
                let hit = server.state().hit(x, y);
                let Some(hit) = hit else { return };
                server.activate(hit.target);
                if hit.blocked {
                    return;
                }
                if button == keys::BUTTON_LEFT
                    && let Some(drag) = self.grab(server, hit.entry)
                {
                    self.drag = Some(drag);
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
        let name = state.shortcuts.name(combo).unwrap_or_default().to_owned();
        Some(Event { kind: "shortcut".into(), window: Some(binding.owner), key: Some(name), title: Some(binding.scope.as_str().into()), ..Default::default() })
    }

    fn key(&mut self, server: &Server, evdev: u32, pressed: bool, text: Option<String>) {
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

    fn dropped(&self, server: &Server, paths: &[std::path::PathBuf]) {
        let (x, y) = self.pointer;
        let hit = server.state().hit(x, y).filter(|hit| !hit.blocked);
        let Some(hit) = hit else { return };
        let owner = drop_owner(&server.state(), hit.target);
        if let Some(app) = owner {
            acde_model::drop_grant::record(app.as_deref(), paths);
        }
        let (lx, ly) = (x - hit.origin[0], y - hit.origin[1]);
        let uris: Vec<String> = paths.iter().filter_map(|p| url::Url::from_file_path(p).ok()).map(String::from).collect();
        let plain: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
        let data = HashMap::from([("text/uri-list".to_owned(), uris.join("\r\n")), ("text/plain".to_owned(), plain.join("\n"))]);
        server.event(hit.target, Event { kind: "dndenter".into(), x: Some(lx), y: Some(ly), mime: Some(data.keys().cloned().collect()), ..Default::default() });
        server.event(hit.target, Event { kind: "dnddrop".into(), x: Some(lx), y: Some(ly), data: Some(data), ..Default::default() });
    }
}
