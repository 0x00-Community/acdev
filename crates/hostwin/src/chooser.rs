use winit::window::Window;

use crate::platform::FolderReply as Reply;

#[cfg(target_os = "macos")]
pub(crate) fn folder(parent: Option<&Window>, title: &str, reply: Reply) {
    use std::cell::Cell;
    use std::path::PathBuf;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponse, NSModalResponseOK, NSOpenPanel, NSView};
    use objc2_foundation::NSString;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Some(mtm) = MainThreadMarker::new() else {
        let _ = reply.send(Err("the folder chooser opens on the main thread".into()));
        return;
    };
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(false);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(false);
    panel.setCanCreateDirectories(true);
    panel.setMessage(Some(&NSString::from_str(title)));
    let shown = Cell::new(Some((panel.clone(), reply)));
    let handler = RcBlock::new(move |response: NSModalResponse| {
        let Some((panel, reply)) = shown.take() else { return };
        let picked = (response == NSModalResponseOK)
            .then(|| panel.URL())
            .flatten()
            .and_then(|url| url.path())
            .map(|path| PathBuf::from(path.to_string()));
        let _ = reply.send(Ok(picked));
    });
    let sheet_of = parent.and_then(|window| {
        let RawWindowHandle::AppKit(handle) = window.window_handle().ok()?.as_raw() else {
            return None;
        };
        let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        view.window()
    });
    match sheet_of {
        Some(window) => panel.beginSheetModalForWindow_completionHandler(&window, &handler),
        None => panel.beginWithCompletionHandler(&handler),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn folder(_parent: Option<&Window>, _title: &str, reply: Reply) {
    let _ = reply.send(Err("no folder chooser in host windows on this platform".into()));
}
