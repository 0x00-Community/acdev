use std::process::Command;

pub fn active_uid() -> Option<String> {
    let said = |args: &[&str]| {
        let out = Command::new("loginctl").args(args).output().ok().filter(|out| out.status.success())?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|text| !text.is_empty())
    };
    let session = said(&["show-seat", "seat0", "--property=ActiveSession", "--value"])?;
    said(&["show-session", &session, "--property=User", "--value"])
}
