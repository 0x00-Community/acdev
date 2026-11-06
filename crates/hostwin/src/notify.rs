#[cfg(target_os = "macos")]
pub(crate) fn show(title: &str, body: &str, subtitle: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let script = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)", "end run"];
    let mut command = Command::new("/usr/bin/osascript");
    for line in script {
        command.args(["-e", line]);
    }
    let child = command
        .args([title, body, subtitle])
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

#[cfg(target_os = "linux")]
pub(crate) fn show(title: &str, body: &str, subtitle: &str) -> Result<(), String> {
    use std::collections::HashMap;
    let (title, body, subtitle) = (title.to_owned(), body.to_owned(), subtitle.to_owned());
    std::thread::Builder::new()
        .name("acde-notify".into())
        .spawn(move || {
            let sent = zbus::blocking::Connection::session().and_then(|bus| {
                let hints: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
                let actions: Vec<&str> = Vec::new();
                let app = if subtitle.is_empty() { "acde" } else { subtitle.as_str() };
                bus.call_method(
                    Some("org.freedesktop.Notifications"),
                    "/org/freedesktop/Notifications",
                    Some("org.freedesktop.Notifications"),
                    "Notify",
                    &(app, 0u32, "", title.as_str(), body.as_str(), actions, hints, -1i32),
                )
                .map(|_| ())
            });
            if let Err(e) = sent {
                log::warn!("notification: org.freedesktop.Notifications: {e}");
            }
        })
        .map(|_| ())
        .map_err(|e| format!("notification thread: {e}"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn show(_: &str, _: &str, _: &str) -> Result<(), String> {
    Err(format!("no native notifications on {}", std::env::consts::OS))
}
