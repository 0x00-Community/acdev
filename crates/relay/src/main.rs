use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::process::ExitCode;
use std::thread;

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(windows)]
use uds_windows::UnixStream;

const USAGE: &str = "usage: acdev-relay SOCKET   (join stdin and stdout to the Unix socket SOCKET)";

fn copy(mut from: impl Read, mut to: impl Write) -> io::Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = from.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        to.write_all(&buffer[..read])?;
        to.flush()?;
    }
}

fn pump(stream: UnixStream, input: impl Read + Send + 'static, output: impl Write) -> io::Result<()> {
    let writer = stream.try_clone()?;
    let up = thread::spawn(move || {
        let _ = copy(input, &writer);
        let _ = writer.shutdown(Shutdown::Write);
    });
    let done = copy(&stream, output);
    let _ = stream.shutdown(Shutdown::Both);
    drop(up);
    done
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path] = args.as_slice() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let done = UnixStream::connect(path).and_then(|stream| pump(stream, io::stdin(), io::stdout()));
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("acdev-relay: {path}: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::unix::net::UnixListener;

    #[test]
    fn bytes_go_to_the_socket_and_its_answer_comes_back() {
        let dir = std::env::temp_dir().join(format!("acdev-relay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("echo.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let server = thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            peer.read_to_end(&mut got).unwrap();
            peer.write_all(&[b"echo: ".as_slice(), &got].concat()).unwrap();
        });
        let mut output = Vec::new();
        pump(UnixStream::connect(&path).unwrap(), Cursor::new(b"hello".to_vec()), &mut output).unwrap();
        server.join().unwrap();
        assert_eq!(output, b"echo: hello");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
