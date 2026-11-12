mod compose;
#[cfg(target_os = "linux")]
mod device;
mod filter;
mod gpu;
mod offscreen;
#[cfg(target_os = "linux")]
mod raster;
mod scene;
mod vello_scene;

pub use compose::{Backdrop, Composer, Effect, Op, Px, Shadow, reach};
#[cfg(target_os = "linux")]
pub use device::{Device, Dmabuf, Fence};
pub use filter::*;
pub use gpu::{DeviceRequest, ErrorSink, Gpu, adapters, set_error_sink, texture, webgpu_features};
pub use offscreen::{GpuImage, ImageSet, Offscreen, Overrides};
#[cfg(target_os = "linux")]
pub use raster::{Content, Part, Pass, Raster, Submitted};
pub use scene::*;
pub use vello_scene::Vello;
pub use {vello, wgpu};

pub const BACKEND: wgpu::Backends = cfg_select! {
    windows => wgpu::Backends::DX12,
    target_os = "macos" => wgpu::Backends::METAL,
    _ => wgpu::Backends::VULKAN,
};
