#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;
#[cfg(target_os = "linux")]
use std::time::Duration;

use crate::{Backdrop, Effect, Px, Scene, Shadow};

pub trait Content {
    fn scene_for(&self, region: Px) -> Scene;
}

pub struct Part<C> {
    pub content: C,
    pub backdrop: Option<Backdrop>,
    pub shadows: Vec<Shadow>,
    pub effect: Effect,
    pub bounds: Option<Px>,
}

impl<C> Part<C> {
    pub fn plain(content: C, bounds: Option<Px>) -> Self {
        Self { content, backdrop: None, shadows: Vec::new(), effect: Effect::default(), bounds }
    }
}

pub struct Pass<C> {
    pub plane: usize,
    pub size: (u32, u32),
    pub parts: Vec<Part<C>>,
    pub next: usize,
    pub targets: Option<Vec<Px>>,
}

#[cfg(target_os = "linux")]
pub struct Submitted {
    pub fence: Option<OwnedFd>,
    pub waited: Duration,
    pub recorded: Duration,
}
