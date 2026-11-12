#[cfg(any(target_os = "macos", test))]
const TITLE: &str = "ACDE_NOTIFY_TITLE";
#[cfg(any(target_os = "macos", test))]
const BODY: &str = "ACDE_NOTIFY_BODY";
#[cfg(any(target_os = "macos", test))]
const SUBTITLE: &str = "ACDE_NOTIFY_SUBTITLE";

#[cfg(any(target_os = "macos", test))]
const READ: &str = "ObjC.import('Foundation'); const env = $.NSProcessInfo.processInfo.environment; \
const text = (name) => { const value = env.objectForKey(name); return value.isNil() ? '' : value.js };";

#[cfg(any(target_os = "macos", test))]
const SHOW: &str = "const app = Application.currentApplication(); app.includeStandardAdditions = true; \
app.displayNotification(text('ACDE_NOTIFY_BODY'), { withTitle: text('ACDE_NOTIFY_TITLE'), subtitle: text('ACDE_NOTIFY_SUBTITLE') });";

#[cfg(any(target_os = "macos", test))]
fn clean(text: &str) -> String {
    text.replace('\0', "")
}

#[cfg(any(target_os = "macos", test))]
fn osascript(action: &str, title: &str, body: &str, subtitle: &str) -> std::process::Command {
    let mut command = std::process::Command::new("/usr/bin/osascript");
    command.args(["-l", "JavaScript", "-e", &format!("{READ} {action}")]).env(TITLE, clean(title)).env(BODY, clean(body)).env(SUBTITLE, clean(subtitle));
    command
}

#[cfg(target_os = "macos")]
pub fn show(title: &str, body: &str, subtitle: &str) -> Result<(), String> {
    use std::process::Stdio;
    let child = osascript(SHOW, title, body, subtitle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript: {e}"))?;
    std::thread::Builder::new()
        .name("acde-notify".into())
        .spawn(move || match child.wait_with_output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => log::warn!("notification: osascript {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim()),
            Err(e) => log::warn!("notification: osascript: {e}"),
        })
        .map(|_| ())
        .map_err(|e| format!("notification thread: {e}"))
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn escape_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(any(target_os = "linux", test))]
fn freedesktop_text(title: &str, body: &str, label: &str, markup: bool) -> (String, String) {
    let summary = if label.is_empty() { title.to_owned() } else { format!("{label}: {title}") };
    let body = if markup { escape_markup(body) } else { body.to_owned() };
    (summary, body)
}

#[cfg(target_os = "linux")]
pub fn show(title: &str, body: &str, label: &str) -> Result<(), String> {
    use std::collections::HashMap;
    const NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    let (title, body, label) = (title.to_owned(), body.to_owned(), label.to_owned());
    std::thread::Builder::new()
        .name("acde-notify".into())
        .spawn(move || {
            let sent = zbus::blocking::Connection::session().and_then(|bus| {
                let capabilities: Vec<String> = bus.call_method(Some(NAME), PATH, Some(NAME), "GetCapabilities", &())?.body().deserialize()?;
                let markup = capabilities.iter().any(|c| c == "body-markup");
                let (summary, body) = freedesktop_text(&title, &body, &label, markup);
                let hints: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
                let actions: Vec<&str> = Vec::new();
                bus.call_method(Some(NAME), PATH, Some(NAME), "Notify", &("acde", 0u32, "", summary.as_str(), body.as_str(), actions, hints, -1i32)).map(|_| ())
            });
            if let Err(e) = sent {
                log::warn!("notification: {NAME}: {e}");
            }
        })
        .map(|_| ())
        .map_err(|e| format!("notification thread: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOSTILE: &[&str] = &[
        "-e",
        "-l",
        "--",
        "-e do shell script \"touch /tmp/acde-notify-pwned\"",
        "\"); do shell script \"touch /tmp/acde-notify-pwned\" --",
        "back\\slash 'single' \"double\"",
        "line one\nline two\r\n",
        "中文 ✓ <b>&amp;</b>",
        "nul\0byte",
    ];

    #[test]
    fn osascript_arguments_never_carry_page_text() {
        for text in HOSTILE {
            let command = osascript(SHOW, text, text, text);
            let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(args.len(), 4);
            assert_eq!(&args[..3], ["-l", "JavaScript", "-e"]);
            assert_eq!(args[3], format!("{READ} {SHOW}"));
            let envs: Vec<_> = command.get_envs().filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned()))).collect();
            for name in [TITLE, BODY, SUBTITLE] {
                assert!(envs.iter().any(|(k, v)| k == name && *v == clean(text)), "{name} for {text:?}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn osascript_reads_the_text_back_unchanged() {
        let echo = "JSON.stringify([text('ACDE_NOTIFY_TITLE'), text('ACDE_NOTIFY_BODY'), text('ACDE_NOTIFY_SUBTITLE')])";
        let _ = std::fs::remove_file("/tmp/acde-notify-pwned");
        for text in HOSTILE {
            let out = osascript(echo, text, "body", "subtitle").output().expect("osascript");
            assert!(out.status.success(), "{text:?}: {}", String::from_utf8_lossy(&out.stderr));
            let read: Vec<String> = serde_json::from_slice(&out.stdout).expect("json");
            assert_eq!(read, [clean(text), "body".to_owned(), "subtitle".to_owned()]);
        }
        assert!(!std::path::Path::new("/tmp/acde-notify-pwned").exists());
    }

    #[test]
    fn freedesktop_body_is_escaped_only_with_markup() {
        let (summary, body) = freedesktop_text("a <b> & 'c'", "<a href=\"x\">&</a>", "记账", true);
        assert_eq!(summary, "记账: a <b> & 'c'");
        assert_eq!(body, "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
        let (summary, body) = freedesktop_text("t", "<i>", "", false);
        assert_eq!((summary.as_str(), body.as_str()), ("t", "<i>"));
    }
}
