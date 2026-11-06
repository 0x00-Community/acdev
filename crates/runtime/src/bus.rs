use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use napi::bindgen_prelude::Unknown;
use napi::{Env, Result};
use napi_derive::napi;
use serde_json::{Value, json};
use zbus::blocking::{Connection, Proxy, connection};
use zbus::fdo::{RequestNameFlags, RequestNameReply};

use crate::js::JsFn;
use crate::{blocking, failure};

pub const FILE_MANAGER: &str = "org.freedesktop.FileManager1";
const FILE_MANAGER_PATH: &str = "/org/freedesktop/FileManager1";
pub const ACDE: &str = "org.dopame.Acde";
const ACDE_PATH: &str = "/org/dopame/Acde";
const ACDE_INTERFACE: &str = "org.dopame.Acde1";

type Answer = Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send>>;
type Handler = Arc<dyn Fn(Value) -> Answer + Send + Sync>;

async fn ask(handler: &Handler, kind: &str, uris: Vec<String>, app: &str) -> zbus::fdo::Result<()> {
    if uris.is_empty() {
        return Err(zbus::fdo::Error::InvalidArgs("no URIs".into()));
    }
    handler(json!({"kind": kind, "uris": uris, "app": app})).await.map_err(zbus::fdo::Error::Failed)
}

struct FileManager {
    handler: Handler,
}

#[zbus::interface(name = "org.freedesktop.FileManager1")]
impl FileManager {
    async fn show_folders(&self, uris: Vec<String>, _startup_id: String) -> zbus::fdo::Result<()> {
        ask(&self.handler, "folders", uris, "").await
    }

    async fn show_items(&self, uris: Vec<String>, _startup_id: String) -> zbus::fdo::Result<()> {
        ask(&self.handler, "items", uris, "").await
    }

    async fn show_item_properties(&self, uris: Vec<String>, _startup_id: String) -> zbus::fdo::Result<()> {
        ask(&self.handler, "properties", uris, "").await
    }
}

struct Opener {
    handler: Handler,
}

#[zbus::interface(name = "org.dopame.Acde1")]
impl Opener {
    async fn open(&self, uris: Vec<String>, app: String) -> zbus::fdo::Result<()> {
        ask(&self.handler, "open", uris, &app).await
    }
}

#[napi]
pub struct DesktopBus {
    connection: Connection,
    owned: Vec<String>,
}

impl DesktopBus {
    fn serve(connection: connection::Builder<'_>, handler: Handler) -> zbus::Result<Self> {
        let connection = connection.serve_at(FILE_MANAGER_PATH, FileManager { handler: handler.clone() })?.serve_at(ACDE_PATH, Opener { handler })?.build()?;
        let mut owned = Vec::new();
        for name in [FILE_MANAGER, ACDE] {
            let flags = RequestNameFlags::ReplaceExisting | RequestNameFlags::AllowReplacement | RequestNameFlags::DoNotQueue;
            if connection.request_name_with_flags(name, flags)? == RequestNameReply::PrimaryOwner {
                owned.push(name.to_owned());
            }
        }
        Ok(Self { connection, owned })
    }

    fn send_on(connection: &Connection, uris: &[String], app: &str) -> zbus::Result<()> {
        Proxy::new(connection, ACDE, ACDE_PATH, ACDE_INTERFACE)?.call::<_, _, ()>("Open", &(uris, app))
    }
}

#[napi]
impl DesktopBus {
    #[napi(factory, ts_args_type = "handler: (request: { kind: 'folders' | 'items' | 'properties' | 'open'; uris: string[]; app: string }) => unknown")]
    pub fn open(env: Env, handler: Unknown<'_>) -> Result<Self> {
        let sink: Arc<JsFn<Value>> = Arc::new(JsFn::new(&env, handler)?);
        let handler: Handler = Arc::new(move |request| {
            let sink = sink.clone();
            Box::pin(async move { sink.ask(request).await.map(drop) })
        });
        let builder = connection::Builder::session().map_err(|e| failure("bus_unavailable", &e.to_string()))?;
        Self::serve(builder, handler).map_err(|e| failure("bus_unavailable", &e.to_string()))
    }

    #[napi(getter)]
    pub fn names(&self) -> Vec<String> {
        self.owned.clone()
    }

    #[napi]
    pub fn close(&self) {
        for name in &self.owned {
            _ = self.connection.release_name(name.as_str());
        }
    }

    #[napi]
    pub async fn send(uris: Vec<String>, app: Option<String>) -> Result<()> {
        blocking(move || {
            let connection = Connection::session().map_err(|e| failure("bus_unavailable", &e.to_string()))?;
            Self::send_on(&connection, &uris, app.as_deref().unwrap_or("")).map_err(|e| match e {
                zbus::Error::MethodError(name, message, _)
                    if name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown" || name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" =>
                {
                    failure("no_session", &message.unwrap_or_else(|| "no acde session on this bus".into()))
                }
                zbus::Error::MethodError(_, Some(message), _) => failure("open_failed", &message),
                other => failure("open_failed", &other.to_string()),
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private_bus;
    use std::sync::Mutex;

    #[test]
    fn calls_reach_the_handler_and_its_errors_the_caller() {
        let Some((mut daemon, address, dir)) = private_bus("bus") else {
            eprintln!("no dbus-daemon: skipped");
            return;
        };
        let builder = || connection::Builder::address(address.as_str()).unwrap();
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let record = seen.clone();
        let handler: Handler = Arc::new(move |request| {
            let refuse = request["uris"][0] == "file:///refused";
            record.lock().unwrap().push(request);
            Box::pin(async move { if refuse { Err("not inside any workspace".to_string()) } else { Ok(()) } })
        });
        let desktop = DesktopBus::serve(builder(), handler).unwrap();
        assert_eq!(desktop.owned, [FILE_MANAGER, ACDE]);
        let caller = builder().build().unwrap();
        let files = Proxy::new(&caller, FILE_MANAGER, FILE_MANAGER_PATH, FILE_MANAGER).unwrap();
        files.call::<_, _, ()>("ShowItems", &(vec!["file:///home/u/a%20b.txt"], "")).unwrap();
        files.call::<_, _, ()>("ShowFolders", &(vec!["file:///home/u"], "token")).unwrap();
        DesktopBus::send_on(&caller, &["/home/u/c.md".into()], "editor").unwrap();
        let refused = DesktopBus::send_on(&caller, &["file:///refused".into()], "");
        assert!(matches!(refused, Err(zbus::Error::MethodError(_, Some(ref m), _)) if m == "not inside any workspace"), "{refused:?}");
        let empty = files.call::<_, _, ()>("ShowFolders", &(Vec::<String>::new(), ""));
        assert!(empty.is_err());
        let seen = seen.lock().unwrap();
        assert_eq!(
            *seen,
            [
                json!({"kind": "items", "uris": ["file:///home/u/a%20b.txt"], "app": ""}),
                json!({"kind": "folders", "uris": ["file:///home/u"], "app": ""}),
                json!({"kind": "open", "uris": ["/home/u/c.md"], "app": "editor"}),
                json!({"kind": "open", "uris": ["file:///refused"], "app": ""}),
            ]
        );
        let other = DesktopBus::serve(builder(), Arc::new(|_| Box::pin(async { Ok(()) }))).unwrap();
        assert_eq!(other.owned, [FILE_MANAGER, ACDE]);
        _ = daemon.kill();
        _ = daemon.wait();
        _ = std::fs::remove_dir_all(dir);
    }
}
