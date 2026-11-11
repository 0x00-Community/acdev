use ironrdp_server::{DesktopSize, KeyboardEvent, MouseEvent, RdpServerInputHandler};

use super::server::{RdpEvent, RdpNotify};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RdpInput {
    Move { x: f64, y: f64 },
    Motion { dx: f64, dy: f64 },
    Button { button: u32, pressed: bool },
    Wheel { dx: f64, dy: f64 },
    Key { code: u32, pressed: bool },
}

pub(crate) struct Handler {
    pub(crate) notify: RdpNotify,
    pub(crate) size: DesktopSize,
}

impl Handler {
    const BTN_LEFT: u32 = 0x110;
    const BTN_RIGHT: u32 = 0x111;
    const BTN_MIDDLE: u32 = 0x112;
    const BTN_SIDE: u32 = 0x113;
    const BTN_EXTRA: u32 = 0x114;
    const WHEEL_DETENT: f64 = 120.0;

    fn send(&self, input: RdpInput) {
        (self.notify)(RdpEvent::Input(input));
    }

    fn evdev(code: u8, extended: bool) -> Option<u32> {
        if !extended {
            return Some(u32::from(code));
        }
        Some(match code {
            0x1c => 96,
            0x1d => 97,
            0x35 => 98,
            0x37 => 99,
            0x38 => 100,
            0x47 => 102,
            0x48 => 103,
            0x49 => 104,
            0x4b => 105,
            0x4d => 106,
            0x4f => 107,
            0x50 => 108,
            0x51 => 109,
            0x52 => 110,
            0x53 => 111,
            0x5b => 125,
            0x5c => 126,
            0x5d => 127,
            _ => return None,
        })
    }

    fn detents(value: impl Into<f64>) -> f64 {
        value.into() / Self::WHEEL_DETENT
    }
}

impl RdpServerInputHandler for Handler {
    fn keyboard(&mut self, event: KeyboardEvent) {
        if let KeyboardEvent::Pressed { code, extended } | KeyboardEvent::Released { code, extended } = event {
            let pressed = matches!(event, KeyboardEvent::Pressed { .. });
            if let Some(code) = Self::evdev(code, extended) {
                self.send(RdpInput::Key { code, pressed });
            }
        }
    }

    fn mouse(&mut self, event: MouseEvent) {
        let button = |button, pressed| RdpInput::Button { button, pressed };
        let input = match event {
            MouseEvent::Move { x, y } => RdpInput::Move { x: x.min(self.size.width.saturating_sub(1)).into(), y: y.min(self.size.height.saturating_sub(1)).into() },
            MouseEvent::RelMove { x, y } => RdpInput::Motion { dx: x.into(), dy: y.into() },
            MouseEvent::LeftPressed => button(Self::BTN_LEFT, true),
            MouseEvent::LeftReleased => button(Self::BTN_LEFT, false),
            MouseEvent::RightPressed => button(Self::BTN_RIGHT, true),
            MouseEvent::RightReleased => button(Self::BTN_RIGHT, false),
            MouseEvent::MiddlePressed => button(Self::BTN_MIDDLE, true),
            MouseEvent::MiddleReleased => button(Self::BTN_MIDDLE, false),
            MouseEvent::Button4Pressed => button(Self::BTN_SIDE, true),
            MouseEvent::Button4Released => button(Self::BTN_SIDE, false),
            MouseEvent::Button5Pressed => button(Self::BTN_EXTRA, true),
            MouseEvent::Button5Released => button(Self::BTN_EXTRA, false),
            MouseEvent::VerticalScroll { value } => RdpInput::Wheel { dx: 0.0, dy: -Self::detents(value) },
            MouseEvent::Scroll { x, y } => RdpInput::Wheel { dx: Self::detents(x), dy: -Self::detents(y) },
        };
        self.send(input);
    }
}
