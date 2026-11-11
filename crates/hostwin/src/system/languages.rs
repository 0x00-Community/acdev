#[cfg(windows)]
pub(crate) fn preferred() -> Vec<String> {
    use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let (mut count, mut size) = (0u32, 0u32);
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, std::ptr::null_mut(), &mut size) } == 0 || size == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u16; size as usize];
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buffer.as_mut_ptr(), &mut size) } == 0 {
        return Vec::new();
    }
    names(&buffer[..size as usize])
}

#[cfg(any(windows, test))]
fn names(multi: &[u16]) -> Vec<String> {
    multi.split(|unit| *unit == 0).filter(|name| !name.is_empty()).map(String::from_utf16_lossy).collect()
}

#[cfg(target_os = "macos")]
#[allow(unused_unsafe)]
pub(crate) fn preferred() -> Vec<String> {
    unsafe { objc2_foundation::NSLocale::preferredLanguages() }.iter().map(|tag| tag.to_string()).collect()
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn preferred() -> Vec<String> {
    ["/etc/locale.conf", "/etc/default/locale"].iter().find_map(|path| std::fs::read_to_string(path).ok()).map(|text| configured(&text)).unwrap_or_default()
}

#[cfg(any(not(any(windows, target_os = "macos")), test))]
fn configured(text: &str) -> Vec<String> {
    let value =
        |name: &str| text.lines().filter_map(|line| line.trim().strip_prefix(name)?.strip_prefix('=')).map(|v| v.trim().trim_matches(['"', '\''])).next_back();
    let tag = |locale: &str| {
        let base = locale.split(['.', '@']).next().unwrap_or_default().trim();
        match base {
            "" => None,
            "C" | "POSIX" => Some("en-US".to_owned()),
            base => Some(base.replace('_', "-")),
        }
    };
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|name| value(name).filter(|v| !v.is_empty()));
    let mut tags: Vec<String> = Vec::new();
    for found in value("LANGUAGE").into_iter().flat_map(|list| list.split(':')).chain(locale).filter_map(tag) {
        if !tags.contains(&found) {
            tags.push(found);
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_multi_string_is_split_into_tags() {
        let multi: Vec<u16> = "zh-CN\0en-US\0\0".encode_utf16().collect();
        assert_eq!(super::names(&multi), ["zh-CN", "en-US"]);
        assert!(super::names(&[0, 0]).is_empty());
    }

    #[test]
    fn the_system_locale_file_gives_the_languages() {
        assert_eq!(super::configured("LANG=en_US.UTF-8\n"), ["en-US"]);
        assert_eq!(super::configured("# comment\nLANG=\"de_DE.UTF-8\"\nLC_MESSAGES=fr_FR.UTF-8\n"), ["fr-FR"]);
        assert_eq!(super::configured("LANGUAGE=zh_CN:en\nLANG=zh_CN.UTF-8\n"), ["zh-CN", "en"]);
        assert_eq!(super::configured("LANG=C.UTF-8\n"), ["en-US"]);
        assert!(super::configured("").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_has_a_display_language() {
        let tags = super::preferred();
        assert!(!tags.is_empty() && tags.iter().all(|t| t.contains('-') || t.len() <= 3), "{tags:?}");
    }
}
