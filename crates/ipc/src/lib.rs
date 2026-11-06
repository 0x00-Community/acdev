use std::io::{self, BufRead, BufReader, Read, Write};

#[cfg(unix)]
mod imp {
    use std::io;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub type Stream = UnixStream;

    pub fn connect(name: &str) -> io::Result<Stream> {
        UnixStream::connect(name)
    }

    pub fn endpoint(tag: &str) -> String {
        std::env::temp_dir().join(format!("acde-{tag}-{}.sock", std::process::id())).to_string_lossy().into_owned()
    }

    pub struct Listener(UnixListener, String);

    impl Listener {
        pub fn bind(name: &str) -> io::Result<Self> {
            let _ = std::fs::remove_file(name);
            Ok(Self(UnixListener::bind(name)?, name.to_owned()))
        }

        pub fn accept(&self) -> io::Result<Stream> {
            self.0.accept().map(|(s, _)| s)
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.1);
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::File;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    use windows_sys::Win32::Foundation::{ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, WaitNamedPipeW,
    };

    const BUFFER: u32 = 64 * 1024;
    const WAIT_MS: u32 = 5000;

    pub type Stream = File;

    fn wide(name: &str) -> Vec<u16> {
        std::ffi::OsStr::new(name).encode_wide().chain(Some(0)).collect()
    }

    pub fn connect(name: &str) -> io::Result<Stream> {
        loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(name) {
                Ok(file) => return Ok(file),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    if unsafe { WaitNamedPipeW(wide(name).as_ptr(), WAIT_MS) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Err(e) => return Err(e),
            }
        }
    }

    pub fn endpoint(tag: &str) -> String {
        format!(r"\\.\pipe\acde-{tag}-{}", std::process::id())
    }

    pub struct Listener(Vec<u16>);

    impl Listener {
        pub fn bind(name: &str) -> io::Result<Self> {
            Ok(Self(wide(name)))
        }

        pub fn accept(&self) -> io::Result<Stream> {
            let handle = unsafe {
                CreateNamedPipeW(
                    self.0.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    BUFFER,
                    BUFFER,
                    0,
                    std::ptr::null(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let file = unsafe { File::from_raw_handle(handle as _) };
            if unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                return Err(io::Error::last_os_error());
            }
            Ok(file)
        }
    }
}

pub use imp::{Listener, Stream, endpoint};

pub fn connect(name: &str) -> io::Result<Stream> {
    imp::connect(name)
}

pub struct Lines<R: Read>(BufReader<R>);

impl<R: Read> Lines<R> {
    pub fn new(reader: R) -> Self {
        Self(BufReader::new(reader))
    }

    pub fn next_line(&mut self) -> io::Result<Option<String>> {
        let mut line = String::new();
        match self.0.read_line(&mut line)? {
            0 => Ok(None),
            _ => Ok(Some(line.trim_end_matches(['\r', '\n']).to_owned())),
        }
    }
}

pub fn send(writer: &mut impl Write, line: &str) -> io::Result<()> {
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let name = endpoint("test");
        let listener = Listener::bind(&name).unwrap();
        let server = std::thread::spawn(move || {
            let stream = listener.accept().unwrap();
            let mut lines = Lines::new(stream.try_clone().unwrap());
            let got = lines.next_line().unwrap();
            let mut stream = stream;
            send(&mut stream, "pong").unwrap();
            got
        });
        let stream = connect(&name).unwrap();
        let mut writer = stream.try_clone().unwrap();
        send(&mut writer, "ping").unwrap();
        let mut lines = Lines::new(stream);
        assert_eq!(lines.next_line().unwrap().as_deref(), Some("pong"));
        assert_eq!(server.join().unwrap().as_deref(), Some("ping"));
    }
}
