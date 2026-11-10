use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd};

use ash::vk;
use wgpu::hal::vulkan::Api as Vk;

const EXTENSIONS: [&std::ffi::CStr; 4] = [
    ash::khr::external_memory_fd::NAME,
    ash::ext::external_memory_dma_buf::NAME,
    ash::ext::image_drm_format_modifier::NAME,
    ash::khr::external_semaphore_fd::NAME,
];

const SEMAPHORES: usize = 8;

#[derive(Clone, Copy)]
pub struct Dmabuf<'f> {
    pub fd: BorrowedFd<'f>,
    pub offset: u32,
    pub stride: u32,
    pub modifier: u64,
}

#[derive(Clone, Copy)]
pub struct Fence(vk::Semaphore);

pub struct Device {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    semaphores: Vec<vk::Semaphore>,
    next: usize,
}

impl Device {
    pub fn open() -> Result<Self, String> {
        let mut errors = Vec::new();
        let (instance, adapters) = crate::adapters();
        let (adapter, device, queue) = adapters
            .into_iter()
            .find_map(|adapter| match Self::open_adapter(&adapter) {
                Ok((device, queue)) => Some((adapter, device, queue)),
                Err(e) => {
                    errors.push(format!("{}: {e}", adapter.get_info().name));
                    None
                }
            })
            .ok_or_else(|| if errors.is_empty() { crate::gpu::no_adapter(&instance) } else { errors.join("; ") })?;
        let mut device = Self { device, queue, info: adapter.get_info(), semaphores: Vec::new(), next: 0 };
        device.semaphores = device.create_semaphores();
        Ok(device)
    }

    fn open_adapter(adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue), String> {
        let limits = adapter.limits();
        let features = adapter.features() & wgpu::Features::all_webgpu_mask();
        let hal = unsafe {
            let hal_adapter = adapter.as_hal::<Vk>().ok_or("not a Vulkan adapter")?;
            let caps = hal_adapter.physical_device_capabilities();
            let missing: Vec<_> = EXTENSIONS.iter().filter(|e| !caps.supports_extension(e)).map(|e| e.to_string_lossy()).collect();
            if !missing.is_empty() {
                return Err(format!("missing Vulkan extensions {}", missing.join(", ")));
            }
            hal_adapter
                .open_with_callback(features, &limits, &wgpu::MemoryHints::MemoryUsage, Some(Box::new(|args| args.extensions.extend(EXTENSIONS))))
                .map_err(|e| format!("opening the Vulkan device: {e}"))?
        };
        let desc = wgpu::DeviceDescriptor { label: Some("acde"), required_features: features, required_limits: limits, ..Default::default() };
        unsafe { adapter.create_device_from_hal::<Vk>(hal, &desc) }.map_err(|e| format!("wgpu device: {e}"))
    }

    fn create_semaphores(&self) -> Vec<vk::Semaphore> {
        unsafe {
            let Some(hal_device) = self.device.as_hal::<Vk>() else { return Vec::new() };
            let raw = hal_device.raw_device();
            (0..SEMAPHORES)
                .map_while(|_| {
                    let mut export = vk::ExportSemaphoreCreateInfo::default().handle_types(vk::ExternalSemaphoreHandleTypeFlags::SYNC_FD);
                    raw.create_semaphore(&vk::SemaphoreCreateInfo::default().push_next(&mut export), None).ok()
                })
                .collect()
        }
    }

    pub fn arm(&mut self) -> Option<Fence> {
        let semaphore = *self.semaphores.get(self.next)?;
        let queue = unsafe { self.queue.as_hal::<Vk>() }?;
        queue.add_signal_semaphore(semaphore, None);
        self.next = (self.next + 1) % self.semaphores.len();
        Some(Fence(semaphore))
    }

    pub fn sync_file(&self, Fence(semaphore): Fence) -> Option<OwnedFd> {
        let fd = unsafe {
            let hal_device = self.device.as_hal::<Vk>()?;
            let ext = ash::khr::external_semaphore_fd::Device::new(hal_device.shared_instance().raw_instance(), hal_device.raw_device());
            let info = vk::SemaphoreGetFdInfoKHR::default().semaphore(semaphore).handle_type(vk::ExternalSemaphoreHandleTypeFlags::SYNC_FD);
            ext.get_semaphore_fd(&info).ok()?
        };
        (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
    }

    pub fn import(&self, dmabuf: Dmabuf<'_>, (width, height): (u32, u32)) -> Result<wgpu::Texture, String> {
        unsafe {
            let hal_device = self.device.as_hal::<Vk>().ok_or("not a Vulkan device")?;
            let raw = hal_device.raw_device();
            let layouts = [vk::SubresourceLayout { offset: dmabuf.offset.into(), size: 0, row_pitch: dmabuf.stride.into(), array_pitch: 0, depth_pitch: 0 }];
            let mut explicit = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::default().drm_format_modifier(dmabuf.modifier).plane_layouts(&layouts);
            let mut external = vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
            let info = vk::ImageCreateInfo::default()
                .image_type(vk::ImageType::TYPE_2D)
                .format(vk::Format::R8G8B8A8_UNORM)
                .extent(vk::Extent3D { width, height, depth: 1 })
                .mip_levels(1)
                .array_layers(1)
                .samples(vk::SampleCountFlags::TYPE_1)
                .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
                .usage(
                    vk::ImageUsageFlags::STORAGE
                        | vk::ImageUsageFlags::SAMPLED
                        | vk::ImageUsageFlags::TRANSFER_DST
                        | vk::ImageUsageFlags::TRANSFER_SRC
                        | vk::ImageUsageFlags::COLOR_ATTACHMENT,
                )
                .sharing_mode(vk::SharingMode::EXCLUSIVE)
                .initial_layout(vk::ImageLayout::UNDEFINED)
                .push_next(&mut external)
                .push_next(&mut explicit);
            let image = raw.create_image(&info, None).map_err(|e| format!("VkImage: {e}"))?;
            let requirements = raw.get_image_memory_requirements(image);
            let fd_ext = ash::khr::external_memory_fd::Device::new(hal_device.shared_instance().raw_instance(), raw);
            let mut fd_props = vk::MemoryFdPropertiesKHR::default();
            if let Err(e) = fd_ext.get_memory_fd_properties(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT, dmabuf.fd.as_raw_fd(), &mut fd_props) {
                raw.destroy_image(image, None);
                return Err(format!("dma-buf memory properties: {e}"));
            }
            let types = requirements.memory_type_bits & fd_props.memory_type_bits;
            if types == 0 {
                raw.destroy_image(image, None);
                return Err("no memory type can import this dma-buf".into());
            }
            let fd = dmabuf.fd.as_fd().try_clone_to_owned().map_err(|e| e.to_string())?;
            let mut import = vk::ImportMemoryFdInfoKHR::default().handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT).fd(fd.as_raw_fd());
            let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
            let alloc = vk::MemoryAllocateInfo::default()
                .allocation_size(requirements.size)
                .memory_type_index(types.trailing_zeros())
                .push_next(&mut import)
                .push_next(&mut dedicated);
            let memory = match raw.allocate_memory(&alloc, None) {
                Ok(memory) => {
                    let _ = fd.into_raw_fd();
                    memory
                }
                Err(e) => {
                    raw.destroy_image(image, None);
                    return Err(format!("importing the dma-buf's memory: {e}"));
                }
            };
            if let Err(e) = raw.bind_image_memory(image, memory, 0) {
                raw.free_memory(memory, None);
                raw.destroy_image(image, None);
                return Err(format!("binding the memory: {e}"));
            }
            let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
            let hal_desc = wgpu::hal::TextureDescriptor {
                label: Some("acde canvas"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUses::STORAGE_READ_WRITE
                    | wgpu::TextureUses::RESOURCE
                    | wgpu::TextureUses::COPY_DST
                    | wgpu::TextureUses::COPY_SRC
                    | wgpu::TextureUses::COLOR_TARGET,
                memory_flags: wgpu::hal::MemoryFlags::empty(),
                view_formats: vec![],
            };
            let hal_texture = hal_device.texture_from_raw(image, &hal_desc, None, wgpu::hal::vulkan::TextureMemory::Dedicated(memory));
            drop(hal_device);
            Ok(self.device.create_texture_from_hal::<Vk>(
                hal_texture,
                &wgpu::TextureDescriptor {
                    label: Some("acde canvas"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::STORAGE_BINDING
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC
                        | wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            ))
        }
    }
}
