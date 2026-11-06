use std::collections::HashMap;
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use acde_model::{Event, Inbox, Waker};

use crate::app::{Cmd, server};
use crate::present::Presenter;
use crate::shell::Mode;

const OPEN_WAIT: Duration = Duration::from_secs(10);

pub struct DragImage {
    pub width: u32,
    pub height: u32,
    pub scene: acde_render::acgpu::Scene,
    pub hotspot: (i32, i32),
}

pub(crate) enum Msg {
    Wake,
    Frame,
    Resized(u32, u32, f64),
    Panel(u32, Option<[f64; 4]>),
    Redraw,
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
    fn send(&self, msg: Msg) {
        let _ = self.0.send(msg);
    }

    pub fn resized(&self, width: u32, height: u32, scale: f64) {
        self.send(Msg::Resized(width, height, scale));
    }

    pub fn redraw(&self) {
        self.send(Msg::Redraw);
    }

    pub fn place(&self, _: [f64; 4]) {}

    pub fn capture(&self, wait: Duration) -> Result<Shot, String> {
        let (reply, got) = mpsc::sync_channel(1);
        self.0.send(Msg::Capture(reply)).map_err(|_| "the window is gone".to_owned())?;
        got.recv_timeout(wait).map_err(|_| "the window did not answer".to_owned())?
    }
}

pub struct Surface {
    window: u32,
    inbox: Arc<Inbox>,
    link: Link,
    thread: Option<JoinHandle<()>>,
}

pub(crate) fn set_mode(id: u32, mode: Mode) {
    let Some(server) = server() else { return };
    let mut state = server.state();
    let Some(entry) = state.entries.get_mut(&id) else {
        return;
    };
    if entry.desktop || entry.mode == mode {
        return;
    }
    let was = entry.mode;
    if mode == Mode::Fullscreen {
        entry.before_fullscreen = Some(entry.rect);
    }
    entry.mode = mode;
    let restore = if was == Mode::Fullscreen {
        entry.before_fullscreen.take()
    } else {
        None
    };
    drop(state);
    if mode == Mode::Fullscreen {
        server.send(Cmd::Fullscreen(id, true));
        server.broker.push(Event {
            kind: "windowfullscreen".into(),
            window: Some(id),
            ..Default::default()
        });
    } else if was == Mode::Fullscreen {
        server.send(Cmd::Fullscreen(id, false));
        if let Some(rect) = restore {
            server.send(Cmd::Place(id, rect));
        }
        server.broker.push(Event {
            kind: "windowunfullscreen".into(),
            window: Some(id),
            ..Default::default()
        });
    }
}

impl Surface {
    pub fn claim(token: u64, render: acde_render::RenderHandle) -> Result<Self, String> {
        let server = server().ok_or("claimSurface: 没有宿主窗口")?;
        let inbox = Arc::new(Inbox::default());
        let (tx, rx) = mpsc::channel();
        let link = Link(tx);
        let window = {
            let mut state = server.state();
            let id = state
                .tokens
                .remove(&token)
                .ok_or("claimSurface: 令牌不对, 或者用过了")?;
            let entry = state.entries.get_mut(&id).ok_or("claimSurface: 窗口没了")?;
            entry.inbox = Some(inbox.clone());
            entry.link = Some(link.clone());
            id
        };
        let (reply, got) = mpsc::sync_channel(1);
        server.send(Cmd::Open { id: window, reply });
        let opened = got
            .recv_timeout(OPEN_WAIT)
            .map_err(|_| "claimSurface: 宿主窗口没有开出来".to_owned())??;
        let wake = link.clone();
        render.set_waker(Box::new(move || wake.send(Msg::Wake)));
        let gpu = server.gpu.clone();
        let events = inbox.clone();
        let thread = std::thread::Builder::new()
            .name(format!("acde-host-{window}"))
            .spawn(move || {
                match Presenter::new(window, gpu, opened, render, events.clone()) {
                    Ok(mut presenter) => presenter.run(rx),
                    Err(e) => log::error!("窗口 {window}: {e}"),
                }
                events.push(Event::named("exit"));
            })
            .map_err(|e| format!("窗口线程: {e}"))?;
        Ok(Self {
            window,
            inbox,
            link,
            thread: Some(thread),
        })
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

    pub fn request_frame(&self) {
        self.link.send(Msg::Frame);
    }

    pub fn set_clipboard(&self, text: String) {
        match arboard::Clipboard::new().and_then(|mut c| c.set_text(text)) {
            Ok(()) => {}
            Err(e) => log::warn!("剪贴板: {e}"),
        }
    }

    pub fn read_clipboard(&self, reply: Box<dyn FnOnce(String) + Send>) {
        let text = arboard::Clipboard::new()
            .and_then(|mut c| c.get_text())
            .unwrap_or_default();
        reply(text);
    }

    pub fn start_drag(&self, _: HashMap<String, String>, _: Option<DragImage>) {
        self.inbox.push(Event {
            kind: "dragend".into(),
            button: Some(0),
            ..Default::default()
        });
    }

    pub fn request_mode(&self, mode: u32) {
        if let Some(mode) = Mode::from_code(mode) {
            set_mode(self.window, mode);
        }
    }

    pub fn set_grab_hint(&self, [x, y, w, h]: [i32; 4], edges: u32) {
        let Some(server) = server() else { return };
        let mut state = server.state();
        let Some(entry) = state.entries.get_mut(&self.window) else {
            return;
        };
        if w <= 0 || h <= 0 {
            entry.hints.clear();
        } else {
            entry.hints.push(([x, y, w, h].map(f64::from), edges));
        }
    }

    pub fn set_backdrop(&self, _: [i32; 4], _: [f64; 4]) {}

    pub fn request_activate(&self) {
        if let Some(server) = server() {
            server.state().raise(self.window);
            server.send(Cmd::Focus(self.window));
        }
    }

    pub fn request_grab(&self, kind: u32, on: bool) {
        if !on {
            return;
        }
        let name = if kind == 2 { "keyboard" } else { "pointer" };
        self.inbox.push(Event {
            kind: "grab".into(),
            key: Some(name.into()),
            code: Some(1),
            ..Default::default()
        });
    }

    pub fn open_panel(&self, id: u32, token: u64, rect: [i32; 4]) {
        if let Some(server) = server() {
            let mut state = server.state();
            if let Some(panel) = state.tokens.remove(&token)
                && let Some(e) = state.entries.get_mut(&panel)
            {
                e.rect = rect.map(f64::from);
                e.opened = true;
            }
        }
        self.link.send(Msg::Panel(id, Some(rect.map(f64::from))));
    }

    pub fn place_panel(&self, id: u32, rect: [i32; 4], _: [i32; 4]) {
        self.link.send(Msg::Panel(id, Some(rect.map(f64::from))));
    }

    pub fn close_panel(&self, id: u32) {
        self.link.send(Msg::Panel(id, None));
    }

    pub fn set_title(&self, title: &str) {
        let Some(server) = server() else { return };
        if let Some(e) = server.state().entries.get_mut(&self.window) {
            e.title = title.to_owned();
        }
        server.send(Cmd::Title(self.window, title.to_owned()));
    }

    pub fn set_ime_area(&self, rect: [f64; 4]) {
        if let Some(server) = server() {
            server.send(Cmd::ImeArea(self.window, rect));
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
        let gone = {
            let mut state = server.state();
            state.tokens.retain(|_, w| *w != self.window);
            state.shortcuts.forget(self.window);
            if state.focus == Some(self.window) {
                state.focus = None;
            }
            state.entries.remove(&self.window)
        };
        server.send(Cmd::Close(self.window));
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
