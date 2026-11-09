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
    fn the_same_state_is_no_change() {
        let mut w = Window::new(Mode::Free);
        assert!(!w.request(Normal));
        w.request(Filled);
        assert!(!w.request(Filled));
    }
}
