use std::io;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use rustix::fs::{self, Mode, OFlags};
use rustix::process::{ioctl_tiocsctty, setsid};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{Winsize, tcsetwinsize};

fn os_error(what: &str, error: impl Into<io::Error>) -> String {
    format!("{what}: {}", error.into())
}

fn window(cols: u32, rows: u32) -> Result<Winsize, String> {
    let size = |value: u32, name: &str| u16::try_from(value).ok().filter(|v| *v > 0).ok_or_else(|| format!("pty {name} must be 1..65535"));
    Ok(Winsize { ws_col: size(cols, "cols")?, ws_row: size(rows, "rows")?, ws_xpixel: 0, ws_ypixel: 0 })
}

pub(crate) fn spawn(command: &mut Command, cols: u32, rows: u32) -> Result<(OwnedFd, Child), String> {
    let size = window(cols, rows)?;
    let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC).map_err(|e| os_error("openpt", e))?;
    grantpt(&master).map_err(|e| os_error("grantpt", e))?;
    unlockpt(&master).map_err(|e| os_error("unlockpt", e))?;
    let name = ptsname(&master, Vec::new()).map_err(|e| os_error("ptsname", e))?;
    let slave = fs::open(name.as_c_str(), OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC, Mode::empty()).map_err(|e| os_error("open the pty", e))?;
    tcsetwinsize(&slave, size).map_err(|e| os_error("resize", e))?;
    command
        .stdin(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
        .stdout(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            setsid()?;
            ioctl_tiocsctty(BorrowedFd::borrow_raw(0))?;
            libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32);
            Ok(())
        });
    }
    let child = command.spawn().map_err(|e| format!("{}: {e}", command.get_program().to_string_lossy()))?;
    Ok((master, child))
}

pub(crate) fn set_size(fd: impl AsFd, cols: u32, rows: u32) -> Result<(), String> {
    tcsetwinsize(fd, window(cols, rows)?).map_err(|e| os_error("resize", e))
}
