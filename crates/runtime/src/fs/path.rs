pub trait NodePath {
    fn is_absolute(&self) -> bool;
    fn normalize(&self) -> String;
    fn join(&self, other: &str) -> String;
    fn dirname(&self) -> &str;
    fn basename(&self) -> &str;
    fn extname(&self) -> &str;
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
