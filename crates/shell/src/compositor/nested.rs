//! The nested backend: acde inside someone else's Wayland desktop (development on a Linux machine that is not an
//! AgentOS session). The compositor renders the screen off-screen on the GPU into GBM dmabufs, the same as the RDP
//! backend, and a host thread shows them in one xdg_toplevel of the host desktop through linux-dmabuf (no CPU copy);
//! the host's pointer and keys come back as injected input. One window of a fixed size (`ACDE_SIZE`, default 1280x800).

use std::path::PathBuf;

use smithay::backend::allocator::dmabuf::{AsDmabuf, Dmabuf};
use smithay::backend::allocator::gbm::{GbmAllocator, GbmBufferFlags};
use smithay::backend::allocator::{Allocator, Fourcc, Modifier};
use smithay::backend::drm::DrmNode;
use smithay::backend::egl::{EGLContext, EGLDisplay};
use smithay::backend::renderer::Bind;
use smithay::backend::renderer::damage::OutputDamageTracker;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::calloop::LoopHandle;
use smithay::reexports::calloop::channel::{self, Channel, Sender};
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::gbm;
use smithay::utils::DeviceFd;

use super::Compositor;
use super::backend::{Backend, CLEAR, Target};
use super::input::Injected;

const REFRESH_MHZ: i32 = 60_000;
const BUFFERS: usize = 3;

/// From the host thread to the compositor.
pub enum Host {
    Input(Injected),
    /// The host released buffer `n`: it can be drawn into again.
    Released(usize),
    /// The host window was closed: the session ends.
    Closed,
}

/// From the compositor to the host thread: show buffer `n`.
struct Show(usize);

struct Slot {
    dmabuf: Dmabuf,
    free: bool,
    /// Frames drawn since this buffer was last drawn into (its damage age; 0: unknown).
    age: usize,
}

pub struct NestedTarget {
    slots: Vec<Slot>,
    damage: OutputDamageTracker,
    show: std::sync::mpsc::Sender<Show>,
}

impl NestedTarget {
    pub fn start(lh: &LoopHandle<'static, Compositor>) -> Result<(Backend, DrmNode), String> {
        let path = std::env::var_os("ACDE_RENDER_NODE").map_or_else(|| PathBuf::from("/dev/dri/renderD128"), PathBuf::from);
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let node = DrmNode::from_path(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let gbm = gbm::Device::new(DeviceFd::from(std::os::fd::OwnedFd::from(file))).map_err(|e| format!("GBM: {e}"))?;
        // SAFETY: the GBM device lives as long as the display (the allocator keeps a clone).
        let egl = unsafe { EGLDisplay::new(gbm.clone()) }.map_err(|e| format!("EGL: {e}"))?;
        let context = EGLContext::new(&egl).map_err(|e| format!("EGL context: {e}"))?;
        // SAFETY: a fresh context, used only by this renderer on the compositor thread.
        let renderer = unsafe { GlesRenderer::new(context) }.map_err(|e| format!("GLES: {e}"))?;

        let (w, h) = std::env::var("ACDE_SIZE")
            .ok()
            .and_then(|s| {
                let (w, h) = s.split_once('x')?;
                Some((w.trim().parse::<i32>().ok()?, h.trim().parse::<i32>().ok()?))
            })
            .unwrap_or((1280, 800));
        let mut allocator = GbmAllocator::new(gbm, GbmBufferFlags::RENDERING);
        let mut slots = Vec::new();
        for _ in 0..BUFFERS {
            let bo = allocator.create_buffer(w as u32, h as u32, Fourcc::Xrgb8888, &[Modifier::Linear]).map_err(|e| format!("GBM 分配: {e}"))?;
            let dmabuf = bo.export().map_err(|e| format!("导出 dmabuf: {e}"))?;
            slots.push(Slot { dmabuf, free: true, age: 0 });
        }

        let mode = Mode { size: (w, h).into(), refresh: REFRESH_MHZ };
        let output = Output::new("acde".into(), PhysicalProperties { size: (0, 0).into(), subpixel: Subpixel::Unknown, make: "acde".into(), model: "nested".into() });
        output.change_current_state(Some(mode), None, None, Some((0, 0).into()));
        output.set_preferred(mode);
        let damage = OutputDamageTracker::from_output(&output);

        let (tx, rx): (Sender<Host>, Channel<Host>) = channel::channel();
        lh.insert_source(rx, |event, _, state| {
            if let channel::Event::Msg(message) = event {
                state.on_host(message);
            }
        })
        .map_err(|e| e.to_string())?;
        let (show, shown) = std::sync::mpsc::channel();
        let buffers: Vec<Dmabuf> = slots.iter().map(|s| s.dmabuf.clone()).collect();
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("acde-nested".into())
            .spawn(move || {
                if let Err(e) = host::run(w, h, &buffers, &shown, &tx, &ready) {
                    log::error!("嵌套窗口: {e}");
                    _ = ready.send(Err(e));
                }
                _ = tx.send(Host::Closed);
            })
            .map_err(|e| e.to_string())?;
        started.recv().map_err(|_| "嵌套窗口: 宿主线程没起来".to_owned())??;
        let target = Target::Nested(Box::new(Self { slots, damage, show }));
        Ok((Backend::new(renderer, output, target), node))
    }
}

impl Compositor {
    fn on_host(&mut self, message: Host) {
        match message {
            Host::Input(event) => self.inject(event),
            Host::Released(n) => {
                if let Target::Nested(nested) = &mut self.backend.target
                    && let Some(slot) = nested.slots.get_mut(n)
                {
                    slot.free = true;
                }
                self.backend.damaged();
            }
            Host::Closed => {
                log::info!("嵌套窗口关了, 会话结束");
                self.signal.stop();
            }
        }
    }

    pub fn render_nested(&mut self) {
        let output = self.backend.output.clone();
        let elements = self.screen_elements(&output, false);
        let Backend { renderer, target, .. } = &mut self.backend;
        let Target::Nested(nested) = target else { return };
        let Some(n) = nested.slots.iter().position(|s| s.free) else { return };
        let states = {
            let slot = &mut nested.slots[n];
            let Ok(mut fb) = renderer.bind(&mut slot.dmabuf) else { return };
            let result = match nested.damage.render_output(renderer, &mut fb, slot.age, &elements, CLEAR) {
                Ok(result) => result,
                Err(e) => {
                    log::warn!("嵌套窗口渲染失败: {e}");
                    return;
                }
            };
            if let Err(e) = result.sync.wait() {
                log::warn!("嵌套窗口等 GPU: {e:?}");
            }
            result.states
        };
        for (i, slot) in nested.slots.iter_mut().enumerate() {
            slot.age = if i == n { 1 } else if slot.age == 0 { 0 } else { slot.age + 1 };
        }
        nested.slots[n].free = false;
        _ = nested.show.send(Show(n));
        self.backend.dirty = false;
        self.backend.presenting = true;
        self.timing.pending = Some(self.post_repaint(&states, &output));
        let _ = self.loop_handle.insert_source(Timer::from_duration(self.frame_duration()), |_, _, state| {
            let feedback = state.timing.pending.take();
            state.on_vblank(feedback);
            TimeoutAction::Drop
        });
    }
}

/// The host side: a plain Wayland client of the desktop acde runs in.
mod host {
    use std::sync::mpsc::{Receiver, SyncSender, TryRecvError};
    use std::time::Duration;

    use smithay::backend::allocator::Buffer;
    use smithay::backend::allocator::dmabuf::Dmabuf;
    use smithay::reexports::calloop::channel::Sender;
    use smithay_client_toolkit::compositor::{CompositorHandler, CompositorState};
    use smithay_client_toolkit::dmabuf::{DmabufFeedback, DmabufHandler, DmabufState};
    use smithay_client_toolkit::output::{OutputHandler, OutputState};
    use smithay_client_toolkit::registry::{ProvidesRegistryState, RegistryState};
    use smithay_client_toolkit::seat::keyboard::{KeyEvent, KeyboardHandler, Keysym, Modifiers, RawModifiers};
    use smithay_client_toolkit::seat::pointer::{PointerEvent, PointerEventKind, PointerHandler};
    use smithay_client_toolkit::seat::{Capability, SeatHandler, SeatState};
    use smithay_client_toolkit::shell::WaylandSurface;
    use smithay_client_toolkit::shell::xdg::XdgShell;
    use smithay_client_toolkit::shell::xdg::window::{Window, WindowConfigure, WindowDecorations, WindowHandler};
    use smithay_client_toolkit::{delegate_dispatch2, delegate_registry, registry_handlers};
    use wayland_client::globals::registry_queue_init;
    use wayland_client::protocol::{wl_buffer, wl_keyboard, wl_output, wl_pointer, wl_seat, wl_surface};
    use wayland_client::{Connection, QueueHandle};
    use wayland_protocols::wp::linux_dmabuf::zv1::client::{zwp_linux_buffer_params_v1, zwp_linux_dmabuf_feedback_v1};

    use super::{Host, Injected, Show};

    struct State {
        registry: RegistryState,
        seat: SeatState,
        outputs: OutputState,
        dmabuf: DmabufState,
        window: Window,
        buffers: Vec<wl_buffer::WlBuffer>,
        pointer: Option<wl_pointer::WlPointer>,
        keyboard: Option<wl_keyboard::WlKeyboard>,
        tx: Sender<Host>,
        configured: bool,
        closed: bool,
    }

    pub fn run(w: i32, h: i32, dmabufs: &[Dmabuf], shown: &Receiver<Show>, tx: &Sender<Host>, ready: &SyncSender<Result<(), String>>) -> Result<(), String> {
        let conn = host_connection()?;
        let (globals, mut queue) = registry_queue_init::<State>(&conn).map_err(|e| format!("registry: {e}"))?;
        let qh = queue.handle();
        let compositor = CompositorState::bind(&globals, &qh).map_err(|e| format!("wl_compositor: {e}"))?;
        let xdg = XdgShell::bind(&globals, &qh).map_err(|e| format!("xdg_wm_base: {e}"))?;
        let dmabuf = DmabufState::new(&globals, &qh);
        if dmabuf.version().is_none() {
            return Err("宿主桌面没有 linux-dmabuf".into());
        }
        let surface = compositor.create_surface(&qh);
        let window = xdg.create_window(surface, WindowDecorations::RequestServer, &qh);
        window.set_title("acde");
        window.set_app_id("acde");
        window.set_min_size(Some((w as u32, h as u32)));
        window.set_max_size(Some((w as u32, h as u32)));
        window.commit();
        let mut state = State {
            registry: RegistryState::new(&globals),
            seat: SeatState::new(&globals, &qh),
            outputs: OutputState::new(&globals, &qh),
            dmabuf,
            window,
            buffers: Vec::new(),
            pointer: None,
            keyboard: None,
            tx: tx.clone(),
            configured: false,
            closed: false,
        };
        for (n, dmabuf) in dmabufs.iter().enumerate() {
            let params = state.dmabuf.create_params(&qh).map_err(|e| format!("linux-dmabuf: {e}"))?;
            let modifier: u64 = dmabuf.format().modifier.into();
            for (i, (fd, (offset, stride))) in dmabuf.handles().zip(dmabuf.offsets().zip(dmabuf.strides())).enumerate() {
                params.add(fd, i as u32, offset, stride, modifier);
            }
            let (buffer, _) = params.create_immed(w, h, dmabuf.format().code as u32, zwp_linux_buffer_params_v1::Flags::empty(), &qh);
            debug_assert_eq!(state.buffers.len(), n);
            state.buffers.push(buffer);
        }
        _ = ready.send(Ok(()));
        while !state.closed {
            queue.flush().map_err(|e| e.to_string())?;
            if let Some(guard) = queue.prepare_read() {
                let fd = guard.connection_fd();
                let mut fds = [rustix::event::PollFd::new(&fd, rustix::event::PollFlags::IN)];
                let timeout = rustix::event::Timespec { tv_sec: 0, tv_nsec: 4_000_000 };
                if rustix::event::poll(&mut fds, Some(&timeout)).is_ok_and(|n| n > 0) {
                    _ = guard.read();
                }
            }
            queue.dispatch_pending(&mut state).map_err(|e| e.to_string())?;
            loop {
                match shown.try_recv() {
                    Ok(Show(n)) => state.show(n),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return Ok(()),
                }
            }
            if !state.configured {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        Ok(())
    }

    /// The desktop acde runs in: `ACDE_HOST_DISPLAY` (WAYLAND_DISPLAY is acde's own socket by now).
    fn host_connection() -> Result<Connection, String> {
        let name = std::env::var("ACDE_HOST_DISPLAY").map_err(|_| "没有宿主桌面 (ACDE_HOST_DISPLAY 没设; 嵌套要在一个 Wayland 桌面里起)".to_owned())?;
        let path = if name.starts_with('/') {
            std::path::PathBuf::from(&name)
        } else {
            std::path::PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or("没有 XDG_RUNTIME_DIR")?).join(&name)
        };
        let stream = std::os::unix::net::UnixStream::connect(&path).map_err(|e| format!("连接宿主桌面 {}: {e}", path.display()))?;
        Connection::from_socket(stream).map_err(|e| format!("宿主桌面: {e}"))
    }

    impl State {
        fn show(&mut self, n: usize) {
            let Some(buffer) = self.buffers.get(n) else { return };
            let surface = self.window.wl_surface();
            surface.attach(Some(buffer), 0, 0);
            surface.damage_buffer(0, 0, i32::MAX, i32::MAX);
            surface.commit();
        }

        fn send(&self, event: Injected) {
            _ = self.tx.send(Host::Input(event));
        }
    }

    impl ProvidesRegistryState for State {
        fn registry(&mut self) -> &mut RegistryState {
            &mut self.registry
        }
        registry_handlers![SeatState, OutputState];
    }

    impl CompositorHandler for State {
        fn scale_factor_changed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: i32) {}
        fn transform_changed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: wl_output::Transform) {}
        fn frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {}
        fn surface_enter(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: &wl_output::WlOutput) {}
        fn surface_leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: &wl_output::WlOutput) {}
    }

    impl OutputHandler for State {
        fn output_state(&mut self) -> &mut OutputState {
            &mut self.outputs
        }
        fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
        fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
        fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    }

    impl WindowHandler for State {
        fn request_close(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &Window) {
            self.closed = true;
        }

        fn configure(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &Window, _: WindowConfigure, _: u32) {
            if !self.configured {
                self.configured = true;
                for n in 0..self.buffers.len() {
                    _ = self.tx.send(Host::Released(n));
                }
            }
        }
    }

    impl SeatHandler for State {
        fn seat_state(&mut self) -> &mut SeatState {
            &mut self.seat
        }
        fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
        fn new_capability(&mut self, _: &Connection, qh: &QueueHandle<Self>, seat: wl_seat::WlSeat, capability: Capability) {
            match capability {
                Capability::Pointer if self.pointer.is_none() => self.pointer = self.seat.get_pointer(qh, &seat).ok(),
                Capability::Keyboard if self.keyboard.is_none() => self.keyboard = self.seat.get_keyboard(qh, &seat, None).ok(),
                _ => {}
            }
        }
        fn remove_capability(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat, capability: Capability) {
            match capability {
                Capability::Pointer => drop(self.pointer.take()),
                Capability::Keyboard => drop(self.keyboard.take()),
                _ => {}
            }
        }
        fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
    }

    impl PointerHandler for State {
        fn pointer_frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_pointer::WlPointer, events: &[PointerEvent]) {
            for event in events {
                let (x, y) = event.position;
                match event.kind {
                    PointerEventKind::Enter { .. } | PointerEventKind::Motion { .. } => self.send(Injected::moved(x, y)),
                    PointerEventKind::Press { button, .. } => self.send(Injected::Button { button, pressed: true }),
                    PointerEventKind::Release { button, .. } => self.send(Injected::Button { button, pressed: false }),
                    PointerEventKind::Axis { horizontal, vertical, source, .. } => {
                        let kind = match source {
                            Some(wl_pointer::AxisSource::Finger) => super::super::input::WheelKind::Finger,
                            Some(wl_pointer::AxisSource::Continuous) => super::super::input::WheelKind::Continuous,
                            _ => super::super::input::WheelKind::Wheel,
                        };
                        self.send(Injected::wheel(horizontal.absolute, vertical.absolute, kind));
                    }
                    PointerEventKind::Leave { .. } => {}
                }
            }
        }
    }

    impl KeyboardHandler for State {
        fn enter(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: &wl_surface::WlSurface, _: u32, _: &[u32], _: &[Keysym]) {}
        fn leave(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: &wl_surface::WlSurface, _: u32) {}
        fn press_key(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: u32, event: KeyEvent) {
            self.send(Injected::Key { code: event.raw_code, pressed: true });
        }
        fn repeat_key(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: u32, _: KeyEvent) {}
        fn release_key(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: u32, event: KeyEvent) {
            self.send(Injected::Key { code: event.raw_code, pressed: false });
        }
        fn update_modifiers(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_keyboard::WlKeyboard, _: u32, _: Modifiers, _: RawModifiers, _: u32) {}
    }

    impl DmabufHandler for State {
        fn dmabuf_state(&mut self) -> &mut DmabufState {
            &mut self.dmabuf
        }
        fn dmabuf_feedback(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &zwp_linux_dmabuf_feedback_v1::ZwpLinuxDmabufFeedbackV1, _: DmabufFeedback) {}
        fn created(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1, _: wl_buffer::WlBuffer) {}
        fn failed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1) {
            log::warn!("宿主桌面拒绝了 acde 的画面 (linux-dmabuf)");
        }
        fn released(&mut self, _: &Connection, _: &QueueHandle<Self>, buffer: &wl_buffer::WlBuffer) {
            if let Some(n) = self.buffers.iter().position(|b| b == buffer) {
                _ = self.tx.send(Host::Released(n));
            }
        }
    }

    delegate_dispatch2!(State);
    delegate_registry!(State);
}
