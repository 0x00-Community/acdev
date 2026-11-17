mod compositor;
mod gpu;

pub use detour::base::*;
#[cfg(target_os = "linux")]
pub use detour::fallback::{Device, Fence};
pub use detour::fallback::{GpuImage, ImageSet};
pub use compositor::{Compositor, Offscreen};
pub use gpu::{DeviceRequest, ErrorSink, Gpu, adapters, lock, set_error_sink, texture, webgpu_features};
pub use {detour, kurbo, peniko, wgpu};

pub const BACKEND: wgpu::Backends = cfg_select! {
    windows => wgpu::Backends::DX12,
    target_os = "macos" => wgpu::Backends::METAL,
    _ => wgpu::Backends::VULKAN,
};
