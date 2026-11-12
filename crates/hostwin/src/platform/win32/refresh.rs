use std::cell::Cell;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{
    DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
};

use crate::platform::HostEvent;

#[derive(Default)]
pub(super) struct RefreshWatch {
    monitor: Cell<Option<isize>>,
}

impl RefreshWatch {
    pub fn placed(&self, hwnd: HWND) -> Option<HostEvent> {
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        self.note(monitor as isize, || read(monitor))
    }

    pub fn forget(&self) {
        self.monitor.set(None);
    }

    fn note(&self, monitor: isize, read: impl FnOnce() -> Option<f64>) -> Option<HostEvent> {
        (self.monitor.replace(Some(monitor)) != Some(monitor)).then(|| HostEvent::Refresh(read()))
    }
}

pub(super) fn of_window(hwnd: HWND) -> Option<f64> {
    read(unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) })
}

fn read(monitor: windows_sys::Win32::Graphics::Gdi::HMONITOR) -> Option<f64> {
    let mut info = MONITORINFOEXW { monitorInfo: MONITORINFO { cbSize: size_of::<MONITORINFOEXW>() as u32, ..Default::default() }, ..Default::default() };
    if unsafe { GetMonitorInfoW(monitor, (&raw mut info).cast()) } == 0 {
        return None;
    }
    let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
    let found = unsafe { EnumDisplaySettingsW(info.szDevice.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode) } != 0;
    (found && mode.dmDisplayFrequency > 1).then(|| f64::from(mode.dmDisplayFrequency))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hz(event: Option<HostEvent>) -> Option<Option<f64>> {
        event.map(|e| match e {
            HostEvent::Refresh(hz) => hz,
            _ => panic!("not a refresh"),
        })
    }

    #[test]
    fn asks_again_only_on_another_monitor_or_a_display_change() {
        let watch = RefreshWatch::default();
        assert_eq!(hz(watch.note(1, || Some(60.0))), Some(Some(60.0)));
        assert_eq!(hz(watch.note(1, || panic!("same monitor"))), None);
        assert_eq!(hz(watch.note(2, || Some(144.0))), Some(Some(144.0)));
        assert_eq!(hz(watch.note(1, || Some(60.0))), Some(Some(60.0)));
        watch.forget();
        assert_eq!(hz(watch.note(1, || Some(120.0))), Some(Some(120.0)));
        assert_eq!(hz(watch.note(3, || None)), Some(None));
    }
}
