mod compose;
#[cfg(target_os = "linux")]
mod device;
mod filter;
mod images;
mod offscreen;
#[cfg(target_os = "linux")]
mod raster;
mod scene;
mod vello_scene;

pub use compose::{Backdrop, Composer, Effect, Shadow};
#[cfg(target_os = "linux")]
pub use device::{Device, Dmabuf, Fence};
pub use filter::*;
pub use images::Images;
pub use offscreen::{GpuImage, ImageSet, Offscreen, Overrides, Shared};
#[cfg(target_os = "linux")]
pub use raster::{Content, Part, Pass, Px, Raster, Submitted};
pub use scene::*;
pub use vello_scene::VelloScene;
pub use {vello, wgpu};

pub const BACKEND: wgpu::Backends = cfg_select! {
    windows => wgpu::Backends::DX12,
    target_os = "macos" => wgpu::Backends::METAL,
    _ => wgpu::Backends::VULKAN,
};
