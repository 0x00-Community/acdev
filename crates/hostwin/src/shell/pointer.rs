use acde_model::{ClickSettings, Mode, WindowState};

use super::State;

pub(crate) enum Press {
    Plain,
    Drag(u32, [f64; 4]),
    Double(Option<WindowState>),
}

pub(crate) struct Hit {
    pub entry: u32,
    pub target: u32,
    pub origin: [f64; 2],
    pub bar: bool,
    pub blocked: bool,
}

impl State {
    pub fn hit(&self, x: f64, y: f64) -> Option<Hit> {
        self.layers().into_iter().rev().find_map(|layer| {
            let e = self.entries.get(&layer.id)?;
            let [rx, ry, rw, rh] = e.rect;
            let (x, y) = layer.look.unmap(&acde_model::Rect::new(rx, ry, rw, rh), 1.0, x, y);
            let inside = |[ax, ay, aw, ah]: [f64; 4]| x >= ax && y >= ay && x < ax + aw && y < ay + ah;
            let area = match e.input {
                Some([ix, iy, iw, ih]) => [rx + ix, ry + iy, iw, ih],
                None => e.rect,
            };
            if !inside(area) {
                return None;
            }
            let hit = match e.owner {
                Some(owner) => Hit { entry: layer.id, target: owner, origin: [0.0, 0.0], bar: false, blocked: false },
                None => Hit { entry: layer.id, target: layer.id, origin: [rx, ry + e.frame], bar: y < ry + e.frame, blocked: false },
            };
            Some(match self.modal_child(hit.target) {
                Some(modal) => Hit { entry: modal, target: modal, origin: [0.0, 0.0], bar: false, blocked: true },
                None => hit,
            })
        })
    }

    pub fn press(&mut self, id: u32, at: [f64; 2], now_ms: f64, settings: ClickSettings) -> Press {
        let Some(e) = self.entries.get(&id).filter(|e| !e.desktop && !e.panel && e.owner.is_none()) else {
            self.clicks.reset();
            return Press::Plain;
        };
        let (x, y) = (at[0] - e.rect[0], at[1] - e.rect[1]);
        let edges = edges_at(&e.grab_hints(&self.theme), x, y);
        let title = edges == Some(0) && matches!(e.mode, Mode::Free | Mode::Fixed);
        let allowed = e.state.moves() && (e.mode == Mode::Free || (e.mode == Mode::Fixed && edges == Some(0)));
        let (mode, state, rect) = (e.mode, e.state, e.rect);
        if !title {
            self.clicks.reset();
        } else if self.clicks.press(id, now_ms, at, settings) >= 2 {
            self.clicks.reset();
            return Press::Double(self.double_click.target(mode, state));
        }
        match edges {
            Some(edges) if allowed => Press::Drag(edges, rect),
            _ => Press::Plain,
        }
    }
}

pub(crate) fn edges_at(hints: &[([f64; 4], u32)], x: f64, y: f64) -> Option<u32> {
    hints.iter().rev().find(|([hx, hy, hw, hh], _)| x >= *hx && y >= *hy && x < hx + hw && y < hy + hh).map(|(_, edges)| *edges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Grant;
    use crate::shell::tests::{apply, open, screen};
    use acde_model::DoubleClick;

    #[test]
    fn a_double_click_on_a_title_area_acts_without_starting_a_move() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("framed").frame = 32.0;
        let title = [300.0, 115.0];
        assert!(matches!(s.press(w, title, 0.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, title, 200.0, settings), Press::Double(Some(WindowState::Filled))));
        assert!(matches!(s.press(w, title, 300.0, settings), Press::Drag(0, _)), "a third press starts over");
        apply(&mut s, w, Some(WindowState::Filled));
        let top = [300.0, 15.0];
        assert!(matches!(s.press(w, top, 1000.0, settings), Press::Plain), "a filled window does not move");
        assert!(matches!(s.press(w, top, 1100.0, settings), Press::Double(Some(WindowState::Normal))));
        apply(&mut s, w, Some(WindowState::Normal));
        assert!(matches!(s.press(w, title, 2000.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, title, 2600.0, settings), Press::Drag(0, _)), "too slow");
        assert!(matches!(s.press(w, [300.0, 300.0], 2700.0, settings), Press::Plain), "the page");
        assert!(matches!(s.press(w, title, 2800.0, settings), Press::Drag(0, _)), "a press elsewhere starts over");
    }

    #[test]
    fn page_grab_hints_without_edges_take_the_double_click() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("frameless").hints = vec![([0.0, 0.0, 400.0, 40.0], 0), ([0.0, 0.0, 400.0, 4.0], acde_model::edge::TOP)];
        let caption = [200.0, 120.0];
        assert!(matches!(s.press(w, caption, 0.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, caption, 100.0, settings), Press::Double(Some(WindowState::Filled))));
        let edge = [200.0, 101.0];
        assert!(matches!(s.press(w, edge, 1000.0, settings), Press::Drag(acde_model::edge::TOP, _)));
        assert!(matches!(s.press(w, edge, 1100.0, settings), Press::Drag(acde_model::edge::TOP, _)), "resize edges never double-click");
    }

    #[test]
    fn the_declared_action_decides_and_some_windows_ignore_the_gesture() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let double = |s: &mut State, id: u32, at: [f64; 2], t: f64| {
            s.press(id, at, t, settings);
            s.press(id, at, t + 100.0, settings)
        };
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("framed").frame = 32.0;
        s.double_click = DoubleClick::Minimize;
        assert!(matches!(double(&mut s, w, [300.0, 115.0], 0.0), Press::Double(Some(WindowState::Minimized))));
        s.double_click = DoubleClick::Off;
        assert!(matches!(double(&mut s, w, [300.0, 115.0], 1000.0), Press::Double(None)));
        s.double_click = DoubleClick::Fill;
        let fixed = open(&mut s, Grant { mode: Some(Mode::Fixed), rect: Some([600.0, 100.0, 300.0, 200.0]), ..Grant::default() });
        s.entries.get_mut(&fixed).expect("fixed").frame = 32.0;
        assert!(matches!(double(&mut s, fixed, [750.0, 115.0], 2000.0), Press::Double(None)));
        let pinned = open(&mut s, Grant { mode: Some(Mode::Pinned), rect: Some([0.0, 700.0, 300.0, 100.0]), ..Grant::default() });
        s.entries.get_mut(&pinned).expect("pinned").hints = vec![([0.0, 0.0, 300.0, 100.0], 0)];
        assert!(matches!(double(&mut s, pinned, [100.0, 750.0], 3000.0), Press::Plain));
        let (desktop, _) = s.grant(Grant { desktop: true, ..Grant::default() });
        s.entries.get_mut(&desktop).expect("desktop").hints = vec![([0.0, 0.0, 1000.0, 800.0], 0)];
        assert!(matches!(double(&mut s, desktop, [10.0, 10.0], 4000.0), Press::Plain));
    }

    #[test]
    fn the_theme_moves_the_title_area_with_the_buttons() {
        let mut s = screen();
        let settings = ClickSettings::default();
        let w = open(&mut s, Grant { rect: Some([100.0, 100.0, 400.0, 300.0]), ..Grant::default() });
        s.entries.get_mut(&w).expect("framed").frame = 32.0;
        s.theme = acde_render::FrameTheme { style: Some(acde_render::FrameStyle::Windows), side: Some(acde_render::ButtonSide::Right), ..Default::default() };
        assert!(matches!(s.press(w, [120.0, 115.0], 0.0, settings), Press::Drag(0, _)));
        assert!(matches!(s.press(w, [480.0, 115.0], 1000.0, settings), Press::Plain), "the close button");
        assert_eq!(s.entries[&w].bar(s.theme, true).button_at(380.0, 15.0), Some(acde_render::FrameButton::Close));
        s.theme.side = Some(acde_render::ButtonSide::Left);
        assert!(matches!(s.press(w, [120.0, 115.0], 2000.0, settings), Press::Plain), "the buttons moved left");
        assert!(matches!(s.press(w, [480.0, 115.0], 3000.0, settings), Press::Drag(0, _)));
        assert_eq!(s.entries[&w].bar(s.theme, true).button_at(100.0, 15.0), Some(acde_render::FrameButton::Close));
    }

    #[test]
    fn only_a_granted_host_window_on_a_host_with_controls_maps_hints_to_the_host() {
        let mut s = screen();
        let plain = open(&mut s, Grant { host: true, ..Grant::default() });
        assert!(!s.entries[&plain].host, "no native controls, no host window");
        s.controls = true;
        let primary = open(&mut s, Grant { host: true, mode: Some(Mode::Fullscreen), ..Grant::default() });
        let other = open(&mut s, Grant { rect: Some([10.0, 10.0, 100.0, 100.0]), ..Grant::default() });
        assert_eq!((s.host_entry(), s.entries[&other].host), (Some(primary), false));
        s.entries.get_mut(&primary).expect("primary").hints = vec![([0.0, 0.0, 1000.0, 40.0], 0), ([0.0, 0.0, 1000.0, 4.0], acde_model::edge::TOP)];
        let hints = s.entries[&primary].grab_hints(&s.theme);
        assert_eq!([20.0, 2.0, 200.0].map(|y| edges_at(&hints, 500.0, y)), [Some(0), Some(acde_model::edge::TOP), None]);
    }
}
