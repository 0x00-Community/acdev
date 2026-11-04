//! acde: the certificate and key are read with openssl and the acceptor is OpenSSL's (ntex-tls's filter wraps it),
//! instead of rustls-pemfile and rustls.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex;

use anyhow::Context as _;
use openssl::pkey::{PKey, Private};
use openssl::ssl::{SslAcceptor, SslMethod};
use openssl::x509::X509;

pub struct TlsIdentityCtx {
    /// The server certificate first, then the rest of its chain.
    pub certs: Vec<X509>,
    pub priv_key: PKey<Private>,
    pub pub_key: Vec<u8>,
}

impl TlsIdentityCtx {
    /// A constructor to create a `TlsIdentityCtx` from the given certificate and key paths.
    ///
    /// acde: each file can be PEM or DER, whatever its name (upstream went by the `.pem` extension); the key
    /// can be PKCS#8, PKCS#1 (RSA) or SEC1 (EC).
    pub fn init_from_paths(cert_path: &Path, key_path: &Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(cert_path).with_context(|| format!("reading server cert `{cert_path:?}`"))?;
        let certs = match X509::stack_from_pem(&bytes) {
            Ok(certs) if !certs.is_empty() => certs,
            _ => vec![X509::from_der(&bytes).with_context(|| format!("collecting server cert `{cert_path:?}`"))?],
        };

        let bytes = std::fs::read(key_path).with_context(|| format!("reading server key `{key_path:?}`"))?;
        let priv_key = PKey::private_key_from_pem(&bytes)
            .or_else(|_| PKey::private_key_from_der(&bytes))
            .with_context(|| format!("reading server key `{key_path:?}`"))?;

        let pub_key = {
            use x509_cert::der::Decode as _;

            let cert = certs.first().ok_or_else(|| std::io::Error::other("invalid cert"))?;
            let der = cert.to_der().context("encoding server cert")?;
            let cert = x509_cert::Certificate::from_der(&der).map_err(std::io::Error::other)?;
            cert.tbs_certificate
                .subject_public_key_info
                .subject_public_key
                .as_bytes()
                .ok_or_else(|| std::io::Error::other("subject public key BIT STRING is not aligned"))?
                .to_owned()
        };

        Ok(Self {
            certs,
            priv_key,
            pub_key,
        })
    }

    /// acde: Mozilla's "intermediate" settings (TLS 1.2 and 1.3, as rustls offered).
    pub fn make_acceptor(&self) -> anyhow::Result<SslAcceptor> {
        let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls_server()).context("TLS context")?;
        let (cert, chain) = self.certs.split_first().context("no certificate")?;
        builder.set_certificate(cert).context("bad certificate/key")?;
        for cert in chain {
            builder
                .add_extra_chain_cert(cert.clone())
                .context("bad certificate chain")?;
        }
        builder.set_private_key(&self.priv_key).context("bad certificate/key")?;
        builder.check_private_key().context("bad certificate/key")?;

        // This adds support for the SSLKEYLOGFILE env variable (https://wiki.wireshark.org/TLS#using-the-pre-master-secret)
        if let Some(path) = std::env::var_os("SSLKEYLOGFILE") {
            match OpenOptions::new().append(true).create(true).open(&path) {
                Ok(file) => {
                    let file = Mutex::new(file);
                    builder.set_keylog_callback(move |_, line| {
                        if let Ok(mut file) = file.lock() {
                            let _ = writeln!(file, "{line}");
                        }
                    });
                }
                Err(error) => tracing::warn!(%error, "Cannot open SSLKEYLOGFILE"),
            }
        }

        Ok(builder.build())
    }
}
