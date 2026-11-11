use std::process::Command;
use std::time::{Duration, Instant};

use crate::var::Var;

pub struct SessionEnv;

impl SessionEnv {
    const TIMEOUT: Duration = Duration::from_secs(3);
    const POLL: Duration = Duration::from_millis(5);
    const EXPORTED: [Var; 4] = [Var::WaylandDisplay, Var::Display, Var::XdgSessionType, Var::XdgCurrentDesktop];
    const PORTALS: [&str; 2] = ["xdg-desktop-portal.service", "xdg-desktop-portal-gtk.service"];

    pub fn export(vars: &[(Var, &str)]) {
        let mut command = Command::new("dbus-update-activation-environment");
        command.arg("--systemd").args(vars.iter().map(|(k, v)| format!("{}={v}", k.name())));
        Self::run(command);
    }

    pub fn clear() {
        let mut unset = Command::new("systemctl");
        unset.args(["--user", "unset-environment"]).args(Self::EXPORTED.map(Var::name));
        Self::run(unset);
        let mut stop = Command::new("systemctl");
        stop.args(["--user", "stop"]).args(Self::PORTALS);
        Self::run(stop);
    }

    fn run(mut command: Command) {
        let name = command.get_program().to_string_lossy().into_owned();
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => return log::warn!("{name}: {e}"),
        };
        let deadline = Instant::now() + Self::TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) if !status.success() => return log::warn!("{name}: {status}"),
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Self::POLL),
                Ok(None) => {
                    log::warn!("{name} {} 秒没做完, 不等了", Self::TIMEOUT.as_secs());
                    std::thread::spawn(move || child.wait());
                    return;
                }
                Err(e) => return log::warn!("{name}: {e}"),
            }
        }
    }
}
