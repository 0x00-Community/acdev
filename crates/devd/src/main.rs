mod frame;
mod key;
mod serve;
mod shell;
mod vsock;

use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

const PORT: u32 = 5252;
const USAGE: &str = "usage: acdevd serve [--port PORT]   (in the guest: answer acdev over vsock, and TCP when it has a key)
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
    let settings = Arc::new(serve::Settings { logs: serve::log_dir().to_path_buf(), key: key::load(key::FW_CFG) });
    let mut loops = Vec::new();
    match vsock::Listener::bind(port) {
        Ok(listener) => loops.push(answer(format!("vsock port {port}"), move || listener.accept(), settings.clone())),
        Err(e) => eprintln!("acdevd: vsock port {port}: {e}"),
    }
    match settings.key.is_some().then(|| tcp(port)) {
        Some(Ok(listener)) => loops.push(answer(format!("tcp port {port}"), move || accept_tcp(&listener), settings.clone())),
        Some(Err(e)) => eprintln!("acdevd: tcp port {port}: {e}"),
        None => eprintln!("acdevd: no key at {}: not listening on tcp", key::FW_CFG),
    }
    if loops.is_empty() {
        return Err(format!("acdevd: nothing to listen on (port {port})"));
    }
    for listening in loops {
        let _ = listening.join();
    }
    Ok(())
}

fn tcp(port: u32) -> io::Result<TcpListener> {
    let port = u16::try_from(port).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "above 65535"))?;
    TcpListener::bind(("0.0.0.0", port))
}

fn accept_tcp(listener: &TcpListener) -> io::Result<UnixStream> {
    let (stream, _) = listener.accept()?;
    stream.set_nodelay(true)?;
    Ok(UnixStream::from(OwnedFd::from(stream)))
}

fn answer(name: String, accept: impl Fn() -> io::Result<UnixStream> + Send + 'static, settings: Arc<serve::Settings>) -> thread::JoinHandle<()> {
    eprintln!("acdevd {}: listening on {name}", serve::VERSION);
    thread::spawn(move || {
        loop {
            let stream = match accept() {
                Ok(stream) => stream,
                Err(e) => {
                    eprintln!("acdevd: accept on {name}: {e}");
                    continue;
                }
            };
            let settings = settings.clone();
            thread::spawn(move || {
                if let Err(e) = serve::handle(stream, &settings) {
                    eprintln!("acdevd: {e}");
                }
            });
        }
    })
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
