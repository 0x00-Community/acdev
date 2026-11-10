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
    Vec::new()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_multi_string_is_split_into_tags() {
        let multi: Vec<u16> = "zh-CN\0en-US\0\0".encode_utf16().collect();
        assert_eq!(super::names(&multi), ["zh-CN", "en-US"]);
        assert!(super::names(&[0, 0]).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_has_a_display_language() {
        let tags = super::preferred();
        assert!(!tags.is_empty() && tags.iter().all(|t| t.contains('-') || t.len() <= 3), "{tags:?}");
    }
}
