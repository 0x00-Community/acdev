mod agent;
mod host;
mod journal;
mod link;
mod ops;
mod screen;

use std::path::PathBuf;
use std::process::ExitCode;

use acdevd::key;

const USAGE: &str = "usage: acdev-agent serve [--socket PATH]   (in a guest acdev started: the dev socket's line protocol, default /run/acdev/agent.sock)
       acdev-agent --version";

fn serve(args: &[String]) -> Result<(), String> {
    let path = match args {
        [] => PathBuf::from(host::SOCKET),
        [flag, path] if flag == "--socket" => PathBuf::from(path),
        _ => return Err(USAGE.into()),
    };
    let key = key::load(key::FW_CFG).ok_or_else(|| format!("acdev-agent: no key at {}: it runs only in a guest acdev started", key::FW_CFG))?;
    let key = String::from_utf8(key).map_err(|_| format!("acdev-agent: the key at {} is not text", key::FW_CFG))?;
    let agent = agent::Agent::new(key);
    agent.clone().follow();
    host::serve(&path, &agent)
}

fn main() -> ExitCode {
    journal::start();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let done = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
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
