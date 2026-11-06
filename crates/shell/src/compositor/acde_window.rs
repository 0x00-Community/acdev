use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::{Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New};
use smithay::wayland::compositor::with_states;

use super::Compositor;

mod generated {
    #![allow(dead_code, non_camel_case_types, unused_unsafe, unused_variables, non_upper_case_globals, non_snake_case, unused_imports, clippy::all)]

    use smithay::reexports::wayland_server;
    use smithay::reexports::wayland_server::protocol::*;

    pub mod __interfaces {
        use smithay::reexports::wayland_server::backend as wayland_backend;
        use smithay::reexports::wayland_server::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../model/protocol/acde-window.xml");
    }

    use self::__interfaces::*;

    wayland_scanner::generate_server_code!("../model/protocol/acde-window.xml");
}

pub use generated::acde_window::{AcdeWindow, GrabKind as WireGrab, GrabLostReason as WireLost};
pub use generated::acde_window_manager::AcdeWindowManager;

#[derive(Clone, Copy, Debug)]
pub struct Grant {
    pub id: u32,
    pub desktop: bool,
    pub mode: acde_model::Mode,
    pub rect: Option<[i32; 4]>,
    pub size: Option<[i32; 2]>,
}

#[derive(Clone, Copy, Debug)]
pub struct Bound(pub Grant);

pub struct WindowRequests {
    pub surface: WlSurface,
}

#[derive(Default)]
pub struct Hints {
    pub grab: Vec<([i32; 4], u32)>,
    pub backdrop: Option<([i32; 4], [f64; 4])>,
}

struct Resource(std::sync::Mutex<AcdeWindow>);

impl Compositor {
    pub fn acde_window_global(dh: &DisplayHandle) {
        dh.create_global::<Compositor, AcdeWindowManager, ()>(1, ());
    }

    pub fn bound(surface: &WlSurface) -> Option<Grant> {
        with_states(surface, |s| s.data_map.get::<Bound>().map(|b| b.0))
    }

    pub fn acde_resource(surface: &WlSurface) -> Option<AcdeWindow> {
        with_states(surface, |s| Some(s.data_map.get::<Resource>()?.0.lock().ok()?.clone()))
    }

    pub fn with_hints<R>(surface: &WlSurface, f: impl FnOnce(&Hints) -> R) -> Option<R> {
        with_states(surface, |s| Some(f(&*s.data_map.get::<std::sync::Mutex<Hints>>()?.lock().ok()?)))
    }
}

impl GlobalDispatch<AcdeWindowManager, ()> for Compositor {
    fn bind(_: &mut Self, _: &DisplayHandle, _: &Client, resource: New<AcdeWindowManager>, _: &(), data_init: &mut DataInit<'_, Self>) {
        data_init.init(resource, ());
    }
}

impl Dispatch<AcdeWindowManager, ()> for Compositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &AcdeWindowManager,
        request: generated::acde_window_manager::Request,
        _: &(),
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        if let generated::acde_window_manager::Request::GetWindow { id, surface } = request {
            let window = data_init.init(id, WindowRequests { surface: surface.clone() });
            with_states(&surface, |s| {
                if let Ok(mut slot) = s.data_map.get_or_insert_threadsafe(|| Resource(std::sync::Mutex::new(window.clone()))).0.lock() {
                    *slot = window;
                }
            });
        }
    }
}

impl Dispatch<AcdeWindow, WindowRequests> for Compositor {
    fn request(
        state: &mut Self,
        _: &Client,
        resource: &AcdeWindow,
        request: generated::acde_window::Request,
        data: &WindowRequests,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        use generated::acde_window::Request;
        let surface = &data.surface;
        match request {
            Request::Bind { token_hi, token_lo } => {
                let token = (u64::from(token_hi) << 32) | u64::from(token_lo);
                match state.grants.remove(&token) {
                    Some(grant) => {
                        with_states(surface, |s| {
                            s.data_map.insert_if_missing_threadsafe(|| Bound(grant));
                        });
                        resource.window(grant.id);
                    }
                    None => log::warn!("acde_window.bind: 令牌不对或已经用过了"),
                }
            }
            Request::RequestActivate => {
                if let Some(window) = state.window_of(surface) {
                    state.focus_window(Some(&window));
                }
            }
            Request::RequestMode { mode } => state.request_mode(surface, acde_model::Mode::try_from(mode).ok()),
            Request::SetGrabHint { x, y, width, height, edges } => state.hints(surface, |h| {
                if width <= 0 || height <= 0 {
                    h.grab.clear();
                } else {
                    h.grab.push(([x, y, width, height], edges.into_result().map_or(0, |e| e.bits())));
                }
            }),
            Request::SetBackdrop { x, y, width, height, radius, blur, saturate, brightness } => {
                let rect = [x, y, width, height];
                state.hints(surface, |h| h.backdrop = (width > 0 && height > 0).then_some((rect, [radius, blur, saturate, brightness])));
            }
            Request::RequestGrab { kind } => {
                if let Ok(kind) = kind.into_result() {
                    state.request_grab(surface, resource, kind);
                }
            }
            Request::ReleaseGrab { kind } => {
                if let Ok(kind) = kind.into_result() {
                    state.release_grab(surface, kind);
                }
            }
            Request::Destroy => {}
        }
    }
}

impl Compositor {
    fn hints(&mut self, surface: &WlSurface, f: impl FnOnce(&mut Hints)) {
        with_states(surface, |s| {
            if let Ok(mut hints) = s.data_map.get_or_insert_threadsafe(|| std::sync::Mutex::new(Hints::default())).lock() {
                f(&mut hints);
            }
        });
        self.backend.damaged();
    }

    fn request_mode(&mut self, surface: &WlSurface, mode: Option<acde_model::Mode>) {
        let (Some(window), Some(mode)) = (self.window_of(surface), mode) else { return };
        let Some(id) = Self::window_id(&window) else { return };
        self.set_mode_managed(id, mode);
    }
}
