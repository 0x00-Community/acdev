const EXTENDED: &[(u32, u32)] = &[
    (86, 0x56),
    (87, 0x57),
    (88, 0x58),
    (96, 0x9c),
    (97, 0x9d),
    (98, 0xb5),
    (99, 0xb7),
    (100, 0xb8),
    (102, 0xc7),
    (103, 0xc8),
    (104, 0xc9),
    (105, 0xcb),
    (106, 0xcd),
    (107, 0xcf),
    (108, 0xd0),
    (109, 0xd1),
    (110, 0xd2),
    (111, 0xd3),
    (119, 0xc6),
    (125, 0xdb),
    (126, 0xdc),
    (127, 0xdd),
];

pub fn qnum_from_evdev(code: u32) -> Option<u32> {
    if (1..=83).contains(&code) {
        return Some(code);
    }
    EXTENDED.iter().find(|(evdev, _)| *evdev == code).map(|(_, qnum)| *qnum)
}

pub fn qnum_from_set1(code: u32) -> Option<u32> {
    match code {
        0..=0x7f => (code != 0).then_some(code),
        0xe000..=0xe07f => Some(0x80 | (code & 0x7f)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evdev_codes_become_qemu_key_numbers() {
        assert_eq!(qnum_from_evdev(30), Some(0x1e));
        assert_eq!(qnum_from_evdev(103), Some(0xc8));
        assert_eq!(qnum_from_evdev(97), Some(0x9d));
        assert_eq!(qnum_from_evdev(0), None);
        assert_eq!(qnum_from_evdev(240), None);
    }

    #[test]
    fn extended_set1_codes_set_the_high_bit() {
        assert_eq!(qnum_from_set1(0x1e), Some(0x1e));
        assert_eq!(qnum_from_set1(0xe048), Some(0xc8));
        assert_eq!(qnum_from_set1(0xe11d), None);
    }
}
