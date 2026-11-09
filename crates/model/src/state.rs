use crate::Mode;

wire!(#[derive(Default)] "window state" WindowState {
    #[default]
    Normal = "normal",
    Minimized = "minimized",
    Filled = "filled",
    Fullscreen = "fullscreen",
});

impl WindowState {
    pub fn allowed(self, mode: Mode) -> bool {
        match self {
            WindowState::Normal => true,
            WindowState::Minimized => matches!(mode, Mode::Free | Mode::Fixed),
            WindowState::Filled | WindowState::Fullscreen => mode == Mode::Free,
        }
    }

    pub fn shown(self) -> bool {
        self != WindowState::Minimized
    }

    pub fn moves(self) -> bool {
        matches!(self, WindowState::Normal)
    }
}

wire!(#[derive(Default)] "double-click action" DoubleClick {
    #[default]
    Fill = "fill",
    Minimize = "minimize",
    Off = "none",
});

impl DoubleClick {
    pub fn target(self, mode: Mode, state: WindowState) -> Option<WindowState> {
        if mode != Mode::Free {
            return None;
        }
        match (self, state) {
            (DoubleClick::Fill, WindowState::Normal) => Some(WindowState::Filled),
            (DoubleClick::Fill, WindowState::Filled) => Some(WindowState::Normal),
            (DoubleClick::Minimize, WindowState::Normal | WindowState::Filled) => Some(WindowState::Minimized),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClickSettings {
    pub time_ms: f64,
    pub distance: [f64; 2],
}

impl Default for ClickSettings {
    fn default() -> Self {
        Self { time_ms: 500.0, distance: [4.0, 4.0] }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Clicks {
    last: Option<(u32, f64, [f64; 2])>,
    count: u32,
}

impl Clicks {
    pub fn press(&mut self, target: u32, now_ms: f64, at: [f64; 2], settings: ClickSettings) -> u32 {
        let near = self.last.is_some_and(|(t, then, [x, y])| {
            t == target
                && now_ms - then <= settings.time_ms
                && (at[0] - x).abs() <= settings.distance[0] / 2.0
                && (at[1] - y).abs() <= settings.distance[1] / 2.0
        });
        self.count = if near { self.count + 1 } else { 1 };
        self.last = Some((target, now_ms, at));
        self.count
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Change {
    pub state: WindowState,
    pub previous: WindowState,
    pub rect: Option<[f64; 4]>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Restore {
    pub normal: Option<[f64; 4]>,
    pub before_fullscreen: WindowState,
    pub before_minimized: WindowState,
}

impl Restore {
    pub fn back(&self, from: WindowState) -> WindowState {
        match from {
            WindowState::Fullscreen => self.before_fullscreen,
            WindowState::Minimized => self.before_minimized,
            _ => WindowState::Normal,
        }
    }

    pub fn normal_rect(&self, state: WindowState, rect: [f64; 4]) -> [f64; 4] {
        match state {
            WindowState::Normal => rect,
            _ => self.normal.unwrap_or(rect),
        }
    }

    pub fn change(&mut self, mode: Mode, from: WindowState, to: WindowState, rect: [f64; 4], work: [f64; 4], screen: [f64; 4]) -> Option<Change> {
        if from == to || !to.allowed(mode) {
            return None;
        }
        if from == WindowState::Normal {
            self.normal = Some(rect);
        }
        let rect = match to {
            WindowState::Normal => self.normal,
            WindowState::Filled => Some(work),
            WindowState::Fullscreen => {
                let prior = if from == WindowState::Minimized { self.before_minimized } else { from };
                if prior != WindowState::Fullscreen {
                    self.before_fullscreen = prior;
                }
                Some(screen)
            }
            WindowState::Minimized => {
                self.before_minimized = from;
                None
            }
        };
        Some(Change { state: to, previous: from, rect })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WindowState::*;

    const SCREEN: [f64; 4] = [0.0, 0.0, 1000.0, 800.0];
    const WORK: [f64; 4] = [0.0, 30.0, 1000.0, 700.0];
    const ORIGINAL: [f64; 4] = [100.0, 120.0, 400.0, 300.0];

    struct Window {
        state: WindowState,
        rect: [f64; 4],
        restore: Restore,
        mode: Mode,
    }

    impl Window {
        fn new(mode: Mode) -> Self {
            Window { state: Normal, rect: ORIGINAL, restore: Restore::default(), mode }
        }

        fn request(&mut self, to: WindowState) -> bool {
            let Some(change) = self.restore.change(self.mode, self.state, to, self.rect, WORK, SCREEN) else { return false };
            assert_eq!(change.previous, self.state);
            self.state = change.state;
            if let Some(rect) = change.rect {
                self.rect = rect;
            }
            true
        }

        fn back(&mut self) -> bool {
            self.request(self.restore.back(self.state))
        }
    }

    #[test]
    fn fill_then_full_screen_then_back_keeps_the_original_rect() {
        let mut w = Window::new(Mode::Free);
        assert!(w.request(Filled));
        assert_eq!(w.rect, WORK);
        assert!(w.request(Fullscreen));
        assert_eq!(w.rect, SCREEN);
        assert!(w.back());
        assert_eq!((w.state, w.rect), (Filled, WORK));
        assert!(w.request(Normal));
        assert_eq!((w.state, w.rect), (Normal, ORIGINAL));
    }

    #[test]
    fn leaving_full_screen_from_normal_goes_back_to_normal() {
        let mut w = Window::new(Mode::Free);
        assert!(w.request(Fullscreen));
        assert!(w.back());
        assert_eq!((w.state, w.rect), (Normal, ORIGINAL));
    }

    #[test]
    fn minimize_keeps_the_rect_and_restores_the_state_before_it() {
        for before in [Normal, Filled, Fullscreen] {
            let mut w = Window::new(Mode::Free);
            if before != Normal {
                w.request(before);
            }
            let rect = w.rect;
            assert!(w.request(Minimized));
            assert!(!w.state.shown());
            assert_eq!(w.rect, rect);
            assert!(w.back());
            assert_eq!((w.state, w.rect), (before, rect));
            assert!(w.request(Normal) || before == Normal);
            assert_eq!(w.rect, ORIGINAL);
        }
    }

    #[test]
    fn every_pair_of_states_is_a_transition() {
        for &from in WindowState::ALL {
            for &to in WindowState::ALL {
                let mut w = Window::new(Mode::Free);
                w.request(from);
                assert_eq!(w.request(to), from != to, "{from:?} -> {to:?}");
                assert_eq!(w.state, to);
                assert!(w.request(Normal) || to == Normal);
                assert_eq!(w.rect, ORIGINAL, "{from:?} -> {to:?} -> normal");
            }
        }
    }

    #[test]
    fn fixed_and_pinned_windows_refuse_fill_and_full_screen() {
        for mode in [Mode::Fixed, Mode::Pinned] {
            let mut w = Window::new(mode);
            assert!(!w.request(Filled));
            assert!(!w.request(Fullscreen));
            assert_eq!((w.state, w.rect), (Normal, ORIGINAL));
        }
        assert!(Window::new(Mode::Fixed).request(Minimized));
        assert!(!Window::new(Mode::Pinned).request(Minimized));
    }

    #[test]
    fn two_presses_close_in_time_and_place_are_a_double_click() {
        let settings = ClickSettings { time_ms: 500.0, distance: [4.0, 4.0] };
        let mut clicks = Clicks::default();
        assert_eq!(clicks.press(1, 0.0, [100.0, 10.0], settings), 1);
        assert_eq!(clicks.press(1, 400.0, [101.0, 11.0], settings), 2);
        clicks.reset();
        assert_eq!(clicks.press(1, 1000.0, [100.0, 10.0], settings), 1);
        assert_eq!(clicks.press(1, 1501.0, [100.0, 10.0], settings), 1, "too slow");
        assert_eq!(clicks.press(1, 1600.0, [103.0, 10.0], settings), 1, "too far");
        assert_eq!(clicks.press(2, 1700.0, [103.0, 10.0], settings), 1, "another window");
        let wide = ClickSettings { time_ms: 900.0, distance: [10.0, 10.0] };
        assert_eq!(clicks.press(2, 2500.0, [107.0, 14.0], wide), 2, "the platform settings decide");
    }

    #[test]
    fn the_double_click_action_toggles_fill_or_minimizes_free_windows() {
        assert_eq!(DoubleClick::default(), DoubleClick::Fill);
        assert_eq!(DoubleClick::Fill.target(Mode::Free, Normal), Some(Filled));
        assert_eq!(DoubleClick::Fill.target(Mode::Free, Filled), Some(Normal));
        assert_eq!(DoubleClick::Fill.target(Mode::Free, Fullscreen), None);
        assert_eq!(DoubleClick::Minimize.target(Mode::Free, Normal), Some(Minimized));
        assert_eq!(DoubleClick::Minimize.target(Mode::Free, Filled), Some(Minimized));
        assert_eq!(DoubleClick::Off.target(Mode::Free, Normal), None);
        for mode in [Mode::Fixed, Mode::Pinned, Mode::Fullscreen] {
            for action in DoubleClick::ALL {
                assert_eq!(action.target(mode, Normal), None, "{mode:?} {action:?}");
            }
        }
        assert_eq!("none".parse::<DoubleClick>(), Ok(DoubleClick::Off));
        assert!("maximize".parse::<DoubleClick>().is_err());
    }

    #[test]
    fn the_same_state_is_no_change() {
        let mut w = Window::new(Mode::Free);
        assert!(!w.request(Normal));
        w.request(Filled);
        assert!(!w.request(Filled));
    }
}
