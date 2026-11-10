//! What Windows knows about file types through its file associations: the content type it registers for an extension
//! (`HKEY_CLASSES_ROOT\.<ext>` `Content Type`, read with `AssocQueryStringW(ASSOCSTR_CONTENTTYPE)`).

use windows_sys::Win32::Foundation::S_OK;
use windows_sys::Win32::UI::Shell::{ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR, ASSOCSTR_CONTENTTYPE, AssocQueryStringW};

const EXTENSION_MAX: usize = 64;

/// `.ext` as a NUL-terminated wide string, or `None` for anything that is not one plain extension.
pub(crate) fn wide_extension(extension: &str) -> Option<Vec<u16>> {
    let name = extension.strip_prefix('.')?;
    let plain = |c: char| !c.is_whitespace() && !c.is_control() && !matches!(c, '.' | '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
    if name.is_empty() || extension.len() > EXTENSION_MAX || !name.chars().all(plain) {
        return None;
    }
    Some(extension.encode_utf16().chain([0]).collect())
}

/// One association string for an extension; `None` when Windows has none (an unknown extension is not answered
/// with the "Open with" dialog, thanks to `ASSOCF_INIT_IGNOREUNKNOWN`).
pub(crate) fn query(what: ASSOCSTR, extension: &[u16]) -> Option<String> {
    let mut len = 0u32;
    let null = std::ptr::null();
    let sized = unsafe { AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, what, extension.as_ptr(), null, std::ptr::null_mut(), &mut len) };
    if sized < 0 || len == 0 {
        return None;
    }
    let mut buffer = vec![0u16; len as usize];
    let done = unsafe { AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, what, extension.as_ptr(), null, buffer.as_mut_ptr(), &mut len) };
    if done != S_OK {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    let text = String::from_utf16(&buffer[..end]).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// The content type Windows registers for `.ext`, as it reports it (`.csv` may well be `application/vnd.ms-excel`).
pub fn content_type(extension: &str) -> Option<String> {
    query(ASSOCSTR_CONTENTTYPE, &wide_extension(extension)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_extensions_are_asked() {
        for ok in [".png", ".TXT", ".tar", ".docx", ".7z"] {
            assert!(wide_extension(ok).is_some(), "{ok}");
        }
        for bad in ["png", ".", "", ".tar.gz", ".a b", r".a\b", ".a/b", ".a:b", ".a*", &format!(".{}", "x".repeat(EXTENSION_MAX))] {
            assert!(wide_extension(bad).is_none(), "{bad:?}");
        }
    }
}
