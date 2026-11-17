use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedFd;

pub struct WakeLock {
    _logind: Option<OwnedFd>,
    screensaver: Option<(Connection, u32)>,
}

impl WakeLock {
    const WHO: &str = "acde";

    pub fn acquire(why: &str) -> Result<Self, String> {
        let logind = Self::logind(why).inspect_err(|e| log::debug!("wake lock, logind: {e}")).ok();
        let screensaver = Self::screensaver(why).inspect_err(|e| log::debug!("wake lock, ScreenSaver: {e}")).ok();
        if logind.is_none() && screensaver.is_none() {
            return Err("neither logind nor a screen saver takes an idle inhibitor here".into());
        }
        Ok(Self { _logind: logind, screensaver })
    }

    fn logind(why: &str) -> zbus::Result<OwnedFd> {
        let bus = Connection::system()?;
        let manager = Proxy::new(&bus, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager")?;
        manager.call("Inhibit", &("idle", Self::WHO, why, "block"))
    }

    fn screensaver(why: &str) -> zbus::Result<(Connection, u32)> {
        let bus = Connection::session()?;
        let saver = Proxy::new(&bus, "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver")?;
        let cookie: u32 = saver.call("Inhibit", &(Self::WHO, why))?;
        Ok((bus, cookie))
    }
}

impl Drop for WakeLock {
    fn drop(&mut self) {
        let Some((bus, cookie)) = self.screensaver.take() else { return };
        let released = Proxy::new(&bus, "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver")
            .and_then(|saver| saver.call::<_, _, ()>("UnInhibit", &(cookie,)));
        if let Err(e) = released {
            log::debug!("wake lock, ScreenSaver release: {e}");
        }
    }
}
