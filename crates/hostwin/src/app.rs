use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, mpsc};

use acde_model::{Combo, Event, Inbox};
use acde_render::acgpu::fallback::wgpu;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{ElementState, Ime, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::ModifiersState;
use winit::window::{Fullscreen, ResizeDirection, Window, WindowId};

use crate::gpu::Gpu;
use crate::keys;
use crate::shell::{Injected, Mode, State};

const LINE: f64 = 40.0;
const DESKTOP: [f64; 2] = [1440.0, 900.0];

pub(crate) enum Cmd {
    Open {
        id: u32,
        reply: mpsc::SyncSender<Result<Opened, String>>,
    },
    Close(u32),
    Title(u32, String),
    Place(u32, [f64; 4]),
    Focus(u32),
    Hide(u32, bool),
    Fullscreen(u32, bool),
    ImeArea(u32, [f64; 4]),
    Inject(Injected),
    ChooseFolder {
        window: Option<u32>,
        title: String,
        reply: crate::chooser::Reply,
    },
    Exit(i32),
}

pub(crate) struct Opened {
    pub window: Arc<Window>,
    pub surface: wgpu::Surface<'static>,
    pub size: (u32, u32),
    pub scale: f64,
    pub refresh: Option<f64>,
}

pub(crate) struct Server {
    proxy: Mutex<EventLoopProxy<Cmd>>,
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
        let _ = self
            .proxy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send_event(cmd);
    }

    fn event(&self, id: u32, event: Event) {
        let inbox = self.state().inbox(id);
        if let Some(inbox) = inbox {
            inbox.push(event);
        }
    }
}

type Main = Box<dyn FnOnce() -> i32 + Send>;

struct App {
    main: Option<Main>,
    proxy: EventLoopProxy<Cmd>,
    ids: HashMap<WindowId, u32>,
    windows: HashMap<u32, Arc<Window>>,
    pointer: HashMap<u32, (f64, f64)>,
    modifiers: ModifiersState,
    swallowed: HashSet<u32>,
    swallowed_buttons: HashSet<u32>,
    active: HashSet<u32>,
    injected: Pointer,
    code: i32,
}

#[derive(Default)]
struct Pointer {
    at: Option<(f64, f64)>,
    over: Option<u32>,
    held: Option<(u32, HashSet<u32>)>,
    mods: u8,
}

enum Input {
    Move(f64, f64),
    Button(u32, bool),
    Wheel(f64, f64),
    Key(u32, bool, Option<String>),
}

pub(crate) fn run(main: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    let event_loop = match EventLoop::<Cmd>::with_user_event().build() {
        Ok(l) => l,
        Err(e) => {
            log::error!("宿主窗口: {e}");
            return 1;
        }
    };
    let gpu = match Gpu::open() {
        Ok(g) => Arc::new(g),
        Err(e) => {
            log::error!("网页图层不可用: {e}");
            return 1;
        }
    };
    acde_render::gpu::install(Some(gpu.shared.clone()));
    let proxy = event_loop.create_proxy();
    if SERVER
        .set(Server {
            proxy: Mutex::new(proxy.clone()),
            state: Mutex::new(State::default()),
            broker: Arc::new(Inbox::default()),
            gpu,
        })
        .is_err()
    {
        log::error!("宿主窗口: 已经起过了");
        return 1;
    }
    let mut app = App {
        main: Some(Box::new(main)),
        proxy,
        ids: HashMap::new(),
        windows: HashMap::new(),
        pointer: HashMap::new(),
        modifiers: ModifiersState::empty(),
        swallowed: HashSet::new(),
        swallowed_buttons: HashSet::new(),
        active: HashSet::new(),
        injected: Pointer::default(),
        code: 0,
    };
    if let Err(e) = event_loop.run_app(&mut app) {
        log::error!("宿主窗口: {e}");
        return 1;
    }
    app.code
}

fn size_from_env() -> Option<[f64; 2]> {
    let text = std::env::var("ACDE_SIZE").ok()?;
    let (w, h) = text.split_once('x')?;
    Some([w.trim().parse().ok()?, h.trim().parse().ok()?])
}

impl App {
    fn start(&mut self, el: &ActiveEventLoop) {
        let Some(main) = self.main.take() else { return };
        let server = server().expect("hostwin");
        let monitor = el
            .primary_monitor()
            .or_else(|| el.available_monitors().next());
        let scale = monitor.as_ref().map_or(1.0, |m| m.scale_factor());
        let fit = monitor
            .as_ref()
            .map(|m| m.size().to_logical::<f64>(scale))
            .map(|s| [s.width * 0.9, s.height * 0.85]);
        let [w, h] = size_from_env().unwrap_or_else(|| {
            fit.map_or(DESKTOP, |[fw, fh]| [DESKTOP[0].min(fw), DESKTOP[1].min(fh)])
        });
        server.state().screen = [w.round(), h.round(), scale];
        server.broker.push(Event {
            kind: "output".into(),
            width: Some((w * scale).round()),
            height: Some((h * scale).round()),
            scale: Some(scale),
            ..Default::default()
        });
        crate::dev::connect(self.proxy.clone());
        let exit = self.proxy.clone();
        let spawned = std::thread::Builder::new()
            .name("acde".into())
            .stack_size(64 << 20)
            .spawn(move || {
                let code = main();
                let _ = exit.send_event(Cmd::Exit(code));
            });
        if let Err(e) = spawned {
            log::error!("Broker 线程: {e}");
            self.code = 1;
            el.exit();
        }
    }

    fn origin(&self) -> [f64; 2] {
        server().map_or([0.0, 0.0], |s| s.state().origin)
    }

    fn note_origin(&self, window: &Window) {
        let Ok(at) = window.inner_position() else {
            return;
        };
        let at = at.to_logical::<f64>(window.scale_factor());
        if let Some(s) = server() {
            s.state().origin = [at.x, at.y];
        }
    }

    fn open(&mut self, el: &ActiveEventLoop, id: u32) -> Result<Opened, String> {
        let server = server().ok_or("hostwin")?;
        let (title, rect, desktop, mode, hidden) = {
            let state = server.state();
            let e = state
                .entries
                .get(&id)
                .ok_or_else(|| format!("没有窗口 {id}"))?;
            (e.title.clone(), e.rect, e.desktop, e.mode, e.hidden)
        };
        let origin = self.origin();
        let title = if title.is_empty() {
            "acde".to_owned()
        } else {
            title
        };
        let mut attrs = Window::default_attributes()
            .with_title(title)
            .with_visible(false)
            .with_inner_size(LogicalSize::new(rect[2].max(1.0), rect[3].max(1.0)));
        if !desktop {
            attrs = attrs.with_position(LogicalPosition::new(
                origin[0] + rect[0],
                origin[1] + rect[1],
            ));
        }
        if matches!(mode, Mode::Fixed | Mode::Pinned) && !desktop {
            attrs = attrs.with_resizable(false);
        }
        let window = Arc::new(
            el.create_window(attrs)
                .map_err(|e| format!("开窗口: {e}"))?,
        );
        window.set_ime_allowed(true);
        if !desktop {
            self.put(&window, rect);
        }
        window.set_visible(!hidden);
        let surface = server
            .gpu
            .instance
            .create_surface(window.clone())
            .map_err(|e| format!("窗口的 surface: {e}"))?;
        let size = window.inner_size();
        let refresh = window
            .current_monitor()
            .and_then(|m| m.refresh_rate_millihertz())
            .map(|mhz| f64::from(mhz) / 1000.0);
        self.ids.insert(window.id(), id);
        self.windows.insert(id, window.clone());
        if desktop {
            self.note_origin(&window);
        }
        {
            let mut state = server.state();
            if let Some(e) = state.entries.get_mut(&id) {
                e.opened = true;
            }
            state.raise(id);
        }
        if !hidden {
            window.focus_window();
        }
        Ok(Opened {
            surface,
            size: (size.width.max(1), size.height.max(1)),
            scale: window.scale_factor(),
            refresh,
            window,
        })
    }

    fn close(&mut self, id: u32) {
        if let Some(window) = self.windows.remove(&id) {
            window.set_visible(false);
            self.ids.remove(&window.id());
        }
        self.pointer.remove(&id);
        self.active.remove(&id);
        if self.injected.over == Some(id) {
            self.injected.over = None;
        }
        if self.injected.held.as_ref().is_some_and(|(w, _)| *w == id) {
            self.injected.held = None;
        }
    }

    fn put(&self, window: &Window, [x, y, ..]: [f64; 4]) {
        let origin = self.origin();
        let want = (origin[0] + x, origin[1] + y);
        let scale = window.scale_factor();
        let (Ok(inner), Ok(outer)) = (window.inner_position(), window.outer_position()) else {
            window.set_outer_position(LogicalPosition::new(want.0, want.1));
            return;
        };
        let inner = inner.to_logical::<f64>(scale);
        let outer = outer.to_logical::<f64>(scale);
        if (inner.x - want.0).abs() < 1.0 && (inner.y - want.1).abs() < 1.0 {
            return;
        }
        window.set_outer_position(LogicalPosition::new(
            want.0 - (inner.x - outer.x),
            want.1 - (inner.y - outer.y),
        ));
    }

    fn place(&self, id: u32, rect: [f64; 4]) {
        let Some(window) = self.windows.get(&id) else {
            return;
        };
        if id != 0 {
            self.put(window, rect);
        }
        let _ = window.request_inner_size(LogicalSize::new(rect[2].max(1.0), rect[3].max(1.0)));
    }

    fn activate(&mut self, id: u32, native: bool) {
        let Some(server) = server() else { return };
        let before = {
            let mut state = server.state();
            if !state.entries.contains_key(&id) {
                return;
            }
            let before = state.focus.replace(id);
            state.raise(id);
            before
        };
        if let Some(before) = before.filter(|b| *b != id) {
            self.deactivate(before);
        }
        if native && let Some(window) = self.windows.get(&id) {
            window.focus_window();
        }
        let fresh = self.active.insert(id);
        if before != Some(id) || fresh {
            server.broker.push(Event {
                kind: "windowactivate".into(),
                window: Some(id),
                ..Default::default()
            });
            server.event(id, Event::named("activate"));
        }
    }

    fn deactivate(&mut self, id: u32) {
        if self.active.remove(&id)
            && let Some(server) = server()
        {
            server.event(id, Event::named("deactivate"));
        }
    }

    fn hide(&mut self, id: u32, hidden: bool) {
        if let Some(w) = self.windows.get(&id) {
            w.set_minimized(hidden);
        }
        let Some(server) = server() else { return };
        if !hidden || server.state().focus != Some(id) {
            return;
        }
        let next = self.stack().into_iter().find(|w| *w != id);
        server.state().focus = None;
        self.deactivate(id);
        if let Some(next) = next {
            self.activate(next, false);
        }
    }

    fn stack(&self) -> Vec<u32> {
        let Some(server) = server() else {
            return Vec::new();
        };
        let state = server.state();
        let mut shown: Vec<(u64, u32)> = state
            .entries
            .iter()
            .filter(|(id, e)| e.opened && !e.hidden && !e.panel && self.windows.contains_key(id))
            .map(|(&id, e)| (e.z, id))
            .collect();
        shown.sort_by(|a, b| b.cmp(a));
        shown.into_iter().map(|(_, id)| id).collect()
    }

    fn content(&self, id: u32) -> Option<[f64; 4]> {
        let window = self.windows.get(&id)?;
        let scale = window.scale_factor();
        let size = window.inner_size().to_logical::<f64>(scale);
        if id == 0 {
            return Some([0.0, 0.0, size.width, size.height]);
        }
        let rect = server()?.state().entries.get(&id)?.rect;
        let at = match window.inner_position() {
            Ok(at) => {
                let at = at.to_logical::<f64>(scale);
                let origin = self.origin();
                [at.x - origin[0], at.y - origin[1]]
            }
            Err(_) => [rect[0], rect[1]],
        };
        Some([at[0], at[1], size.width, size.height])
    }

    fn under(&self, (x, y): (f64, f64)) -> Option<(u32, f64, f64)> {
        self.stack().into_iter().find_map(|id| {
            let [wx, wy, ww, wh] = self.content(id)?;
            (x >= wx && y >= wy && x < wx + ww && y < wy + wh).then_some((id, x - wx, y - wy))
        })
    }

    fn local(&self, id: u32, (x, y): (f64, f64)) -> (f64, f64) {
        let [wx, wy, ..] = self.content(id).unwrap_or_default();
        (x - wx, y - wy)
    }

    fn inject(&mut self, event: Injected) {
        match event {
            Injected::Move(x, y) => self.inject_move((x, y)),
            Injected::Motion(dx, dy) => {
                let (x, y) = self.injected.at.unwrap_or_default();
                self.inject_move((x + dx, y + dy));
            }
            Injected::Button { button, pressed } => {
                let Some(at) = self.injected.at else {
                    log::debug!("inject: 按键之前没有指针位置 (先 move)");
                    return;
                };
                let target = match &mut self.injected.held {
                    Some((id, buttons)) => {
                        let id = *id;
                        if pressed {
                            buttons.insert(button);
                        } else {
                            buttons.remove(&button);
                        }
                        Some(id)
                    }
                    None => self.under(at).map(|(id, ..)| id).inspect(|&id| {
                        if pressed {
                            self.injected.held = Some((id, HashSet::from([button])));
                        }
                    }),
                };
                if self.injected.held.as_ref().is_some_and(|(_, b)| b.is_empty()) {
                    self.injected.held = None;
                }
                let Some(id) = target else { return };
                let (x, y) = self.local(id, at);
                if pressed {
                    self.activate(id, true);
                }
                self.pointer.insert(id, (x, y));
                self.input(id, Input::Button(button, pressed), false);
            }
            Injected::Wheel(dx, dy) => {
                if dx == 0.0 && dy == 0.0 {
                    return;
                }
                let Some(at) = self.injected.at else { return };
                let target = self.injected.held.as_ref().map(|(id, _)| *id).or_else(|| self.under(at).map(|(id, ..)| id));
                let Some(id) = target else { return };
                let local = self.local(id, at);
                self.pointer.insert(id, local);
                self.input(id, Input::Wheel(dx, dy), false);
            }
            Injected::Key { code, pressed } => {
                let bit = keys::combo_bit(code);
                if pressed {
                    self.injected.mods |= bit;
                } else {
                    self.injected.mods &= !bit;
                }
                let focus = server().and_then(|s| s.state().focus);
                let target = focus.filter(|id| self.windows.contains_key(id)).or_else(|| self.stack().first().copied());
                let Some(id) = target else { return };
                let shift = self.injected.mods & acde_model::Combo::SHIFT != 0;
                let text = pressed.then(|| keys::us_text(code, shift)).flatten();
                self.input(id, Input::Key(code, pressed, text), false);
            }
        }
    }

    fn inject_move(&mut self, at: (f64, f64)) {
        self.injected.at = Some(at);
        let (target, local) = match &self.injected.held {
            Some((id, _)) => (Some(*id), self.local(*id, at)),
            None => match self.under(at) {
                Some((id, x, y)) => (Some(id), (x, y)),
                None => (None, (0.0, 0.0)),
            },
        };
        if self.injected.over != target {
            if let Some(old) = self.injected.over
                && let Some(server) = server()
            {
                server.event(old, Event::named("pointerleave"));
            }
            self.injected.over = target;
        }
        if let Some(id) = target {
            self.input(id, Input::Move(local.0, local.1), false);
        }
    }

    fn input(&mut self, id: u32, input: Input, native: bool) {
        let Some(server) = server() else { return };
        match input {
            Input::Move(x, y) => {
                self.pointer.insert(id, (x, y));
                server.event(
                    id,
                    Event {
                        kind: "pointermove".into(),
                        x: Some(x),
                        y: Some(y),
                        ..Default::default()
                    },
                );
            }
            Input::Button(button, pressed) => {
                let (x, y) = self.pointer.get(&id).copied().unwrap_or_default();
                if pressed
                    && button == keys::BUTTON_LEFT
                    && let Some(edges) = self.hint(id, (x, y))
                {
                    self.swallowed_buttons.insert(button);
                    if native && let Some(window) = self.windows.get(&id) {
                        let _ = match Self::resize_direction(edges) {
                            Some(dir) => window.drag_resize_window(dir),
                            None => window.drag_window(),
                        };
                    }
                    return;
                }
                if !pressed && self.swallowed_buttons.remove(&button) {
                    return;
                }
                let kind = if pressed { "pointerdown" } else { "pointerup" };
                server.event(
                    id,
                    Event {
                        kind: kind.into(),
                        x: Some(x),
                        y: Some(y),
                        button: Some(button),
                        ..Default::default()
                    },
                );
            }
            Input::Wheel(dx, dy) => {
                let (x, y) = self.pointer.get(&id).copied().unwrap_or_default();
                server.event(
                    id,
                    Event {
                        kind: "wheel".into(),
                        x: Some(x),
                        y: Some(y),
                        delta_x: Some(dx),
                        delta_y: Some(dy),
                        ..Default::default()
                    },
                );
            }
            Input::Key(evdev, pressed, text) => {
                if pressed && !keys::is_modifier(evdev) {
                    if let Some(shortcut) = self.shortcut(evdev) {
                        self.swallowed.insert(evdev);
                        server.broker.push(shortcut);
                        return;
                    }
                } else if !pressed && self.swallowed.remove(&evdev) {
                    return;
                }
                let kind = if pressed { "keydown" } else { "keyup" };
                server.event(
                    id,
                    Event {
                        kind: kind.into(),
                        code: Some(evdev),
                        key: text,
                        ..Default::default()
                    },
                );
            }
        }
    }

    fn combo_mods(&self) -> u8 {
        let m = self.modifiers;
        let mut mods = 0;
        if m.control_key() {
            mods |= Combo::CTRL;
        }
        if m.alt_key() {
            mods |= Combo::ALT;
        }
        if m.shift_key() {
            mods |= Combo::SHIFT;
        }
        if m.super_key() {
            mods |= Combo::SUPER;
        }
        mods | self.injected.mods
    }

    fn shortcut(&self, evdev: u32) -> Option<Event> {
        let server = server()?;
        let state = server.state();
        let combo = Combo {
            mods: self.combo_mods(),
            key: evdev,
        };
        let binding = state.shortcuts.find(combo, state.focus)?;
        let name = state.names.get(&combo).cloned().unwrap_or_default();
        let scope = match binding.scope {
            acde_model::Scope::Session => "session",
            acde_model::Scope::Desktop => "desktop",
            acde_model::Scope::App => "app",
        };
        Some(Event {
            kind: "shortcut".into(),
            window: Some(binding.owner),
            key: Some(name),
            title: Some(scope.into()),
            ..Default::default()
        })
    }

    fn hint(&self, id: u32, (x, y): (f64, f64)) -> Option<u32> {
        let state = server()?.state();
        let entry = state.entries.get(&id)?;
        entry
            .hints
            .iter()
            .rev()
            .find(|([hx, hy, hw, hh], _)| x >= *hx && y >= *hy && x < hx + hw && y < hy + hh)
            .map(|(_, edges)| *edges)
    }

    fn resize_direction(edges: u32) -> Option<ResizeDirection> {
        Some(match edges {
            1 => ResizeDirection::North,
            2 => ResizeDirection::South,
            4 => ResizeDirection::West,
            8 => ResizeDirection::East,
            5 => ResizeDirection::NorthWest,
            6 => ResizeDirection::SouthWest,
            9 => ResizeDirection::NorthEast,
            10 => ResizeDirection::SouthEast,
            _ => return None,
        })
    }

    fn window_event(&mut self, id: u32, window: Arc<Window>, event: WindowEvent) {
        let Some(server) = server() else { return };
        let scale = window.scale_factor();
        match event {
            WindowEvent::Resized(size) => {
                let logical = size.to_logical::<f64>(scale);
                let link = {
                    let mut state = server.state();
                    let entry = state.entries.get_mut(&id);
                    entry.and_then(|e| {
                        e.rect[2] = logical.width;
                        e.rect[3] = logical.height;
                        e.link.clone()
                    })
                };
                if let Some(link) = link {
                    link.resized(size.width.max(1), size.height.max(1), scale);
                }
                if id == 0 {
                    let mut state = server.state();
                    state.screen = [logical.width.round(), logical.height.round(), scale];
                    drop(state);
                    server.broker.push(Event {
                        kind: "output".into(),
                        width: Some(f64::from(size.width)),
                        height: Some(f64::from(size.height)),
                        scale: Some(scale),
                        ..Default::default()
                    });
                }
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                let size = window.inner_size();
                let link = server.state().entries.get(&id).and_then(|e| e.link.clone());
                if let Some(link) = link {
                    link.resized(size.width.max(1), size.height.max(1), scale_factor);
                }
            }
            WindowEvent::Moved(_) => {
                if id == 0 {
                    self.note_origin(&window);
                } else if let Ok(at) = window.inner_position() {
                    let at = at.to_logical::<f64>(scale);
                    let origin = self.origin();
                    if let Some(e) = server.state().entries.get_mut(&id) {
                        e.rect[0] = at.x - origin[0];
                        e.rect[1] = at.y - origin[1];
                    }
                }
            }
            WindowEvent::CloseRequested => {
                server.broker.push(Event {
                    kind: "windowcloserequest".into(),
                    window: Some(id),
                    ..Default::default()
                });
            }
            WindowEvent::Focused(focused) => {
                if focused {
                    self.activate(id, false);
                } else {
                    self.deactivate(id);
                    self.modifiers = ModifiersState::empty();
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let at = position.to_logical::<f64>(scale);
                self.input(id, Input::Move(at.x, at.y), true);
            }
            WindowEvent::CursorLeft { .. } => server.event(id, Event::named("pointerleave")),
            WindowEvent::MouseInput { state, button, .. } => {
                let pressed = state == ElementState::Pressed;
                self.input(id, Input::Button(keys::mouse_button(button), pressed), true);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(dx, dy) => {
                        (-f64::from(dx) * LINE, -f64::from(dy) * LINE)
                    }
                    MouseScrollDelta::PixelDelta(p) => (-p.x / scale, -p.y / scale),
                };
                self.input(id, Input::Wheel(dx, dy), true);
            }
            WindowEvent::ModifiersChanged(m) => self.modifiers = m.state(),
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(key) = keys::key(event.physical_key) else {
                    return;
                };
                let pressed = event.state == ElementState::Pressed;
                let text = event
                    .text
                    .as_ref()
                    .map(|t| t.to_string())
                    .filter(|t| t.chars().next().is_some_and(|c| !c.is_control()));
                self.input(id, Input::Key(key.evdev, pressed, text), true);
            }
            WindowEvent::Ime(ime) => match ime {
                Ime::Preedit(text, _) => server.event(
                    id,
                    Event {
                        kind: "imepreedit".into(),
                        key: Some(text),
                        ..Default::default()
                    },
                ),
                Ime::Commit(text) => server.event(
                    id,
                    Event {
                        kind: "imecommit".into(),
                        key: Some(text),
                        ..Default::default()
                    },
                ),
                Ime::Enabled | Ime::Disabled => {}
            },
            WindowEvent::DroppedFile(path) => {
                let (x, y) = self.pointer.get(&id).copied().unwrap_or_default();
                let uri = format!("file://{}", path.display());
                let data = HashMap::from([
                    ("text/uri-list".to_owned(), uri.clone()),
                    ("text/plain".to_owned(), path.display().to_string()),
                ]);
                server.event(
                    id,
                    Event {
                        kind: "dndenter".into(),
                        x: Some(x),
                        y: Some(y),
                        mime: Some(data.keys().cloned().collect()),
                        ..Default::default()
                    },
                );
                server.event(
                    id,
                    Event {
                        kind: "dnddrop".into(),
                        x: Some(x),
                        y: Some(y),
                        data: Some(data),
                        ..Default::default()
                    },
                );
            }
            WindowEvent::Occluded(false) | WindowEvent::RedrawRequested => {
                let link = server.state().entries.get(&id).and_then(|e| e.link.clone());
                if let Some(link) = link {
                    link.redraw();
                }
            }
            _ => {}
        }
    }
}

impl ApplicationHandler<Cmd> for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        self.start(el);
    }

    fn user_event(&mut self, el: &ActiveEventLoop, cmd: Cmd) {
        match cmd {
            Cmd::Open { id, reply } => {
                let opened = self.open(el, id);
                let _ = reply.send(opened);
            }
            Cmd::Close(id) => self.close(id),
            Cmd::Title(id, title) => {
                if let Some(w) = self.windows.get(&id) {
                    w.set_title(&title);
                }
            }
            Cmd::Place(id, rect) => self.place(id, rect),
            Cmd::Focus(id) => {
                if let Some(w) = self.windows.get(&id) {
                    w.set_visible(true);
                    w.set_minimized(false);
                }
                self.activate(id, true);
            }
            Cmd::Hide(id, hidden) => self.hide(id, hidden),
            Cmd::Inject(event) => self.inject(event),
            Cmd::Fullscreen(id, on) => {
                if let Some(w) = self.windows.get(&id) {
                    w.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
                }
            }
            Cmd::ImeArea(id, [x, y, w, h]) => {
                if let Some(window) = self.windows.get(&id) {
                    window.set_ime_cursor_area(
                        LogicalPosition::new(x, y),
                        LogicalSize::new(w.max(1.0), h.max(1.0)),
                    );
                }
            }
            Cmd::ChooseFolder { window, title, reply } => {
                let parent = window.and_then(|id| self.windows.get(&id)).map(|w| &**w);
                crate::chooser::folder(parent, &title, reply);
            }
            Cmd::Exit(code) => {
                self.code = code;
                el.exit();
            }
        }
    }

    fn window_event(&mut self, _: &ActiveEventLoop, window: WindowId, event: WindowEvent) {
        let Some(&id) = self.ids.get(&window) else {
            return;
        };
        let Some(host) = self.windows.get(&id).cloned() else {
            return;
        };
        self.window_event(id, host, event);
    }
}
