mod agent;
mod host;
mod journal;
mod link;
mod ops;
mod overlay;
mod screen;

use std::path::PathBuf;
use std::process::ExitCode;

use acdevd::key;
use serde_json::{Value, json};

const USAGE: &str = "usage: acdev-agent serve [--socket PATH]   (in a guest acdev started: the dev socket's line protocol, default /run/acdev/agent.sock)
       acdev-agent overlay mount NAME [--reload APP]... [--desktop]   (acdev push: bind /var/lib/acdev/overlay/NAME on the package, reload)
       acdev-agent overlay reset [NAME]   (unbind and delete the overlays, or the one of NAME)
       acdev-agent --version";

fn agent() -> Result<std::sync::Arc<agent::Agent>, String> {
    let key = key::load(key::FW_CFG).ok_or_else(|| format!("acdev-agent: no key at {}: it runs only in a guest acdev started", key::FW_CFG))?;
    let key = String::from_utf8(key).map_err(|_| format!("acdev-agent: the key at {} is not text", key::FW_CFG))?;
    Ok(agent::Agent::new(key))
}

fn serve(args: &[String]) -> Result<(), String> {
    let path = match args {
        [] => PathBuf::from(host::SOCKET),
        [flag, path] if flag == "--socket" => PathBuf::from(path),
        _ => return Err(USAGE.into()),
    };
    let agent = agent()?;
    agent.clone().follow();
    host::serve(&path, &agent)
}

fn main() -> ExitCode {
    journal::start();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let done = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
        Some("overlay") => overlay(&args[1..]),
        Some("--version") => {
            println!("acdev-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err(USAGE.into()),
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            log::error!("{message}");
            ExitCode::from(2)
        }
    }
}

fn reloads(args: &[String]) -> Result<Vec<Value>, String> {
    let mut asked = Vec::new();
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            "--reload" => asked.push(json!({ "action": "reload", "app": rest.next().ok_or_else(|| USAGE.to_string())? })),
            "--desktop" => asked.push(json!({ "action": "reload" })),
            _ => return Err(USAGE.into()),
        }
    }
    Ok(asked)
}

fn overlay(args: &[String]) -> Result<(), String> {
    let done = match args {
        [action, name, rest @ ..] if action == "mount" => {
            let asked = reloads(rest)?;
            let mut done = overlay::mount(name)?;
            let agent = agent()?;
            let reloaded: Result<Vec<Value>, String> = asked.into_iter().map(|given| agent.hook("act", given)).collect();
            done["reloaded"] = json!(reloaded?);
            done
        }
        [action, only @ ..] if action == "reset" && only.len() <= 1 => json!({ "reset": overlay::reset(only.first().map(String::as_str))? }),
        _ => return Err(USAGE.into()),
    };
    println!("{done}");
    Ok(())
}
