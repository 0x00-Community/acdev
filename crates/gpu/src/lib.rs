mod compose;
mod compositor;
#[cfg(target_os = "linux")]
mod device;
mod filter;
mod gpu;
mod image;
mod part;
mod scene;

pub use compose::{Backdrop, Effect, Px, Shadow, reach};
pub use compositor::{Compositor, Offscreen};
#[cfg(target_os = "linux")]
pub use device::{Device, Dmabuf, Fence};
pub use filter::*;
pub use gpu::{DeviceRequest, ErrorSink, Gpu, adapters, lock, set_error_sink, texture, webgpu_features};
pub use image::{GpuImage, ImageSet, image_data};
pub use part::{Content, Part, Pass, Submitted};
pub use scene::*;
pub use {kurbo, peniko, wgpu};

pub const BACKEND: wgpu::Backends = cfg_select! {
    windows => wgpu::Backends::DX12,
    target_os = "macos" => wgpu::Backends::METAL,
    _ => wgpu::Backends::VULKAN,
};
