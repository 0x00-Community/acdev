use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Weak};

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request, Url};

use crate::Resource;

type Done = Box<dyn FnOnce(Option<Vec<u8>>, bool) + Send>;

pub struct Load {
    pub url: String,
    pub destination: &'static str,
    pub cors: &'static str,
    pub served: bool,
    done: Option<Done>,
}

impl Load {
    pub fn finish(mut self, bytes: Option<Vec<u8>>) {
        if let Some(done) = self.done.take() {
            done(bytes, false);
        }
    }

    pub fn finish_opaque(mut self, bytes: Vec<u8>) {
        if let Some(done) = self.done.take() {
            done(Some(bytes), true);
        }
    }
}

impl Drop for Load {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            done(None, false);
        }
    }
}

#[derive(Clone)]
pub struct Loader(Arc<dyn Fn(Load) + Send + Sync>);

impl Loader {
    pub fn new(load: impl Fn(Load) + Send + Sync + 'static) -> Self {
        Self(Arc::new(load))
    }
}

impl std::fmt::Debug for Loader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Loader")
    }
}

pub(crate) struct LocalNet {
    pub(crate) base: Url,
    pub(crate) resources: Vec<Resource>,
    pub(crate) arrived: Arc<AtomicBool>,
    loader: Option<Loader>,
    wake: Weak<Sender<()>>,
}

impl LocalNet {
    pub(crate) fn new(base: Url, resources: &[Resource], arrived: Arc<AtomicBool>, loader: Option<Loader>, wake: Weak<Sender<()>>) -> Self {
        let mut resources = resources.to_vec();
        resources.sort_by_key(|r| std::cmp::Reverse(r.prefix.len()));
        Self { base, resources, arrived, loader, wake }
    }

    fn path(&self, url: &Url) -> Option<PathBuf> {
        if url.scheme() == "file" {
            return url.to_file_path().ok();
        }
        if url.origin() != self.base.origin() {
            return None;
        }
        let path = url.path();
        let (resource, rest) = self.resources.iter().find_map(|r| Some((r, path.strip_prefix(r.prefix.as_str())?)))?;
        let rest = Path::new(rest.trim_start_matches('/'));
        if !rest.components().all(|c| matches!(c, Component::Normal(_))) {
            return None;
        }
        resource.dirs.iter().map(|d| Path::new(d).join(rest)).find(|p| p.is_file())
    }
}

impl NetProvider for LocalNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url;
        let bytes = match url.scheme() {
            "data" => data_url::DataUrl::process(url.as_str()).ok().and_then(|d| d.decode_to_vec().ok()).map(|(bytes, _)| bytes),
            _ => self.path(&url).and_then(|p| std::fs::read(p).ok()),
        };
        if let (None, Some(loader)) = (&bytes, &self.loader)
            && matches!(url.scheme(), "http" | "https" | "blob")
        {
            let (arrived, wake, resolved) = (self.arrived.clone(), self.wake.clone(), url.to_string());
            let (destination, cors) = (handler.destination(), handler.cors());
            let mut handler = handler;
            let done: Done = Box::new(move |bytes, opaque| {
                if opaque {
                    handler.opaque();
                }
                match bytes {
                    Some(bytes) => handler.bytes(resolved, Bytes::from(bytes)),
                    None => handler.failed(resolved),
                }
                arrived.store(true, Ordering::Release);
                if let Some(wake) = wake.upgrade() {
                    _ = wake.send(());
                }
            });
            return (loader.0)(Load { url: url.to_string(), destination, cors, served: false, done: Some(done) });
        }
        if let (Some(_), Some(loader)) = (&bytes, &self.loader)
            && matches!(url.scheme(), "http" | "https")
        {
            (loader.0)(Load { url: url.to_string(), destination: handler.destination(), cors: handler.cors(), served: true, done: None });
        }
        self.arrived.store(true, Ordering::Release);
        match bytes {
            Some(bytes) => handler.bytes(url.to_string(), Bytes::from(bytes)),
            None => {
                log::warn!("not loaded: {url}");
                handler.failed(url.to_string());
            }
        }
    }
}
