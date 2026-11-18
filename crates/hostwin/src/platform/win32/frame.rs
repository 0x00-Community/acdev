use std::cell::Cell;
use std::ptr::null_mut;

use acde::model::WindowState;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow, ScreenToClient};
use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_STYLE, GetWindowLongPtrW, GetWindowPlacement, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCAPTION, HTCLIENT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT,
    HTTOPRIGHT, HWND_TOP, IsIconic, IsZoomed, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSIZE, SWP_NOZORDER, SetWindowLongPtrW, SetWindowPlacement, SetWindowPos, ShowWindow, WINDOWPLACEMENT, WS_OVERLAPPEDWINDOW,
};

use crate::platform::HostEvent;

#[derive(Default)]
pub(super) struct HostFrame {
    saved: Cell<Option<(isize, WINDOWPLACEMENT)>>,
    state: Cell<Option<WindowState>>,
    output: Cell<Option<((u32, u32), [i64; 5])>>,
}

impl HostFrame {
    pub fn state(&self, hwnd: HWND) -> WindowState {
        unsafe {
            if IsIconic(hwnd) != 0 {
                WindowState::Minimized
            } else if self.saved.get().is_some() {
                WindowState::Fullscreen
            } else if IsZoomed(hwnd) != 0 {
                WindowState::Filled
            } else {
                WindowState::Normal
            }
        }
    }

    pub fn changed(&self, hwnd: HWND) -> Option<HostEvent> {
        let now = self.state(hwnd);
        (self.state.replace(Some(now)) != Some(now)).then_some(HostEvent::State(now))
    }

    pub fn set(&self, hwnd: HWND, to: Option<WindowState>) {
        let from = self.state(hwnd);
        unsafe {
            match (from, to) {
                (WindowState::Minimized, None) => _ = ShowWindow(hwnd, SW_RESTORE),
                (_, None) => self.leave(hwnd),
                (_, Some(WindowState::Minimized)) => _ = ShowWindow(hwnd, SW_MINIMIZE),
                (_, Some(WindowState::Fullscreen)) => self.enter(hwnd),
                (_, Some(WindowState::Filled)) => {
                    self.leave(hwnd);
                    ShowWindow(hwnd, SW_MAXIMIZE);
                }
                (_, Some(WindowState::Normal)) => {
                    self.leave(hwnd);
                    for _ in 0..2 {
                        if IsZoomed(hwnd) == 0 && IsIconic(hwnd) == 0 {
                            break;
                        }
                        ShowWindow(hwnd, SW_RESTORE);
                    }
                }
            }
        }
    }

    fn enter(&self, hwnd: HWND) {
        if self.saved.get().is_some() {
            return;
        }
        unsafe {
            let mut placement = WINDOWPLACEMENT { length: size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
            GetWindowPlacement(hwnd, &mut placement);
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            self.saved.set(Some((style, placement)));
            if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_OVERLAPPEDWINDOW as isize));
            let monitor = monitor(hwnd).map_or(RECT { left: 0, top: 0, right: 0, bottom: 0 }, |m| m.rcMonitor);
            let (w, h) = (monitor.right - monitor.left, monitor.bottom - monitor.top);
            SetWindowPos(hwnd, HWND_TOP, monitor.left, monitor.top, w, h, SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
        }
    }

    fn leave(&self, hwnd: HWND) {
        let Some((style, placement)) = self.saved.take() else { return };
        unsafe {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style);
            SetWindowPlacement(hwnd, &placement);
            SetWindowPos(hwnd, null_mut(), 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
    }

    pub fn resize(&self, hwnd: HWND, [w, h]: [f64; 2]) {
        if self.state(hwnd) != WindowState::Normal {
            return;
        }
        let Some(info) = monitor(hwnd) else { return };
        let work = info.rcWork;
        unsafe {
            let dpi = GetDpiForWindow(hwnd).max(1);
            let scale = f64::from(dpi) / 96.0;
            let mut outer = RECT { left: 0, top: 0, right: (w * scale).round() as i32, bottom: (h * scale).round() as i32 };
            AdjustWindowRectExForDpi(&mut outer, WS_OVERLAPPEDWINDOW, 0, 0, dpi);
            let (room_w, room_h) = (work.right - work.left, work.bottom - work.top);
            let (ow, oh) = ((outer.right - outer.left).min(room_w), (outer.bottom - outer.top).min(room_h));
            let (x, y) = (work.left + (room_w - ow) / 2, work.top + (room_h - oh) / 2);
            SetWindowPos(hwnd, null_mut(), x, y, ow, oh, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
    }

    pub fn output(&self, hwnd: HWND) -> Option<HostEvent> {
        let info = monitor(hwnd)?;
        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(1);
        let (m, w) = (info.rcMonitor, info.rcWork);
        let size = ((m.right - m.left).max(1) as u32, (m.bottom - m.top).max(1) as u32);
        let key = (size, [i64::from(dpi), i64::from(w.left - m.left), i64::from(w.top - m.top), i64::from(w.right - w.left), i64::from(w.bottom - w.top)]);
        if self.output.replace(Some(key)) == Some(key) {
            return None;
        }
        let scale = f64::from(dpi) / 96.0;
        let work = [w.left - m.left, w.top - m.top, w.right - w.left, w.bottom - w.top].map(|v| (f64::from(v) / scale).round());
        Some(HostEvent::Output { size, scale, work })
    }
}

fn monitor(hwnd: HWND) -> Option<MONITORINFO> {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    (unsafe { GetMonitorInfoW(handle, &mut info) } != 0).then_some(info)
}

pub(super) fn hit(hwnd: HWND, lparam: LPARAM, scale: f64) -> Option<LRESULT> {
    let mut point = POINT { x: i32::from((lparam & 0xffff) as u16 as i16), y: i32::from(((lparam >> 16) & 0xffff) as u16 as i16) };
    unsafe { ScreenToClient(hwnd, &mut point) };
    let (x, y) = (f64::from(point.x) / scale, f64::from(point.y) / scale);
    let state = crate::app::server()?.state();
    let host = state.entries.values().find(|e| e.host && e.shown())?;
    let edges = crate::shell::pointer::edges_at(&host.grab_hints(&state.theme), x, y)?;
    let (top, bottom, left, right) = (edges & 1 != 0, edges & 2 != 0, edges & 4 != 0, edges & 8 != 0);
    let code = match (top, bottom, left, right) {
        (true, _, true, _) => HTTOPLEFT,
        (true, _, _, true) => HTTOPRIGHT,
        (_, true, true, _) => HTBOTTOMLEFT,
        (_, true, _, true) => HTBOTTOMRIGHT,
        (true, ..) => HTTOP,
        (_, true, ..) => HTBOTTOM,
        (.., true, _) => HTLEFT,
        (.., true) => HTRIGHT,
        _ if edges == 0 => HTCAPTION,
        _ => HTCLIENT,
    };
    Some(code as LRESULT)
}
