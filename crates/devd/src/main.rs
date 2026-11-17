mod frame;
mod serve;
mod shell;
mod vsock;

use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::thread;

const PORT: u32 = 5252;
const USAGE: &str = "usage: acdevd serve [--port PORT]   (in the guest: answer acdev over vsock)
       acdevd connect CID [PORT]     (on the host: relay stdin and stdout to the guest's acdevd)
       acdevd --version";

fn port(text: Option<&String>) -> Result<u32, String> {
    text.map_or(Ok(PORT), |t| t.parse().map_err(|_| format!("acdevd: {t} is not a port")))
}

fn serve(args: &[String]) -> Result<(), String> {
    let port = match args {
        [] => PORT,
        [flag, value] if flag == "--port" => port(Some(value))?,
        _ => return Err(USAGE.into()),
    };
    let listener = vsock::Listener::bind(port).map_err(|e| format!("acdevd: vsock port {port}: {e}"))?;
    eprintln!("acdevd {}: listening on vsock port {port}", serve::VERSION);
    loop {
        let stream = match listener.accept() {
            Ok(stream) => stream,
            Err(e) => {
                eprintln!("acdevd: accept: {e}");
                continue;
            }
        };
        thread::spawn(move || {
            let settings = serve::Settings { logs: serve::log_dir().to_path_buf() };
            if let Err(e) = serve::handle(stream, &settings) {
                eprintln!("acdevd: {e}");
            }
        });
    }
}

fn copy(mut from: impl Read, mut to: impl Write) {
    let mut buffer = [0u8; 64 * 1024];
    while let Ok(read) = from.read(&mut buffer) {
        if read == 0 || to.write_all(&buffer[..read]).and_then(|()| to.flush()).is_err() {
            break;
        }
    }
}

fn connect(args: &[String]) -> Result<(), String> {
    let (cid, port) = match args {
        [cid] => (cid, PORT),
        [cid, value] => (cid, port(Some(value))?),
        _ => return Err(USAGE.into()),
    };
    let cid: u32 = cid.parse().map_err(|_| format!("acdevd: {cid} is not a context id"))?;
    let stream = vsock::connect_to(cid, port).map_err(|e| format!("acdevd: vsock {cid}:{port}: {e}"))?;
    let back = stream.try_clone().map_err(|e| e.to_string())?;
    let up = thread::spawn(move || {
        copy(io::stdin(), &stream);
        let _ = stream.shutdown(std::net::Shutdown::Write);
    });
    copy(back, io::stdout());
    drop(up);
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let done = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
        Some("connect") => connect(&args[1..]),
        Some("--version") => {
            println!("acdevd {}", serve::VERSION);
            Ok(())
        }
        _ => Err(USAGE.into()),
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}
