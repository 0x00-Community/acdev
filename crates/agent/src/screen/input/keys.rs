pub(super) fn evdev_key(name: &str) -> Option<u32> {
    const LETTERS: &str = "qwertyuiop\0\0\0\0asdfghjkl\0\0\0\0\0zxcvbnm";
    let lower = name.to_ascii_lowercase();
    let named = match lower.as_str() {
        "ctrl" | "control" | "controlleft" => 29,
        "controlright" => 97,
        "shift" | "shiftleft" => 42,
        "shiftright" => 54,
        "alt" | "option" | "altleft" => 56,
        "altright" | "altgraph" => 100,
        "super" | "meta" | "win" | "cmd" | "command" | "os" | "metaleft" | "osleft" => 125,
        "metaright" | "osright" => 126,
        "enter" | "return" | "numpadenter" => 28,
        "esc" | "escape" => 1,
        "tab" => 15,
        " " | "space" | "spacebar" => 57,
        "backspace" => 14,
        "delete" | "del" => 111,
        "up" | "arrowup" => 103,
        "down" | "arrowdown" => 108,
        "left" | "arrowleft" => 105,
        "right" | "arrowright" => 106,
        "home" => 102,
        "end" => 107,
        "pageup" => 104,
        "pagedown" => 109,
        "insert" => 110,
        "menu" | "contextmenu" => 127,
        "capslock" => 58,
        "-" | "minus" => 12,
        "=" | "equal" => 13,
        "[" | "bracketleft" => 26,
        "]" | "bracketright" => 27,
        ";" | "semicolon" => 39,
        "'" | "quote" => 40,
        "`" | "backquote" => 41,
        "\\" | "backslash" => 43,
        "," | "comma" => 51,
        "." | "period" => 52,
        "/" | "slash" => 53,
        "f11" => 87,
        "f12" => 88,
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=10).contains(n)) {
        return Some(58 + n);
    }
    let single = lower.strip_prefix("key").or_else(|| lower.strip_prefix("digit")).filter(|s| s.chars().count() == 1).unwrap_or(&lower);
    let mut chars = single.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else { return None };
    match c.to_digit(10) {
        Some(0) => Some(11),
        Some(d) => Some(1 + d),
        None => LETTERS.find(c).map(|at| 16 + at as u32),
    }
}

pub(super) fn button(name: Option<&str>) -> u32 {
    match name {
        Some("right") => 0x111,
        Some("middle") => 0x112,
        _ => 0x110,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names_follow_the_host_aliases() {
        for (name, code) in [("ctrl", 29), ("Control", 29), ("SHIFT", 42), ("option", 56), ("cmd", 125), ("return", 28), ("esc", 1), ("del", 111)] {
            assert_eq!(evdev_key(name), Some(code), "{name}");
        }
        for (name, code) in [("up", 103), ("ArrowLeft", 105), ("PageDown", 109), ("insert", 110), ("menu", 127), ("/", 53), ("\\", 43)] {
            assert_eq!(evdev_key(name), Some(code), "{name}");
        }
        for (name, code) in [("KeyA", 30), ("a", 30), ("N", 49), ("Digit1", 2), ("0", 11), ("F1", 59), ("f12", 88)] {
            assert_eq!(evdev_key(name), Some(code), "{name}");
        }
        assert_eq!(evdev_key("Hyper"), None);
    }
}
