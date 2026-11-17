use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::frame::{self, Frame};
use crate::{key, shell};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

pub struct Settings {
    pub logs: PathBuf,
    pub key: Option<Vec<u8>>,
}

pub fn handle(stream: UnixStream, settings: &Settings) -> io::Result<()> {
    let mut reader = stream.try_clone()?;
    let mut writer = stream;
    let done = match frame::read(&mut reader)? {
        Some(first) => match authorized(first, &mut reader, settings.key.as_deref()) {
            Ok(Some(first)) => answer(first, reader, &mut writer, settings),
            Ok(None) => return Ok(()),
            Err(denied) => Err(denied),
        },
        None => return Ok(()),
    };
    if let Err(error) = &done {
        let _ = frame::write(&mut writer, frame::ERROR, error.to_string().as_bytes());
    }
    done
}

fn authorized(first: Frame, reader: &mut UnixStream, key: Option<&[u8]>) -> io::Result<Option<Frame>> {
    if first.kind != frame::AUTH {
        return match key {
            Some(_) => Err(io::Error::new(io::ErrorKind::PermissionDenied, "this acdevd wants the key first")),
            None => Ok(Some(first)),
        };
    }
    if key.is_some_and(|key| !key::matches(&first.body, key)) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "wrong key"));
    }
    frame::read(reader)
}

fn answer(first: Frame, mut reader: UnixStream, writer: &mut UnixStream, settings: &Settings) -> io::Result<()> {
    match first.kind {
        frame::VERSION => frame::write(writer, frame::OK, VERSION.as_bytes()),
        frame::PUSH => push(first, &mut reader, writer),
        frame::PULL => pull(&first.body, writer),
        frame::RUN => run(&first.body, reader, writer.try_clone()?, settings),
        frame::KILL => signal(&first.body, writer),
        frame::SHELL => shell::run(&first.body, reader, writer.try_clone()?),
        other => Err(io::Error::new(io::ErrorKind::InvalidData, format!("unknown request {:?}", other as char))),
    }
}

fn push(first: Frame, reader: &mut UnixStream, writer: &mut UnixStream) -> io::Result<()> {
    let mut files = 0u32;
    let mut header = Some(first);
    loop {
        let frame = match header.take() {
            Some(frame) => frame,
            None => frame::read(reader)?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "push ended early"))?,
        };
        match frame.kind {
            frame::PUSH => {
                receive(&frame.body, reader)?;
                files += 1;
            }
            frame::DONE => return frame::write(writer, frame::OK, &files.to_le_bytes()),
            other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{:?} inside a push", other as char))),
        }
    }
}

fn receive(body: &[u8], reader: &mut UnixStream) -> io::Result<()> {
    let mode = frame::u32_at(body, 0).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "a push without a mode"))?;
    let path = PathBuf::from(String::from_utf8_lossy(&body[4..]).into_owned());
    if !path.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not an absolute path", path.display())));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let part = path.with_extension("acdevd-part");
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(&part)?;
    loop {
        let frame = frame::read(reader)?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "a file ended early"))?;
        match frame.kind {
            frame::DATA => file.write_all(&frame.body)?,
            frame::END => break,
            other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{:?} inside a file", other as char))),
        }
    }
    file.sync_all()?;
    fs::set_permissions(&part, fs::Permissions::from_mode(mode & 0o7777))?;
    fs::rename(&part, &path)
}

const CHUNK: usize = 1 << 20;

fn pull(body: &[u8], writer: &mut UnixStream) -> io::Result<()> {
    let root = PathBuf::from(String::from_utf8_lossy(body).into_owned());
    if !root.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not an absolute path", root.display())));
    }
    let mut files = 0u32;
    if fs::metadata(&root)?.is_dir() {
        send_tree(&root, &root, writer, &mut files)?;
    } else {
        send(&root, "", writer)?;
        files = 1;
    }
    frame::write(writer, frame::OK, &files.to_le_bytes())
}

fn send_tree(root: &Path, dir: &Path, writer: &mut UnixStream, files: &mut u32) -> io::Result<()> {
    let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            send_tree(root, &path, writer, files)?;
        } else if kind.is_file() {
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            send(&path, &relative.to_string_lossy(), writer)?;
            *files += 1;
        }
    }
    Ok(())
}

fn send(path: &Path, name: &str, writer: &mut UnixStream) -> io::Result<()> {
    let mut file = File::open(path)?;
    let mode = file.metadata()?.permissions().mode() & 0o7777;
    let mut header = mode.to_le_bytes().to_vec();
    header.extend_from_slice(name.as_bytes());
    frame::write(writer, frame::PUSH, &header)?;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        frame::write(writer, frame::DATA, &buffer[..read])?;
    }
    frame::write(writer, frame::END, &[])
}

fn command(body: &[u8]) -> io::Result<(bool, Command)> {
    let detach = body.first().is_some_and(|flags| flags & frame::DETACH != 0);
    let argv = frame::strings(body.get(1..).unwrap_or_default());
    let (program, args) = argv.split_first().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "nothing to run"))?;
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).process_group(0);
    Ok((detach, command))
}

fn run(body: &[u8], reader: UnixStream, writer: UnixStream, settings: &Settings) -> io::Result<()> {
    let (detach, mut command) = command(body)?;
    if detach {
        return start_detached(command, writer, settings);
    }
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let pid = child.id();
    let out = Arc::new(Mutex::new(writer));
    frame::write(&mut *out.lock().unwrap(), frame::PID, &pid.to_le_bytes())?;
    let pumps = [
        pump(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), frame::STDOUT, out.clone()),
        pump(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), frame::STDERR, out.clone()),
    ];
    let finished = Arc::new(AtomicBool::new(false));
    let watcher = watch_hangup(reader, pid, finished.clone());
    let status = child.wait()?;
    finished.store(true, Ordering::SeqCst);
    for handle in pumps.into_iter().flatten() {
        let _ = handle.join();
    }
    let _ = out.lock().unwrap().shutdown(Shutdown::Read);
    let _ = watcher.join();
    let code = status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
    frame::write(&mut *out.lock().unwrap(), frame::EXIT, &code.to_le_bytes())
}

fn start_detached(mut command: Command, mut writer: UnixStream, settings: &Settings) -> io::Result<()> {
    fs::create_dir_all(&settings.logs)?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let log = settings.logs.join(format!(".starting-{nanos}.log"));
    let file = File::create(&log)?;
    let child: Child = command.stdout(file.try_clone()?).stderr(file).spawn()?;
    let pid = child.id();
    let named = settings.logs.join(format!("{pid}.log"));
    fs::rename(&log, &named)?;
    thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    frame::write(&mut writer, frame::PID, &pid.to_le_bytes())?;
    frame::write(&mut writer, frame::OK, named.to_string_lossy().as_bytes())
}

fn pump(source: Option<Box<dyn Read + Send>>, kind: u8, out: Arc<Mutex<UnixStream>>) -> Option<thread::JoinHandle<()>> {
    let mut source = source?;
    Some(thread::spawn(move || {
        let mut buffer = [0u8; 64 * 1024];
        while let Ok(read) = source.read(&mut buffer) {
            if read == 0 || frame::write(&mut *out.lock().unwrap(), kind, &buffer[..read]).is_err() {
                break;
            }
        }
    }))
}

fn watch_hangup(mut reader: UnixStream, pid: u32, finished: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut byte = [0u8; 1];
        if matches!(reader.read(&mut byte), Ok(0) | Err(_)) && !finished.load(Ordering::SeqCst) {
            unsafe { kill(-(pid as i32), SIGTERM) };
        }
    })
}

fn signal(body: &[u8], writer: &mut UnixStream) -> io::Result<()> {
    let pid = frame::u32_at(body, 0).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "kill without a pid"))?;
    let sig = match body.get(4) {
        Some(9) => SIGKILL,
        _ => SIGTERM,
    };
    if pid == 0 || unsafe { kill(-(pid as i32), sig) } != 0 {
        return Err(io::Error::new(io::ErrorKind::NotFound, format!("no process group {pid}: {}", io::Error::last_os_error())));
    }
    frame::write(writer, frame::OK, &[])
}

pub fn log_dir() -> &'static Path {
    Path::new("/var/log/acdevd")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serve() -> (UnixStream, thread::JoinHandle<io::Result<()>>, PathBuf) {
        serve_with(None)
    }

    fn serve_with(key: Option<&[u8]>) -> (UnixStream, thread::JoinHandle<io::Result<()>>, PathBuf) {
        let (host, guest) = UnixStream::pair().unwrap();
        let logs = std::env::temp_dir().join(format!("acdevd-test-{}-{}", std::process::id(), rand()));
        let settings = Settings { logs: logs.clone(), key: key.map(<[u8]>::to_vec) };
        (host, thread::spawn(move || handle(guest, &settings)), logs)
    }

    fn rand() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn argv(flags: u8, words: &[&str]) -> Vec<u8> {
        let mut body = vec![flags];
        for word in words {
            body.extend_from_slice(word.as_bytes());
            body.push(0);
        }
        body
    }

    fn drain(host: &mut UnixStream) -> Vec<Frame> {
        let mut frames = Vec::new();
        while let Some(frame) = frame::read(host).unwrap() {
            let last = frame.kind == frame::EXIT || frame.kind == frame::ERROR || frame.kind == frame::OK;
            frames.push(frame);
            if last {
                break;
            }
        }
        frames
    }

    #[test]
    fn version() {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::VERSION, &[]).unwrap();
        let reply = frame::read(&mut host).unwrap().unwrap();
        assert_eq!((reply.kind, reply.body), (frame::OK, VERSION.as_bytes().to_vec()));
        server.join().unwrap().unwrap();
    }

    fn ask_version(host: &mut UnixStream) -> Frame {
        frame::write(host, frame::VERSION, &[]).unwrap();
        frame::read(host).unwrap().unwrap()
    }

    #[test]
    fn the_right_key_opens_the_connection() {
        let (mut host, server, _) = serve_with(Some(b"s3cret"));
        frame::write(&mut host, frame::AUTH, b"s3cret").unwrap();
        assert_eq!(ask_version(&mut host).kind, frame::OK);
        server.join().unwrap().unwrap();
    }

    #[test]
    fn a_wrong_or_missing_key_is_refused() {
        let (mut host, server, _) = serve_with(Some(b"s3cret"));
        frame::write(&mut host, frame::AUTH, b"guess!").unwrap();
        let reply = frame::read(&mut host).unwrap().unwrap();
        assert_eq!((reply.kind, reply.body.as_slice()), (frame::ERROR, &b"wrong key"[..]));
        assert!(server.join().unwrap().is_err());
        let (mut host, server, _) = serve_with(Some(b"s3cret"));
        assert_eq!(ask_version(&mut host).kind, frame::ERROR);
        assert!(server.join().unwrap().is_err());
    }

    #[test]
    fn without_a_key_the_key_frame_is_optional() {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::AUTH, b"anything").unwrap();
        assert_eq!(ask_version(&mut host).kind, frame::OK);
        server.join().unwrap().unwrap();
    }

    #[test]
    fn push_writes_files_with_their_mode() {
        let dir = std::env::temp_dir().join(format!("acdevd-push-{}", rand()));
        let (mut host, server, _) = serve();
        for (name, mode, text) in [("a/run.sh", 0o755u32, "echo hi\n"), ("b.txt", 0o644, "plain")] {
            let mut body = mode.to_le_bytes().to_vec();
            body.extend_from_slice(dir.join(name).to_string_lossy().as_bytes());
            frame::write(&mut host, frame::PUSH, &body).unwrap();
            frame::write(&mut host, frame::DATA, text.as_bytes()).unwrap();
            frame::write(&mut host, frame::END, &[]).unwrap();
        }
        frame::write(&mut host, frame::DONE, &[]).unwrap();
        let reply = frame::read(&mut host).unwrap().unwrap();
        assert_eq!((reply.kind, frame::u32_at(&reply.body, 0)), (frame::OK, Some(2)));
        server.join().unwrap().unwrap();
        assert_eq!(fs::read_to_string(dir.join("a/run.sh")).unwrap(), "echo hi\n");
        assert_eq!(fs::metadata(dir.join("a/run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::metadata(dir.join("b.txt")).unwrap().permissions().mode() & 0o777, 0o644);
        fs::remove_dir_all(dir).unwrap();
    }

    fn pulled(path: &Path) -> (Vec<(u32, String, Vec<u8>)>, u32) {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::PULL, path.to_string_lossy().as_bytes()).unwrap();
        let mut files = Vec::new();
        loop {
            let reply = frame::read(&mut host).unwrap().unwrap();
            match reply.kind {
                frame::PUSH => files.push((frame::u32_at(&reply.body, 0).unwrap(), String::from_utf8_lossy(&reply.body[4..]).into_owned(), Vec::new())),
                frame::DATA => files.last_mut().unwrap().2.extend_from_slice(&reply.body),
                frame::END => {}
                frame::OK => {
                    server.join().unwrap().unwrap();
                    return (files, frame::u32_at(&reply.body, 0).unwrap());
                }
                other => panic!("{:?}: {}", other as char, String::from_utf8_lossy(&reply.body)),
            }
        }
    }

    #[test]
    fn pull_sends_a_file_or_a_tree_with_modes() {
        let dir = std::env::temp_dir().join(format!("acdevd-pull-{}", rand()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/run.sh"), "echo hi\n").unwrap();
        fs::set_permissions(dir.join("sub/run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(dir.join("a.txt"), vec![7u8; CHUNK + 5]).unwrap();
        fs::set_permissions(dir.join("a.txt"), fs::Permissions::from_mode(0o640)).unwrap();
        let (files, count) = pulled(&dir);
        assert_eq!(count, 2);
        let shape: Vec<_> = files.iter().map(|(mode, name, data)| (*mode, name.as_str(), data.len())).collect();
        assert_eq!(shape, [(0o640, "a.txt", CHUNK + 5), (0o755, "sub/run.sh", 8)]);
        let (files, count) = pulled(&dir.join("sub/run.sh"));
        assert_eq!((count, files[0].1.as_str(), files[0].2.as_slice()), (1, "", &b"echo hi\n"[..]));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pulling_what_is_not_there_is_an_error() {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::PULL, b"/no/such/acdevd/file").unwrap();
        assert_eq!(frame::read(&mut host).unwrap().unwrap().kind, frame::ERROR);
        assert!(server.join().unwrap().is_err());
    }

    #[test]
    fn run_streams_output_and_the_exit_code() {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::RUN, &argv(0, &["/bin/sh", "-c", "echo out; echo err >&2; exit 3"])).unwrap();
        let frames = drain(&mut host);
        assert_eq!(frames[0].kind, frame::PID);
        let text = |kind| frames.iter().filter(|f| f.kind == kind).flat_map(|f| f.body.clone()).collect::<Vec<u8>>();
        assert_eq!(text(frame::STDOUT), b"out\n");
        assert_eq!(text(frame::STDERR), b"err\n");
        assert_eq!(frames.last().unwrap().body, 3i32.to_le_bytes());
        drop(host);
        server.join().unwrap().unwrap();
    }

    #[test]
    fn a_detached_program_is_stopped_by_kill() {
        let (mut host, server, logs) = serve();
        frame::write(&mut host, frame::RUN, &argv(frame::DETACH, &["/bin/sh", "-c", "echo started; exec sleep 30"])).unwrap();
        let frames = drain(&mut host);
        server.join().unwrap().unwrap();
        let pid = frame::u32_at(&frames[0].body, 0).unwrap();
        assert!(String::from_utf8_lossy(&frames[1].body).ends_with(&format!("{pid}.log")));
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::KILL, &pid.to_le_bytes()).unwrap();
        assert_eq!(frame::read(&mut host).unwrap().unwrap().kind, frame::OK);
        server.join().unwrap().unwrap();
        thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(fs::read_to_string(logs.join(format!("{pid}.log"))).unwrap(), "started\n");
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::KILL, &pid.to_le_bytes()).unwrap();
        assert_eq!(frame::read(&mut host).unwrap().unwrap().kind, frame::ERROR);
        assert!(server.join().unwrap().is_err());
        fs::remove_dir_all(logs).unwrap();
    }

    fn shell(rows: u16, cols: u16, words: &[&str]) -> Vec<u8> {
        let mut body = [rows.to_le_bytes(), cols.to_le_bytes()].concat();
        for word in std::iter::once(&"xterm").chain(words) {
            body.extend_from_slice(word.as_bytes());
            body.push(0);
        }
        body
    }

    fn output_until(host: &mut UnixStream, text: &str) -> String {
        let mut seen = String::new();
        while !seen.contains(text) {
            let frame = frame::read(host).unwrap().unwrap();
            assert_eq!(frame.kind, frame::STDOUT, "{seen}");
            seen.push_str(&String::from_utf8_lossy(&frame.body));
        }
        seen
    }

    fn shell_pid(host: &mut UnixStream) {
        let frame = frame::read(host).unwrap().unwrap();
        assert_eq!(frame.kind, frame::PID, "{}", String::from_utf8_lossy(&frame.body));
    }

    fn exit_code(host: &mut UnixStream) -> i32 {
        loop {
            let frame = frame::read(host).unwrap().unwrap();
            if frame.kind == frame::EXIT {
                return i32::from_le_bytes(frame.body.try_into().unwrap());
            }
        }
    }

    #[test]
    fn a_shell_has_a_terminal_of_the_given_size_and_its_exit_code() {
        let (mut host, server, _) = serve();
        let script = "stty size; [ -t 0 ] && echo tty=$TERM; exit 5";
        frame::write(&mut host, frame::SHELL, &shell(30, 100, &["/bin/sh", "-c", script])).unwrap();
        shell_pid(&mut host);
        let seen = output_until(&mut host, "tty=xterm");
        assert!(seen.contains("30 100"), "{seen}");
        assert_eq!(exit_code(&mut host), 5);
        server.join().unwrap().unwrap();
    }

    #[test]
    fn a_shell_takes_input_and_follows_a_resize() {
        let (mut host, server, _) = serve();
        let script = "read line; stty size; echo got=$line; exit 0";
        frame::write(&mut host, frame::SHELL, &shell(24, 80, &["/bin/sh", "-c", script])).unwrap();
        shell_pid(&mut host);
        let size = 50u32 | (132u32 << 16);
        frame::write(&mut host, frame::RESIZE, &size.to_le_bytes()).unwrap();
        frame::write(&mut host, frame::DATA, b"hello\r").unwrap();
        let seen = output_until(&mut host, "got=hello");
        assert!(seen.contains("50 132"), "{seen}");
        assert_eq!(exit_code(&mut host), 0);
        server.join().unwrap().unwrap();
    }

    #[test]
    fn a_hangup_ends_the_shell() {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::SHELL, &shell(24, 80, &["/bin/sh", "-c", "echo ready; exec sleep 30"])).unwrap();
        shell_pid(&mut host);
        output_until(&mut host, "ready");
        let started = std::time::Instant::now();
        drop(host);
        let _ = server.join().unwrap();
        assert!(started.elapsed().as_secs() < 10);
    }

    #[test]
    fn a_hangup_ends_the_program() {
        let (mut host, server, _) = serve();
        frame::write(&mut host, frame::RUN, &argv(0, &["/bin/sh", "-c", "exec sleep 30"])).unwrap();
        shell_pid(&mut host);
        let started = std::time::Instant::now();
        drop(host);
        let _ = server.join().unwrap();
        assert!(started.elapsed().as_secs() < 10);
    }
}
