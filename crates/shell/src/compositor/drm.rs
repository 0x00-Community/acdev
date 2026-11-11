use std::collections::HashSet;
use std::time::Duration;

use smithay::backend::allocator::Fourcc;
use smithay::backend::allocator::gbm::{GbmAllocator, GbmBufferFlags, GbmDevice};
use smithay::backend::drm::compositor::FrameFlags;
use smithay::backend::drm::exporter::gbm::GbmFramebufferExporter;
use smithay::backend::drm::output::{DrmOutput, DrmOutputManager, DrmOutputRenderElements};
use smithay::backend::allocator::format::FormatSet;
use smithay::backend::drm::{DrmDevice, DrmDeviceFd, DrmEvent, DrmNode, DrmSurface, NodeType};
use smithay::backend::egl::{EGLContext, EGLDisplay};
use smithay::backend::libinput::{LibinputInputBackend, LibinputSessionInterface};
use smithay::backend::renderer::element::{RenderElement, RenderElementStates, UnderlyingStorage};
use smithay::backend::renderer::utils::Buffer;
use smithay::backend::renderer::element::utils::select_dmabuf_feedback;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::session::libseat::LibSeatSession;
use smithay::backend::session::{Event as SessionEvent, Session};
use smithay::desktop::utils::{OutputPresentationFeedback, surface_primary_scanout_output};
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::calloop::LoopHandle;
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::drm::control::{Device as ControlDevice, ModeTypeFlags, connector, crtc};
use smithay::reexports::input::Libinput;
use smithay::reexports::rustix::fs::OFlags;
use smithay::reexports::wayland_protocols::wp::linux_dmabuf::zv1::server::zwp_linux_dmabuf_feedback_v1::TrancheFlags;
use smithay::utils::DeviceFd;
use smithay::wayland::dmabuf::{DmabufFeedback, DmabufFeedbackBuilder};

use super::backend::{Backend, CLEAR, Elements, Target};
use super::Compositor;

type Manager = DrmOutputManager<GbmAllocator<DrmDeviceFd>, GbmFramebufferExporter<DrmDeviceFd>, Option<OutputPresentationFeedback>, DrmDeviceFd>;
type Surface = DrmOutput<GbmAllocator<DrmDeviceFd>, GbmFramebufferExporter<DrmDeviceFd>, Option<OutputPresentationFeedback>, DrmDeviceFd>;

const WATCHDOG: Duration = Duration::from_secs(1);

const COLOR_FORMATS: [Fourcc; 2] = [Fourcc::Argb8888, Fourcc::Abgr8888];

struct Screen {
    crtc: crtc::Handle,
    output: Output,
    surface: Surface,
    dirty: bool,
    presenting: bool,
    queued: Option<std::time::Instant>,
    feedback: Option<ScreenFeedback>,
    sampled: Vec<Buffer>,
    planes: (bool, usize),
}

#[derive(Clone)]
struct ScreenFeedback {
    render: DmabufFeedback,
    scanout: DmabufFeedback,
}

impl ScreenFeedback {
    fn new(display: DrmNode, render: DrmNode, render_formats: &FormatSet, surface: &DrmSurface) -> Option<Self> {
        let planes = surface.planes();
        let scanout: FormatSet = planes.primary.iter().chain(&planes.overlay).flat_map(|p| p.formats.iter().copied()).filter(|f| render_formats.contains(f)).collect();
        let builder = || DmabufFeedbackBuilder::new(render.dev_id(), render_formats.iter().copied());
        let built = (builder().build(), builder().add_preference_tranche(display.dev_id(), Some(TrancheFlags::Scanout), scanout).build());
        match built {
            (Ok(render), Ok(scanout)) => Some(Self { render, scanout }),
            (Err(e), _) | (_, Err(e)) => {
                log::warn!("dmabuf feedback: {e}");
                None
            }
        }
    }
}

pub struct DrmTarget {
    session: LibSeatSession,
    manager: Manager,
    screens: Vec<Screen>,
    libinput: Libinput,
    idle_vblank: bool,
    paused: bool,
}

impl DrmTarget {
    pub fn start(lh: &LoopHandle<'static, Compositor>) -> Result<(Backend, DrmNode), String> {
        let (mut session, notifier) = LibSeatSession::new().map_err(|e| format!("libseat 会话: {e}"))?;
        let seat = session.seat();
        let path = smithay::backend::udev::primary_gpu(&seat)
            .ok()
            .flatten()
            .or_else(|| smithay::backend::udev::all_gpus(&seat).ok()?.into_iter().next())
            .ok_or("没有 GPU")?;
        let (fd, drm, notifier_drm) = Self::open_drm(&mut session, &path)?;
        let node = DrmNode::from_file(&fd).map_err(|e| format!("DRM 节点: {e}"))?;
        let render_node = node.node_with_type(NodeType::Render).and_then(Result::ok).unwrap_or(node);
        let gbm = GbmDevice::new(fd).map_err(|e| format!("GBM: {e}"))?;
        let egl = unsafe { EGLDisplay::new(gbm.clone()) }.map_err(|e| format!("EGL: {e}"))?;
        let context = EGLContext::new(&egl).map_err(|e| format!("EGL context: {e}"))?;
        let render_formats = context.dmabuf_render_formats().clone();
        let mut renderer = unsafe { GlesRenderer::new(context) }.map_err(|e| format!("GLES: {e}"))?;

        let screens_info = Self::connected(&drm);
        let mut manager = Manager::new(
            drm,
            GbmAllocator::new(gbm.clone(), GbmBufferFlags::RENDERING | GbmBufferFlags::SCANOUT),
            GbmFramebufferExporter::new(gbm.clone(), Some(render_node)),
            Some(gbm.clone()),
            COLOR_FORMATS,
            render_formats.clone(),
        );
        let mut screens = Vec::new();
        let mut x = 0;
        for (conn, crtc, mode) in screens_info {
            let wl_mode = Mode::from(mode);
            let name = format!("{}-{}", conn.interface().as_str(), conn.interface_id());
            let edid = super::outputs::edid(&name);
            let output = Output::new(
                name,
                PhysicalProperties {
                    size: conn.size().map_or((0, 0).into(), |(w, h)| (i32::try_from(w).unwrap_or(0), i32::try_from(h).unwrap_or(0)).into()),
                    subpixel: Subpixel::Unknown,
                    make: edid.as_ref().map_or_else(|| "acde".into(), |e| e.make.clone()),
                    model: edid.as_ref().map(|e| e.model.clone()).filter(|m| !m.is_empty()).unwrap_or_else(|| "DRM".into()),
                },
            );
            output.user_data().insert_if_missing(|| super::outputs::Identity { edid: edid.map(|e| e.identifier) });
            output.set_preferred(wl_mode);
            output.change_current_state(Some(wl_mode), None, None, Some((x, 0).into()));
            x += wl_mode.size.w;
            let planes = manager.device().planes(&crtc).ok();
            let surface = manager
                .initialize_output::<GlesRenderer, Elements>(crtc, mode, &[conn.handle()], &output, planes, &mut renderer, &DrmOutputRenderElements::default())
                .map_err(|e| format!("初始化输出 {}: {e}", output.name()))?;
            let feedback = surface.with_compositor(|c| ScreenFeedback::new(node, render_node, &render_formats, c.surface()));
            screens.push(Screen { crtc, output, surface, dirty: true, presenting: false, queued: None, feedback, sampled: Vec::new(), planes: (false, 0) });
        }
        let primary = screens.first().map(|s| s.output.clone()).ok_or("没有已连接的显示器")?;

        let mut libinput = Libinput::new_with_udev::<LibinputSessionInterface<LibSeatSession>>(session.clone().into());
        libinput.udev_assign_seat(&seat).map_err(|()| "libinput 分配 seat 失败".to_string())?;
        lh.insert_source(LibinputInputBackend::new(libinput.clone()), |event, _, state| state.on_input(event)).map_err(|e| e.to_string())?;
        lh.insert_source(notifier_drm, |event, _, state| match event {
            DrmEvent::VBlank(crtc) => state.on_drm_vblank(crtc),
            DrmEvent::Error(e) => log::warn!("DRM: {e}"),
        })
        .map_err(|e| e.to_string())?;
        lh.insert_source(notifier, |event, _, state| state.on_session(event)).map_err(|e| e.to_string())?;
        lh.insert_source(Timer::from_duration(WATCHDOG), |_, _, state| {
            state.drm_watchdog();
            TimeoutAction::ToDuration(WATCHDOG)
        })
        .map_err(|e| e.to_string())?;

        let target = Target::Drm(Box::new(Self { session, manager, screens, libinput, idle_vblank: false, paused: false }));
        Ok((Backend::new(renderer, primary, target), render_node))
    }

    fn open_drm(session: &mut LibSeatSession, path: &std::path::Path) -> Result<(DrmDeviceFd, DrmDevice, smithay::backend::drm::DrmDeviceNotifier), String> {
        const TRIES: u32 = 10;
        let mut attempt = 0;
        loop {
            attempt += 1;
            let owned = session.open(path, OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOCTTY | OFlags::NONBLOCK).map_err(|e| format!("打开 {}: {e}", path.display()))?;
            let fd = DrmDeviceFd::new(DeviceFd::from(owned.try_clone().map_err(|e| format!("复制 DRM fd: {e}"))?));
            match DrmDevice::new(fd.clone(), true) {
                Ok((drm, notifier)) => return Ok((fd, drm, notifier)),
                Err(e) if attempt < TRIES => {
                    log::warn!("DRM 设备 (第 {attempt} 次): {e}, 稍后重试");
                    drop(fd);
                    if let Err(e) = session.close(owned) {
                        log::warn!("交还 DRM 设备: {e}");
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                Err(e) => return Err(format!("DRM 设备: {e}")),
            }
        }
    }

    fn connected(drm: &DrmDevice) -> Vec<(connector::Info, crtc::Handle, smithay::reexports::drm::control::Mode)> {
        let Ok(resources) = drm.resource_handles() else { return Vec::new() };
        let mut used = HashSet::new();
        resources
            .connectors()
            .iter()
            .filter_map(|&handle| drm.get_connector(handle, false).ok())
            .filter(|info| info.state() == connector::State::Connected)
            .filter_map(|info| {
                let mode = info.modes().iter().find(|m| m.mode_type().contains(ModeTypeFlags::PREFERRED)).or_else(|| info.modes().first()).copied()?;
                let crtc = info
                    .encoders()
                    .iter()
                    .filter_map(|&e| drm.get_encoder(e).ok())
                    .flat_map(|enc| resources.filter_crtcs(enc.possible_crtcs()))
                    .find(|c| !used.contains(c))?;
                used.insert(crtc);
                Some((info, crtc, mode))
            })
            .collect()
    }

    pub fn outputs(&self) -> impl Iterator<Item = &Output> {
        self.screens.iter().map(|s| &s.output)
    }
}

impl Compositor {
    pub fn render_drm(&mut self) {
        let Target::Drm(drm) = &mut self.backend.target else { return };
        if drm.paused {
            return;
        }
        let dirty = std::mem::take(&mut self.backend.dirty);
        for screen in &mut drm.screens {
            screen.dirty |= dirty;
        }
        let outputs: Vec<(usize, Output)> = drm.screens.iter().enumerate().filter(|(_, s)| s.dirty && !s.presenting).map(|(i, s)| (i, s.output.clone())).collect();
        let primary = self.backend.output.clone();
        for (index, output) in outputs {
            let elements = self.screen_elements(&output, true);
            let backend = &mut self.backend;
            let Target::Drm(drm) = &mut backend.target else { return };
            let screen = &mut drm.screens[index];
            screen.dirty = false;
            let started = std::time::Instant::now();
            let flags = match super::env::ENV.scanout {
                true => FrameFlags::ALLOW_PRIMARY_PLANE_SCANOUT | FrameFlags::ALLOW_OVERLAY_PLANE_SCANOUT,
                false => FrameFlags::empty(),
            };
            let states = match screen.surface.render_frame(&mut backend.renderer, &elements, CLEAR, flags) {
                Ok(result) if !result.is_empty => {
                    let planes = (matches!(result.primary_element, smithay::backend::drm::compositor::PrimaryPlaneElement::Element(_)), result.overlay_elements.len());
                    if planes != screen.planes {
                        log::info!("平面 {}: 主平面{} 叠加平面 {} 个", output.name(), if planes.0 { "直扫客户端缓冲" } else { "合成" }, planes.1);
                        screen.planes = planes;
                    }
                    log::debug!(target: "perf::compose", "{} elements={} ms={:.3}", output.name(), elements.len(), acde_log::since_ms(started));
                    for element in &elements {
                        if let Some(UnderlyingStorage::Wayland(buffer)) = element.underlying_storage(&mut backend.renderer) {
                            screen.sampled.push(buffer.clone());
                        }
                    }
                    result.states
                }
                Ok(_) => {
                    drm.idle_vblank |= output == primary;
                    self.frames_without_repaint(&output);
                    continue;
                }
                Err(e) => {
                    log::warn!("渲染 {}: {e}", output.name());
                    screen.dirty = true;
                    drm.idle_vblank |= output == primary;
                    continue;
                }
            };
            let dmabuf = drm.screens[index].feedback.clone();
            let feedback = self.post_repaint(&states, &output);
            if let Some(dmabuf) = dmabuf {
                self.send_dmabuf_feedback(&output, &states, &dmabuf);
            }
            let Target::Drm(drm) = &mut self.backend.target else { return };
            let screen = &mut drm.screens[index];
            match screen.surface.queue_frame(Some(feedback)) {
                Ok(()) => {
                    screen.presenting = true;
                    screen.queued = Some(std::time::Instant::now());
                    if output == primary {
                        self.backend.presenting = true;
                    }
                }
                Err(e) => {
                    log::warn!("排帧 {}: {e}", output.name());
                    screen.dirty = true;
                    drm.idle_vblank |= output == primary;
                }
            }
        }
        self.schedule_idle_vblank();
    }

    pub fn screens_pending(&self) -> bool {
        let Target::Drm(drm) = &self.backend.target else { return false };
        !drm.paused && drm.screens.iter().any(|s| s.dirty && !s.presenting)
    }

    fn send_dmabuf_feedback(&self, output: &Output, states: &RenderElementStates, feedback: &ScreenFeedback) {
        for window in self.space.elements() {
            window.send_dmabuf_feedback(output, surface_primary_scanout_output, |surface, _| select_dmabuf_feedback(surface, states, &feedback.render, &feedback.scanout));
        }
    }

    fn schedule_idle_vblank(&mut self) {
        if let Target::Drm(drm) = &mut self.backend.target
            && std::mem::take(&mut drm.idle_vblank)
        {
            self.idle_vblank();
        }
    }

    fn on_drm_vblank(&mut self, crtc: crtc::Handle) {
        let primary = self.backend.output.clone();
        let Target::Drm(drm) = &mut self.backend.target else { return };
        let Some(screen) = drm.screens.iter_mut().find(|s| s.crtc == crtc) else { return };
        screen.presenting = false;
        screen.queued = None;
        screen.sampled.clear();
        let feedback = match screen.surface.frame_submitted() {
            Ok(feedback) => feedback.flatten(),
            Err(e) => {
                log::warn!("vblank {}: {e}", screen.output.name());
                None
            }
        };
        if screen.output == primary {
            self.on_vblank(feedback);
        } else if let Some(feedback) = feedback {
            self.feedback_presented(feedback);
        }
    }

    pub fn change_vt(&mut self, vt: i32) {
        let Target::Drm(drm) = &mut self.backend.target else { return };
        if let Err(e) = drm.session.change_vt(vt) {
            log::warn!("切到 VT {vt}: {e}");
        }
    }

    fn drm_watchdog(&mut self) {
        let Target::Drm(drm) = &mut self.backend.target else { return };
        if drm.paused || !drm.screens.iter().any(|s| s.presenting && s.queued.is_some_and(|t| t.elapsed() > WATCHDOG)) {
            return;
        }
        log::warn!("翻页超过 {WATCHDOG:?} 没完成 (待机唤醒?), 重置 DRM 状态");
        for screen in drm.screens.iter_mut().filter(|s| s.presenting) {
            let _ = screen.surface.frame_submitted();
        }
        self.reactivate_drm();
    }

    fn reactivate_drm(&mut self) {
        let Target::Drm(drm) = &mut self.backend.target else { return };
        if let Err(e) = drm.manager.activate(false) {
            log::warn!("DRM 恢复: {e}");
        }
        for screen in &mut drm.screens {
            screen.surface.reset_buffers();
            screen.presenting = false;
            screen.queued = None;
            screen.sampled.clear();
        }
        self.backend.presenting = false;
        self.backend.damaged();
    }

    fn on_session(&mut self, event: SessionEvent) {
        let Target::Drm(drm) = &mut self.backend.target else { return };
        match event {
            SessionEvent::PauseSession => {
                drm.paused = true;
                drm.libinput.suspend();
                drm.manager.pause();
            }
            SessionEvent::ActivateSession => {
                drm.paused = false;
                if drm.libinput.resume().is_err() {
                    log::warn!("libinput 恢复失败");
                }
                self.reactivate_drm();
            }
        }
    }
}
