use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

use napi::Result;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::{blocking, failure};

#[napi(object)]
pub struct GreetUser {
    pub name: String,
    pub full_name: String,
    pub uid: u32,
}

struct Ipc {
    stream: UnixStream,
}

impl Ipc {
    fn open() -> Result<Self> {
        let path = std::env::var("GREETD_SOCK").map_err(|_| failure("greetd_unavailable", "GREETD_SOCK is not set: acde was not started by greetd"))?;
        let stream = UnixStream::connect(&path).map_err(|e| failure("greetd_unavailable", &format!("{path}: {e}")))?;
        Ok(Self { stream })
    }

    fn ask(&mut self, request: Value) -> Result<Value> {
        let io = |e: std::io::Error| failure("greetd_failed", &e.to_string());
        let body = request.to_string();
        let len = u32::try_from(body.len()).map_err(|_| failure("greetd_failed", "request too long"))?;
        self.stream.write_all(&len.to_ne_bytes()).map_err(io)?;
        self.stream.write_all(body.as_bytes()).map_err(io)?;
        let mut head = [0u8; 4];
        self.stream.read_exact(&mut head).map_err(io)?;
        let mut answer = vec![0u8; u32::from_ne_bytes(head) as usize];
        self.stream.read_exact(&mut answer).map_err(io)?;
        serde_json::from_slice(&answer).map_err(|e| failure("greetd_failed", &e.to_string()))
    }

    fn login(&mut self, user: &str, password: &str, cmd: Vec<String>, env: Vec<String>) -> Result<()> {
        let mut answer = self.ask(json!({"type": "create_session", "username": user}))?;
        let mut said: Vec<String> = Vec::new();
        let mut secret_given = false;
        loop {
            match answer["type"].as_str() {
                Some("success") => break,
                Some("auth_message") => {
                    let text = answer["auth_message"].as_str().unwrap_or_default().to_owned();
                    let response = match answer["auth_message_type"].as_str() {
                        Some("secret") | Some("visible") if !secret_given => {
                            secret_given = true;
                            json!(password)
                        }
                        Some("secret") | Some("visible") => {
                            self.cancel();
                            return Err(failure("auth_failed", if text.is_empty() { "the login asks for more than a password" } else { &text }));
                        }
                        _ => {
                            if !text.is_empty() {
                                said.push(text);
                            }
                            Value::Null
                        }
                    };
                    answer = self.ask(json!({"type": "post_auth_message_response", "response": response}))?;
                }
                _ => {
                    let description = answer["description"].as_str().unwrap_or("login refused").to_owned();
                    self.cancel();
                    let code = if answer["error_type"] == "auth_error" { "auth_failed" } else { "greetd_failed" };
                    said.push(description);
                    return Err(failure(code, &said.join(" ")));
                }
            }
        }
        let started = self.ask(json!({"type": "start_session", "cmd": cmd, "env": env}))?;
        if started["type"] != "success" {
            self.cancel();
            return Err(failure("greetd_failed", started["description"].as_str().unwrap_or("greetd did not start the session")));
        }
        Ok(())
    }

    fn cancel(&mut self) {
        _ = self.ask(json!({"type": "cancel_session"}));
    }
}

fn users(passwd: &str) -> Vec<GreetUser> {
    let mut out: Vec<GreetUser> = passwd
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(':').collect();
            let [name, _, uid, _, gecos, _, shell] = f[..] else { return None };
            let uid: u32 = uid.parse().ok()?;
            if !(1000..60000).contains(&uid) || shell.ends_with("nologin") || shell.ends_with("/false") || shell.is_empty() {
                return None;
            }
            let full = gecos.split(',').next().unwrap_or_default().trim();
            Some(GreetUser { name: name.to_owned(), full_name: if full.is_empty() { name.to_owned() } else { full.to_owned() }, uid })
        })
        .collect();
    out.sort_by_key(|u| u.uid);
    out
}

#[napi]
pub struct Greetd;

#[napi]
impl Greetd {
    #[napi]
    pub fn available() -> bool {
        std::env::var_os("GREETD_SOCK").is_some()
    }

    #[napi]
    pub fn users() -> Result<Vec<GreetUser>> {
        let passwd = std::fs::read_to_string("/etc/passwd").map_err(|e| failure("users_unreadable", &e.to_string()))?;
        Ok(users(&passwd))
    }

    #[napi]
    pub async fn login(user: String, password: String, cmd: Vec<String>, env: Vec<String>) -> Result<()> {
        blocking(move || Ipc::open()?.login(&user, &password, cmd, env)).await
    }
}

#[cfg(test)]
mod tests {
    use super::users;

    #[test]
    fn login_accounts_only() {
        let passwd = "root:x:0:0::/root:/bin/bash\n\
                      greeter:x:964:964::/var/lib/greetd:/bin/false\n\
                      bo:x:1001:1001:Bo Li,,,:/home/bo:/bin/zsh\n\
                      ann:x:1000:1000::/home/ann:/bin/bash\n\
                      svc:x:1002:1002::/srv:/usr/bin/nologin\n\
                      nobody:x:65534:65534::/:/usr/bin/nologin";
        let found: Vec<(String, String)> = users(passwd).into_iter().map(|u| (u.name, u.full_name)).collect();
        assert_eq!(found, [("ann".into(), "ann".into()), ("bo".into(), "Bo Li".into())]);
    }
}
