use std::io;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::process::{Command as Process, Stdio};
use std::sync::Arc;

use acde_model::{Easing, Mode, Scope};
use smithay::backend::input::AxisSource;
use smithay::reexports::calloop::channel;
use smithay::reexports::wayland_server::{Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource};

use super::{Animate, Command, Compositor, Grant, Injected, handlers::ClientState};

mod generated {
    #![allow(dead_code, non_camel_case_types, unused_unsafe, unused_variables, non_upper_case_globals, non_snake_case, unused_imports, clippy::all)]

    use smithay::reexports::wayland_server;
    use smithay::reexports::wayland_server::protocol::*;

    pub mod __interfaces {
        use smithay::reexports::wayland_server::backend as wayland_backend;
        use smithay::reexports::wayland_server::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../model/protocol/acde-shell.xml");
    }

    use self::__interfaces::*;

    wayland_scanner::generate_server_code!("../model/protocol/acde-shell.xml");
}

use generated::acde_shell::{AcdeShell, Animated, Easing as WireEasing, Mode as WireMode, Request, Scope as WireScope, WheelSource};
use generated::acde_shell_list::AcdeShellList;
use generated::acde_shell_result::AcdeShellResult;
use generated::acde_shell_stats::AcdeShellStats;

#[derive(Clone, Debug)]
pub enum ShellEvent {
    Output { width: i32, height: i32, scale: f64, name: String, description: String, refresh: i32 },
    WindowOpen { window: u32, title: Option<String>, app_id: Option<String> },
    WindowClose(Option<u32>),
    WindowTitle { window: Option<u32>, title: Option<String>, app_id: Option<String> },
    WindowFullscreen { window: u32, fullscreen: bool },
    WindowMinimize(Option<u32>),
    WindowActivate(Option<u32>),
    WindowAnimated(u32),
    Shortcut { owner: u32, key: Option<String>, scope: Scope },
    WindowGone { window: Option<u32>, rect: [i32; 4] },
    WindowMinSize { window: Option<u32>, width: i32, height: i32 },
    WindowParent { window: u32, parent: Option<u32> },
    Milestone { title: &'static str, ms: f64 },
    InputTarget { window: Option<u32>, x: f64, y: f64, button: u32 },
}

#[derive(Default)]
pub struct ShellLink {
    bound: Vec<AcdeShell>,
    backlog: Vec<ShellEvent>,
}

impl ShellLink {
    const BACKLOG: usize = 256;

    pub fn emit(&mut self, event: ShellEvent) {
        self.bound.retain(Resource::is_alive);
        if self.bound.is_empty() {
            if self.backlog.len() < Self::BACKLOG {
                self.backlog.push(event);
            }
            return;
        }
        for shell in &self.bound {
            event.send(shell);
        }
    }

    fn bind(&mut self, shell: AcdeShell) -> bool {
        let first = !self.backlog.is_empty();
        for event in self.backlog.drain(..) {
            event.send(&shell);
        }
        self.bound.push(shell.clone());
        first
    }
}

trait Wire {
    fn wire(self) -> i32;
}

impl Wire for Option<u32> {
    fn wire(self) -> i32 {
        self.and_then(|v| i32::try_from(v).ok()).unwrap_or(-1)
    }
}

impl ShellEvent {
    fn send(&self, shell: &AcdeShell) {
        match self.clone() {
            Self::Output { width, height, scale, name, description, refresh } => shell.output(width, height, scale, name, description, refresh),
            Self::WindowOpen { window, title, app_id } => shell.window_open(window, title, app_id),
            Self::WindowClose(window) => shell.window_close(window.wire()),
            Self::WindowTitle { window, title, app_id } => shell.window_title(window.wire(), title, app_id),
            Self::WindowFullscreen { window, fullscreen } => shell.window_fullscreen(window, fullscreen.into()),
            Self::WindowMinimize(window) => shell.window_minimize(window.wire()),
            Self::WindowActivate(window) => shell.window_activate(window.wire()),
            Self::WindowAnimated(window) => shell.window_animated(window),
            Self::Shortcut { owner, key, scope } => shell.shortcut(owner, key, scope.into()),
            Self::WindowGone { window, rect: [x, y, w, h] } => shell.window_gone(window.wire(), x, y, w, h),
            Self::WindowMinSize { window, width, height } => shell.window_min_size(window.wire(), width, height),
            Self::WindowParent { window, parent } => shell.window_parent(window, parent.wire()),
            Self::Milestone { title, ms } => shell.milestone(title.into(), ms),
            Self::InputTarget { window, x, y, button } => shell.input_target(window.wire(), x, y, button),
        }
    }
}

impl From<Mode> for WireMode {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Fullscreen => Self::Fullscreen,
            Mode::Free => Self::Free,
            Mode::Fixed => Self::Fixed,
            Mode::Pinned => Self::Pinned,
        }
    }
}

impl From<WireMode> for Mode {
    fn from(mode: WireMode) -> Self {
        match mode {
            WireMode::Fullscreen => Self::Fullscreen,
            WireMode::Free => Self::Free,
            WireMode::Fixed => Self::Fixed,
            WireMode::Pinned => Self::Pinned,
        }
    }
}

impl From<Scope> for WireScope {
    fn from(scope: Scope) -> Self {
        match scope {
            Scope::Session => Self::Session,
            Scope::Desktop => Self::Desktop,
            Scope::App => Self::App,
        }
    }
}

impl From<WireScope> for Scope {
    fn from(scope: WireScope) -> Self {
        match scope {
            WireScope::Session => Self::Session,
            WireScope::Desktop => Self::Desktop,
            WireScope::App => Self::App,
        }
    }
}

impl From<WireEasing> for Easing {
    fn from(easing: WireEasing) -> Self {
        match easing {
            WireEasing::Linear => Self::Linear,
            WireEasing::Ease => Self::Ease,
            WireEasing::EaseIn => Self::EaseIn,
            WireEasing::EaseOut => Self::EaseOut,
            WireEasing::EaseInOut => Self::EaseInOut,
        }
    }
}

impl From<WheelSource> for AxisSource {
    fn from(source: WheelSource) -> Self {
        match source {
            WheelSource::Wheel => Self::Wheel,
            WheelSource::Finger => Self::Finger,
            WheelSource::Continuous => Self::Continuous,
        }
    }
}

impl Compositor {
    pub fn acde_shell_global(dh: &DisplayHandle) {
        dh.create_global::<Compositor, AcdeShell, ()>(1, ());
    }

    pub fn insert_shell_client(&mut self, stream: UnixStream) -> Result<(), String> {
        self.display.insert_client(stream, Arc::new(ClientState { shell: true, ..Default::default() })).map(drop).map_err(|e| format!("acde_shell 连接: {e}"))
    }

    pub fn launch(&self, argv: &[String], cwd: &str, env: &[(String, String)]) -> io::Result<u32> {
        let (program, args) = argv.split_first().ok_or_else(|| io::Error::other("argv 为空"))?;
        let mut process = Process::new(program);
        let out = std::io::stdout().as_fd().try_clone_to_owned()?;
        let err = std::io::stderr().as_fd().try_clone_to_owned()?;
        process.args(args).env("WAYLAND_DISPLAY", &self.socket).stdin(Stdio::null()).stdout(out).stderr(err);
        process.env_remove("DISPLAY");
        process.envs(env.iter().map(|(k, v)| (k, v)));
        if !cwd.is_empty() {
            process.current_dir(cwd);
        }
        let mut child = process.spawn()?;
        let pid = child.id();
        std::thread::spawn(move || child.wait());
        Ok(pid)
    }

    fn shell_screenshot(&mut self, path: String, reply: AcdeShellResult) {
        let (tx, rx) = std::sync::mpsc::channel();
        self.on_command(Command::Screenshot(path.into(), tx));
        let (to_loop, from_thread) = channel::channel();
        let inserted = self.loop_handle.insert_source(from_thread, move |event, _, _| {
            if let channel::Event::Msg(result) = event {
                Self::answer(&reply, result);
            }
        });
        if let Err(e) = inserted {
            log::warn!("acde_shell.screenshot: {e}");
            return;
        }
        std::thread::spawn(move || {
            let result = rx.recv().unwrap_or_else(|_| Err("截屏没有结果".into()));
            let _ = to_loop.send(result);
        });
    }

    fn answer(reply: &AcdeShellResult, result: Result<(u32, u32), String>) {
        match result {
            Ok((first, second)) => reply.done(first, second),
            Err(message) => reply.failed(message),
        }
    }

    fn shell_request(&mut self, request: Request, data_init: &mut DataInit<'_, Self>) {
        let command = match request {
            Request::Grant { token_hi, token_lo, window, desktop, mode, x, y, width, height, size_width, size_height } => {
                let token = (u64::from(token_hi) << 32) | u64::from(token_lo);
                let mode = mode.into_result().map_or(Mode::Free, Mode::from);
                let rect = (width > 0 && height > 0).then_some([x, y, width, height]);
                let size = (size_width > 0 && size_height > 0).then_some([size_width, size_height]);
                Command::Grant(token, Grant { id: window, desktop: desktop != 0, mode, rect, size })
            }
            Request::Release { window } => Command::Release(window),
            Request::Focus { window } => Command::Focus(window),
            Request::Hide { window, hidden } => Command::Hide { window, hidden: hidden != 0 },
            Request::Close { window } => Command::Close(window),
            Request::Place { window, x, y, width, height } => Command::Place { window, x, y, width, height },
            Request::Raise { window, above } => Command::Raise { window, above: u32::try_from(above).ok() },
            Request::SetMode { window, mode } => {
                let Ok(mode) = mode.into_result() else { return };
                Command::SetMode { window, mode: mode.into() }
            }
            Request::List { callback } => {
                let callback = data_init.init(callback, ());
                let (tx, rx) = std::sync::mpsc::channel();
                self.on_command(Command::List(tx));
                let (windows, canvases) = rx.try_recv().ok().unwrap_or_default();
                for w in windows {
                    let mode = w.mode.into();
                    callback.window(w.id, w.window.wire(), w.canvas, mode, w.x, w.y, w.width, w.height, w.z, w.focus.into(), w.hidden.into(), w.pid.wire());
                }
                for c in canvases {
                    callback.canvas(c.id, c.x, c.y, c.width, c.height, c.scale);
                }
                callback.done();
                return;
            }
            Request::Stats { reset, callback } => {
                let callback = data_init.init(callback, ());
                let (tx, rx) = std::sync::mpsc::channel();
                self.on_command(Command::Stats(reset != 0, tx));
                let s = rx.try_recv().ok().unwrap_or_default();
                callback.done(s.frames, s.compose_p50, s.compose_p95, s.compose_max, s.plans, s.direct);
                return;
            }
            Request::SetScale { output, scale, callback } => {
                let callback = data_init.init(callback, ());
                let (tx, rx) = std::sync::mpsc::channel();
                self.on_command(Command::SetScale { output, scale, reply: tx });
                Self::answer(&callback, rx.try_recv().ok().unwrap_or_else(|| Err("缩放没有结果".into())).map(|()| (0, 0)));
                return;
            }
            Request::Screenshot { path, callback } => {
                let callback = data_init.init(callback, ());
                self.shell_screenshot(path, callback);
                return;
            }
            Request::InjectMove { x, y } => Command::Inject(Injected::Move((x, y).into())),
            Request::InjectMotion { dx, dy } => Command::Inject(Injected::Motion((dx, dy).into())),
            Request::InjectButton { button, pressed } => Command::Inject(Injected::Button { button, pressed: pressed != 0 }),
            Request::InjectWheel { dx, dy, source } => {
                let source = source.into_result().map_or(AxisSource::Wheel, AxisSource::from);
                Command::Inject(Injected::Wheel { delta: (dx, dy).into(), source })
            }
            Request::InjectKey { code, pressed } => Command::Inject(Injected::Key { code, pressed: pressed != 0 }),
            Request::Animate { window, given, opacity, scale, dx, dy, duration_ms, delay_ms, easing } => {
                let given = given.into_result().unwrap_or(Animated::empty());
                let pick = |flag: Animated, v: f64| given.contains(flag).then_some(v);
                let easing = given.contains(Animated::Easing).then(|| easing.into_result().ok().map(Easing::from)).flatten();
                let spec = Animate {
                    opacity: pick(Animated::Opacity, opacity),
                    scale: pick(Animated::Scale, scale),
                    dx: pick(Animated::Dx, dx),
                    dy: pick(Animated::Dy, dy),
                    duration_ms: duration_ms.into(),
                    delay_ms: delay_ms.into(),
                    easing,
                };
                Command::Animate(window, spec)
            }
            Request::Shortcut { combo, scope, owner, callback } => {
                let callback = data_init.init(callback, ());
                let Ok(scope) = scope.into_result() else { return callback.failed("acde_shell.shortcut: 不认识的 scope".into()) };
                let (tx, rx) = std::sync::mpsc::channel();
                self.on_command(Command::Shortcut { combo, scope: scope.into(), owner, reply: tx });
                Self::answer(&callback, rx.try_recv().ok().unwrap_or_else(|| Err("快捷键没有结果".into())).map(|()| (0, 0)));
                return;
            }
            Request::Unshortcut { combo, scope, owner } => {
                let Ok(scope) = scope.into_result() else { return };
                Command::Unshortcut { combo, scope: scope.into(), owner }
            }
            Request::Launch { argv, cwd, env, callback } => {
                let callback = data_init.init(callback, ());
                let strings = |bytes: &[u8]| bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect::<Vec<_>>();
                let env: Vec<(String, String)> = strings(&env).into_iter().filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned()))).collect();
                Self::answer(&callback, self.launch(&strings(&argv), &cwd, &env).map(|pid| (pid, 0)).map_err(|e| e.to_string()));
                return;
            }
            Request::Quit => Command::Quit,
        };
        self.on_command(command);
    }
}

impl GlobalDispatch<AcdeShell, ()> for Compositor {
    fn bind(state: &mut Self, _: &DisplayHandle, _: &Client, resource: New<AcdeShell>, _: &(), data_init: &mut DataInit<'_, Self>) {
        let shell = data_init.init(resource, ());
        if !state.shell.bind(shell.clone())
            && let Some(event) = state.output_event()
        {
            event.send(&shell);
        }
    }

    fn can_view(client: Client, _: &()) -> bool {
        client.get_data::<ClientState>().is_some_and(|c| c.shell)
    }
}

impl Dispatch<AcdeShell, ()> for Compositor {
    fn request(state: &mut Self, _: &Client, _: &AcdeShell, request: Request, _: &(), _: &DisplayHandle, data_init: &mut DataInit<'_, Self>) {
        state.shell_request(request, data_init);
    }
}

macro_rules! replies {
    ($($t:ty),*) => {$(
        impl Dispatch<$t, ()> for Compositor {
            fn request(_: &mut Self, _: &Client, _: &$t, request: <$t as Resource>::Request, _: &(), _: &DisplayHandle, _: &mut DataInit<'_, Self>) {
                match request {}
            }
        }
    )*};
}

replies!(AcdeShellList, AcdeShellStats, AcdeShellResult);

