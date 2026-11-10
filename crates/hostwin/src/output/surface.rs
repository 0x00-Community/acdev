use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use acde_model::{DoubleClick, Event, Inbox, Mode, Waker, WindowState};
use acde_render::{RenderHandle, SurfaceCommand};

use crate::app::server;
use crate::output::gpu::guarded;
use crate::output::present::Presenter;
use crate::platform::{self, Cmd};

pub(crate) enum Msg {
    Wake,
    Frame,
    Resized(u32, u32, f64),
    Scroll(f64, f64, f64, f64),
    Panel(u32, Option<u32>),
    Title(String),
    Fullscreen(bool),
    Theme(acde_render::FrameTheme),
    Active(bool),
    Refresh(Option<f64>),
    Capture(mpsc::SyncSender<Result<Shot, String>>),
    Stop,
}

pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct Link(mpsc::Sender<Msg>);

impl Link {
    pub(crate) fn send(&self, msg: Msg) {
        let _ = self.0.send(msg);
    }

    #[cfg(test)]
    pub(crate) fn pair() -> (Self, mpsc::Receiver<Msg>) {
        let (tx, rx) = mpsc::channel();
        (Self(tx), rx)
    }

    pub fn resized(&self, width: u32, height: u32, scale: f64) {
        self.send(Msg::Resized(width, height, scale));
    }

    pub fn capture(&self, wait: std::time::Duration) -> Result<Shot, String> {
        let (reply, got) = mpsc::sync_channel(1);
        self.0.send(Msg::Capture(reply)).map_err(|_| "the window is gone".to_owned())?;
        got.recv_timeout(wait).map_err(|_| "the window did not answer".to_owned())?
    }
}

pub struct Surface {
    window: u32,
    inbox: Arc<Inbox>,
    link: Link,
    panels: Mutex<HashMap<u32, u32>>,
    thread: Option<JoinHandle<()>>,
}

pub(crate) fn set_mode(id: u32, mode: Mode) {
    let Some(server) = server() else { return };
    let current = {
        let mut state = server.state();
        let Some(entry) = state.entries.get_mut(&id) else { return };
        if entry.desktop || mode == Mode::Fullscreen || entry.mode == Mode::Fullscreen {
            return;
        }
        entry.mode = mode;
        entry.state
    };
    if !current.allowed(mode) {
        request_state(id, Some(WindowState::Normal));
    }
}

pub(crate) fn request_state(id: u32, to: Option<WindowState>) {
    let Some(server) = server() else { return };
    if server.state().entries.get(&id).is_some_and(|e| e.host) {
        return server.send(Cmd::HostState(to));
    }
    let (change, link, focused) = {
        let mut state = server.state();
        let focused = state.focus == Some(id);
        let Some(change) = state.change_state(id, to) else { return };
        let link = state.entries.get(&id).and_then(|e| e.link.clone().filter(|_| e.frame > 0.0));
        (change, link, focused)
    };
    if let Some(rect) = change.rect {
        server.set_rect(id, rect);
    }
    if let Some(link) = link {
        link.send(Msg::Fullscreen(change.state == WindowState::Fullscreen));
    }
    if change.state == WindowState::Minimized {
        if focused {
            server.focus_top();
        }
    } else if change.previous == WindowState::Minimized {
        server.activate(id);
    }
    server.relayout();
    announce(id, change.state, change.previous);
}

pub(crate) fn announce(id: u32, to: WindowState, from: WindowState) {
    let Some(server) = server() else { return };
    let (state, previous) = (Some(to.as_str().to_owned()), Some(from.as_str().to_owned()));
    server.event(id, Event { kind: "state".into(), state: state.clone(), previous: previous.clone(), ..Default::default() });
    server.broker.push(Event { kind: "windowstate".into(), window: Some(id), state, previous, ..Default::default() });
}

impl Surface {
    pub fn claim(token: u64, render: RenderHandle, frame: u32, app: Option<String>) -> Result<Self, String> {
        let server = server().ok_or("claimSurface: no host window")?;
        let inbox = Arc::new(Inbox::default());
        let (tx, rx) = mpsc::channel();
        let link = Link(tx);
        let (window, size, scale, refresh, focus, bar) = {
            let mut state = server.state();
            let id = state.tokens.remove(&token).ok_or("claimSurface: wrong or already used token")?;
            let (scale, refresh, unfocused, theme) = (state.screen[2], state.refresh, state.focus.is_none(), state.theme);
            let entry = state.entries.get_mut(&id).ok_or("claimSurface: window is gone")?;
            entry.frame = if entry.desktop || entry.panel || entry.host { 0.0 } else { f64::from(frame) };
            entry.inbox = Some(inbox.clone());
            entry.link = Some(link.clone());
            entry.app = app;
            entry.opened = true;
            let focus = !entry.hidden && (!entry.desktop || unfocused);
            let bar = entry.bar(theme, false);
            (id, state.content(&state.entries[&id]), scale, refresh, focus, bar)
        };
        let wake = link.clone();
        render.set_waker(Box::new(move || wake.send(Msg::Wake)));
        let gpu = server.gpu.clone();
        let events = inbox.clone();
        let thread = std::thread::Builder::new()
            .name(format!("acde-host-{window}"))
            .spawn(move || {
                guarded(|| match Presenter::new(window, gpu, size, scale, refresh, bar, render, events.clone()) {
                    Ok(mut presenter) => presenter.run(&rx),
                    Err(e) => log::error!("window {window}: {e}"),
                });
                events.push(Event::named("exit"));
            })
            .map_err(|e| format!("window thread: {e}"))?;
        if focus {
            server.activate(window);
        } else {
            server.relayout();
        }
        Ok(Self { window, inbox, link, panels: Mutex::new(HashMap::new()), thread: Some(thread) })
    }

    pub fn window(&self) -> u32 {
        self.window
    }

    pub fn pump(&self) -> Vec<Event> {
        self.inbox.drain()
    }

    pub fn has_events(&self) -> bool {
        !self.inbox.is_empty()
    }

    pub fn set_waker(&self, waker: Option<Waker>) {
        self.inbox.set_waker(waker);
    }

    pub fn send(&self, command: SurfaceCommand) {
        use SurfaceCommand as C;
        match command {
            C::RequestFrame => self.link.send(Msg::Frame),
            C::SetClipboard(text) => platform::clipboard_set(text),
            C::ReadClipboard(reply) => reply(platform::clipboard_get()),
            C::StartDrag(data, _) => match server() {
                Some(server) => server.send(Cmd::StartDrag { window: self.window, data }),
                None => self.inbox.push(Event { kind: "dragend".into(), button: Some(0), ..Default::default() }),
            },
            C::Mode(mode) => {
                if let Ok(mode) = Mode::try_from(mode) {
                    set_mode(self.window, mode);
                }
            }
            C::State(state) => {
                if let Ok(state) = WindowState::try_from(state) {
                    request_state(self.window, Some(state));
                }
            }
            C::GrabHint(rect, edges) => self.set_grab_hint(rect, edges),
            C::Backdrop(rect, effect) => self.set_backdrop(rect, effect),
            C::Activate => {
                if let Some(server) = server() {
                    server.activate(self.window);
                }
            }
            C::Grab(kind, true) => {
                let name = if kind == 2 { "keyboard" } else { "pointer" };
                self.inbox.push(Event { kind: "grab".into(), key: Some(name.into()), code: Some(1), ..Default::default() });
            }
            C::Grab(_, false) => {}
            C::OpenPanel { id, token, rect } => self.open_panel(id, token, rect),
            C::PlacePanel { id, rect, input } => self.place_panel(id, rect, input),
            C::ClosePanel(id) => self.close_panel(id),
            C::ReservePanel { id, edge, thickness } => self.reserve_panel(id, edge, thickness),
            C::FrameTheme(theme) => {
                if let Some(server) = server() {
                    server.set_theme(theme);
                }
            }
            C::DoubleClick(action) => {
                if let (Some(server), Ok(action)) = (server(), DoubleClick::try_from(action)) {
                    server.state().double_click = action;
                }
            }
            C::Title(title) => self.set_title(&title),
            C::ImeArea(rect) => self.set_ime_area(rect),
        }
    }

    fn set_grab_hint(&self, [x, y, w, h]: [i32; 4], edges: u32) {
        let Some(server) = server() else { return };
        let mut state = server.state();
        let Some(entry) = state.entries.get_mut(&self.window) else { return };
        if w <= 0 || h <= 0 {
            entry.hints.clear();
        } else {
            entry.hints.push(([x, y, w, h].map(f64::from), edges));
        }
    }

    fn set_backdrop(&self, [x, y, w, h]: [i32; 4], effect: [f64; 4]) {
        let Some(server) = server() else { return };
        let mut state = server.state();
        let scale = state.screen[2];
        let Some(entry) = state.entries.get_mut(&self.window) else { return };
        let top = (entry.frame * scale).round();
        entry.backdrop = (w > 0 && h > 0).then(|| ([f64::from(x), f64::from(y) + top, f64::from(w), f64::from(h)], effect));
        drop(state);
        if let Some(compositor) = server.compositor() {
            compositor.dirty();
        }
    }

    fn panels(&self) -> std::sync::MutexGuard<'_, HashMap<u32, u32>> {
        self.panels.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn open_panel(&self, id: u32, token: u64, rect: [i32; 4]) {
        let Some(server) = server() else { return };
        self.close_panel(id);
        let panel = {
            let mut state = server.state();
            let Some(panel) = state.tokens.remove(&token) else { return };
            let Some(e) = state.entries.get_mut(&panel) else { return };
            e.rect = rect.map(f64::from);
            e.opened = true;
            e.panel = true;
            e.owner = Some(self.window);
            panel
        };
        self.panels().insert(id, panel);
        self.link.send(Msg::Panel(id, Some(panel)));
        server.relayout();
    }

    fn place_panel(&self, id: u32, rect: [i32; 4], input: [i32; 4]) {
        let Some(server) = server() else { return };
        let Some(panel) = self.panels().get(&id).copied() else { return };
        {
            let mut state = server.state();
            let scale = state.screen[2];
            let Some(e) = state.entries.get_mut(&panel) else { return };
            e.pending = Some((rect.map(f64::from), input.map(f64::from)));
            if !crate::shell::State::place_when_drawn(e, scale) {
                return;
            }
        }
        server.relayout();
    }

    fn close_panel(&self, id: u32) {
        let Some(panel) = self.panels().remove(&id) else { return };
        self.link.send(Msg::Panel(id, None));
        if let Some(server) = server() {
            server.state().entries.remove(&panel);
            server.refill();
            server.relayout();
        }
    }

    fn reserve_panel(&self, id: u32, edge: u32, thickness: f64) {
        let Some(server) = server() else { return };
        let Some(panel) = self.panels().get(&id).copied() else { return };
        let reserve = (edge != 0 && thickness > 0.0).then_some((edge, thickness));
        match server.state().entries.get_mut(&panel) {
            Some(e) if e.reserve != reserve => e.reserve = reserve,
            _ => return,
        }
        server.refill();
    }

    pub fn minimizable(&self) -> bool {
        server().is_some_and(|s| s.state().entries.get(&self.window).is_some_and(|e| e.minimize))
    }

    pub fn host_controls(&self) -> bool {
        server().is_some_and(|s| s.state().entries.get(&self.window).is_some_and(|e| e.host))
    }

    pub fn size(&self) -> Option<(u32, u32, f64)> {
        let server = server()?;
        let state = server.state();
        state.entries.get(&self.window).map(|e| {
            let (w, h) = state.content(e);
            (w, h, state.screen[2])
        })
    }

    pub fn content_offset(&self) -> (f64, f64) {
        let frame = server().and_then(|s| s.state().entries.get(&self.window).map(|e| e.frame));
        (0.0, frame.unwrap_or(0.0))
    }

    fn set_title(&self, title: &str) {
        let Some(server) = server() else { return };
        let (framed, host) = match server.state().entries.get_mut(&self.window) {
            Some(e) => {
                e.title = title.to_owned();
                (e.frame > 0.0, e.host)
            }
            None => (false, false),
        };
        if framed {
            self.link.send(Msg::Title(title.to_owned()));
        }
        if self.window == 0 || host {
            server.send(Cmd::Title(title.to_owned()));
        }
    }

    fn set_ime_area(&self, [x, y, w, h]: [f64; 4]) {
        let Some(server) = server() else { return };
        let origin = {
            let state = server.state();
            if state.focus != Some(self.window) {
                return;
            }
            state.entries.get(&self.window).map(|e| [e.rect[0], e.rect[1] + e.frame])
        };
        if let Some([ox, oy]) = origin {
            server.send(Cmd::ImeArea([ox + x, oy + y, w, h]));
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        self.link.send(Msg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let Some(server) = server() else { return };
        let panels: Vec<u32> = self.panels().drain().map(|(_, w)| w).collect();
        let (gone, focused) = {
            let mut state = server.state();
            state.tokens.retain(|_, w| *w != self.window);
            state.shortcuts.forget(self.window);
            for panel in &panels {
                state.entries.remove(panel);
            }
            let focused = state.focus == Some(self.window);
            if focused {
                state.focus = None;
            }
            (state.forget(self.window), focused)
        };
        if let Some(compositor) = server.compositor() {
            compositor.remove(self.window);
            for panel in panels {
                compositor.remove(panel);
            }
        }
        if focused {
            let parent = gone.as_ref().and_then(|e| e.parent).filter(|p| server.state().entries.get(p).is_some_and(|e| e.opened && !e.hidden));
            match parent {
                Some(parent) => server.activate(parent),
                None => server.focus_top(),
            }
        }
        server.relayout();
        let Some(entry) = gone else { return };
        if entry.desktop || entry.panel || entry.mode == Mode::Pinned {
            return;
        }
        let [x, y, w, h] = entry.restore.normal_rect(entry.state, entry.rect);
        server.broker.push(Event {
            kind: "windowgone".into(),
            window: Some(self.window),
            x: Some(x),
            y: Some(y),
            width: Some(w),
            height: Some(h),
            ..Default::default()
        });
    }
}
