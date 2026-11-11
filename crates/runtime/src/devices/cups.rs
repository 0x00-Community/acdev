use std::path::PathBuf;

use serde_json::{json, Value};

use super::ipp::{self, Failure, Request};

const PRINTER: u8 = 0x04;
const JOB: u8 = 0x02;

fn printer_uri(name: &str) -> String {
    let escaped: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("ipp://localhost/printers/{escaped}")
}

fn lpoptions() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(".cups/lpoptions"))
}

fn user_default(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix("Default ")?;
        let name = rest.split_whitespace().next()?;
        Some(name.split('/').next().unwrap_or(name).to_owned())
    })
}

pub fn with_default(text: &str, name: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut placed = false;
    for line in text.lines() {
        let (kind, rest) = match line.split_once(' ') {
            Some((kind @ ("Default" | "Dest"), rest)) => (kind, rest),
            _ => {
                lines.push(line.to_owned());
                continue;
            }
        };
        let rest = rest.trim_start();
        let dest = rest.split_whitespace().next().unwrap_or("");
        let options = rest[dest.len()..].trim();
        let mine = name.is_some_and(|n| dest == n);
        if mine && !placed {
            placed = true;
            lines.push(format!("Default {rest}"));
        } else if kind == "Default" {
            if !options.is_empty() {
                lines.push(format!("Dest {rest}"));
            }
        } else {
            lines.push(line.to_owned());
        }
    }
    if let (Some(name), false) = (name, placed) {
        lines.push(format!("Default {name}"));
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn default_printer() -> Option<String> {
    if let Some(name) = lpoptions().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| user_default(&t)) {
        return Some(name);
    }
    let response = ipp::send("/", &Request::new(ipp::CUPS_GET_DEFAULT).keywords("requested-attributes", &["printer-name"])).ok()?;
    response.of(PRINTER).next().map(|a| ipp::text(a, "printer-name")).filter(|n| !n.is_empty())
}

pub fn printers() -> (bool, Vec<Value>) {
    let request = Request::new(ipp::CUPS_GET_PRINTERS).keywords(
        "requested-attributes",
        &[
            "printer-name",
            "printer-info",
            "printer-location",
            "printer-make-and-model",
            "printer-state",
            "printer-state-message",
            "printer-state-reasons",
            "printer-is-accepting-jobs",
            "printer-is-shared",
            "queued-job-count",
        ],
    );
    let response = match ipp::send("/", &request) {
        Ok(response) => response,
        Err(Failure::Status(0x0406, _)) => return (true, Vec::new()),
        Err(Failure::Unreachable(_)) => return (false, Vec::new()),
        Err(e) => {
            log::debug!("CUPS-Get-Printers: {}", e.message());
            return (true, Vec::new());
        }
    };
    let default = default_printer();
    let list = response
        .of(PRINTER)
        .map(|a| {
            let id = ipp::text(a, "printer-name");
            let info = ipp::text(a, "printer-info");
            let reasons = ipp::texts(a, "printer-state-reasons");
            let state = match ipp::int(a, "printer-state") {
                _ if reasons.iter().any(|r| r.starts_with("offline")) => "offline",
                Some(4) => "printing",
                Some(5) => "stopped",
                _ => "idle",
            };
            json!({
                "id": id,
                "name": if info.is_empty() { id.clone() } else { info },
                "state": state,
                "isDefault": default.as_deref() == Some(id.as_str()),
                "jobs": ipp::int(a, "queued-job-count").unwrap_or(0).max(0),
                "model": ipp::text(a, "printer-make-and-model"),
                "location": ipp::text(a, "printer-location"),
                "message": ipp::text(a, "printer-state-message"),
                "reasons": reasons.into_iter().filter(|r| r != "none").collect::<Vec<_>>(),
                "accepting": ipp::boolean(a, "printer-is-accepting-jobs").unwrap_or(true),
                "shared": ipp::boolean(a, "printer-is-shared").unwrap_or(false),
            })
        })
        .collect();
    (true, list)
}

fn admin(operation: u16, name: &str) -> Result<(), String> {
    let request = Request::new(operation).uri("printer-uri", &printer_uri(name)).name("requesting-user-name", &ipp::user());
    ipp::send("/admin/", &request).map(drop).map_err(Failure::message)
}

pub fn set_default(name: &str) -> Result<(), String> {
    let file = lpoptions();
    let text = file.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let (keep, server) = match admin(ipp::CUPS_SET_DEFAULT, name) {
        Ok(()) => (None, Ok(())),
        Err(e) => (Some(name), Err(e)),
    };
    if let Err(e) = &server {
        log::info!("CUPS-Set-Default {name}: {e}; the default is set for this user only");
    }
    let Some(file) = file else { return server };
    let next = with_default(&text, keep);
    if next == text {
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&file, next).map_err(|e| format!("{}: {e}", file.display()))
}

pub fn pause(name: &str) -> Result<(), String> {
    admin(ipp::PAUSE_PRINTER, name)
}

pub fn resume(name: &str) -> Result<(), String> {
    admin(ipp::RESUME_PRINTER, name)
}

fn job_state(state: i32) -> &'static str {
    match state {
        3 => "pending",
        4 => "held",
        5 => "processing",
        6 => "stopped",
        7 => "canceled",
        8 => "aborted",
        _ => "completed",
    }
}

pub fn jobs(name: &str) -> Result<Value, String> {
    let request = Request::new(ipp::GET_JOBS)
        .uri("printer-uri", &printer_uri(name))
        .name("requesting-user-name", &ipp::user())
        .keywords("which-jobs", &["not-completed"])
        .keywords(
            "requested-attributes",
            &["job-id", "job-name", "job-state", "job-originating-user-name", "job-k-octets", "time-at-creation", "job-printer-state-message"],
        );
    let response = match ipp::send("/", &request) {
        Ok(response) => response,
        Err(Failure::Status(0x0406, _)) => return Ok(json!([])),
        Err(e) => return Err(e.message()),
    };
    let list: Vec<Value> = response
        .of(JOB)
        .map(|a| {
            json!({
                "id": ipp::int(a, "job-id").unwrap_or(0),
                "name": ipp::text(a, "job-name"),
                "user": ipp::text(a, "job-originating-user-name"),
                "state": job_state(ipp::int(a, "job-state").unwrap_or(3)),
                "size": i64::from(ipp::int(a, "job-k-octets").unwrap_or(0).max(0)) * 1024,
                "created": ipp::int(a, "time-at-creation").unwrap_or(0),
                "message": ipp::text(a, "job-printer-state-message"),
            })
        })
        .collect();
    Ok(Value::Array(list))
}

pub fn cancel(name: &str, job: i32) -> Result<(), String> {
    let request = Request::new(ipp::CANCEL_JOB).uri("printer-uri", &printer_uri(name)).int("job-id", job).name("requesting-user-name", &ipp::user());
    ipp::send("/jobs/", &request).map(drop).map_err(Failure::message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_defaults() {
        assert_eq!(user_default("Dest a sides=one\nDefault laser/draft media=a4\n").as_deref(), Some("laser"));
        assert_eq!(with_default("Dest a sides=one\nDefault b\n", Some("a")), "Default a sides=one\n");
        assert_eq!(with_default("Default b copies=2\n", Some("c")), "Dest b copies=2\nDefault c\n");
        assert_eq!(with_default("Default b\nDest c x=1\n", None), "Dest c x=1\n");
        assert_eq!(with_default("", None), "");
        assert_eq!(printer_uri("HP LaserJet"), "ipp://localhost/printers/HP%20LaserJet");
    }

    #[test]
    #[ignore = "talks to this machine's CUPS"]
    fn this_machine() {
        let (running, list) = printers();
        eprintln!("CUPS running: {running}, printers: {}", serde_json::to_string_pretty(&list).unwrap());
        for p in &list {
            eprintln!("jobs of {}: {:?}", p["id"], jobs(p["id"].as_str().unwrap()));
        }
    }
}
