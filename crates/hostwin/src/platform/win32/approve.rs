use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, GW_OWNER, GetClassNameW, GetWindow, GetWindowThreadProcessId, IDNO, IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_SETFOREGROUND, MB_YESNO,
    MessageBoxW, PostMessageW, WM_COMMAND,
};

use super::wide;

static OWNER: AtomicIsize = AtomicIsize::new(0);
static DISMISSED: AtomicBool = AtomicBool::new(false);

pub(super) fn ask(owner: HWND, title: &str, message: &str) -> Option<bool> {
    let (title, message) = (wide(title), wide(message));
    DISMISSED.store(false, Ordering::SeqCst);
    OWNER.store(owner as isize, Ordering::SeqCst);
    let code = unsafe { MessageBoxW(owner, message.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND) };
    OWNER.store(0, Ordering::SeqCst);
    outcome(code, DISMISSED.swap(false, Ordering::SeqCst))
}

fn outcome(code: i32, dismissed: bool) -> Option<bool> {
    match code {
        _ if dismissed => None,
        IDYES => Some(true),
        IDNO => Some(false),
        _ => None,
    }
}

pub(crate) fn dismiss() {
    let owner = OWNER.load(Ordering::SeqCst);
    if owner == 0 {
        return;
    }
    DISMISSED.store(true, Ordering::SeqCst);
    let thread = unsafe { GetWindowThreadProcessId(owner as HWND, std::ptr::null_mut()) };
    unsafe { EnumThreadWindows(thread, Some(close_owned), owner) };
}

unsafe extern "system" fn close_owned(hwnd: HWND, owner: LPARAM) -> i32 {
    let mut class = [0u16; 16];
    let len = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    let dialog = String::from_utf16_lossy(&class[..len.max(0) as usize]) == "#32770";
    if dialog && unsafe { GetWindow(hwnd, GW_OWNER) } as isize == owner {
        unsafe { PostMessageW(hwnd, WM_COMMAND, IDNO as usize, 0) };
        return 0;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_map_to_allow_and_deny() {
        assert_eq!(outcome(IDYES, false), Some(true));
        assert_eq!(outcome(IDNO, false), Some(false));
        assert_eq!(outcome(0, false), None);
    }

    #[test]
    fn a_dismissed_dialog_gives_no_answer() {
        assert_eq!(outcome(IDNO, true), None);
        assert_eq!(outcome(IDYES, true), None);
    }

    #[test]
    fn dismissing_without_a_dialog_does_nothing() {
        dismiss();
        assert!(!DISMISSED.load(Ordering::SeqCst));
    }
}
