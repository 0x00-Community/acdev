use std::os::fd::{AsFd, AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::sync::mpsc;

use acde_render::anyrender::PaintScene;
use acde_render::anyrender_vello::VelloScenePainter;
use acde_render::anyrender_vello::wgpu;
use ash::vk;
use smithay::backend::allocator::Buffer;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::reexports::calloop::ping::Ping;
use smithay::reexports::rustix;
use vello::kurbo::Affine;
use vello::peniko::Color;
use wgpu::hal::vulkan::Api as Vk;

use acde_render::gpu::Overrides;

use crate::compose::Composer;
use crate::gpu::Gpu;
use crate::plane::{Part, Pixels, Rect};

const EXTENSIONS: [&std::ffi::CStr; 4] = [
    ash::khr::external_memory_fd::NAME,
    ash::ext::external_memory_dma_buf::NAME,
    ash::ext::image_drm_format_modifier::NAME,
    ash::khr::external_semaphore_fd::NAME,
];

const SEMAPHORES: usize = 8;
const IDLE_TRIM: std::time::Duration = std::time::Duration::from_secs(2);

pub enum Job {
    Canvases(usize, Vec<Dmabuf>, (u32, u32)),
    Draw(Vec<Pass>),
    Release(usize),
    Icon { dmabuf: Dmabuf, size: (u32, u32), scene: acde_render::anyrender::Scene, reply: mpsc::Sender<Result<(), String>> },
}

pub struct Pass {
    pub plane: usize,
    pub size: (u32, u32),
    pub parts: Vec<Part>,
    pub next: usize,
    pub targets: Option<Vec<Rect>>,
}

pub type Ready = std::sync::Arc<std::sync::OnceLock<bool>>;

pub type Done = Result<Option<OwnedFd>, String>;

pub struct Raster {
    device: wgpu::Device,
    queue: wgpu::Queue,
    vello: vello::Renderer,
    scene: vello::Scene,
    canvases: std::collections::HashMap<usize, Vec<Option<(wgpu::Texture, wgpu::TextureView)>>>,
    semaphores: Vec<vk::Semaphore>,
    next_semaphore: usize,
    submits: std::collections::VecDeque<(wgpu::SubmissionIndex, Option<OwnedFd>)>,
    composer: Composer,
    gpu: Option<std::sync::Arc<Gpu>>,
    overrides: Overrides,
    poll: bool,
}

impl Raster {
    pub fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let mut adapters: Vec<_> = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN))
            .into_iter()
            .filter(|a| a.get_info().device_type != wgpu::DeviceType::Cpu)
            .collect();
        adapters.sort_by_key(|a| match a.get_info().device_type {
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => 0,
            _ => 1,
        });
        let mut errors = Vec::new();
        let (adapter, device, queue) = adapters
            .into_iter()
            .find_map(|adapter| match Self::open(&adapter) {
                Ok((device, queue)) => Some((adapter, device, queue)),
                Err(e) => {
                    errors.push(format!("{}: {e}", adapter.get_info().name));
                    None
                }
            })
            .ok_or_else(|| if errors.is_empty() { "没有 GPU (Vulkan)".to_string() } else { errors.join("; ") })?;
        log::info!("网页图层用 {} ({:?})", adapter.get_info().name, adapter.get_info().device_type);
        let vello = vello::Renderer::new(
            &device,
            vello::RendererOptions { use_cpu: false, antialiasing_support: vello::AaSupport::area_only(), num_init_threads: None, pipeline_cache: None },
        )
        .map_err(|e| format!("vello: {e}"))?;
        let composer = Composer::new(&device, &queue);
        let mut raster = Self {
            device,
            queue,
            vello,
            scene: vello::Scene::new(),
            canvases: Default::default(),
            semaphores: Vec::new(),
            next_semaphore: 0,
            submits: Default::default(),
            composer,
            gpu: None,
            overrides: Overrides::default(),
            poll: std::env::var_os("ACDE_WEB_POLL").is_some(),
        };
        raster.semaphores = raster.create_semaphores();
        raster.warm_up();
        raster.gpu = Gpu::publish(Some((raster.device.clone(), raster.queue.clone(), adapter.get_info())));
        Ok(raster)
    }

    pub fn spawn(jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>, ready: Ready, waker: Ping) -> std::io::Result<()> {
        acde_render::gpu::expect();
        std::thread::Builder::new().name("acde-web".into()).spawn(move || {
            let mut raster = match Self::new() {
                Ok(raster) => raster,
                Err(e) => {
                    log::error!("网页图层不可用: {e}");
                    Gpu::publish(None);
                    let _ = ready.set(false);
                    waker.ping();
                    return;
                }
            };
            let _ = ready.set(true);
            waker.ping();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raster.run(waker, jobs, done))).is_err() {
                log::error!("网页图层的光栅化线程 panic, 退出这个 web 进程");
                acde_log::flush();
                std::process::exit(101);
            }
        })?;
        Ok(())
    }

    fn run(&mut self, waker: Ping, jobs: mpsc::Receiver<Job>, done: mpsc::Sender<Done>) {
        loop {
            let job = match jobs.recv_timeout(IDLE_TRIM) {
                Ok(job) => job,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.composer.trim();
                    match jobs.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            match job {
                Job::Canvases(plane, dmabufs, size) => {
                    let canvases = dmabufs
                        .iter()
                        .map(|d| {
                            let t = self.import_vulkan(d, size).inspect_err(|e| log::warn!("网页画布导入 Vulkan: {e}")).ok()?;
                            let view = t.create_view(&wgpu::TextureViewDescriptor::default());
                            Some((t, view))
                        })
                        .collect();
                    self.canvases.insert(plane, canvases);
                }
                Job::Release(plane) => {
                    self.canvases.remove(&plane);
                }
                Job::Icon { dmabuf, size, scene, reply } => {
                    let _ = reply.send(self.icon(&dmabuf, size, scene));
                }
                Job::Draw(passes) => {
                    let result = self.draw(passes);
                    if done.send(result).is_err() {
                        break;
                    }
                    waker.ping();
                }
            }
        }
    }

    fn open(adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue), String> {
        let limits = adapter.limits();
        let features = adapter.features() & wgpu::Features::all_webgpu_mask();
        let hal = unsafe {
            let hal_adapter = adapter.as_hal::<Vk>().ok_or("不是 Vulkan adapter")?;
            let caps = hal_adapter.physical_device_capabilities();
            let missing: Vec<_> = EXTENSIONS.iter().filter(|e| !caps.supports_extension(e)).map(|e| e.to_string_lossy()).collect();
            if !missing.is_empty() {
                return Err(format!("缺 Vulkan 扩展 {}", missing.join(", ")));
            }
            hal_adapter
                .open_with_callback(
                    features,
                    &limits,
                    &wgpu::MemoryHints::MemoryUsage,
                    Some(Box::new(|args| args.extensions.extend(EXTENSIONS))),
                )
                .map_err(|e| format!("打开 Vulkan 设备: {e}"))?
        };
        let desc = wgpu::DeviceDescriptor { label: Some("acde web"), required_features: features, required_limits: limits, ..Default::default() };
        unsafe { adapter.create_device_from_hal::<Vk>(hal, &desc) }.map_err(|e| format!("wgpu 设备: {e}"))
    }

    fn draw(&mut self, passes: Vec<Pass>) -> Done {
        let started = std::time::Instant::now();
        let count = passes.len();
        let oldest = if self.submits.len() > 1 { self.submits.pop_front() } else { None };
        let poll = match oldest {
            Some((_, Some(fence))) => {
                let mut fds = [rustix::event::PollFd::new(&fence, rustix::event::PollFlags::IN)];
                if let Err(e) = rustix::event::poll(&mut fds, Some(&rustix::event::Timespec { tv_sec: 1, tv_nsec: 0 })) {
                    log::warn!("等上一帧网页: {e}");
                }
                wgpu::PollType::Poll
            }
            Some((index, None)) => wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(std::time::Duration::from_secs(1)) },
            None => wgpu::PollType::Poll,
        };
        if let Err(e) = self.device.poll(poll) {
            log::warn!("等上一帧网页: {e}");
        }
        let waited = started.elapsed();
        let encoder_desc = wgpu::CommandEncoderDescriptor { label: Some("acde web") };
        let mut encoder = self.device.create_command_encoder(&encoder_desc);
        for pass in passes {
            self.draw_pass(&mut encoder, pass)?;
        }
        let semaphore = self.semaphores.get(self.next_semaphore).copied().filter(|_| !self.poll);
        let lock = self.gpu.as_ref().map(|gpu| gpu.submit_lock());
        if let Some(s) = semaphore {
            if let Some(queue) = unsafe { self.queue.as_hal::<Vk>() } {
                queue.add_signal_semaphore(s, None);
            }
            self.next_semaphore = (self.next_semaphore + 1) % self.semaphores.len();
        }
        self.submits.push_back((Self::submit(&self.device, &self.queue, &mut self.composer, &mut encoder), None));
        drop(lock);
        self.overrides.submitted();
        log::debug!(
            target: "perf::raster",
            "job surfaces={count} wait={:.3} record={:.3} ms={:.3}",
            waited.as_secs_f64() * 1000.0,
            (started.elapsed() - waited).as_secs_f64() * 1000.0,
            acde_log::since_ms(started),
        );
        self.composer.end_frame();
        self.overrides.forget(&mut self.vello);
        match semaphore.and_then(|s| self.export_sync_file(s)) {
            Some(fd) => {
                if let Some(last) = self.submits.back_mut() {
                    last.1 = fd.try_clone().ok();
                }
                Ok(Some(fd))
            }
            None => {
                self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("等 GPU: {e}"))?;
                Ok(None)
            }
        }
    }

    fn submit(device: &wgpu::Device, queue: &wgpu::Queue, composer: &mut Composer, encoder: &mut wgpu::CommandEncoder) -> wgpu::SubmissionIndex {
        composer.flush();
        let done = std::mem::replace(encoder, device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde web") }));
        queue.submit([done.finish()])
    }

    fn pieces(part: &Part, targets: &[Rect], full: Rect) -> Vec<(Rect, Rect)> {
        let margin = part.shadows.iter().map(|s| (s.dx.abs().max(s.dy.abs()) + 4.0 * s.blur).ceil() as i32).max().unwrap_or(0).max((3.0 * part.effect.blur).ceil() as i32);
        targets
            .iter()
            .filter_map(|t| {
                let clip = part.bounds.map_or(Some(*t), |b| b.intersection(*t))?;
                let drawn = part.bounds.map_or(Some(*t), |b| b.intersection(t.grown(margin)))?.intersection(full)?;
                Some((drawn, clip))
            })
            .collect()
    }

    fn draw_pass(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        Pass { plane, size, parts, next, targets }: Pass,
    ) -> Result<(), String> {
        let full = Rect::from_size((size.0 as i32, size.1 as i32).into());
        let (_, canvas_view) = self.canvases.get(&plane).and_then(|c| c.get(next)?.clone()).ok_or("网页画布还没导入")?;
        let layer = self.composer.layer_view(size);
        match &targets {
            Some(regions) => self.composer.clear_rects(encoder, &canvas_view, regions.iter().map(Pixels::xywh)),
            None => Composer::clear(encoder, &canvas_view),
        }
        let targets = targets.unwrap_or_else(|| vec![full]);
        for part in parts {
            if let Some(backdrop) = part.backdrop.as_ref().filter(|b| targets.iter().any(|t| Rect::covering(b.rect).overlaps(*t))) {
                self.composer.backdrop(encoder, &canvas_view, backdrop);
            }
            for (drawn, clip) in Self::pieces(&part, &targets, full) {
                let [ox, oy, width, height] = drawn.xywh();
                let origin = Affine::translate((-f64::from(ox), -f64::from(oy)));
                let scene = part.content.scene_for(drawn);
                if scene.commands.is_empty() {
                    continue;
                }
                Self::submit(&self.device, &self.queue, &mut self.composer, encoder);
                self.render(scene, origin, (width, height), &layer)?;
                for shadow in &part.shadows {
                    self.composer.shadow(encoder, &canvas_view, shadow, drawn.xywh(), clip.xywh());
                }
                match part.effect.is_none() {
                    true => self.composer.place(encoder, &canvas_view, [ox, oy], clip.xywh()),
                    false => self.composer.filtered(encoder, &canvas_view, &part.effect, drawn.xywh(), clip.xywh()),
                }
            }
        }
        Ok(())
    }

    fn render(&mut self, scene: acde_render::anyrender::Scene, place: Affine, (width, height): (u32, u32), target: &wgpu::TextureView) -> Result<(), String> {
        self.scene.reset();
        self.overrides.apply(&mut self.vello, &scene);
        VelloScenePainter::new(&mut self.scene).append_scene(scene, place);
        acde_render::gpu::keep_atlas(&mut self.scene);
        let params = vello::RenderParams { base_color: Color::TRANSPARENT, width, height, antialiasing_method: vello::AaConfig::Area };
        self.vello.render_to_texture(&self.device, &self.queue, &self.scene, target, &params).map_err(|e| format!("vello 渲染: {e}"))
    }

    fn icon(&mut self, dmabuf: &Dmabuf, (width, height): (u32, u32), scene: acde_render::anyrender::Scene) -> Result<(), String> {
        let texture = self.import_vulkan(dmabuf, (width, height))?;
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let layer = self.composer.layer_view((width, height));
        self.render(scene, Affine::IDENTITY, (width, height), &layer)?;
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("acde drag icon") });
        Composer::clear(&mut encoder, &view);
        self.composer.place(&mut encoder, &view, [0, 0], [0, 0, width, height]);
        let index = Self::submit(&self.device, &self.queue, &mut self.composer, &mut encoder);
        self.overrides.submitted();
        self.composer.end_frame();
        self.device
            .poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: Some(std::time::Duration::from_secs(2)) })
            .map(|_| ())
            .map_err(|e| format!("等 GPU: {e}"))
    }

    fn warm_up(&mut self) {
        let started = std::time::Instant::now();
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("acde web warm-up"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let params = vello::RenderParams { base_color: Color::TRANSPARENT, width: 64, height: 64, antialiasing_method: vello::AaConfig::Area };
        if let Err(e) = self.vello.render_to_texture(&self.device, &self.queue, &vello::Scene::new(), &view, &params) {
            log::warn!("vello 预热: {e}");
        }
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        log::info!("vello 预热 {:.1}ms", acde_log::since_ms(started));
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

    fn export_sync_file(&self, semaphore: vk::Semaphore) -> Option<OwnedFd> {
        let fd = unsafe {
            let hal_device = self.device.as_hal::<Vk>()?;
            let ext = ash::khr::external_semaphore_fd::Device::new(hal_device.shared_instance().raw_instance(), hal_device.raw_device());
            let info = vk::SemaphoreGetFdInfoKHR::default().semaphore(semaphore).handle_type(vk::ExternalSemaphoreHandleTypeFlags::SYNC_FD);
            ext.get_semaphore_fd(&info).ok()?
        };
        (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn import_vulkan(&self, dmabuf: &Dmabuf, (width, height): (u32, u32)) -> Result<wgpu::Texture, String> {
        let plane = dmabuf.handles().next().ok_or("dmabuf 没有平面")?;
        let offset = dmabuf.offsets().next().unwrap_or(0);
        let stride = dmabuf.strides().next().unwrap_or(width * 4);
        let modifier: u64 = dmabuf.format().modifier.into();
        unsafe {
            let hal_device = self.device.as_hal::<Vk>().ok_or("不是 Vulkan 设备")?;
            let raw = hal_device.raw_device();
            let layouts = [vk::SubresourceLayout { offset: offset.into(), size: 0, row_pitch: stride.into(), array_pitch: 0, depth_pitch: 0 }];
            let mut explicit = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::default().drm_format_modifier(modifier).plane_layouts(&layouts);
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
            if let Err(e) = fd_ext.get_memory_fd_properties(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT, plane.as_raw_fd(), &mut fd_props) {
                raw.destroy_image(image, None);
                return Err(format!("dmabuf 内存属性: {e}"));
            }
            let types = requirements.memory_type_bits & fd_props.memory_type_bits;
            if types == 0 {
                raw.destroy_image(image, None);
                return Err("没有能导入这块 dmabuf 的内存类型".into());
            }
            let fd = plane.as_fd().try_clone_to_owned().map_err(|e| e.to_string())?;
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
                    return Err(format!("导入 dmabuf 内存: {e}"));
                }
            };
            if let Err(e) = raw.bind_image_memory(image, memory, 0) {
                raw.free_memory(memory, None);
                raw.destroy_image(image, None);
                return Err(format!("绑定内存: {e}"));
            }
            let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
            let hal_desc = wgpu::hal::TextureDescriptor {
                label: Some("acde web canvas"),
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
                    label: Some("acde web canvas"),
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
