use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::agent::{Agent, Writer, write_line};
use crate::ops;

pub const SOCKET: &str = "/run/acdev/agent.sock";

pub fn serve(path: &Path, agent: &Arc<Agent>) -> Result<(), String> {
    let at = |e: std::io::Error| format!("{}: {e}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(at)?;
    }
    _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(at)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(at)?;
    log::info!("acdev's agent {} listens at {}", env!("CARGO_PKG_VERSION"), path.display());
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let agent = agent.clone();
                std::thread::spawn(move || connection(stream, &agent));
            }
            Err(e) => log::warn!("{}: accept: {e}", path.display()),
        }
    }
    Ok(())
}

fn connection(stream: UnixStream, agent: &Arc<Agent>) {
    let Ok(writer) = stream.try_clone() else { return };
    let writer: Writer = Arc::new(Mutex::new(writer));
    for line in BufReader::new(stream).split(b'\n') {
        let Ok(line) = line else { break };
        match serde_json::from_slice::<Value>(&line) {
            Ok(value) => said(agent, &writer, value),
            Err(e) => log::warn!("a host line that is not JSON: {e}"),
        }
    }
    agent.unwatch(&writer);
}

fn said(agent: &Arc<Agent>, writer: &Writer, value: Value) {
    match value["type"].as_str().unwrap_or_default() {
        "hello" if value["role"] == "dev" => agent.watch(writer.clone()),
        "reload" => act(agent, json!({ "action": "reload", "app": value["app"], "hot": value["hot"] == true })),
        "quit" => act(agent, json!({ "action": "end" })),
        "request" => {
            let (agent, writer) = (agent.clone(), writer.clone());
            std::thread::spawn(move || write_line(&writer, &ops::answer(&agent, &value)));
        }
        _ => {}
    }
}

fn act(agent: &Arc<Agent>, given: Value) {
    let agent = agent.clone();
    std::thread::spawn(move || {
        if let Err(why) = agent.hook("act", given.clone()) {
            log::warn!("dev.act {given}: {why}");
        }
    });
}
