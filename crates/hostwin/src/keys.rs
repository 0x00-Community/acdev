use winit::keyboard::{KeyCode, PhysicalKey};

const KEYS: &[(KeyCode, u32, &str)] = &[
    (KeyCode::Escape, 1, "escape"),
    (KeyCode::Digit1, 2, "1"),
    (KeyCode::Digit2, 3, "2"),
    (KeyCode::Digit3, 4, "3"),
    (KeyCode::Digit4, 5, "4"),
    (KeyCode::Digit5, 6, "5"),
    (KeyCode::Digit6, 7, "6"),
    (KeyCode::Digit7, 8, "7"),
    (KeyCode::Digit8, 9, "8"),
    (KeyCode::Digit9, 10, "9"),
    (KeyCode::Digit0, 11, "0"),
    (KeyCode::Minus, 12, "minus"),
    (KeyCode::Equal, 13, "equal"),
    (KeyCode::Backspace, 14, "backspace"),
    (KeyCode::Tab, 15, "tab"),
    (KeyCode::KeyQ, 16, "q"),
    (KeyCode::KeyW, 17, "w"),
    (KeyCode::KeyE, 18, "e"),
    (KeyCode::KeyR, 19, "r"),
    (KeyCode::KeyT, 20, "t"),
    (KeyCode::KeyY, 21, "y"),
    (KeyCode::KeyU, 22, "u"),
    (KeyCode::KeyI, 23, "i"),
    (KeyCode::KeyO, 24, "o"),
    (KeyCode::KeyP, 25, "p"),
    (KeyCode::BracketLeft, 26, "bracketleft"),
    (KeyCode::BracketRight, 27, "bracketright"),
    (KeyCode::Enter, 28, "return"),
    (KeyCode::ControlLeft, 29, "control_l"),
    (KeyCode::KeyA, 30, "a"),
    (KeyCode::KeyS, 31, "s"),
    (KeyCode::KeyD, 32, "d"),
    (KeyCode::KeyF, 33, "f"),
    (KeyCode::KeyG, 34, "g"),
    (KeyCode::KeyH, 35, "h"),
    (KeyCode::KeyJ, 36, "j"),
    (KeyCode::KeyK, 37, "k"),
    (KeyCode::KeyL, 38, "l"),
    (KeyCode::Semicolon, 39, "semicolon"),
    (KeyCode::Quote, 40, "apostrophe"),
    (KeyCode::Backquote, 41, "grave"),
    (KeyCode::ShiftLeft, 42, "shift_l"),
    (KeyCode::Backslash, 43, "backslash"),
    (KeyCode::KeyZ, 44, "z"),
    (KeyCode::KeyX, 45, "x"),
    (KeyCode::KeyC, 46, "c"),
    (KeyCode::KeyV, 47, "v"),
    (KeyCode::KeyB, 48, "b"),
    (KeyCode::KeyN, 49, "n"),
    (KeyCode::KeyM, 50, "m"),
    (KeyCode::Comma, 51, "comma"),
    (KeyCode::Period, 52, "period"),
    (KeyCode::Slash, 53, "slash"),
    (KeyCode::ShiftRight, 54, "shift_r"),
    (KeyCode::NumpadMultiply, 55, "kp_multiply"),
    (KeyCode::AltLeft, 56, "alt_l"),
    (KeyCode::Space, 57, "space"),
    (KeyCode::CapsLock, 58, "caps_lock"),
    (KeyCode::F1, 59, "f1"),
    (KeyCode::F2, 60, "f2"),
    (KeyCode::F3, 61, "f3"),
    (KeyCode::F4, 62, "f4"),
    (KeyCode::F5, 63, "f5"),
    (KeyCode::F6, 64, "f6"),
    (KeyCode::F7, 65, "f7"),
    (KeyCode::F8, 66, "f8"),
    (KeyCode::F9, 67, "f9"),
    (KeyCode::F10, 68, "f10"),
    (KeyCode::NumLock, 69, "num_lock"),
    (KeyCode::ScrollLock, 70, "scroll_lock"),
    (KeyCode::Numpad7, 71, "kp_7"),
    (KeyCode::Numpad8, 72, "kp_8"),
    (KeyCode::Numpad9, 73, "kp_9"),
    (KeyCode::NumpadSubtract, 74, "kp_subtract"),
    (KeyCode::Numpad4, 75, "kp_4"),
    (KeyCode::Numpad5, 76, "kp_5"),
    (KeyCode::Numpad6, 77, "kp_6"),
    (KeyCode::NumpadAdd, 78, "kp_add"),
    (KeyCode::Numpad1, 79, "kp_1"),
    (KeyCode::Numpad2, 80, "kp_2"),
    (KeyCode::Numpad3, 81, "kp_3"),
    (KeyCode::Numpad0, 82, "kp_0"),
    (KeyCode::NumpadDecimal, 83, "kp_decimal"),
    (KeyCode::IntlBackslash, 86, "less"),
    (KeyCode::F11, 87, "f11"),
    (KeyCode::F12, 88, "f12"),
    (KeyCode::NumpadEnter, 96, "kp_enter"),
    (KeyCode::ControlRight, 97, "control_r"),
    (KeyCode::NumpadDivide, 98, "kp_divide"),
    (KeyCode::PrintScreen, 99, "print"),
    (KeyCode::AltRight, 100, "alt_r"),
    (KeyCode::Home, 102, "home"),
    (KeyCode::ArrowUp, 103, "up"),
    (KeyCode::PageUp, 104, "prior"),
    (KeyCode::ArrowLeft, 105, "left"),
    (KeyCode::ArrowRight, 106, "right"),
    (KeyCode::End, 107, "end"),
    (KeyCode::ArrowDown, 108, "down"),
    (KeyCode::PageDown, 109, "next"),
    (KeyCode::Insert, 110, "insert"),
    (KeyCode::Delete, 111, "delete"),
    (KeyCode::Pause, 119, "pause"),
    (KeyCode::SuperLeft, 125, "super_l"),
    (KeyCode::SuperRight, 126, "super_r"),
    (KeyCode::ContextMenu, 127, "menu"),
];

const ALIASES: &[(&str, &str)] = &[
    ("enter", "return"),
    ("esc", "escape"),
    ("pageup", "prior"),
    ("page_up", "prior"),
    ("pagedown", "next"),
    ("page_down", "next"),
    ("del", "delete"),
    ("printscreen", "print"),
];

pub(crate) struct Key {
    pub evdev: u32,
}

pub(crate) fn key(physical: PhysicalKey) -> Option<Key> {
    let PhysicalKey::Code(code) = physical else {
        return None;
    };
    KEYS.iter()
        .find(|(c, ..)| *c == code)
        .map(|&(_, evdev, _)| Key { evdev })
}

pub(crate) fn by_name(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let name = ALIASES
        .iter()
        .find(|(a, _)| *a == lower)
        .map_or(lower.as_str(), |(_, n)| n);
    KEYS.iter()
        .find(|(_, _, n)| *n == name)
        .map(|&(_, evdev, _)| evdev)
}

pub(crate) const BUTTON_LEFT: u32 = 0x110;

const US: &[(u32, char, char)] = &[
    (2, '1', '!'),
    (3, '2', '@'),
    (4, '3', '#'),
    (5, '4', '$'),
    (6, '5', '%'),
    (7, '6', '^'),
    (8, '7', '&'),
    (9, '8', '*'),
    (10, '9', '('),
    (11, '0', ')'),
    (12, '-', '_'),
    (13, '=', '+'),
    (26, '[', '{'),
    (27, ']', '}'),
    (39, ';', ':'),
    (40, '\'', '"'),
    (41, '`', '~'),
    (43, '\\', '|'),
    (51, ',', '<'),
    (52, '.', '>'),
    (53, '/', '?'),
    (57, ' ', ' '),
    (55, '*', '*'),
    (71, '7', '7'),
    (72, '8', '8'),
    (73, '9', '9'),
    (74, '-', '-'),
    (75, '4', '4'),
    (76, '5', '5'),
    (77, '6', '6'),
    (78, '+', '+'),
    (79, '1', '1'),
    (80, '2', '2'),
    (81, '3', '3'),
    (82, '0', '0'),
    (83, '.', '.'),
    (98, '/', '/'),
];

pub(crate) fn us_text(evdev: u32, shift: bool) -> Option<String> {
    if let Some(&(_, plain, shifted)) = US.iter().find(|(code, ..)| *code == evdev) {
        return Some(if shift { shifted } else { plain }.to_string());
    }
    let letter = KEYS
        .iter()
        .find(|(_, code, name)| *code == evdev && name.len() == 1 && name.as_bytes()[0].is_ascii_lowercase())
        .map(|(_, _, name)| *name)?;
    Some(if shift { letter.to_ascii_uppercase() } else { letter.to_owned() })
}

pub(crate) fn combo_bit(evdev: u32) -> u8 {
    use acde_model::Combo;
    match evdev {
        29 | 97 => Combo::CTRL,
        42 | 54 => Combo::SHIFT,
        56 | 100 => Combo::ALT,
        125 | 126 => Combo::SUPER,
        _ => 0,
    }
}

pub(crate) fn is_modifier(evdev: u32) -> bool {
    matches!(evdev, 29 | 42 | 54 | 56 | 97 | 100 | 125 | 126)
}

pub(crate) fn mouse_button(button: winit::event::MouseButton) -> u32 {
    use winit::event::MouseButton;
    match button {
        MouseButton::Left => BUTTON_LEFT,
        MouseButton::Right => 0x111,
        MouseButton::Middle => 0x112,
        MouseButton::Back => 0x113,
        MouseButton::Forward => 0x114,
        MouseButton::Other(n) => 0x110 + u32::from(n),
    }
}
