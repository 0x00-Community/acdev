use acde_model::{BTN_LEFT, Event};
use acde_paint::{Drawn, Sheet};
use acde_render::{Bar, Decoration, FrameButton, FrameStyle};
use smithay_client_toolkit::seat::pointer::{PointerEvent, PointerEventKind};
use smithay_client_toolkit::shell::xdg::XdgSurface;
use smithay_client_toolkit::subcompositor::SubcompositorState;
use wayland_client::protocol::{wl_subsurface, wl_surface};
use wayland_protocols::wp::cursor_shape::v1::client::wp_cursor_shape_device_v1::Shape;
use wayland_protocols::wp::viewporter::client::wp_viewport;

use crate::client::{App, Buffers, Data, show};
use crate::protocol::acde_window::Edges;

pub(crate) const PLANE: usize = usize::MAX;

pub(crate) struct DecorationView {
    pub(crate) surface: wl_surface::WlSurface,
    _subsurface: wl_subsurface::WlSubsurface,
    viewport: wp_viewport::WpViewport,
    pub(crate) buffers: Buffers,
    pub(crate) height: u32,
    title: String,
    painter: Decoration,
    drawn: Option<Bar>,
    pub(crate) fullscreen: bool,
    pressed: Option<FrameButton>,
    pub(crate) theme: acde_render::FrameTheme,
    pub(crate) dark_page: bool,
}

impl DecorationView {
    pub(crate) fn new(
        app_surface: &wl_surface::WlSurface,
        subcompositor: &SubcompositorState,
        viewporter: &wayland_protocols::wp::viewporter::client::wp_viewporter::WpViewporter,
        height: u32,
        qh: &wayland_client::QueueHandle<App>,
    ) -> Self {
        let (subsurface, surface) = subcompositor.create_subsurface(app_surface.clone(), qh);
        subsurface.set_position(0, -(height as i32));
        let viewport = viewporter.get_viewport(&surface, qh, Data);
        Self {
            surface,
            _subsurface: subsurface,
            viewport,
            buffers: Buffers::default(),
            height,
            title: String::new(),
            painter: Decoration::new(),
            drawn: None,
            fullscreen: false,
            pressed: None,
            theme: crate::client::Surface::frame_theme(),
            dark_page: false,
        }
    }
}

impl App {
    pub(crate) fn frame_height(&self) -> u32 {
        self.decoration.as_ref().map_or(0, |d| d.height)
    }

    pub(crate) fn content(&self) -> (u32, u32) {
        content_size(self.logical, self.frame_height())
    }

    pub(crate) fn set_frame_look(&mut self, theme: Option<acde_render::FrameTheme>, dark_page: Option<bool>) {
        let Some(deco) = self.decoration.as_mut() else { return };
        if let Some(theme) = theme {
            deco.theme = theme;
        }
        if let Some(dark) = dark_page {
            deco.dark_page = dark;
        }
        self.paint();
    }

    pub(crate) fn set_title(&mut self, title: String) {
        if let Some(deco) = self.decoration.as_mut() {
            deco.title = title;
            self.paint();
        }
    }

    pub(crate) fn decorate(&mut self, fullscreen: bool) {
        let (w, h) = self.logical;
        let Some(deco) = self.decoration.as_mut() else { return };
        deco.fullscreen = fullscreen;
        self.window.xdg_surface().set_window_geometry(0, -(deco.height as i32), w as i32, h as i32);
        self.send_hints();
    }

    fn bar(&self) -> Option<Bar> {
        let deco = self.decoration.as_ref()?;
        Some(Bar {
            title: deco.title.clone(),
            width: f64::from(self.logical.0),
            height: f64::from(deco.height),
            scale: self.scale,
            style: FrameStyle::current(),
            fullscreen: deco.fullscreen,
            theme: deco.theme,
            active: true,
            dark_page: deco.dark_page,
            minimize: true,
        })
    }

    pub(crate) fn decoration_sheet(&mut self) -> Option<(usize, Sheet, (u32, u32))> {
        let bar = self.bar()?;
        let deco = self.decoration.as_mut()?;
        if deco.drawn.as_ref() == Some(&bar) {
            return None;
        }
        let scene = deco.painter.scene(&bar);
        let size = bar.pixels();
        deco.drawn = Some(bar);
        Some((PLANE, Sheet::whole(scene, size), size))
    }

    pub(crate) fn redraw_decoration(&mut self) {
        if let Some(deco) = self.decoration.as_mut() {
            deco.drawn = None;
        }
    }

    pub(crate) fn present_decoration(&mut self, drawn: Drawn) -> bool {
        let Some(buffer) = self.current_buffer(&drawn) else { return false };
        let scale = self.scale;
        let Some(deco) = self.decoration.as_mut() else { return false };
        show(&deco.surface, &deco.viewport, &buffer, &drawn, scale);
        deco.surface.commit();
        deco.buffers.destroy_retired();
        self.painter.hold(PLANE, drawn.canvas, true);
        true
    }

    pub(crate) fn set_page_hint(&mut self, [x, y, w, h]: [i32; 4], edges: u32) {
        match w <= 0 || h <= 0 {
            true => self.page_hints.clear(),
            false => self.page_hints.push(([x, y, w, h], edges)),
        }
        self.send_hints();
    }

    pub(crate) fn send_hints(&mut self) {
        self.acde.set_grab_hint(0, 0, 0, 0, Edges::empty());
        for ([x, y, w, h], edges) in grab_hints(self.logical, self.frame_height(), &self.page_hints) {
            self.acde.set_grab_hint(x, y, w, h, edges);
        }
    }

    pub(crate) fn page_backdrop(&self, rect: [i32; 4]) -> [i32; 4] {
        backdrop_rect(rect, self.frame_height(), self.scale)
    }

    pub(crate) fn decoration_pointer(&mut self, event: &PointerEvent) -> bool {
        let Some(bar) = self.bar() else { return false };
        let Some(deco) = self.decoration.as_mut().filter(|d| d.surface == event.surface) else { return false };
        match event.kind {
            PointerEventKind::Enter { serial } => {
                if let Some(shape) = &self.shape {
                    shape.set_shape(serial, Shape::Default);
                }
            }
            PointerEventKind::Motion { .. } | PointerEventKind::Axis { .. } => {}
            PointerEventKind::Leave { .. } => deco.pressed = None,
            PointerEventKind::Press { button, serial, .. } => {
                self.serial = serial;
                self.pointer_serial = serial;
                deco.pressed = (button == BTN_LEFT).then(|| bar.button_at(event.position.0, event.position.1)).flatten();
            }
            PointerEventKind::Release { button, serial, .. } => {
                self.serial = serial;
                let pressed = deco.pressed.take().filter(|_| button == BTN_LEFT);
                if let Some(button) = pressed.filter(|&p| bar.button_at(event.position.0, event.position.1) == Some(p)) {
                    self.events.push(Event { kind: "framebutton".into(), key: Some(button.key(deco.fullscreen).into()), ..Default::default() });
                }
            }
        }
        true
    }
}

fn content_size((w, h): (u32, u32), top: u32) -> (u32, u32) {
    (w, h.saturating_sub(top).max(1))
}

fn grab_hints((w, h): (u32, u32), top: u32, page: &[([i32; 4], u32)]) -> Vec<([i32; 4], Edges)> {
    let top = top as i32;
    let mut hints: Vec<([i32; 4], Edges)> = page.iter().map(|&([x, y, w, h], edges)| ([x, y + top, w, h], Edges::from_bits_truncate(edges))).collect();
    if top != 0 && w > 0 && h > 0 {
        let frame = Bar::grab_hints(w.into(), h.into(), top.into());
        hints.extend(frame.map(|(r, edges)| (r.map(|v| v as i32), Edges::from_bits_truncate(edges))));
    }
    hints
}

fn backdrop_rect([x, y, w, h]: [i32; 4], top: u32, scale: f64) -> [i32; 4] {
    match w <= 0 || h <= 0 {
        true => [x, y, w, h],
        false => [x, y + (f64::from(top) * scale).round() as i32, w, h],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_gets_the_window_less_the_frame() {
        assert_eq!(content_size((640, 552), 32), (640, 520));
        assert_eq!(content_size((640, 520), 0), (640, 520));
        assert_eq!(content_size((640, 20), 32), (640, 1));
    }

    #[test]
    fn page_hints_move_below_the_frame_and_the_frame_wins_last() {
        let page = [([10, 0, 100, 20], 0), ([0, 500, 640, 20], Edges::Bottom.bits())];
        let hints = grab_hints((640, 552), 32, &page);
        assert_eq!(hints[0], ([10, 32, 100, 20], Edges::empty()));
        assert_eq!(hints[1], ([0, 532, 640, 20], Edges::Bottom));
        assert_eq!(hints[2], ([76, 0, 564, 32], Edges::empty()), "the title bar, buttons left out");
        assert!(hints.contains(&([0, 548, 640, 4], Edges::Bottom)));
        assert!(hints.contains(&([630, 542, 10, 10], Edges::Bottom | Edges::Right)));
        assert_eq!(hints.len(), 2 + 9);
    }

    #[test]
    fn without_a_frame_page_hints_pass_through() {
        let page = [([10, 0, 100, 20], Edges::Left.bits())];
        assert_eq!(grab_hints((640, 520), 0, &page), vec![([10, 0, 100, 20], Edges::Left)]);
        assert_eq!(grab_hints((0, 0), 32, &page), vec![([10, 32, 100, 20], Edges::Left)]);
    }

    #[test]
    fn backdrops_move_by_the_frame_in_physical_pixels() {
        assert_eq!(backdrop_rect([0, 10, 50, 50], 32, 2.0), [0, 74, 50, 50]);
        assert_eq!(backdrop_rect([0, 10, 50, 50], 32, 1.25), [0, 50, 50, 50]);
        assert_eq!(backdrop_rect([0, 0, 0, 0], 32, 2.0), [0, 0, 0, 0], "clearing stays a clear");
    }
}
