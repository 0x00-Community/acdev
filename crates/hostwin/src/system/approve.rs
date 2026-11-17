use winit::window::Window;

use crate::platform::ApproveReply;

#[cfg(any(target_os = "macos", target_os = "linux"))]
const ALLOW: &str = "Allow";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const DENY: &str = "Don't Allow";

#[cfg(target_os = "macos")]
mod appkit {
    use std::cell::{Cell, RefCell};

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle, NSModalResponse, NSModalResponseAbort, NSView, NSWindow};
    use objc2_foundation::{NSOperationQueue, NSString};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use winit::window::Window;

    use crate::platform::ApproveReply;

    thread_local! {
        static SHOWN: RefCell<Option<(Retained<NSWindow>, Retained<NSAlert>)>> = const { RefCell::new(None) };
    }

    fn window_of(window: &Window) -> Option<Retained<NSWindow>> {
        let RawWindowHandle::AppKit(handle) = window.window_handle().ok()?.as_raw() else {
            return None;
        };
        let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        view.window()
    }

    pub(super) fn answer(response: NSModalResponse) -> Option<bool> {
        match response {
            r if r == NSAlertFirstButtonReturn => Some(false),
            r if r == NSAlertSecondButtonReturn => Some(true),
            _ => None,
        }
    }

    pub(super) fn ask(parent: &Window, title: &str, message: &str, reply: ApproveReply) {
        let (Some(mtm), Some(window)) = (MainThreadMarker::new(), window_of(parent)) else {
            let _ = reply.send(Ok(None));
            return;
        };
        if SHOWN.with_borrow(Option::is_some) {
            let _ = reply.send(Err("an approval dialog is already open".into()));
            return;
        }
        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(message));
        alert.addButtonWithTitle(&NSString::from_str(super::DENY));
        alert.addButtonWithTitle(&NSString::from_str(super::ALLOW));
        let reply = Cell::new(Some(reply));
        let handler = RcBlock::new(move |response: NSModalResponse| {
            SHOWN.set(None);
            if let Some(reply) = reply.take() {
                let _ = reply.send(Ok(answer(response)));
            }
        });
        SHOWN.set(Some((window.clone(), alert.clone())));
        alert.beginSheetModalForWindow_completionHandler(&window, Some(&handler));
    }

    pub(super) fn dismiss() {
        let close = RcBlock::new(|| {
            if let Some((window, alert)) = SHOWN.with_borrow(Clone::clone) {
                window.endSheet_returnCode(&alert.window(), NSModalResponseAbort);
            }
        });
        unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&close) };
    }
}

#[cfg(target_os = "linux")]
mod freedesktop {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use zbus::blocking::{Connection, MessageIterator};
    use zbus::zvariant::Value;

    use crate::platform::ApproveReply;

    const NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    const ALLOW_KEY: &str = "allow";
    const DENY_KEY: &str = "deny";

    const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    static SHOWN: Mutex<Option<(Connection, u32)>> = Mutex::new(None);

    enum Signal {
        Action(u32, String),
        Closed(u32),
        Other,
    }

    fn signal(message: &zbus::Message) -> Signal {
        let header = message.header();
        match header.member().map(|m| m.as_str()) {
            Some("ActionInvoked") => message.body().deserialize::<(u32, String)>().map_or(Signal::Other, |(id, key)| Signal::Action(id, key)),
            Some("NotificationClosed") => message.body().deserialize::<(u32, u32)>().map_or(Signal::Other, |(id, _)| Signal::Closed(id)),
            _ => Signal::Other,
        }
    }

    pub(super) fn answer(key: &str) -> Option<bool> {
        match key {
            ALLOW_KEY => Some(true),
            DENY_KEY => Some(false),
            _ => None,
        }
    }

    fn close(bus: &Connection, id: u32) {
        if let Err(e) = bus.call_method(Some(NAME), PATH, Some(NAME), "CloseNotification", &(id,)) {
            log::warn!("approval: {NAME} CloseNotification: {e}");
        }
    }

    fn run(title: &str, message: &str) -> zbus::Result<Option<bool>> {
        let bus = zbus::blocking::connection::Builder::session()?.method_timeout(CALL_TIMEOUT).build()?;
        let capabilities: Vec<String> = bus.call_method(Some(NAME), PATH, Some(NAME), "GetCapabilities", &())?.body().deserialize()?;
        if !capabilities.iter().any(|c| c == "actions") {
            log::warn!("approval: the notification server has no actions, so the prompt waits for acdev allow or acdev deny");
            return Ok(None);
        }
        let markup = capabilities.iter().any(|c| c == "body-markup");
        let body = if markup { crate::system::notify::escape_markup(message) } else { message.to_owned() };
        let rule = zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(NAME)?.path(PATH)?.build();
        let signals = MessageIterator::for_match_rule(rule, &bus, Some(32))?;
        let hints: HashMap<&str, Value> = HashMap::from([("urgency", Value::U8(2)), ("resident", Value::Bool(true))]);
        let actions = [DENY_KEY, super::DENY, ALLOW_KEY, super::ALLOW];
        let id: u32 = bus
            .call_method(Some(NAME), PATH, Some(NAME), "Notify", &("acde", 0u32, "dialog-question", title, body.as_str(), &actions[..], hints, 0i32))?
            .body()
            .deserialize()?;
        *SHOWN.lock().unwrap_or_else(|e| e.into_inner()) = Some((bus.clone(), id));
        let mut answer = None;
        for message in signals {
            match signal(&message?) {
                Signal::Action(at, key) if at == id => {
                    answer = self::answer(&key);
                    if answer.is_some() {
                        break;
                    }
                }
                Signal::Closed(at) if at == id => break,
                _ => {}
            }
        }
        if SHOWN.lock().unwrap_or_else(|e| e.into_inner()).take().is_some() && answer.is_some() {
            close(&bus, id);
        }
        Ok(answer)
    }

    pub(super) fn ask(title: &str, message: &str, reply: ApproveReply) {
        let (title, message) = (title.to_owned(), message.to_owned());
        let spawned = std::thread::Builder::new().name("acde-approve".into()).spawn(move || {
            let answer = run(&title, &message).unwrap_or_else(|e| {
                log::warn!("approval: {NAME}: {e}");
                None
            });
            let _ = reply.send(Ok(answer));
        });
        if let Err(e) = spawned {
            log::warn!("approval thread: {e}");
        }
    }

    pub(super) fn dismiss() {
        let shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((bus, id)) = shown {
            close(&bus, id);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ask(parent: &Window, title: &str, message: &str, reply: ApproveReply) {
    appkit::ask(parent, title, message, reply);
}

#[cfg(target_os = "linux")]
pub(crate) fn ask(_parent: &Window, title: &str, message: &str, reply: ApproveReply) {
    freedesktop::ask(title, message, reply);
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn ask(_parent: &Window, _title: &str, _message: &str, reply: ApproveReply) {
    let _ = reply.send(Ok(None));
}

pub(crate) fn dismiss() {
    #[cfg(target_os = "macos")]
    appkit::dismiss();
    #[cfg(target_os = "linux")]
    freedesktop::dismiss();
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn the_first_button_denies_and_a_dismissed_sheet_gives_no_answer() {
        use objc2_app_kit::{NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSModalResponseAbort};
        assert_eq!(super::appkit::answer(NSAlertFirstButtonReturn), Some(false));
        assert_eq!(super::appkit::answer(NSAlertSecondButtonReturn), Some(true));
        assert_eq!(super::appkit::answer(NSModalResponseAbort), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_the_two_actions_answer() {
        assert_eq!(super::freedesktop::answer("allow"), Some(true));
        assert_eq!(super::freedesktop::answer("deny"), Some(false));
        assert_eq!(super::freedesktop::answer("default"), None);
    }

    #[test]
    fn dismissing_without_a_dialog_does_nothing() {
        super::dismiss();
    }
}
