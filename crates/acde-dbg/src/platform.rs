use acdert::model::{Event, OpenRequest, SaveRequest, Waker};
use acdert::render::{RenderHandle, SurfaceCommand};
use acdert::{Platform, Window, v8};

pub struct Host;

struct Surface(acde_hostwin::Surface);

impl Window for Surface {
    fn window(&self) -> u32 {
        self.0.window()
    }

    fn content_offset(&self) -> (f64, f64) {
        self.0.content_offset()
    }

    fn pump(&self) -> Vec<Event> {
        self.0.pump()
    }

    fn has_events(&self) -> bool {
        self.0.has_events()
    }

    fn set_waker(&self, waker: Option<Waker>) {
        self.0.set_waker(waker)
    }

    fn send(&self, command: SurfaceCommand) {
        self.0.send(command)
    }

    fn minimizable(&self) -> bool {
        self.0.minimizable()
    }

    fn host_controls(&self) -> bool {
        self.0.host_controls()
    }

    fn size(&self) -> Option<(u32, u32, f64)> {
        self.0.size()
    }

    fn hosted(&self) -> bool {
        true
    }
}

impl Platform for Host {
    fn claim(&self, token: u64, render: RenderHandle, frame: u32, app: Option<String>) -> Result<Box<dyn Window>, String> {
        acde_hostwin::Surface::claim(token, render, frame, app).map(|s| Box::new(Surface(s)) as Box<dyn Window>)
    }

    fn exports<'s>(&self, scope: &mut v8::PinScope<'s, '_>, napi: v8::Local<'s, v8::Value>) -> v8::Local<'s, v8::Value> {
        crate::hostnative::exports(scope, Some(napi))
    }

    #[cfg(windows)]
    fn content_type(&self, extension: &str) -> Option<String> {
        acde_hostwin::content_type(extension)
    }

    fn choose_folder(&self, title: &str) -> Result<Option<String>, String> {
        crate::chooser::folder(title)
    }

    fn open_files(&self, request: OpenRequest) -> Result<Option<Vec<String>>, String> {
        crate::chooser::open(request)
    }

    fn save_file(&self, request: SaveRequest) -> Result<Option<String>, String> {
        crate::chooser::save(request)
    }
}
