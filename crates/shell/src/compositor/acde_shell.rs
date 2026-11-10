use std::io;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::process::{Command as Process, Stdio};
use std::sync::Arc;

use acde_model::{Easing, Injected, Mode, Scope, WheelSource, WindowState};
use smithay::reexports::calloop::channel;
use smithay::reexports::wayland_server::{Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource};

use super::{Animate, Compositor, Grant, handlers::ClientState};

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

use generated::acde_shell::{AcdeShell, Animated, Request};
use generated::acde_shell_list::AcdeShellList;
use generated::acde_shell_result::AcdeShellResult;
use generated::acde_shell_stats::AcdeShellStats;

#[derive(Clone, Debug)]
pub enum ShellEvent {
    Output { width: i32, height: i32, scale: f64 },
    WindowOpen { window: u32, title: Option<String>, app_id: Option<String> },
    WindowClose(Option<u32>),
    WindowTitle { window: Option<u32>, title: Option<String>, app_id: Option<String> },
    WindowState { window: u32, state: WindowState, previous: WindowState },
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

fn wire(v: Option<u32>) -> i32 {
    v.and_then(|v| i32::try_from(v).ok()).unwrap_or(-1)
}

impl ShellEvent {
    fn send(&self, shell: &AcdeShell) {
        match self.clone() {
            Self::Output { width, height, scale } => shell.output(width, height, scale),
            Self::WindowOpen { window, title, app_id } => shell.window_open(window, title, app_id),
            Self::WindowClose(window) => shell.window_close(wire(window)),
            Self::WindowTitle { window, title, app_id } => shell.window_title(wire(window), title, app_id),
            Self::WindowState { window, state, previous } => shell.window_state(window, state as u32, previous as u32),
            Self::WindowActivate(window) => shell.window_activate(wire(window)),
            Self::WindowAnimated(window) => shell.window_animated(window),
            Self::Shortcut { owner, key, scope } => shell.shortcut(owner, key, scope as u32),
            Self::WindowGone { window, rect: [x, y, w, h] } => shell.window_gone(wire(window), x, y, w, h),
            Self::WindowMinSize { window, width, height } => shell.window_min_size(wire(window), width, height),
            Self::WindowParent { window, parent } => shell.window_parent(window, wire(parent)),
            Self::Milestone { title, ms } => shell.milestone(title.into(), ms),
            Self::InputTarget { window, x, y, button } => shell.input_target(wire(window), x, y, button),
        }
    }
}

impl Compositor {
    pub fn acde_shell_global(dh: &DisplayHandle) {
        dh.create_global::<Compositor, AcdeShell, ()>(1, ());
    }

    pub fn insert_shell_client(&mut self, stream: UnixStream) -> Result<(), String> {
        self.display
            .insert_client(stream, Arc::new(ClientState { shell: true, ..Default::default() }))
            .map(drop)
            .map_err(|e| format!("acde_shell connection: {e}"))
    }

    pub fn launch(&self, argv: &[String], cwd: &str, env: &[(String, String)]) -> io::Result<u32> {
        let (program, args) = argv.split_first().ok_or_else(|| io::Error::other("empty argv"))?;
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
        let (w, h, rgba) = match self.capture() {
            Ok(shot) => shot,
            Err(e) => return reply.failed(e),
        };
        let (to_loop, from_thread) = channel::channel();
        let inserted = self.loop_handle.insert_source(from_thread, move |event, _, _| {
            if let channel::Event::Msg(result) = event {
                Self::answer(&reply, result);
            }
        });
        if let Err(e) = inserted {
            log::warn!("acde_shell.screenshot: {e}");
        }
        std::thread::spawn(move || _ = to_loop.send(Self::write_png(path.as_ref(), w, h, &rgba).map(|()| (w, h))));
    }

    fn answer(reply: &AcdeShellResult, result: Result<(u32, u32), String>) {
        match result {
            Ok((first, second)) => reply.done(first, second),
            Err(message) => reply.failed(message),
        }
    }

    fn list_windows(&self, callback: &AcdeShellList) {
        let Some(canvas) = self.canvas.and_then(|c| self.table.canvas(c)) else { return };
        for (z, &managed) in canvas.z.iter().enumerate() {
            let Some(w) = self.table.window(managed) else { continue };
            let id = managed.0;
            let surface = self.window(id).and_then(|w| w.toplevel().map(|t| t.wl_surface().clone()));
            let window = surface.as_ref().and_then(Self::bound).map(|g| g.id);
            let pid = surface.and_then(|s| s.client()).and_then(|c| c.get_credentials(&self.display).ok()).and_then(|c| u32::try_from(c.pid).ok());
            let (r, focus, hidden) = (w.rect, canvas.focus == Some(managed), self.hidden.contains(&id));
            callback.window(
                id,
                wire(window),
                0,
                w.mode as u32,
                r.x as i32,
                r.y as i32,
                r.w as u32,
                r.h as u32,
                z as i32,
                focus.into(),
                hidden.into(),
                wire(pid),
            );
        }
    }

    fn shell_request(&mut self, request: Request, data_init: &mut DataInit<'_, Self>) {
        match request {
            Request::Grant { token_hi, token_lo, window, desktop, mode, x, y, width, height, size_width, size_height, parent, modal } => {
                let token = (u64::from(token_hi) << 32) | u64::from(token_lo);
                let mode = Mode::try_from(mode).unwrap_or(Mode::Free);
                let rect = (width > 0 && height > 0).then_some([x, y, width, height]);
                let size = (size_width > 0 && size_height > 0).then_some([size_width, size_height]);
                let parent = u32::try_from(parent).ok().filter(|p| *p != window);
                let grant = Grant { id: window, desktop: desktop != 0, mode, rect, size, parent, modal: modal != 0 && parent.is_some() };
                self.grants.insert(token, grant);
            }
            Request::Release { window } => self.grants.retain(|_, g| g.id != window),
            Request::Focus { window } if self.minimized.contains_key(&window) => self.hide(window, false),
            Request::Focus { window } => {
                if let Some(window) = self.window(window) {
                    self.focus_window(Some(&window));
                }
            }
            Request::Hide { window, hidden } => self.hide(window, hidden != 0),
            Request::Close { window } => {
                if let Some(toplevel) = self.window(window).as_ref().and_then(|w| w.toplevel()) {
                    toplevel.send_close();
                }
            }
            Request::Place { window, x, y, width, height } => self.place_managed(window, x, y, width, height),
            Request::List { callback } => {
                let callback = data_init.init(callback, ());
                self.list_windows(&callback);
                callback.done();
            }
            Request::Stats { reset, callback } => {
                let s = self.stats(reset != 0);
                data_init.init(callback, ()).done(s.frames, s.compose_p50, s.compose_p95, s.compose_max, s.plans, s.direct);
            }
            Request::Screenshot { path, callback } => {
                let callback = data_init.init(callback, ());
                self.shell_screenshot(path, callback);
            }
            Request::InjectMove { x, y } => self.inject(Injected::Move(x, y)),
            Request::InjectMotion { dx, dy } => self.inject(Injected::Motion(dx, dy)),
            Request::InjectButton { button, pressed } => self.inject(Injected::Button { button, pressed: pressed != 0 }),
            Request::InjectWheel { dx, dy, source } => {
                self.inject(Injected::Wheel { dx, dy, source: WheelSource::try_from(source).unwrap_or(WheelSource::Wheel) })
            }
            Request::InjectKey { code, pressed } => self.inject(Injected::Key { code, pressed: pressed != 0 }),
            Request::Animate { window, given, opacity, scale, dx, dy, duration_ms, delay_ms, easing } => {
                let given = given.into_result().unwrap_or(Animated::empty());
                let pick = |flag: Animated, v: f64| given.contains(flag).then_some(v);
                let spec = Animate {
                    opacity: pick(Animated::Opacity, opacity),
                    scale: pick(Animated::Scale, scale),
                    dx: pick(Animated::Dx, dx),
                    dy: pick(Animated::Dy, dy),
                    duration_ms: duration_ms.into(),
                    delay_ms: delay_ms.into(),
                    easing: given.contains(Animated::Easing).then(|| Easing::try_from(easing).ok()).flatten(),
                };
                self.animate(window, spec);
            }
            Request::Shortcut { combo, scope, owner, callback } => {
                let callback = data_init.init(callback, ());
                let Ok(scope) = Scope::try_from(scope) else { return callback.failed("acde_shell.shortcut: unknown scope".into()) };
                Self::answer(&callback, self.register_shortcut(&combo, scope, owner).map(|()| (0, 0)));
            }
            Request::Unshortcut { combo, scope, owner } => {
                if let Ok(scope) = Scope::try_from(scope) {
                    self.unregister_shortcut(&combo, scope, owner);
                }
            }
            Request::Launch { argv, cwd, env, callback } => {
                let callback = data_init.init(callback, ());
                let strings =
                    |bytes: &[u8]| bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect::<Vec<_>>();
                let env: Vec<(String, String)> =
                    strings(&env).into_iter().filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned()))).collect();
                Self::answer(&callback, self.launch(&strings(&argv), &cwd, &env).map(|pid| (pid, 0)).map_err(|e| e.to_string()));
            }
            Request::Quit => self.quit(),
        }
    }
}

impl GlobalDispatch<AcdeShell, ()> for Compositor {
    fn bind(state: &mut Self, _: &DisplayHandle, _: &Client, resource: New<AcdeShell>, _: &(), data_init: &mut DataInit<'_, Self>) {
        let shell = data_init.init(resource, ());
        if !state.shell.bind(shell.clone())
            && let Some(mode) = state.backend.output.current_mode()
        {
            ShellEvent::Output { width: mode.size.w, height: mode.size.h, scale: state.scale() }.send(&shell);
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
