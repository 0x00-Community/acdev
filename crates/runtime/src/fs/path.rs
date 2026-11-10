pub trait NodePath {
    fn is_absolute(&self) -> bool;
    fn normalize(&self) -> String;
    fn join(&self, other: &str) -> String;
    fn dirname(&self) -> &str;
    fn basename(&self) -> &str;
    fn extname(&self) -> &str;
    fn within(&self, root: &str) -> Option<&str>;
}

#[cfg(windows)]
pub(super) fn windows_file_name(name: &str) -> bool {
    if name.ends_with([' ', '.']) || name.bytes().any(|byte| byte < b' ' || b"\\/:<>\"|?*".contains(&byte)) {
        return false;
    }
    let device = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let named_device = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$");
    let port = device.strip_prefix("COM").or_else(|| device.strip_prefix("LPT"));
    let reserved_ports = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"];
    !named_device && !port.is_some_and(|number| reserved_ports.contains(&number))
}

#[cfg(windows)]
pub(super) fn windows_directory(value: &str) -> Option<String> {
    use std::path::{Component, Path, Prefix};

    let path = Path::new(value);
    if !path.is_absolute() {
        return None;
    }
    let mut parts = path.components();
    match parts.next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(_) => {}
            Prefix::UNC(server, share) => {
                let (server, share) = (server.to_str()?, share.to_str()?);
                if !windows_file_name(server) || !windows_file_name(share) {
                    return None;
                }
                if share.eq_ignore_ascii_case("pipe") || share.eq_ignore_ascii_case("IPC$") {
                    return None;
                }
            }
            _ => return None,
        },
        _ => return None,
    }
    if parts.any(|part| matches!(part, Component::Normal(name) if !name.to_str().is_some_and(windows_file_name))) {
        return None;
    }
    std::path::absolute(path).ok()?.into_os_string().into_string().ok()
}

#[cfg(windows)]
fn same_windows_name(a: &str, b: &str) -> bool {
    let upper = |c: char| {
        let mut mapped = c.to_uppercase();
        match (mapped.next(), mapped.next()) {
            (Some(single), None) => single,
            _ => c,
        }
    };
    a.chars().map(upper).eq(b.chars().map(upper))
}

#[cfg(windows)]
pub(super) fn windows_within(path: &std::path::Path, root: &str) -> Option<String> {
    let mut parts = path.components();
    for top in std::path::Path::new(root).components() {
        if !same_windows_name(parts.next()?.as_os_str().to_str()?, top.as_os_str().to_str()?) {
            return None;
        }
    }
    let rest: Option<Vec<&str>> = parts.map(|part| part.as_os_str().to_str()).collect();
    Some(rest?.join("/"))
}

#[cfg(windows)]
pub(super) fn same_folder(a: &str, b: &str) -> bool {
    windows_within(std::path::Path::new(a), b).is_some_and(|rest| rest.is_empty())
}

#[cfg(not(windows))]
pub(super) fn same_folder(a: &str, b: &str) -> bool {
    a == b
}

impl NodePath for str {
    fn is_absolute(&self) -> bool {
        self.starts_with('/')
    }

    fn normalize(&self) -> String {
        if self.is_empty() {
            return ".".into();
        }
        let absolute = self.is_absolute();
        let mut parts: Vec<&str> = Vec::new();
        for part in self.split('/') {
            match part {
                "" | "." => {}
                ".." if parts.last().is_some_and(|last| *last != "..") => {
                    parts.pop();
                }
                ".." if !absolute => parts.push(".."),
                ".." => {}
                part => parts.push(part),
            }
        }
        let mut out = parts.join("/");
        match (out.is_empty(), absolute) {
            (true, true) => return "/".into(),
            (true, false) => out.push('.'),
            _ => {}
        }
        if self.ends_with('/') {
            out.push('/');
        }
        if absolute { format!("/{out}") } else { out }
    }

    fn within(&self, root: &str) -> Option<&str> {
        if self == root {
            return Some("");
        }
        let rest = self.strip_prefix(root)?;
        if root.ends_with('/') { Some(rest) } else { rest.strip_prefix('/') }
    }

    fn join(&self, other: &str) -> String {
        match (self.is_empty(), other.is_empty()) {
            (true, true) => ".".into(),
            (true, false) => other.normalize(),
            (false, true) => self.normalize(),
            (false, false) => format!("{self}/{other}").normalize(),
        }
    }

    fn dirname(&self) -> &str {
        let bytes = self.as_bytes();
        let Some(first) = bytes.first() else {
            return ".";
        };
        let root = *first == b'/';
        let mut matched_slash = true;
        let end = (1..bytes.len()).rev().find(|&i| {
            if bytes[i] == b'/' {
                !matched_slash
            } else {
                matched_slash = false;
                false
            }
        });
        match end {
            None if root => "/",
            None => ".",
            Some(1) if root => "//",
            Some(end) => &self[..end],
        }
    }

    fn basename(&self) -> &str {
        let trimmed = self.trim_end_matches('/');
        trimmed.rsplit('/').next().unwrap_or("")
    }

    fn extname(&self) -> &str {
        let bytes = self.as_bytes();
        let (mut start_dot, mut start_part, mut end) = (None, 0, None);
        let (mut matched_slash, mut pre_dot) = (true, 0i8);
        for i in (0..bytes.len()).rev() {
            if bytes[i] == b'/' {
                if !matched_slash {
                    start_part = i + 1;
                    break;
                }
                continue;
            }
            if end.is_none() {
                matched_slash = false;
                end = Some(i + 1);
            }
            if bytes[i] == b'.' {
                if start_dot.is_none() {
                    start_dot = Some(i);
                } else if pre_dot != 1 {
                    pre_dot = 1;
                }
            } else if start_dot.is_some() {
                pre_dot = -1;
            }
        }
        match (start_dot, end) {
            (Some(dot), Some(end)) if pre_dot != 0 && !(pre_dot == 1 && dot + 1 == end && dot == start_part + 1) => &self[dot..end],
            _ => "",
        }
    }
}

#[cfg(windows)]
pub(super) fn known_folder(key: &str) -> Option<String> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Videos, KF_FLAG_DEFAULT, SHGetKnownFolderPath,
    };
    let id = match key {
        "DESKTOP" => &FOLDERID_Desktop,
        "DOCUMENTS" => &FOLDERID_Documents,
        "DOWNLOAD" => &FOLDERID_Downloads,
        "MUSIC" => &FOLDERID_Music,
        "PICTURES" => &FOLDERID_Pictures,
        "VIDEOS" => &FOLDERID_Videos,
        _ => return None,
    };
    let mut path = std::ptr::null_mut();
    let found = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT as u32, std::ptr::null_mut(), &mut path) } == 0;
    let text = found.then(|| {
        let len = (0..).take_while(|&i| unsafe { *path.add(i) } != 0).count();
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(path, len) })
    });
    unsafe { CoTaskMemFree(path.cast()) };
    text.and_then(|text| windows_directory(&text))
}
