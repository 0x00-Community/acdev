use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::num::NonZeroIsize;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use acde_gpu::wgpu;
use acde_model::Combo;
use wgpu::rwh;
use windows_sys::Win32::Foundation::{GlobalFree, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint, ValidateRect};
use windows_sys::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForSystem, GetDpiForWindow, SetProcessDpiAwarenessContext,
};
use windows_sys::Win32::UI::Input::Ime::{
    CANDIDATEFORM, CFS_EXCLUDE, CFS_POINT, COMPOSITIONFORM, GCS_COMPSTR, GCS_RESULTSTR, IMECHARPOSITION, IMR_QUERYCHARPOSITION, ISC_SHOWUICOMPOSITIONWINDOW,
    ImmGetCompositionStringW, ImmGetContext, ImmReleaseContext, ImmSetCandidateWindow, ImmSetCompositionWindow,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, GetKeyState, ReleaseCapture, SetCapture, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent, VK_CONTROL, VK_F4, VK_LWIN, VK_MENU,
    VK_PROCESSKEY, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::Shell::{
    BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS, BROWSEINFOW, DragAcceptFiles, DragFinish, DragQueryFileW, DragQueryPoint, HDROP, SHBrowseForFolderW,
    SHGetPathFromIDListW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW, GetSystemMetrics, HTCLIENT,
    IDC_ARROW, LoadCursorW, MSG, PM_REMOVE, PeekMessageW, PostMessageW, PostQuitMessage, RegisterClassExW, SM_CXDOUBLECLK, SM_CYDOUBLECLK, SW_SHOW,
    SWP_NOACTIVATE, SWP_NOZORDER, SetCursor, SetWindowPos, SetWindowTextW, ShowWindow, TranslateMessage, WM_APP, WM_CHAR, WM_CLOSE, WM_DESTROY, WM_DPICHANGED,
    WM_DROPFILES, WM_ERASEBKGND, WM_IME_COMPOSITION, WM_IME_ENDCOMPOSITION, WM_IME_REQUEST, WM_IME_SETCONTEXT, WM_IME_STARTCOMPOSITION, WM_KEYDOWN, WM_KEYUP,
    WM_KILLFOCUS, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_PAINT, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_SETCURSOR, WM_SETFOCUS, WM_SIZE, WM_SYSCHAR, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
    XBUTTON1,
};

use super::{Cmd, Handler, HostEvent, LINE, Monitor};
use crate::keys;
use crate::{OpenRequest, SaveRequest};

mod dialog;
mod frame;
mod refresh;


const WM_MOUSELEAVE: u32 = 0x02a3;
const SIZE_MINIMIZED: usize = 1;
const WM_MOVE: u32 = 0x0003;
const WM_SETTINGCHANGE: u32 = 0x001a;
const WM_DISPLAYCHANGE: u32 = 0x007e;
const WM_NCHITTEST: u32 = 0x0084;
const WHEEL_DELTA: f64 = 120.0;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Queue {
    hwnd: isize,
    cmds: Mutex<VecDeque<Cmd>>,
}

#[derive(Clone)]
pub(crate) struct Proxy(Arc<Queue>);

impl Proxy {
    pub fn send(&self, cmd: Cmd) {
        self.0.cmds.lock().unwrap_or_else(|e| e.into_inner()).push_back(cmd);
        unsafe { PostMessageW(self.0.hwnd as HWND, WM_APP, 0, 0) };
    }

    fn drain(&self) -> Vec<Cmd> {
        self.0.cmds.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect()
    }
}

pub(crate) struct Host {
    hwnd: HWND,
    hinstance: isize,
    scale: Cell<f64>,
    exit: Cell<Option<i32>>,
    ime_area: Cell<Option<RECT>>,
    frame: frame::HostFrame,
}

impl super::Host for Host {
    fn controls(&self) -> bool {
        true
    }

    fn set_state(&self, state: Option<acde_model::WindowState>) {
        self.frame.set(self.hwnd, state);
    }

    fn set_size(&self, size: [f64; 2]) {
        self.frame.resize(self.hwnd, size);
    }

    fn set_title(&self, title: &str) {
        let title = wide(title);
        unsafe { SetWindowTextW(self.hwnd, title.as_ptr()) };
    }

    fn set_ime_area(&self, [x, y, w, h]: [f64; 4]) {
        let s = self.scale.get();
        let (left, top, right, bottom) = ((x * s) as i32, (y * s) as i32, ((x + w.max(1.0)) * s) as i32, ((y + h.max(1.0)) * s) as i32);
        self.ime_area.set(Some(RECT { left, top, right, bottom }));
        unsafe {
            let imc = ImmGetContext(self.hwnd);
            if imc.is_null() {
                return;
            }
            let composition = COMPOSITIONFORM { dwStyle: CFS_POINT, ptCurrentPos: POINT { x: left, y: top }, rcArea: RECT { left, top, right, bottom } };
            ImmSetCompositionWindow(imc, &composition);
            let candidate =
                CANDIDATEFORM { dwIndex: 0, dwStyle: CFS_EXCLUDE, ptCurrentPos: POINT { x: left, y: bottom }, rcArea: RECT { left, top, right, bottom } };
            ImmSetCandidateWindow(imc, &candidate);
            ImmReleaseContext(self.hwnd, imc);
        }
    }

    fn surface(&self, instance: &wgpu::Instance) -> Result<Option<wgpu::Surface<'static>>, String> {
        let hwnd = NonZeroIsize::new(self.hwnd as isize).ok_or("no window")?;
        let mut handle = rwh::Win32WindowHandle::new(hwnd);
        handle.hinstance = NonZeroIsize::new(self.hinstance);
        let target = wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(rwh::RawDisplayHandle::Windows(rwh::WindowsDisplayHandle::new())),
            raw_window_handle: rwh::RawWindowHandle::Win32(handle),
        };
        unsafe { instance.create_surface_unsafe(target) }.map(Some).map_err(|e| e.to_string())
    }

    fn open_files(&self, request: OpenRequest, reply: super::FilesReply) {
        let _ = reply.send(dialog::open(self.hwnd, &request));
    }

    fn save_file(&self, request: SaveRequest, reply: super::FolderReply) {
        let _ = reply.send(dialog::save(self.hwnd, &request));
    }

    fn choose_folder(&self, title: &str, reply: super::FolderReply) {
        let title = wide(title);
        let mut name = [0u16; 260];
        let info = BROWSEINFOW {
            hwndOwner: self.hwnd,
            pszDisplayName: name.as_mut_ptr(),
            lpszTitle: title.as_ptr(),
            ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
            ..Default::default()
        };
        let picked = unsafe {
            CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
            let list = SHBrowseForFolderW(&info);
            if list.is_null() {
                None
            } else {
                let mut path = vec![0u16; 32768];
                let ok = SHGetPathFromIDListW(list, path.as_mut_ptr()) != 0;
                CoTaskMemFree(list.cast());
                ok.then(|| PathBuf::from(String::from_utf16_lossy(&path[..path.iter().position(|&c| c == 0).unwrap_or(0)])))
            }
        };
        let _ = reply.send(Ok(picked));
    }

    fn exit(&self, code: i32) {
        self.exit.set(Some(code));
    }
}

fn open_clipboard() -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(null_mut()) } != 0 {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    false
}

pub(crate) fn clipboard_set(text: String) {
    if !open_clipboard() {
        log::warn!("clipboard: cannot open");
        return;
    }
    let data = wide(&text);
    unsafe {
        EmptyClipboard();
        let memory = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2);
        if !memory.is_null() {
            let target = GlobalLock(memory).cast::<u16>();
            if target.is_null() {
                GlobalFree(memory);
            } else {
                std::ptr::copy_nonoverlapping(data.as_ptr(), target, data.len());
                GlobalUnlock(memory);
                if SetClipboardData(u32::from(CF_UNICODETEXT), memory).is_null() {
                    GlobalFree(memory);
                }
            }
        }
        CloseClipboard();
    }
}

pub(crate) fn clipboard_get() -> String {
    if !open_clipboard() {
        return String::new();
    }
    let mut text = String::new();
    unsafe {
        let memory = GetClipboardData(u32::from(CF_UNICODETEXT));
        if !memory.is_null() {
            let source = GlobalLock(memory).cast::<u16>();
            if !source.is_null() {
                let mut len = 0;
                while *source.add(len) != 0 {
                    len += 1;
                }
                text = String::from_utf16_lossy(std::slice::from_raw_parts(source, len));
                GlobalUnlock(memory);
            }
        }
        CloseClipboard();
    }
    text
}

pub(crate) fn click_settings() -> acde_model::ClickSettings {
    let (time, x, y) = unsafe { (GetDoubleClickTime(), GetSystemMetrics(SM_CXDOUBLECLK), GetSystemMetrics(SM_CYDOUBLECLK)) };
    acde_model::ClickSettings { time_ms: f64::from(time), distance: [f64::from(x.max(1)), f64::from(y.max(1))] }
}

struct Win {
    host: Host,
    proxy: Proxy,
    handler: RefCell<Box<dyn Handler>>,
    queue: RefCell<VecDeque<HostEvent>>,
    code: Cell<i32>,
    closed: Cell<bool>,
    tracking: Cell<bool>,
    buttons: Cell<u32>,
    mods: Cell<u8>,
    surrogate: Cell<Option<u16>>,
    composing: Cell<bool>,
    refresh: refresh::RefreshWatch,
}

thread_local! {
    static WIN: RefCell<Option<Rc<Win>>> = const { RefCell::new(None) };
}

impl Win {
    fn emit(&self, event: HostEvent) {
        self.queue.borrow_mut().push_back(event);
        let Ok(mut handler) = self.handler.try_borrow_mut() else { return };
        loop {
            let Some(event) = self.queue.borrow_mut().pop_front() else { break };
            if self.closed.get() {
                continue;
            }
            handler.event(&self.host, event);
            if let Some(code) = self.host.exit.take() {
                self.close(code);
            }
        }
    }

    fn close(&self, code: i32) {
        if self.closed.replace(true) {
            return;
        }
        self.code.set(code);
        unsafe { DestroyWindow(self.host.hwnd) };
    }

    fn placed(&self, hwnd: HWND) {
        let events = [self.host.frame.changed(hwnd), self.host.frame.output(hwnd), self.refresh.placed(hwnd)];
        for event in events.into_iter().flatten() {
            self.emit(event);
        }
    }

    fn mods(&self) {
        let down = |vk: u16| unsafe { GetKeyState(i32::from(vk)) } < 0;
        let mods = Combo::mods(down(VK_CONTROL), down(VK_MENU), down(VK_SHIFT), down(VK_LWIN) || down(VK_RWIN));
        if self.mods.replace(mods) != mods {
            self.emit(HostEvent::Modifiers(mods));
        }
    }

    fn point(&self, lparam: LPARAM) -> (f64, f64) {
        let s = self.host.scale.get();
        let x = (lparam & 0xffff) as u16 as i16;
        let y = ((lparam >> 16) & 0xffff) as u16 as i16;
        (f64::from(x) / s, f64::from(y) / s)
    }

    fn client_size(&self) -> (u32, u32) {
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetClientRect(self.host.hwnd, &mut rect) };
        (((rect.right - rect.left).max(1)) as u32, ((rect.bottom - rect.top).max(1)) as u32)
    }

    fn button(&self, button: u32, pressed: bool) {
        let bit = 1 << (button - keys::BUTTON_LEFT);
        let held = self.buttons.get();
        if pressed {
            if held == 0 {
                unsafe { SetCapture(self.host.hwnd) };
            }
            self.buttons.set(held | bit);
        } else {
            let rest = held & !bit;
            self.buttons.set(rest);
            if rest == 0 {
                unsafe { ReleaseCapture() };
            }
        }
        self.emit(HostEvent::Button(button, pressed));
    }

    fn text(&self) -> Option<String> {
        let mut units = Vec::new();
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, self.host.hwnd, WM_CHAR, WM_CHAR, PM_REMOVE) } != 0 {
            let unit = msg.wParam as u16;
            units.push(unit);
            if !(0xd800..0xdc00).contains(&unit) {
                break;
            }
        }
        let text = String::from_utf16(&units).ok()?;
        (!text.is_empty()).then_some(text)
    }

    fn key(&self, wparam: WPARAM, lparam: LPARAM, pressed: bool) {
        if wparam as u16 == VK_PROCESSKEY {
            return;
        }
        self.mods();
        let code = ((lparam >> 16) & 0xff) as u32;
        let extended = (lparam >> 24) & 1 == 1;
        let Some(evdev) = keys::scancode(code, extended) else { return };
        let text = if pressed { self.text() } else { None };
        self.emit(HostEvent::Key { evdev, pressed, text });
    }

    fn char_position(&self, lparam: LPARAM) -> LRESULT {
        let Some(area) = self.host.ime_area.get() else { return 0 };
        let hwnd = self.host.hwnd;
        unsafe {
            let position = &mut *(lparam as *mut IMECHARPOSITION);
            let mut at = POINT { x: area.left, y: area.top };
            ClientToScreen(hwnd, &mut at);
            let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetClientRect(hwnd, &mut client);
            let (mut origin, mut corner) = (POINT { x: client.left, y: client.top }, POINT { x: client.right, y: client.bottom });
            ClientToScreen(hwnd, &mut origin);
            ClientToScreen(hwnd, &mut corner);
            position.pt = at;
            position.cLineHeight = (area.bottom - area.top).max(1) as u32;
            position.rcDocument = RECT { left: origin.x, top: origin.y, right: corner.x, bottom: corner.y };
        }
        1
    }

    fn composition(&self, kind: u32) -> Option<String> {
        unsafe {
            let imc = ImmGetContext(self.host.hwnd);
            if imc.is_null() {
                return None;
            }
            let bytes = ImmGetCompositionStringW(imc, kind, null_mut(), 0);
            let text = if bytes >= 0 {
                let mut units = vec![0u16; bytes as usize / 2];
                ImmGetCompositionStringW(imc, kind, units.as_mut_ptr().cast(), bytes as u32);
                Some(String::from_utf16_lossy(&units))
            } else {
                None
            };
            ImmReleaseContext(self.host.hwnd, imc);
            text
        }
    }

    fn dropped(&self, drop: HDROP) {
        let mut paths = Vec::new();
        unsafe {
            let mut at = POINT { x: 0, y: 0 };
            if DragQueryPoint(drop, &mut at) != 0 {
                let s = self.host.scale.get();
                self.emit(HostEvent::PointerMove(f64::from(at.x) / s, f64::from(at.y) / s));
            }
            let count = DragQueryFileW(drop, u32::MAX, null_mut(), 0);
            for i in 0..count {
                let len = DragQueryFileW(drop, i, null_mut(), 0);
                let mut buf = vec![0u16; len as usize + 1];
                let got = DragQueryFileW(drop, i, buf.as_mut_ptr(), buf.len() as u32);
                paths.push(PathBuf::from(String::from_utf16_lossy(&buf[..got as usize])));
            }
            DragFinish(drop);
        }
        if !paths.is_empty() {
            self.emit(HostEvent::Dropped(paths));
        }
    }

    fn message(&self, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_APP => {
                for cmd in self.proxy.drain() {
                    self.emit(HostEvent::Cmd(cmd));
                }
            }
            WM_SIZE => {
                if wparam != SIZE_MINIMIZED {
                    let size = ((lparam & 0xffff) as u32, ((lparam >> 16) & 0xffff) as u32);
                    self.emit(HostEvent::Resized { size: (size.0.max(1), size.1.max(1)), scale: self.host.scale.get() });
                }
                self.placed(hwnd);
            }
            WM_MOVE | WM_SETTINGCHANGE => self.placed(hwnd),
            WM_DISPLAYCHANGE => {
                self.refresh.forget();
                self.placed(hwnd);
            }
            WM_NCHITTEST => {
                let hit = unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
                if hit != HTCLIENT as LRESULT {
                    return Some(hit);
                }
                return Some(frame::hit(hwnd, lparam, self.host.scale.get()).unwrap_or(hit));
            }
            WM_DPICHANGED => {
                self.host.scale.set(f64::from((wparam & 0xffff) as u32) / 96.0);
                let rect = unsafe { &*(lparam as *const RECT) };
                unsafe { SetWindowPos(hwnd, null_mut(), rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, SWP_NOZORDER | SWP_NOACTIVATE) };
                self.emit(HostEvent::Resized { size: self.client_size(), scale: self.host.scale.get() });
                self.placed(hwnd);
            }
            WM_CLOSE => self.emit(HostEvent::CloseRequested),
            WM_DESTROY => unsafe { PostQuitMessage(self.code.get()) },
            WM_SETFOCUS => {
                self.mods();
                self.emit(HostEvent::Focused(true));
            }
            WM_KILLFOCUS => self.emit(HostEvent::Focused(false)),
            WM_MOUSEMOVE => {
                if !self.tracking.replace(true) {
                    let mut track = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 };
                    unsafe { TrackMouseEvent(&mut track) };
                }
                let (x, y) = self.point(lparam);
                self.emit(HostEvent::PointerMove(x, y));
            }
            WM_MOUSELEAVE => {
                self.tracking.set(false);
                self.emit(HostEvent::PointerLeave);
            }
            WM_LBUTTONDOWN | WM_LBUTTONUP => self.button(keys::BUTTON_LEFT, msg == WM_LBUTTONDOWN),
            WM_RBUTTONDOWN | WM_RBUTTONUP => self.button(keys::BUTTON_RIGHT, msg == WM_RBUTTONDOWN),
            WM_MBUTTONDOWN | WM_MBUTTONUP => self.button(keys::BUTTON_MIDDLE, msg == WM_MBUTTONDOWN),
            WM_XBUTTONDOWN | WM_XBUTTONUP => {
                let button = if ((wparam >> 16) & 0xffff) as u16 == XBUTTON1 { keys::BUTTON_BACK } else { keys::BUTTON_FORWARD };
                self.button(button, msg == WM_XBUTTONDOWN);
                return Some(1);
            }
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                let delta = f64::from(((wparam >> 16) & 0xffff) as u16 as i16) / WHEEL_DELTA * LINE;
                self.emit(if msg == WM_MOUSEWHEEL { HostEvent::Wheel(0.0, -delta) } else { HostEvent::Wheel(delta, 0.0) });
            }
            WM_KEYDOWN | WM_KEYUP => self.key(wparam, lparam, msg == WM_KEYDOWN),
            WM_SYSKEYDOWN | WM_SYSKEYUP => {
                self.key(wparam, lparam, msg == WM_SYSKEYDOWN);
                if wparam as u16 == VK_F4 {
                    return None;
                }
            }
            WM_CHAR => {
                let unit = wparam as u16;
                if (0xd800..0xdc00).contains(&unit) {
                    self.surrogate.set(Some(unit));
                } else {
                    let units: Vec<u16> = self.surrogate.take().into_iter().chain(std::iter::once(unit)).collect();
                    if let Ok(text) = String::from_utf16(&units)
                        && text.chars().all(|c| !c.is_control())
                    {
                        self.emit(HostEvent::ImeCommit(text));
                    }
                }
            }
            WM_SYSCHAR => {}
            WM_IME_SETCONTEXT => return Some(unsafe { DefWindowProcW(hwnd, msg, wparam, lparam & !(ISC_SHOWUICOMPOSITIONWINDOW as isize)) }),
            WM_IME_STARTCOMPOSITION => {}
            WM_IME_COMPOSITION => {
                let flags = lparam as u32;
                if flags & GCS_RESULTSTR != 0
                    && let Some(text) = self.composition(GCS_RESULTSTR)
                {
                    self.composing.set(false);
                    self.emit(HostEvent::ImeCommit(text));
                }
                if flags & GCS_COMPSTR != 0 {
                    let text = self.composition(GCS_COMPSTR).unwrap_or_default();
                    if !text.is_empty() || self.composing.get() {
                        self.composing.set(!text.is_empty());
                        self.emit(HostEvent::ImePreedit(text));
                    }
                }
            }
            WM_IME_ENDCOMPOSITION => {
                if self.composing.replace(false) {
                    self.emit(HostEvent::ImePreedit(String::new()));
                }
            }
            WM_IME_REQUEST if wparam as u32 == IMR_QUERYCHARPOSITION => return Some(self.char_position(lparam)),
            WM_DROPFILES => self.dropped(wparam as HDROP),
            WM_SETCURSOR => {
                if (lparam & 0xffff) as u32 != HTCLIENT {
                    return None;
                }
                unsafe { SetCursor(LoadCursorW(null_mut(), IDC_ARROW)) };
                return Some(1);
            }
            WM_PAINT => {
                unsafe { ValidateRect(hwnd, null()) };
                self.emit(HostEvent::Redraw);
            }
            WM_ERASEBKGND => return Some(1),
            _ => return None,
        }
        Some(0)
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let win = WIN.with(|w| w.borrow().clone());
    if let Some(win) = win
        && win.host.hwnd == hwnd
        && let Some(result) = win.message(hwnd, msg, wparam, lparam)
    {
        return result;
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn monitor() -> (Option<Monitor>, RECT, f64) {
    unsafe {
        let scale = f64::from(GetDpiForSystem()) / 96.0;
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        let handle = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        if GetMonitorInfoW(handle, &mut info) == 0 {
            return (None, RECT { left: 0, top: 0, right: 0, bottom: 0 }, scale);
        }
        let work = info.rcWork;
        let size = [f64::from(work.right - work.left) / scale, f64::from(work.bottom - work.top) / scale];
        (Some(Monitor { size, refresh: None }), work, scale)
    }
}

pub(crate) fn run(mut handler: Box<dyn Handler>) -> Result<i32, String> {
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let (monitor, work, scale) = monitor();
    let [w, h] = handler.size(monitor.as_ref());
    let hinstance = unsafe { GetModuleHandleW(null()) };
    let class = wide("acde");
    let wc = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc),
        hInstance: hinstance,
        hCursor: unsafe { LoadCursorW(null_mut(), IDC_ARROW) },
        lpszClassName: class.as_ptr(),
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&wc) } == 0 {
        return Err(format!("register window class: {}", std::io::Error::last_os_error()));
    }
    let dpi = (scale * 96.0).round() as u32;
    let mut outer = RECT { left: 0, top: 0, right: (w * scale).round() as i32, bottom: (h * scale).round() as i32 };
    unsafe { AdjustWindowRectExForDpi(&mut outer, WS_OVERLAPPEDWINDOW, 0, 0, dpi) };
    let (ow, oh) = (outer.right - outer.left, outer.bottom - outer.top);
    let x = work.left + ((work.right - work.left) - ow).max(0) / 2;
    let y = work.top + ((work.bottom - work.top) - oh).max(0) / 2;
    let title = wide("acde");
    let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_OVERLAPPEDWINDOW, x, y, ow, oh, null_mut(), null_mut(), hinstance, null()) };
    if hwnd.is_null() {
        return Err(format!("open window: {}", std::io::Error::last_os_error()));
    }
    unsafe { DragAcceptFiles(hwnd, 1) };
    let monitor = monitor.map(|m| Monitor { refresh: refresh::of_window(hwnd), ..m });
    let scale = f64::from(unsafe { GetDpiForWindow(hwnd) }.max(1)) / 96.0;
    let host = Host {
        hwnd,
        hinstance: hinstance as isize,
        scale: Cell::new(scale),
        exit: Cell::new(None),
        ime_area: Cell::new(None),
        frame: frame::HostFrame::default(),
    };
    let proxy = Proxy(Arc::new(Queue { hwnd: hwnd as isize, cmds: Mutex::new(VecDeque::new()) }));
    let win = Rc::new(Win {
        host,
        proxy: proxy.clone(),
        handler: RefCell::new(handler),
        queue: RefCell::new(VecDeque::new()),
        code: Cell::new(0),
        closed: Cell::new(false),
        tracking: Cell::new(false),
        buttons: Cell::new(0),
        mods: Cell::new(0),
        surrogate: Cell::new(None),
        composing: Cell::new(false),
        refresh: refresh::RefreshWatch::default(),
    });
    let size = win.client_size();
    win.handler.borrow_mut().started(&win.host, super::Proxy::Native(proxy), monitor, size, scale);
    WIN.with(|w| *w.borrow_mut() = Some(win.clone()));
    if let Some(code) = win.host.exit.take() {
        win.close(code);
    } else {
        unsafe { ShowWindow(hwnd, SW_SHOW) };
        win.placed(hwnd);
        win.emit(HostEvent::Redraw);
    }
    let mut msg = MSG::default();
    let code = loop {
        match unsafe { GetMessageW(&mut msg, null_mut(), 0, 0) } {
            0 => break msg.wParam as i32,
            -1 => break win.code.get(),
            _ => unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            },
        }
    };
    WIN.with(|w| w.borrow_mut().take());
    Ok(code)
}
