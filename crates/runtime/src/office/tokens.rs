use crate::sync::Locked;
use crate::failure::{Failure, Outcome};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use std::{collections::HashMap, sync::Mutex};

struct Signing;

impl Signing {
    pub fn mac(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }

    fn same(a: &str, b: &str) -> bool {
        a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    fn object(part: &str) -> Outcome<Map<String, Value>> {
        let bytes = B64.decode(part.trim_end_matches('=')).map_err(|_| Failure::token_refused("malformed token"))?;
        match serde_json::from_slice(&bytes) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(Failure::token_refused("malformed token")),
        }
    }

    fn now_ms() -> f64 {
        crate::clock::Clock::now().as_millis() as f64
    }
}

pub struct Jwt {
    secret: Vec<u8>,
}

impl Jwt {
    pub fn new(secret: &str) -> Self {
        Self { secret: secret.as_bytes().to_vec() }
    }

    fn sign_part(&self, data: &str) -> String {
        B64.encode(Signing::mac(&self.secret, data.as_bytes()))
    }

    pub fn sign(&self, claims: &Value, ttl_seconds: Option<u64>) -> String {
        let now = (Signing::now_ms() / 1000.0).floor() as u64;
        let mut body = claims.as_object().cloned().unwrap_or_default();
        body.insert("iat".into(), now.into());
        if let Some(ttl) = ttl_seconds {
            body.insert("exp".into(), (now + ttl).into());
        }
        let unsigned = format!("{}.{}", B64.encode(json!({"alg": "HS256", "typ": "JWT"}).to_string()), B64.encode(Value::Object(body).to_string()));
        format!("{unsigned}.{}", self.sign_part(&unsigned))
    }

    pub fn verify(&self, token: &str) -> Outcome<Map<String, Value>> {
        let parts: Vec<&str> = token.split('.').collect();
        let [header_part, claims_part, signature] = parts.as_slice() else { return Err(Failure::token_refused("malformed token")) };
        let (header, claims) = (Signing::object(header_part)?, Signing::object(claims_part)?);
        if header.get("alg").and_then(Value::as_str) != Some("HS256") {
            return Err(Failure::token_refused("unexpected token algorithm"));
        }
        let signed = format!("{header_part}.{claims_part}");
        if !Signing::same(&self.sign_part(&signed), signature) {
            return Err(Failure::token_refused("bad token signature"));
        }
        let now = Signing::now_ms() / 1000.0;
        if claims.get("exp").and_then(Value::as_f64).is_some_and(|exp| exp + 60.0 < now) {
            return Err(Failure::token_refused("token expired"));
        }
        if claims.get("nbf").and_then(Value::as_f64).is_some_and(|nbf| nbf - 60.0 > now) {
            return Err(Failure::token_refused("token not yet valid"));
        }
        Ok(claims)
    }

    pub fn verify_header(&self, header: Option<&str>) -> Outcome<Map<String, Value>> {
        let token = header
            .and_then(|h| {
                let (scheme, rest) = h.split_once(char::is_whitespace)?;
                let token = rest.trim_start();
                (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(char::is_whitespace)).then_some(token)
            })
            .ok_or_else(|| Failure::token_refused("missing Authorization token"))?;
        let claims = self.verify(token)?;
        match claims.get("payload") {
            Some(Value::Object(payload)) => Ok(payload.clone()),
            _ => Ok(claims),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    File,
    Callback,
}

impl TicketKind {
    fn name(&self) -> &str {
        match self {
            Self::File => "file",
            Self::Callback => "callback",
        }
    }
}

#[derive(Clone)]
pub struct Ticket {
    pub root: String,
    pub path: String,
    pub key: String,
    pub mtime_ms: i64,
    nonce: String,
    exp: f64,
}

pub struct Tickets {
    key: Vec<u8>,
    used: Mutex<HashMap<String, f64>>,
}

const FILE_TTL_MS: f64 = 10.0 * 60_000.0;
const CALLBACK_TTL_MS: f64 = 24.0 * 3_600_000.0;

impl Tickets {
    pub fn new(secret: &str) -> Self {
        Self { key: Signing::mac(secret.as_bytes(), b"agentrt-office/ticket/v1"), used: Mutex::default() }
    }

    fn sign(&self, body: &str) -> String {
        B64.encode(Signing::mac(&self.key, body.as_bytes()))
    }

    pub fn issue(&self, kind: TicketKind, root: &str, path: &str, key: &str, mtime_ms: i64) -> String {
        let ttl = if kind == TicketKind::File { FILE_TTL_MS } else { CALLBACK_TTL_MS };
        let nonce = B64.encode(rand::random::<[u8; 9]>());
        let body = json!({"root": root, "path": path, "key": key, "mtimeMs": mtime_ms, "kind": kind.name(),
            "exp": Signing::now_ms() + ttl, "nonce": nonce});
        let body = B64.encode(body.to_string());
        format!("{body}.{}", self.sign(&body))
    }

    pub fn read(&self, token: &str, kind: TicketKind) -> Outcome<Ticket> {
        let mut parts = token.split('.');
        let (Some(body), Some(signature), None) = (parts.next(), parts.next(), parts.next()) else { return Err(Failure::token_refused("bad ticket")) };
        if body.is_empty() || signature.is_empty() || !Signing::same(&self.sign(body), signature) {
            return Err(Failure::token_refused("bad ticket"));
        }
        let value = Signing::object(body).map_err(|_| Failure::token_refused("bad ticket"))?;
        if value.get("kind").and_then(Value::as_str) != Some(kind.name()) {
            return Err(Failure::token_refused("ticket is for another purpose"));
        }
        let exp = value.get("exp").and_then(Value::as_f64).ok_or_else(|| Failure::token_refused("ticket expired"))?;
        if exp < Signing::now_ms() {
            return Err(Failure::token_refused("ticket expired"));
        }
        let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        let (Some(root), Some(path), Some(key), Some(nonce), Some(mtime)) =
            (text("root"), text("path"), text("key"), text("nonce"), value.get("mtimeMs").and_then(Value::as_f64))
        else {
            return Err(Failure::token_refused("bad ticket"));
        };
        Ok(Ticket { root, path, key, mtime_ms: mtime as i64, nonce, exp })
    }

    pub fn consume(&self, token: &str) -> Outcome<Ticket> {
        let ticket = self.read(token, TicketKind::File)?;
        let now = Signing::now_ms();
        let mut used = self.used.locked();
        used.retain(|_, exp| *exp >= now);
        if used.contains_key(&ticket.nonce) {
            return Err(Failure::token_refused("ticket already used"));
        }
        used.insert(ticket.nonce.clone(), ticket.exp);
        Ok(ticket)
    }
}
