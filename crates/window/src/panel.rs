use acde_model::Event;
use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::{Interest, Mode, PostAction};
use smithay_client_toolkit::compositor::Region;
use smithay_client_toolkit::shell::WaylandSurface;
use smithay_client_toolkit::shell::xdg::window::{Window, WindowDecorations};
use wayland_client::protocol::{wl_buffer, wl_surface};
use wayland_protocols::wp::viewporter::client::wp_viewport;

use crate::client::{App, Buffers, Data, show};
use crate::protocol::acde_window;

pub(crate) struct PanelView {
    pub(crate) id: u32,
    pub(crate) window: Window,
    pub(crate) acde: acde_window::AcdeWindow,
    viewport: wp_viewport::WpViewport,
    pub(crate) rect: [i32; 4],
    input: Option<[i32; 4]>,
    pub(crate) buffers: Buffers,
    pub(crate) configured: bool,
    pub(crate) active: bool,
    reported: Option<[f64; 4]>,
    backdrop: Option<Backdrop>,
    backdrops: std::collections::VecDeque<(u64, Option<Backdrop>)>,
}

pub(crate) type Backdrop = ([i32; 4], [f64; 4]);

impl PanelView {
    pub(crate) fn plane(id: u32) -> usize {
        id as usize + 1
    }

    fn surface(&self) -> &wl_surface::WlSurface {
        self.window.wl_surface()
    }
}

impl App {
    pub(crate) fn open_panel(&mut self, id: u32, token: u64, rect: [i32; 4]) {
        self.close_panel(id);
        let surface = self.compositor.create_surface(&self.qh);
        let window = self.xdg.create_window(surface, WindowDecorations::RequestClient, &self.qh);
        window.set_app_id("acde-panel");
        let acde = self.manager.get_window(window.wl_surface(), &self.qh, Data);
        acde.bind((token >> 32) as u32, token as u32);
        let viewport = self.viewporter.get_viewport(window.wl_surface(), &self.qh, Data);
        window.commit();
        self.panels.push(PanelView {
            id,
            window,
            acde,
            viewport,
            rect,
            input: None,
            buffers: Buffers::default(),
            configured: false,
            active: false,
            reported: None,
            backdrop: None,
            backdrops: std::collections::VecDeque::new(),
        });
    }

    pub(crate) fn place_panel(&mut self, id: u32, rect: [i32; 4], input: [i32; 4]) {
        let Some(panel) = self.panels.iter_mut().find(|p| p.id == id) else { return };
        panel.rect = rect;
        if panel.input != Some(input) {
            panel.input = Some(input);
            if let Ok(region) = Region::new(&self.compositor) {
                region.add(input[0], input[1], input[2], input[3]);
                panel.surface().set_input_region(Some(region.wl_region()));
                panel.surface().commit();
            }
        }
    }

    pub(crate) fn close_panel(&mut self, id: u32) {
        let Some(at) = self.panels.iter().position(|p| p.id == id) else { return };
        let panel = self.panels.remove(at);
        self.painter.release(PanelView::plane(id));
        panel.acde.destroy();
        panel.buffers.destroy();
    }

    pub(crate) fn panel_configured(&mut self, window: &Window, active: bool) -> bool {
        let Some(panel) = self.panels.iter_mut().find(|p| &p.window == window) else { return false };
        let fresh = !panel.configured;
        panel.configured = true;
        panel.active = active;
        if fresh {
            self.render.invalidate();
        }
        true
    }

    pub(crate) fn activity(&mut self) {
        let active = self.active || self.panels.iter().any(|p| p.active);
        if active != self.told_active {
            self.told_active = active;
            self.events.push(Event::named(if active { "activate" } else { "deactivate" }));
        }
    }

    pub(crate) fn backdrops(panels: &[acde_render::Panel]) -> Vec<(u32, Option<Backdrop>)> {
        panels
            .iter()
            .map(|p| {
                let backdrop = p
                    .plane
                    .layers
                    .iter()
                    .filter_map(|l| l.backdrop.as_ref())
                    .map(|b| {
                        let r = b.bounds.intersect(b.clip);
                        (
                            [r.x0.floor() as i32, r.y0.floor() as i32, r.width().ceil().max(0.0) as i32, r.height().ceil().max(0.0) as i32],
                            [b.radius(), b.blur(), f64::from(b.saturate()), f64::from(b.brightness())],
                        )
                    })
                    .max_by_key(|([_, _, w, h], _)| w * h);
                (p.id, backdrop)
            })
            .collect()
    }

    pub(crate) fn queue_backdrops(&mut self, frame: u64, backdrops: Vec<(u32, Option<Backdrop>)>) {
        for (id, backdrop) in backdrops {
            if let Some(view) = self.panels.iter_mut().find(|v| v.id == id) {
                view.backdrops.push_back((frame, backdrop));
            }
        }
    }

    fn apply_backdrop(panel: &mut PanelView, frame: u64) {
        let mut latest = None;
        while panel.backdrops.front().is_some_and(|(f, _)| *f <= frame) {
            latest = panel.backdrops.pop_front().map(|(_, b)| b);
        }
        if let Some(backdrop) = latest.filter(|b| *b != panel.backdrop) {
            let ([x, y, w, h], [radius, blur, saturate, brightness]) = backdrop.unwrap_or_default();
            panel.acde.set_backdrop(x, y, w, h, radius, blur, saturate, brightness);
            panel.backdrop = backdrop;
        }
    }

    pub(crate) fn escapes(&mut self, panels: &[acde_render::Panel]) {
        let scale = self.scale;
        for p in panels {
            let Some(view) = self.panels.iter_mut().find(|v| v.id == p.id) else { continue };
            let Some(e) = p.extent else { continue };
            let (w, h) = (f64::from(p.size.0), f64::from(p.size.1));
            let out = e.x < -0.5 || e.y < -0.5 || e.x + e.width > w + 0.5 || e.y + e.height > h + 0.5;
            let seen = [e.x, e.y, e.width, e.height];
            if out && view.reported != Some(seen) {
                view.reported = Some(seen);
                let [x, y] = [view.rect[0], view.rect[1]].map(f64::from);
                self.events.push(Event {
                    kind: "panelmove".into(),
                    code: Some(p.id),
                    x: Some(x + e.x / scale),
                    y: Some(y + e.y / scale),
                    width: Some(e.width / scale),
                    height: Some(e.height / scale),
                    ..Default::default()
                });
            }
        }
    }

    pub(crate) fn origin_of(&self, surface: &wl_surface::WlSurface) -> Option<(f64, f64)> {
        if surface == self.window.wl_surface() {
            return Some((0.0, 0.0));
        }
        self.panels.iter().find(|p| p.surface() == surface).map(|p| (f64::from(p.rect[0]), f64::from(p.rect[1])))
    }

    pub(crate) fn present_panel(&mut self, drawn: acde_paint::Drawn) {
        let plane = drawn.plane;
        let Some(buffer) = self.current_buffer(&drawn) else { return };
        let scale = self.scale;
        let Some(panel) = self.panels.iter_mut().find(|p| PanelView::plane(p.id) == plane) else { return };
        let surface = panel.surface().clone();
        show(&surface, &panel.viewport, &buffer, &drawn, scale);
        Self::apply_backdrop(panel, drawn.frame);
        surface.commit();
        panel.buffers.destroy_retired();
        self.painter.hold(plane, drawn.canvas, true);
    }

    pub(crate) fn release_buffer(&mut self, buffer: &wl_buffer::WlBuffer) {
        let mut released = Vec::new();
        if let Some(index) = self.buffers.index_of(buffer, self.painter.generation(0)) {
            released.push((0, index));
        }
        let plane = crate::decoration::PLANE;
        if let Some(index) = self.decoration.as_ref().and_then(|d| d.buffers.index_of(buffer, self.painter.generation(plane))) {
            released.push((plane, index));
        }
        for panel in &self.panels {
            let plane = PanelView::plane(panel.id);
            if let Some(index) = panel.buffers.index_of(buffer, self.painter.generation(plane)) {
                released.push((plane, index));
            }
        }
        for (plane, index) in released {
            self.unhold_when_idle(plane, index);
        }
        self.paint();
    }

    fn unhold_when_idle(&mut self, plane: usize, index: usize) {
        let generation = self.painter.generation(plane);
        let fd = self.painter.canvases(plane).nth(index).and_then(|d| d.handles().next()).and_then(|fd| fd.try_clone_to_owned().ok());
        let Some(fd) = fd.filter(|fd| !Self::writable(fd)) else {
            self.painter.hold(plane, index, false);
            return;
        };
        let source = Generic::new(fd, Interest::WRITE, Mode::OneShot);
        let inserted = self.handle.insert_source(source, move |_, _, app| {
            if app.painter.generation(plane) == generation {
                app.painter.hold(plane, index, false);
                app.paint();
            }
            Ok(PostAction::Remove)
        });
        if let Err(e) = inserted {
            log::warn!("web canvas waiting for the compositor to finish reading: {e}");
            self.painter.hold(plane, index, false);
        }
    }

    fn writable(fd: &std::os::fd::OwnedFd) -> bool {
        let mut fds = [rustix::event::PollFd::new(fd, rustix::event::PollFlags::OUT)];
        matches!(rustix::event::poll(&mut fds, Some(&rustix::event::Timespec { tv_sec: 0, tv_nsec: 0 })), Ok(1))
    }
}
