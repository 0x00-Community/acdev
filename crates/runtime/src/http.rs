use ntex::io::Io;

pub(crate) fn tls() -> Result<openssl::ssl::SslConnector, openssl::error::ErrorStack> {
    let mut ssl = openssl::ssl::SslConnector::builder(openssl::ssl::SslMethod::tls())?;
    _ = ssl.set_alpn_protos(b"\x08http/1.1");
    cfg_select! {
        target_os = "linux" => {}
        _ => {
            let store = ssl.cert_store_mut();
            for der in roots() {
                if let Ok(cert) = openssl::x509::X509::from_der(der) {
                    _ = store.add_cert(cert);
                }
            }
            #[cfg(windows)]
            ssl.set_verify_callback(openssl::ssl::SslVerifyMode::PEER, |ok, ctx| ok || system_trusts(ctx));
        }
    }
    Ok(ssl.build())
}

#[cfg(windows)]
fn system_trusts(ctx: &openssl::x509::X509StoreContextRef) -> bool {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::*;
    let ssl = openssl::x509::X509StoreContext::ssl_idx().ok().and_then(|index| ctx.ex_data(index));
    let Some(host) = ssl.and_then(|ssl| ssl.servername(openssl::ssl::NameType::HOST_NAME)) else { return false };
    let ders: Vec<Vec<u8>> = ctx.chain().into_iter().flatten().filter_map(|cert| cert.to_der().ok()).collect();
    let Some((leaf, rest)) = ders.split_first() else { return false };
    let mut name: Vec<u16> = host.encode_utf16().chain(Some(0)).collect();
    let mut usage = [szOID_PKIX_KP_SERVER_AUTH as *mut u8];
    let para = CERT_CHAIN_PARA {
        cbSize: size_of::<CERT_CHAIN_PARA>() as u32,
        RequestedUsage: CERT_USAGE_MATCH { dwType: USAGE_MATCH_TYPE_AND, Usage: CTL_USAGE { cUsageIdentifier: 1, rgpszUsageIdentifier: usage.as_mut_ptr() } },
        ..Default::default()
    };
    let mut server = HTTPSPolicyCallbackData {
        Anonymous: HTTPSPolicyCallbackData_0 { cbSize: size_of::<HTTPSPolicyCallbackData>() as u32 },
        dwAuthType: AUTHTYPE_SERVER,
        fdwChecks: 0,
        pwszServerName: name.as_mut_ptr(),
    };
    let policy = CERT_CHAIN_POLICY_PARA { cbSize: size_of::<CERT_CHAIN_POLICY_PARA>() as u32, dwFlags: 0, pvExtraPolicyPara: (&raw mut server).cast() };
    let mut status = CERT_CHAIN_POLICY_STATUS { cbSize: size_of::<CERT_CHAIN_POLICY_STATUS>() as u32, ..Default::default() };
    let store = unsafe { CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, 0, null()) };
    if store.is_null() {
        return false;
    }
    for der in rest {
        unsafe { CertAddEncodedCertificateToStore(store, X509_ASN_ENCODING, der.as_ptr(), der.len() as u32, CERT_STORE_ADD_ALWAYS, null_mut()) };
    }
    let cert = unsafe { CertCreateCertificateContext(X509_ASN_ENCODING, leaf.as_ptr(), leaf.len() as u32) };
    let mut trusted = false;
    if !cert.is_null() {
        let mut chain = null_mut();
        if unsafe { CertGetCertificateChain(null_mut(), cert, null(), store, &para, 0, null(), &mut chain) } != 0 {
            trusted = unsafe { CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_SSL, chain, &policy, &mut status) } != 0 && status.dwError == 0;
            unsafe { CertFreeCertificateChain(chain) };
        }
        unsafe { CertFreeCertificateContext(cert) };
    }
    unsafe { CertCloseStore(store, 0) };
    if trusted {
        log::debug!("TLS: Windows verified {host}, whose root was not among the roots read at startup");
    }
    trusted
}

#[cfg(not(target_os = "linux"))]
fn roots() -> &'static [Vec<u8>] {
    static ROOTS: std::sync::OnceLock<Vec<Vec<u8>>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| {
        let found = rustls_native_certs::load_native_certs();
        for error in &found.errors {
            log::warn!("TLS: reading the system's root certificates: {error}");
        }
        if found.certs.is_empty() {
            log::error!("TLS: the system has no root certificates, so no HTTPS server can be verified");
        }
        found.certs.iter().map(|cert| cert.as_ref().to_vec()).collect()
    })
}

pub(crate) fn tls_config() -> ntex::tls::TlsConfig {
    ntex::tls::TlsConfig::new().set_handshake_timeout(ntex::time::Seconds(30))
}

pub(crate) fn client() -> ntex::client::Client {
    thread_local! {
        static CLIENT: ntex::client::Client = ntex::client::Client::builder().openssl(tls().expect("acde runtime: OpenSSL")).build(ntex::SharedCfg::new("acde-http").add(tls_config()));
    }
    CLIENT.with(Clone::clone)
}

#[cfg(target_os = "linux")]
pub(crate) async fn take(io: &Io, raw: &mut Vec<u8>) -> std::io::Result<bool> {
    loop {
        let moved = io.with_read_dst(|buf| {
            raw.extend_from_slice(buf);
            let moved = buf.len();
            buf.clear();
            moved
        });
        if moved > 0 {
            return Ok(true);
        }
        if io.read_more().await?.is_none() {
            return Ok(false);
        }
    }
}

#[derive(Default)]
pub(crate) struct Messages {
    partial: Option<(bool, Vec<u8>)>,
}

pub(crate) enum Incoming {
    Text(String),
    Binary(Vec<u8>),
    Ping(ntex::util::Bytes),
    Close(Option<ntex::ws::CloseReason>),
    Nothing,
}

impl Messages {
    pub(crate) const FRAME: usize = 16 << 20;
    const MESSAGE: usize = 64 << 20;

    pub(crate) async fn next<F>(&mut self, io: &Io<F>, codec: &ntex::ws::Codec) -> Result<Option<Incoming>, String> {
        use ntex::ws::{Frame, Item};
        let frame = loop {
            if let Some(frame) = io.decode(codec).map_err(|e| e.to_string())? {
                break frame;
            }
            if io.read_more().await.map_err(|e| e.to_string())?.is_none() {
                return Ok(None);
            }
        };
        let (text, data) = match frame {
            Frame::Text(data) => (true, data.to_vec()),
            Frame::Binary(data) => (false, data.to_vec()),
            Frame::Ping(data) => return Ok(Some(Incoming::Ping(data))),
            Frame::Pong(_) => return Ok(Some(Incoming::Nothing)),
            Frame::Close(reason) => return Ok(Some(Incoming::Close(reason))),
            Frame::Continuation(Item::FirstText(data)) => {
                self.partial = Some((true, data.to_vec()));
                return Ok(Some(Incoming::Nothing));
            }
            Frame::Continuation(Item::FirstBinary(data)) => {
                self.partial = Some((false, data.to_vec()));
                return Ok(Some(Incoming::Nothing));
            }
            Frame::Continuation(Item::Continue(data)) => {
                self.join(&data)?;
                return Ok(Some(Incoming::Nothing));
            }
            Frame::Continuation(Item::Last(data)) => {
                self.join(&data)?;
                self.partial.take().ok_or("a continuation without a first frame")?
            }
        };
        Ok(Some(if text {
            Incoming::Text(String::from_utf8(data).map_err(|_| "a text message that is not UTF-8".to_owned())?)
        } else {
            Incoming::Binary(data)
        }))
    }

    fn join(&mut self, data: &[u8]) -> Result<(), String> {
        let (_, joined) = self.partial.as_mut().ok_or("a continuation without a first frame")?;
        joined.extend_from_slice(data);
        if joined.len() > Self::MESSAGE {
            return Err("the message is too big".into());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod frames {
    use std::io::Read;

    pub(crate) fn write(fin: bool, opcode: u8, payload: &[u8], mask: bool) -> Vec<u8> {
        let mut frame = vec![if fin { 0x80 } else { 0 } | opcode];
        let bit = if mask { 0x80 } else { 0 };
        match payload.len() {
            n if n < 126 => frame.push(bit | n as u8),
            n if n <= 0xffff => {
                frame.push(bit | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(bit | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        if mask {
            let key = [0x12, 0x34, 0x56, 0x78];
            frame.extend_from_slice(&key);
            frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
        } else {
            frame.extend_from_slice(payload);
        }
        frame
    }

    pub(crate) fn read(reader: &mut impl Read, masked: bool) -> (bool, u8, Vec<u8>) {
        let mut head = [0u8; 2];
        reader.read_exact(&mut head).expect("frame head");
        assert_eq!(head[1] & 0x80 != 0, masked, "masking");
        let length = match head[1] & 0x7f {
            126 => {
                let mut n = [0u8; 2];
                reader.read_exact(&mut n).expect("length");
                u16::from_be_bytes(n) as usize
            }
            127 => {
                let mut n = [0u8; 8];
                reader.read_exact(&mut n).expect("length");
                u64::from_be_bytes(n) as usize
            }
            n => n as usize,
        };
        let mut key = [0u8; 4];
        if masked {
            reader.read_exact(&mut key).expect("mask");
        }
        let mut payload = vec![0u8; length];
        reader.read_exact(&mut payload).expect("payload");
        payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= key[i % 4]);
        (head[0] & 0x80 != 0, head[0] & 0x0f, payload)
    }
}
