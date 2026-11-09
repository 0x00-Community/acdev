use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use acde_model::{Event, Inbox, Mode, Waker};
use acde_render::{RenderHandle, SurfaceCommand};

use crate::app::server;
use crate::platform::{self, Cmd};
use crate::present::Presenter;

pub(crate) enum Msg {
    Wake,
    Frame,
    Resized(u32, u32, f64),
    Scroll(f64, f64, f64, f64),
    Panel(u32, Option<u32>),
    Title(String),
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
    let (was, rect) = {
        let mut state = server.state();
        let [sw, sh, _] = state.screen;
        let Some(entry) = state.entries.get_mut(&id) else { return };
        if entry.desktop || entry.mode == mode {
            return;
        }
        let was = entry.mode;
        entry.mode = mode;
        let rect = if mode == Mode::Fullscreen {
            entry.before_fullscreen = Some(entry.rect);
            Some([0.0, 0.0, sw, sh])
        } else if was == Mode::Fullscreen {
            entry.before_fullscreen.take()
        } else {
            None
        };
        (was, rect)
    };
    if let Some(rect) = rect {
        server.set_rect(id, rect);
    }
    if mode == Mode::Fullscreen {
        server.broker.push(Event { kind: "windowfullscreen".into(), window: Some(id), ..Default::default() });
    } else if was == Mode::Fullscreen {
        server.broker.push(Event { kind: "windowunfullscreen".into(), window: Some(id), ..Default::default() });
    }
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
            let (scale, refresh, unfocused) = (state.screen[2], state.refresh, state.focus.is_none());
            let entry = state.entries.get_mut(&id).ok_or("claimSurface: window is gone")?;
            entry.frame = if entry.desktop || entry.panel { 0.0 } else { f64::from(frame) };
            entry.inbox = Some(inbox.clone());
            entry.link = Some(link.clone());
            entry.app = app;
            entry.opened = true;
            let focus = !entry.hidden && (!entry.desktop || unfocused);
            let bar = entry.bar();
            (id, state.content(&state.entries[&id]), scale, refresh, focus, bar)
        };
        let wake = link.clone();
        render.set_waker(Box::new(move || wake.send(Msg::Wake)));
        let gpu = server.gpu.clone();
        let events = inbox.clone();
        let thread = std::thread::Builder::new()
            .name(format!("acde-host-{window}"))
            .spawn(move || {
                match Presenter::new(window, gpu, size, scale, refresh, bar, render, events.clone()) {
                    Ok(mut presenter) => presenter.run(&rx),
                    Err(e) => log::error!("window {window}: {e}"),
                }
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
            server.relayout();
        }
    }

    pub fn content_offset(&self) -> (f64, f64) {
        let frame = server().and_then(|s| s.state().entries.get(&self.window).map(|e| e.frame));
        (0.0, frame.unwrap_or(0.0))
    }

    fn set_title(&self, title: &str) {
        let Some(server) = server() else { return };
        let framed = match server.state().entries.get_mut(&self.window) {
            Some(e) => {
                e.title = title.to_owned();
                e.frame > 0.0
            }
            None => false,
        };
        if framed {
            self.link.send(Msg::Title(title.to_owned()));
        }
        if self.window == 0 {
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
            (state.entries.remove(&self.window), focused)
        };
        if let Some(compositor) = server.compositor() {
            compositor.remove(self.window);
            for panel in panels {
                compositor.remove(panel);
            }
        }
        if focused {
            server.focus_top();
        }
        server.relayout();
        let Some(entry) = gone else { return };
        if entry.desktop || entry.panel || entry.mode == Mode::Pinned {
            return;
        }
        let [x, y, w, h] = entry.before_fullscreen.unwrap_or(entry.rect);
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
