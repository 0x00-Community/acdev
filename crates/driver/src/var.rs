use std::ffi::OsString;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Var {
    Backend,
    RenderNode,
    Size,
    Scale,
    Socket,
    HostDisplay,
    ShellFd,
    Scanout,
    DebugInput,
    Pages,
    PageFps,
    PageFull,
    PagePoll,
    PaintVerify,
    CanvasMaxCommands,
    RdpUser,
    RdpPassword,
    RdpCert,
    RdpKey,
    RdpAddr,
    RdpSecurity,
    Display,
    WaylandDisplay,
    XdgRuntimeDir,
    XdgConfigHome,
    XdgSessionType,
    XdgCurrentDesktop,
    Home,
    XcursorTheme,
    XcursorSize,
}

impl Var {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Backend => "ACDE_BACKEND",
            Self::RenderNode => "ACDE_RENDER_NODE",
            Self::Size => "ACDE_SIZE",
            Self::Scale => "ACDE_SCALE",
            Self::Socket => "ACDE_SOCKET",
            Self::HostDisplay => "ACDE_HOST_DISPLAY",
            Self::ShellFd => "ACDE_SHELL_FD",
            Self::Scanout => "ACDE_SCANOUT",
            Self::DebugInput => "ACDE_DEBUG_INPUT",
            Self::Pages => "ACDE_PAGES",
            Self::PageFps => "ACDE_PAGE_FPS",
            Self::PageFull => "ACDE_PAGE_FULL",
            Self::PagePoll => "ACDE_PAGE_POLL",
            Self::PaintVerify => "ACDE_PAINT_VERIFY",
            Self::CanvasMaxCommands => "ACDE_CANVAS_MAX_COMMANDS",
            Self::RdpUser => "ACDE_RDP_USER",
            Self::RdpPassword => "ACDE_RDP_PASSWORD",
            Self::RdpCert => "ACDE_RDP_CERT",
            Self::RdpKey => "ACDE_RDP_KEY",
            Self::RdpAddr => "ACDE_RDP_ADDR",
            Self::RdpSecurity => "ACDE_RDP_SECURITY",
            Self::Display => "DISPLAY",
            Self::WaylandDisplay => "WAYLAND_DISPLAY",
            Self::XdgRuntimeDir => "XDG_RUNTIME_DIR",
            Self::XdgConfigHome => "XDG_CONFIG_HOME",
            Self::XdgSessionType => "XDG_SESSION_TYPE",
            Self::XdgCurrentDesktop => "XDG_CURRENT_DESKTOP",
            Self::Home => "HOME",
            Self::XcursorTheme => "XCURSOR_THEME",
            Self::XcursorSize => "XCURSOR_SIZE",
        }
    }

    pub fn os(self) -> Option<OsString> {
        std::env::var_os(self.name()).filter(|v| !v.is_empty())
    }

    pub fn get(self) -> Option<String> {
        std::env::var(self.name()).ok().filter(|v| !v.is_empty())
    }

    pub fn is_set(self) -> bool {
        std::env::var_os(self.name()).is_some()
    }

    pub fn path(self) -> Option<PathBuf> {
        self.os().map(PathBuf::from)
    }

    pub fn parse<T: FromStr>(self) -> Option<T> {
        self.get()?.trim().parse().ok()
    }

    pub fn on(self, default: bool) -> bool {
        self.get().map_or(default, |v| v != "0")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Drm,
    Rdp,
    Nested,
}

impl FromStr for Backend {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "drm" => Ok(Self::Drm),
            "rdp" => Ok(Self::Rdp),
            "nested" => Ok(Self::Nested),
            other => Err(format!("{}: 只认 drm / rdp / nested, 不认 {other}", Var::Backend.name())),
        }
    }
}

impl Backend {
    pub fn chosen() -> Self {
        let inside = Var::Display.is_set() || Var::WaylandDisplay.is_set();
        match Var::Backend.get().map(|v| v.parse::<Self>()) {
            Some(Ok(backend)) => backend,
            Some(Err(e)) => {
                log::warn!("{e}");
                Self::fallback(inside)
            }
            None => Self::fallback(inside),
        }
    }

    const fn fallback(inside: bool) -> Self {
        if inside { Self::Nested } else { Self::Drm }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: u16,
    pub height: u16,
}

impl FromStr for Size {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (w, h) = value.split_once('x').ok_or(())?;
        Ok(Self { width: w.trim().parse().map_err(|_| ())?, height: h.trim().parse().map_err(|_| ())? })
    }
}

impl Size {
    pub fn or(default: Self) -> Self {
        Var::Size.parse().unwrap_or(default)
    }
}
