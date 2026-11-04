//! `acde:session` and `acde:desktops` on the caller's thread: ending the session, the session language, the list of
//! desktops. What only the Broker can finish (stopping the session's loop, switching the desktop and its services,
//! handing the session to another desktop) it is told to do, as it is told the desktop stopped.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::files::Xdg;
use super::app::DesktopKind;
use super::{Desk, Done, Failure};

/// How the session ends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum End {
    Logout,
    Reboot,
    Poweroff,
}

impl End {
    pub const fn name(self) -> &'static str {
        match self {
            End::Logout => "logout",
            End::Reboot => "reboot",
            End::Poweroff => "poweroff",
        }
    }
}

impl TryFrom<&str> for End {
    type Error = Failure;

    fn try_from(name: &str) -> Result<Self, Failure> {
        [End::Logout, End::Reboot, End::Poweroff].into_iter().find(|e| e.name() == name).ok_or_else(|| Failure::new(400, "bad_end", format!("acde.session: no {name:?}")))
    }
}

/// A language-REGION tag (`zh-CN`), the only form `setLanguage` takes.
pub struct Tag {
    language: String,
    region: String,
}

impl TryFrom<&str> for Tag {
    type Error = Failure;

    fn try_from(tag: &str) -> Result<Self, Failure> {
        let refused = || Failure::new(400, "bad_language", format!("acde.session.setLanguage: {tag:?} is not a language-REGION tag such as zh-CN"));
        let (language, region) = tag.split_once('-').ok_or_else(refused)?;
        let language_ok = (2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase());
        let region_ok = region.len() == 2 && region.bytes().all(|b| b.is_ascii_uppercase());
        if !(language_ok && region_ok) {
            return Err(refused());
        }
        Ok(Tag { language: language.to_owned(), region: region.to_owned() })
    }
}

impl Tag {
    fn locale(&self) -> String {
        format!("{}_{}.UTF-8", self.language, self.region)
    }

    /// What pages see as `navigator.language` / `languages`.
    fn languages(&self) -> Value {
        let tag = format!("{}-{}", self.language, self.region);
        json!({ "language": tag, "languages": [tag, self.language] })
    }
}

impl Desk {
    /// The desk's `acde:` modules beyond windows and apps a caller gets: the desktop all, a window those its manifest names.
    pub(super) fn session_modules(caps: Option<&super::Capabilities>) -> Value {
        let mut modules = Vec::new();
        if caps.is_none_or(|c| c.open_files) {
            modules.push("files");
        }
        if caps.is_none() {
            modules.push("inspect");
        }
        if caps.is_none_or(|c| c.session) {
            modules.push("session");
        }
        if caps.is_none_or(|c| c.desktops) {
            modules.push("desktops");
        }
        modules.into()
    }

    const SYSTEMCTL_WAIT: Duration = Duration::from_secs(15);

    fn session_rights(&self, caller: u32, what: &str, granted: impl Fn(&super::Capabilities) -> bool) -> Done<()> {
        let (desktop, who, caps) = self.rights(caller);
        if desktop || granted(&caps) { Ok(()) } else { Err(Failure::refused(&who, what)) }
    }

    /// `session.own()`: whether this acde is the login session (not nested in another desktop).
    pub fn session_own(&self) -> bool {
        self.state().look.own
    }

    /// `logout` / `reboot` / `poweroff`. Reboot and power-off only in its own session, through systemd; the Broker
    /// then ends the session. Blocking (systemctl): run it off the caller's loop.
    pub fn end_session(&self, caller: u32, end: End) -> Done<()> {
        self.session_rights(caller, "acde.session", |c| c.session)?;
        if end != End::Logout {
            if !self.session_own() {
                log::info!("{} asked for; nested, not done", end.name());
                return Ok(());
            }
            Self::systemctl(end)?;
        }
        log::info!("session {}", end.name());
        self.to_broker(json!({ "type": "end", "kind": end.name() }));
        Ok(())
    }

    fn systemctl(end: End) -> Done<()> {
        let mut child = std::process::Command::new("systemctl")
            .args([end.name(), "--no-wall"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("systemctl {}: {e}", end.name()))?;
        let until = Instant::now() + Self::SYSTEMCTL_WAIT;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= until {
                _ = child.kill();
                return Err(format!("systemctl {}: no answer in {} s", end.name(), Self::SYSTEMCTL_WAIT.as_secs()).into());
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if status.success() {
            return Ok(());
        }
        let mut stderr = String::new();
        if let Some(mut err) = child.stderr.take() {
            _ = std::io::Read::read_to_string(&mut err, &mut stderr);
        }
        let message = Some(stderr.trim().to_owned()).filter(|m| !m.is_empty()).unwrap_or_else(|| format!("systemctl {}: {status}", end.name()));
        log::warn!("{} refused: {message}", end.name());
        Err(message.into())
    }

    /// `setLanguage(tag)`: written to `locale.conf` for the next login, and given to every isolate now.
    pub fn set_language(&self, caller: u32, tag: &str) -> Done<()> {
        self.session_rights(caller, "acde.session", |c| c.session)?;
        let tag = Tag::try_from(tag)?;
        let locale = tag.locale();
        let file = Xdg::config().join("locale.conf");
        if let Err(e) = Self::persist_locale(&file, &locale) {
            log::warn!("{} not written: {e}", file.display());
        }
        let languages = tag.languages();
        if self.state().look.languages.get("language") == languages.get("language") {
            return Ok(());
        }
        log::info!("session language: {}", languages["language"]);
        self.change_look(super::LookChange { languages: Some(languages), ..Default::default() });
        self.to_broker(json!({ "type": "language", "locale": locale }));
        Ok(())
    }

    fn persist_locale(file: &std::path::Path, locale: &str) -> std::io::Result<()> {
        let kept: Vec<String> = std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty() && !["LANG=", "LANGUAGE="].iter().any(|k| l.trim_start().starts_with(k)))
            .map(str::to_owned)
            .collect();
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut text = format!("LANG={locale}\n");
        for line in kept {
            text.push_str(&line);
            text.push('\n');
        }
        let temp = file.with_extension("conf.tmp");
        std::fs::write(&temp, text)?;
        std::fs::rename(temp, file)
    }

    /// `desktops.list()`: the installed acde desktops and the other Wayland sessions, and the current one.
    pub fn desktops(&self, caller: u32) -> Done<Value> {
        self.session_rights(caller, "acde.desktops", |c| c.desktops)?;
        Ok(serde_json::to_value(&self.state().look.desktops).unwrap_or_default())
    }

    /// `desktops.choose(id, remember)`: remembered for the next login when asked; the switch (or the hand-off to
    /// another session) is the Broker's.
    pub fn choose_desktop(&self, caller: u32, id: &str, remember: bool) -> Done<()> {
        self.session_rights(caller, "acde.desktops", |c| c.desktops)?;
        let (kind, current, standalone) = {
            let state = self.state();
            let look = &state.look;
            let kind = look.desktops.desktops.iter().find(|d| d.id == id).map(|d| d.kind);
            (kind, look.desktops.current.clone(), look.standalone)
        };
        let Some(kind) = kind else { return Err(Failure::missing(format!("no desktop {id}"))) };
        let foreign = kind == DesktopKind::Session;
        if foreign && standalone {
            return Err(Failure::new(409, "conflict", format!("acde window: {id} is not an acde desktop")));
        }
        if remember {
            let file = Xdg::state().join("acde/desktop");
            let written = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&file, format!("{id}\n")));
            if let Err(e) = written {
                log::warn!("{}: {e}", file.display());
            }
        }
        if !foreign && current == id {
            return Ok(());
        }
        self.to_broker(json!({ "type": "choose", "id": id }));
        Ok(())
    }
}
