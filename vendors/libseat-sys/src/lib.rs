// acde: libseat is opened with dlopen when first used instead of being linked, so acdert starts on
// machines without libseat (it is only needed by the compositor of a Dopame session). Without it
// libseat_open_seat returns null, which the libseat crate reports as an error.
#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(clippy::missing_safety_doc)]

use std::os::raw::{c_char, c_int, c_uint, c_void};
use std::sync::OnceLock;

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct libseat {
    _unused: [u8; 0],
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct libseat_seat_listener {
    pub enable_seat: Option<unsafe extern "C" fn(seat: *mut libseat, userdata: *mut c_void)>,
    pub disable_seat: Option<unsafe extern "C" fn(seat: *mut libseat, userdata: *mut c_void)>,
}

pub const libseat_log_level_LIBSEAT_LOG_LEVEL_SILENT: libseat_log_level = 0;
pub const libseat_log_level_LIBSEAT_LOG_LEVEL_ERROR: libseat_log_level = 1;
pub const libseat_log_level_LIBSEAT_LOG_LEVEL_INFO: libseat_log_level = 2;
pub const libseat_log_level_LIBSEAT_LOG_LEVEL_DEBUG: libseat_log_level = 3;
pub const libseat_log_level_LIBSEAT_LOG_LEVEL_LAST: libseat_log_level = 4;
pub type libseat_log_level = c_uint;

struct Api {
    _lib: libloading::Library,
    open_seat: unsafe extern "C" fn(*const libseat_seat_listener, *mut c_void) -> *mut libseat,
    disable_seat: unsafe extern "C" fn(*mut libseat) -> c_int,
    close_seat: unsafe extern "C" fn(*mut libseat) -> c_int,
    open_device: unsafe extern "C" fn(*mut libseat, *const c_char, *mut c_int) -> c_int,
    close_device: unsafe extern "C" fn(*mut libseat, c_int) -> c_int,
    seat_name: unsafe extern "C" fn(*mut libseat) -> *const c_char,
    switch_session: unsafe extern "C" fn(*mut libseat, c_int) -> c_int,
    get_fd: unsafe extern "C" fn(*mut libseat) -> c_int,
    dispatch: unsafe extern "C" fn(*mut libseat, c_int) -> c_int,
    set_log_level: unsafe extern "C" fn(libseat_log_level),
}

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let lib = ["libseat.so.1", "libseat.so"].iter().find_map(|name| libloading::Library::new(name).ok())?;
        Some(Api {
            open_seat: *lib.get(b"libseat_open_seat\0").ok()?,
            disable_seat: *lib.get(b"libseat_disable_seat\0").ok()?,
            close_seat: *lib.get(b"libseat_close_seat\0").ok()?,
            open_device: *lib.get(b"libseat_open_device\0").ok()?,
            close_device: *lib.get(b"libseat_close_device\0").ok()?,
            seat_name: *lib.get(b"libseat_seat_name\0").ok()?,
            switch_session: *lib.get(b"libseat_switch_session\0").ok()?,
            get_fd: *lib.get(b"libseat_get_fd\0").ok()?,
            dispatch: *lib.get(b"libseat_dispatch\0").ok()?,
            set_log_level: *lib.get(b"libseat_set_log_level\0").ok()?,
            _lib: lib,
        })
    })
    .as_ref()
}

pub unsafe fn libseat_open_seat(listener: *const libseat_seat_listener, userdata: *mut c_void) -> *mut libseat {
    match api() {
        Some(api) => (api.open_seat)(listener, userdata),
        None => std::ptr::null_mut(),
    }
}

pub unsafe fn libseat_disable_seat(seat: *mut libseat) -> c_int {
    api().map_or(-1, |api| (api.disable_seat)(seat))
}

pub unsafe fn libseat_close_seat(seat: *mut libseat) -> c_int {
    api().map_or(-1, |api| (api.close_seat)(seat))
}

pub unsafe fn libseat_open_device(seat: *mut libseat, path: *const c_char, fd: *mut c_int) -> c_int {
    api().map_or(-1, |api| (api.open_device)(seat, path, fd))
}

pub unsafe fn libseat_close_device(seat: *mut libseat, device_id: c_int) -> c_int {
    api().map_or(-1, |api| (api.close_device)(seat, device_id))
}

pub unsafe fn libseat_seat_name(seat: *mut libseat) -> *const c_char {
    api().map_or(std::ptr::null(), |api| (api.seat_name)(seat))
}

pub unsafe fn libseat_switch_session(seat: *mut libseat, session: c_int) -> c_int {
    api().map_or(-1, |api| (api.switch_session)(seat, session))
}

pub unsafe fn libseat_get_fd(seat: *mut libseat) -> c_int {
    api().map_or(-1, |api| (api.get_fd)(seat))
}

pub unsafe fn libseat_dispatch(seat: *mut libseat, timeout: c_int) -> c_int {
    api().map_or(-1, |api| (api.dispatch)(seat, timeout))
}

pub unsafe fn libseat_set_log_level(level: libseat_log_level) {
    if let Some(api) = api() {
        (api.set_log_level)(level)
    }
}
