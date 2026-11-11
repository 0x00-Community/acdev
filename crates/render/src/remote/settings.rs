use std::net::SocketAddr;
use std::path::PathBuf;

use acde_driver::{Config, Size, Var};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RdpSecurity {
    #[default]
    Tls,
    Nla,
}

impl TryFrom<&str> for RdpSecurity {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "tls" => Ok(Self::Tls),
            "nla" => Ok(Self::Nla),
            other => Err(format!("{}: 只认 tls / nla, 不认 {other}", Var::RdpSecurity.name())),
        }
    }
}

#[derive(Clone, Debug)]
pub struct RdpSettings {
    pub user: String,
    pub password: String,
    pub cert: PathBuf,
    pub key: PathBuf,
    pub addr: SocketAddr,
    pub security: RdpSecurity,
    pub size: Size,
    pub video: bool,
    pub kbps: u32,
}

impl RdpSettings {
    const ADDR: &str = "0.0.0.0:3390";
    const SIZE: Size = Size { width: 1440, height: 900 };
    const DIR: &str = "agentos/rdp";
    const CERT: &str = "cert.pem";
    const KEY: &str = "key.pem";
    const KBPS: u32 = 6000;

    pub fn from_env() -> Result<Self, String> {
        let (Some(user), Some(password)) = (Var::RdpUser.get(), Var::RdpPassword.get()) else {
            return Err(format!("RDP 后端要 {} 和 {}", Var::RdpUser.name(), Var::RdpPassword.name()));
        };
        let dir = Config::home().unwrap_or_default().join(Self::DIR);
        let cert = Var::RdpCert.path().unwrap_or_else(|| dir.join(Self::CERT));
        let key = Var::RdpKey.path().unwrap_or_else(|| dir.join(Self::KEY));
        let addr = Var::RdpAddr.get().as_deref().unwrap_or(Self::ADDR).parse().map_err(|e| format!("{}: {e}", Var::RdpAddr.name()))?;
        let security = Var::RdpSecurity.get().as_deref().map_or(Ok(RdpSecurity::default()), RdpSecurity::try_from)?;
        let video = Var::RdpVideo.on(true);
        let kbps = Var::RdpKbps.parse().filter(|k| *k > 0).unwrap_or(Self::KBPS);
        Ok(Self { user, password, cert, key, addr, security, size: Size::or(Self::SIZE), video, kbps })
    }
}
