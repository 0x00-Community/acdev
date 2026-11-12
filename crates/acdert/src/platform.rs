use std::sync::Arc;

use acde_model::{Event, OpenRequest, SaveRequest, Waker};
use acde_render::{RenderHandle, SurfaceCommand};

pub trait Window {
    fn window(&self) -> u32;
    fn content_offset(&self) -> (f64, f64);
    fn pump(&self) -> Vec<Event>;
    fn has_events(&self) -> bool;
    fn set_waker(&self, waker: Option<Waker>);
    fn send(&self, command: SurfaceCommand);

    fn minimizable(&self) -> bool {
        true
    }

    fn host_controls(&self) -> bool {
        false
    }

    fn size(&self) -> Option<(u32, u32, f64)> {
        None
    }

    fn hosted(&self) -> bool {
        false
    }
}

pub trait Platform: Send + Sync {
    fn claim(&self, token: u64, render: RenderHandle, frame: u32, app: Option<String>) -> Result<Box<dyn Window>, String>;

    fn exports<'s>(&self, scope: &mut v8::PinScope<'s, '_>, napi: v8::Local<'s, v8::Value>) -> v8::Local<'s, v8::Value> {
        let _ = scope;
        napi
    }

    fn content_type(&self, extension: &str) -> Option<String> {
        let _ = extension;
        None
    }

    fn choose_folder(&self, title: &str) -> Result<Option<String>, String> {
        Portal.choose_folder(title)
    }

    fn open_files(&self, request: OpenRequest) -> Result<Option<Vec<String>>, String> {
        Portal.open_files(request)
    }

    fn save_file(&self, request: SaveRequest) -> Result<Option<String>, String> {
        Portal.save_file(request)
    }
}

pub type Shared = Arc<dyn Platform>;

pub struct Portal;

impl Portal {
    #[cfg(target_os = "linux")]
    fn filters(filters: &[acde_model::FileFilter]) -> Vec<acde_runtime::PortalFilter> {
        filters.iter().map(|f| acde_runtime::PortalFilter { name: f.name.clone(), globs: f.globs.clone(), mimes: f.mimes.clone() }).collect()
    }

    pub fn choose_folder(&self, title: &str) -> Result<Option<String>, String> {
        cfg_select! {
            target_os = "linux" => acde_runtime::choose_folder(title),
            _ => Err(format!("choose folder {title:?}: no chooser here")),
        }
    }

    pub fn open_files(&self, request: OpenRequest) -> Result<Option<Vec<String>>, String> {
        cfg_select! {
            target_os = "linux" => acde_runtime::open_files(&request.title, request.multiple, request.directory, &Self::filters(&request.filters)),
            _ => Err(format!("open {:?}: no chooser here", request.title)),
        }
    }

    pub fn save_file(&self, request: SaveRequest) -> Result<Option<String>, String> {
        cfg_select! {
            target_os = "linux" => acde_runtime::save_file(&request.title, &request.name, &Self::filters(&request.filters)),
            _ => Err(format!("save {:?}: no chooser here", request.title)),
        }
    }
}

pub struct Headless;

impl Platform for Headless {
    fn claim(&self, _: u64, _: RenderHandle, _: u32, _: Option<String>) -> Result<Box<dyn Window>, String> {
        Err("claimSurface: no windows here".into())
    }
}
