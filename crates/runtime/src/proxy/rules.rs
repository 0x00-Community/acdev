//! The text forms of proxy settings: the environment variables and `no_proxy` (curl's and Go's reading), and the proxy and
//! bypass lists of the Windows Internet settings. Pure functions, so they are tested on every platform.

use super::{Endpoint, Hop};
use std::net::IpAddr;
use url::Url;

/// `http_proxy` / `https_proxy` / `all_proxy`, lower case first, then upper case.
pub(crate) struct Env {
    http: Option<Hop>,
    https: Option<Hop>,
    all: Option<Hop>,
}

impl Env {
    /// The proxy variables (none when not one is set) and `no_proxy`, which holds for the system settings too.
    pub(crate) fn read(var: impl Fn(&str) -> Option<String>) -> (Option<Self>, NoProxy) {
        let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        let value = |name: &str| set(name).or_else(|| set(&name.to_ascii_uppercase()));
        let (http, https, all) = (value("http_proxy"), value("https_proxy"), value("all_proxy"));
        let no_proxy = NoProxy::parse(&value("no_proxy").unwrap_or_default());
        if http.is_none() && https.is_none() && all.is_none() {
            return (None, no_proxy);
        }
        let hop = |text: Option<String>| text.and_then(|text| proxy(&text, "http"));
        (Some(Self { http: hop(http), https: hop(https), all: hop(all) }), no_proxy)
    }

    pub(crate) fn find(&self, url: &Url) -> Vec<Hop> {
        let scheme = if url.scheme() == "https" { &self.https } else { &self.http };
        vec![scheme.as_ref().or(self.all.as_ref()).cloned().unwrap_or(Hop::Direct)]
    }
}

/// A proxy URL (`http://h:p`, `socks5://h:p`, or `h:p` taken as `default://h:p`); the user name and password are ignored
/// (proxies asking for them answer 407, which the request then reports).
pub(crate) fn proxy(text: &str, default: &str) -> Option<Hop> {
    let text = text.trim();
    let parsed = if text.contains("://") { Url::parse(text) } else { Url::parse(&format!("{default}://{text}")) };
    let Ok(parsed) = parsed else {
        log::warn!("proxy: {text:?} is not a proxy address");
        return None;
    };
    let host = match parsed.host()? {
        url::Host::Domain(name) => name.to_owned(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    };
    let scheme = parsed.scheme().to_ascii_lowercase();
    let port = |default: u16| parsed.port().unwrap_or(default);
    let hop = match scheme.as_str() {
        "http" => Hop::Http(Endpoint { host, port: port(80) }),
        "socks4" | "socks4a" => Hop::Socks4(Endpoint { host, port: port(1080) }),
        "socks" | "socks5" | "socks5h" => Hop::Socks5(Endpoint { host, port: port(1080) }),
        _ => {
            log::warn!("proxy: {scheme}:// proxies are not supported, {}:{} is not used", parsed.host_str().unwrap_or_default(), port(0));
            return None;
        }
    };
    Some(hop)
}

/// localhost and loopback addresses are never proxied
pub(crate) fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback()),
        None => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pattern {
    /// the name and its subdomains (`example.com`, `.example.com` and `*.example.com` alike)
    Domain(String),
    /// an address or a CIDR block
    Net(IpAddr, u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    pattern: Pattern,
    port: Option<u16>,
}

/// `no_proxy`: comma separated names, addresses and CIDR blocks, each with an optional `:port`; `*` is every host.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct NoProxy {
    all: bool,
    entries: Vec<Entry>,
}

impl NoProxy {
    pub(crate) fn parse(text: &str) -> Self {
        let mut list = Self::default();
        for item in text.split([',', ' ', '\t', '\n']).map(str::trim).filter(|item| !item.is_empty()) {
            if item == "*" {
                list.all = true;
            } else if let Some(entry) = Entry::parse(item) {
                list.entries.push(entry);
            }
        }
        list
    }

    pub(crate) fn matches(&self, url: &Url) -> bool {
        if self.all {
            return true;
        }
        let Some(host) = url.host() else { return false };
        let port = url.port_or_known_default();
        self.entries.iter().any(|entry| entry.port.is_none_or(|wanted| Some(wanted) == port) && entry.pattern.matches(&host))
    }
}

impl Entry {
    fn parse(item: &str) -> Option<Self> {
        if let Some(rest) = item.strip_prefix('[') {
            let (address, after) = rest.split_once(']')?;
            let port = match after.strip_prefix(':') {
                Some(port) => Some(port.parse().ok()?),
                None if after.is_empty() => None,
                None => return None,
            };
            let ip: IpAddr = address.parse().ok()?;
            return Some(Self { pattern: Pattern::Net(ip, bits(ip)), port });
        }
        if let Some((address, prefix)) = item.split_once('/') {
            let ip: IpAddr = address.parse().ok()?;
            let prefix: u8 = prefix.parse().ok().filter(|prefix| *prefix <= bits(ip))?;
            return Some(Self { pattern: Pattern::Net(ip, prefix), port: None });
        }
        if let Ok(ip) = item.parse::<IpAddr>() {
            return Some(Self { pattern: Pattern::Net(ip, bits(ip)), port: None });
        }
        let (name, port) = match item.rsplit_once(':') {
            Some((name, port)) => (name, Some(port.parse().ok()?)),
            None => (item, None),
        };
        if let Ok(ip) = name.parse::<IpAddr>() {
            return Some(Self { pattern: Pattern::Net(ip, bits(ip)), port });
        }
        let name = name.trim_start_matches('*').trim_start_matches('.').trim_end_matches('.').to_ascii_lowercase();
        (!name.is_empty()).then_some(Self { pattern: Pattern::Domain(name), port })
    }
}

fn bits(ip: IpAddr) -> u8 {
    if ip.is_ipv4() { 32 } else { 128 }
}

impl Pattern {
    fn matches(&self, host: &url::Host<&str>) -> bool {
        match (self, host) {
            (Self::Domain(name), url::Host::Domain(host)) => {
                let host = host.trim_end_matches('.').to_ascii_lowercase();
                host == *name || host.strip_suffix(name.as_str()).is_some_and(|rest| rest.ends_with('.'))
            }
            (Self::Net(net, prefix), url::Host::Ipv4(ip)) => within(*net, *prefix, IpAddr::V4(*ip)),
            (Self::Net(net, prefix), url::Host::Ipv6(ip)) => within(*net, *prefix, IpAddr::V6(*ip)),
            _ => false,
        }
    }
}

fn within(net: IpAddr, prefix: u8, ip: IpAddr) -> bool {
    let mask = |width: u32| if prefix == 0 { 0 } else { u128::MAX << (width - u32::from(prefix)) };
    match (net, ip) {
        (IpAddr::V4(net), IpAddr::V4(ip)) => {
            let mask = mask(32) as u32;
            u32::from(net) & mask == u32::from(ip) & mask
        }
        (IpAddr::V6(net), IpAddr::V6(ip)) => {
            let mask = mask(128);
            u128::from(net) & mask == u128::from(ip) & mask
        }
        _ => false,
    }
}

/// The proxy list of the Windows Internet settings (and of WinHTTP's PAC answer): `h:p` for every scheme, or
/// `http=h:p;https=h:p;socks=h:p`; entries are separated by `;` or white space. `socks=` is SOCKS4 as in Windows, and serves
/// the schemes without a proxy of their own.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_list(text: &str, secure: bool) -> Vec<Hop> {
    let (mut every, mut http, mut https, mut socks) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for item in text.split([';', ' ', '\t', '\r', '\n']).filter(|item| !item.is_empty()) {
        match item.split_once('=') {
            Some((scheme, value)) => match scheme.trim().to_ascii_lowercase().as_str() {
                "http" => http.extend(proxy(value, "http")),
                "https" => https.extend(proxy(value, "http")),
                "socks" => socks.extend(proxy(value, "socks4")),
                _ => {}
            },
            None => every.extend(proxy(item, "http")),
        }
    }
    let own = if secure { https } else { http };
    [own, every, socks].into_iter().find(|list| !list.is_empty()).unwrap_or_else(|| vec![Hop::Direct])
}

/// The bypass list of the Windows Internet settings: `;` separated host patterns with `*`, optionally with a scheme and a
/// port; `<local>` is every name without a dot.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_bypass(text: &str, url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let with_port = url.port_or_known_default().map(|port| format!("{host}:{port}"));
    text.split([';', ',', ' ', '\t', '\r', '\n']).filter(|item| !item.is_empty()).any(|item| {
        let item = item.to_ascii_lowercase();
        if item == "<local>" {
            return matches!(url.host(), Some(url::Host::Domain(_))) && !host.contains('.');
        }
        if item.starts_with('<') {
            return false;
        }
        let pattern = match item.split_once("://") {
            Some((scheme, rest)) if scheme == url.scheme() => rest,
            Some(_) => return false,
            None => item.as_str(),
        };
        let pattern = pattern.trim_end_matches('/');
        wildcard(pattern, &host) || with_port.as_deref().is_some_and(|with_port| wildcard(pattern, with_port))
    })
}

/// `*` is any run of characters
#[cfg_attr(not(windows), allow(dead_code))]
fn wildcard(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((at, from)) = star {
            p = at + 1;
            t = from + 1;
            star = Some((at, from + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|b| *b == b'*')
}
