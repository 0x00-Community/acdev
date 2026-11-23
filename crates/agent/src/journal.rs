use std::io::Write;

use log::{Level, LevelFilter, Log, Metadata, Record};

pub const TARGET: &str = "acdev-agent";

struct Journal;

impl Log for Journal {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let priority = match record.level() {
            Level::Error => 3,
            Level::Warn => 4,
            Level::Info => 6,
            Level::Debug | Level::Trace => 7,
        };
        _ = writeln!(std::io::stderr().lock(), "<{priority}>{}", record.args());
    }

    fn flush(&self) {}
}

pub fn start() {
    if log::set_logger(&Journal).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

pub fn timeline(line: &str) {
    log::info!(target: TARGET, "{line}");
}

pub fn line(kind: &str, fields: &[(&str, String)]) -> String {
    let mut out = format!("event={kind}");
    for (key, value) in fields {
        out.push(' ');
        out.push_str(key);
        out.push('=');
        out.push_str(&quoted(value));
    }
    out
}

fn quoted(value: &str) -> String {
    let plain = !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"' || c == '=');
    if plain {
        return value.to_string();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timeline_line_quotes_empty_and_spaced_values() {
        let fields = [("window", "3".to_string()), ("reason", "the window is \"filled\"".to_string()), ("app", String::new())];
        assert_eq!(line("move-request", &fields), r#"event=move-request window=3 reason="the window is \"filled\"" app="""#);
    }
}
