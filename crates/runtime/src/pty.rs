use std::io;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use rustix::fs::{self, Mode, OFlags};
use rustix::process::{ioctl_tiocsctty, setsid};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{Winsize, tcsetwinsize};

pub struct PtyOptions {
    pub file: String,
    pub args: Vec<String>,
    pub env: Vec<(&'static str, &'static str)>,
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
}

pub struct Pty;

impl Pty {
    fn os_error(what: &str, error: impl Into<io::Error>) -> String {
        format!("{what}: {}", error.into())
    }

    fn window(cols: u32, rows: u32) -> Result<Winsize, String> {
        let size = |value: u32, name: &str| {
            u16::try_from(value).ok().filter(|v| *v > 0).ok_or_else(|| format!("pty {name} must be 1..65535"))
        };
        Ok(Winsize {
            ws_col: size(cols, "cols")?,
            ws_row: size(rows, "rows")?,
            ws_xpixel: 0,
            ws_ypixel: 0,
        })
    }

    pub(crate) fn open(options: &PtyOptions) -> Result<(OwnedFd, Child), String> {
        let size = Self::window(options.cols, options.rows)?;
        let flags = OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC;
        let master = openpt(flags).map_err(|e| Self::os_error("openpt", e))?;
        grantpt(&master).map_err(|e| Self::os_error("grantpt", e))?;
        unlockpt(&master).map_err(|e| Self::os_error("unlockpt", e))?;
        let name = ptsname(&master, Vec::new()).map_err(|e| Self::os_error("ptsname", e))?;
        let slave = fs::open(name.as_c_str(), OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC, Mode::empty())
            .map_err(|e| Self::os_error("open the pty", e))?;
        tcsetwinsize(&slave, size).map_err(|e| Self::os_error("resize", e))?;
        let mut command = Command::new(&options.file);
        command
            .args(&options.args)
            .envs(options.env.iter().copied())
            .current_dir(&options.cwd)
            .stdin(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
            .stdout(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(slave));
        unsafe {
            command.pre_exec(|| {
                setsid()?;
                ioctl_tiocsctty(BorrowedFd::borrow_raw(0))?;
                Ok(())
            });
        }
        let child = command.spawn().map_err(|e| format!("{}: {e}", options.file))?;
        Ok((master, child))
    }

    pub(crate) fn set_size(fd: impl AsFd, cols: u32, rows: u32) -> Result<(), String> {
        tcsetwinsize(fd, Self::window(cols, rows)?).map_err(|e| Self::os_error("resize", e))
    }
}
