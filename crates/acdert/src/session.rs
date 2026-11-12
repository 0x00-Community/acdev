use acde_model::{Event, Waker};
use acde_render::{RenderHandle, SurfaceCommand};

use crate::platform::{Platform, Window};

pub struct Session;

impl Window for acde_window::Surface {
    fn window(&self) -> u32 {
        acde_window::Surface::window(self)
    }

    fn content_offset(&self) -> (f64, f64) {
        acde_window::Surface::content_offset(self)
    }

    fn pump(&self) -> Vec<Event> {
        acde_window::Surface::pump(self)
    }

    fn has_events(&self) -> bool {
        acde_window::Surface::has_events(self)
    }

    fn set_waker(&self, waker: Option<Waker>) {
        acde_window::Surface::set_waker(self, waker)
    }

    fn send(&self, command: SurfaceCommand) {
        acde_window::Surface::send(self, command)
    }
}

impl Platform for Session {
    fn claim(&self, token: u64, render: RenderHandle, frame: u32, _: Option<String>) -> Result<Box<dyn Window>, String> {
        acde_window::Surface::claim(token, render, frame).map(|s| Box::new(s) as Box<dyn Window>)
    }
}
