#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
use winit::window::Window;

use crate::platform::{FilesReply, FolderReply};
use crate::{OpenRequest, SaveRequest};

#[cfg(target_os = "macos")]
mod appkit {
    use std::cell::Cell;
    use std::path::PathBuf;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSModalResponse, NSModalResponseOK, NSOpenPanel, NSSavePanel, NSView, NSWindow};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use objc2_uniform_type_identifiers::UTType;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use winit::window::Window;

    use crate::FileFilter;

    pub(super) const NOT_MAIN: &str = "the chooser opens on the main thread";

    fn sheet_of(parent: Option<&Window>) -> Option<Retained<NSWindow>> {
        let RawWindowHandle::AppKit(handle) = parent?.window_handle().ok()?.as_raw() else {
            return None;
        };
        let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        view.window()
    }

    pub(super) fn show(panel: &NSSavePanel, parent: Option<&Window>, done: impl FnOnce(bool) + 'static) {
        let done = Cell::new(Some(done));
        let handler = RcBlock::new(move |response: NSModalResponse| {
            if let Some(done) = done.take() {
                done(response == NSModalResponseOK);
            }
        });
        match sheet_of(parent) {
            Some(window) => panel.beginSheetModalForWindow_completionHandler(&window, &handler),
            None => panel.beginWithCompletionHandler(&handler),
        }
    }

    pub(super) fn path(url: &NSURL) -> Option<PathBuf> {
        url.path().map(|path| PathBuf::from(path.to_string()))
    }

    pub(super) fn open_panel(mtm: MainThreadMarker, title: &str, directory: bool, multiple: bool) -> Retained<NSOpenPanel> {
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseFiles(!directory);
        panel.setCanChooseDirectories(directory);
        panel.setAllowsMultipleSelection(multiple);
        panel.setCanCreateDirectories(directory);
        panel.setMessage(Some(&NSString::from_str(title)));
        panel
    }

    pub(super) fn save_panel(mtm: MainThreadMarker, title: &str, name: &str) -> Retained<NSSavePanel> {
        let panel = NSSavePanel::savePanel(mtm);
        panel.setCanCreateDirectories(true);
        panel.setMessage(Some(&NSString::from_str(title)));
        if !name.is_empty() {
            panel.setNameFieldStringValue(&NSString::from_str(name));
        }
        panel
    }

    pub(super) fn picked(panel: &NSOpenPanel) -> Vec<PathBuf> {
        panel.URLs().iter().filter_map(|url| path(&url)).collect()
    }

    fn glob_type(glob: &str) -> Option<Retained<UTType>> {
        let extension = glob.strip_prefix("*.")?;
        if extension.is_empty() || extension.contains(['*', '?', '[', '/']) {
            return None;
        }
        UTType::typeWithFilenameExtension(&NSString::from_str(extension))
    }

    fn mime_type(mime: &str) -> Option<Retained<UTType>> {
        let identifier = match mime.split_once('/')? {
            ("image", "*") => "public.image",
            ("text", "*") => "public.text",
            ("audio", "*") => "public.audio",
            ("video", "*") => "public.movie",
            (_, "*") => return None,
            _ => return UTType::typeWithMIMEType(&NSString::from_str(mime)),
        };
        UTType::typeWithIdentifier(&NSString::from_str(identifier))
    }

    pub(super) fn content_types(filters: &[FileFilter]) -> Option<Retained<NSArray<UTType>>> {
        let mut types = Vec::new();
        for filter in filters {
            for glob in &filter.globs {
                types.push(glob_type(glob)?);
            }
            for mime in &filter.mimes {
                types.push(mime_type(mime)?);
            }
        }
        (!types.is_empty()).then(|| NSArray::from_retained_slice(&types))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn filter(globs: &[&str], mimes: &[&str]) -> FileFilter {
            FileFilter { name: String::new(), globs: globs.iter().map(|g| (*g).to_owned()).collect(), mimes: mimes.iter().map(|m| (*m).to_owned()).collect() }
        }

        fn identifiers(filters: &[FileFilter]) -> Option<Vec<String>> {
            content_types(filters).map(|types| types.iter().map(|t| t.identifier().to_string()).collect())
        }

        #[test]
        fn filters_become_content_types() {
            assert_eq!(identifiers(&[filter(&["*.png"], &["text/plain"])]), Some(vec!["public.png".to_owned(), "public.plain-text".to_owned()]));
            assert_eq!(identifiers(&[filter(&[], &["image/*"]), filter(&["*.JPG"], &[])]), Some(vec!["public.image".to_owned(), "public.jpeg".to_owned()]));
        }

        #[test]
        fn filters_that_name_no_type_allow_every_file() {
            assert_eq!(identifiers(&[]), None);
            assert_eq!(identifiers(&[filter(&["*"], &[])]), None);
            assert_eq!(identifiers(&[filter(&["*.png", "report-*"], &[])]), None);
            assert_eq!(identifiers(&[filter(&[], &["application/*"])]), None);
            assert_eq!(identifiers(&[filter(&[], &["not a mime"])]), None);
        }

        #[test]
        fn unknown_extensions_still_match_their_files() {
            let types = identifiers(&[filter(&["*.acdetest"], &[])]).unwrap();
            assert_eq!(types.len(), 1);
            assert!(types[0].starts_with("dyn."), "{types:?}");
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn folder(parent: Option<&Window>, title: &str, reply: FolderReply) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = reply.send(Err(appkit::NOT_MAIN.to_owned()));
        return;
    };
    let panel = appkit::open_panel(mtm, title, true, false);
    let shown = panel.clone();
    appkit::show(&panel, parent, move |ok| {
        let _ = reply.send(Ok(appkit::picked(&shown).into_iter().next().filter(|_| ok)));
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn open(parent: Option<&Window>, request: &OpenRequest, reply: FilesReply) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = reply.send(Err(appkit::NOT_MAIN.to_owned()));
        return;
    };
    let panel = appkit::open_panel(mtm, &request.title, request.directory, request.multiple);
    if !request.directory
        && let Some(types) = appkit::content_types(&request.filters)
    {
        panel.setAllowedContentTypes(&types);
    }
    let shown = panel.clone();
    appkit::show(&panel, parent, move |ok| {
        let paths = if ok { appkit::picked(&shown) } else { Vec::new() };
        let _ = reply.send(Ok((!paths.is_empty()).then_some(paths)));
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn save(parent: Option<&Window>, request: &SaveRequest, reply: FolderReply) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = reply.send(Err(appkit::NOT_MAIN.to_owned()));
        return;
    };
    let panel = appkit::save_panel(mtm, &request.title, &request.name);
    let shown = panel.clone();
    appkit::show(&panel, parent, move |ok| {
        let _ = reply.send(Ok(if ok { shown.URL().and_then(|url| appkit::path(&url)) } else { None }));
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn folder(_parent: Option<&Window>, _title: &str, reply: FolderReply) {
    let _ = reply.send(Err("no folder chooser in host windows on this platform".into()));
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn open(_parent: Option<&Window>, _request: &OpenRequest, reply: FilesReply) {
    let _ = reply.send(Err("no file chooser in host windows on this platform".into()));
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn save(_parent: Option<&Window>, _request: &SaveRequest, reply: FolderReply) {
    let _ = reply.send(Err("no save chooser in host windows on this platform".into()));
}
