use std::sync::Arc;

use acde_driver::Dri;
use acde_render::{RdpBitmap, RdpEvent, RdpSettings, RdpSlot, RdpUpdates};
use smithay::backend::allocator::Fourcc;
use smithay::backend::drm::DrmNode;
use smithay::backend::egl::{EGLContext, EGLDisplay};
use smithay::backend::renderer::damage::OutputDamageTracker;
use smithay::backend::renderer::gles::{GlesRenderer, GlesTexture};
use smithay::backend::renderer::{Bind, ExportMem, Offscreen};
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::calloop::channel::{self, Channel, Sender};
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::calloop::LoopHandle;
use smithay::reexports::gbm;
use smithay::utils::{DeviceFd, Physical, Rectangle, Size};

use super::backend::{Backend, CLEAR, Target};
use super::Compositor;

const REFRESH_MHZ: i32 = 60_000;
const TILE: i32 = 64;

type Rect = Rectangle<i32, Physical>;

pub struct RdpTarget {
    texture: GlesTexture,
    damage: OutputDamageTracker,
    updates: RdpUpdates,
    rendered: bool,
    full: bool,
    pending: Tiles,
    sent: usize,
}

struct Tiles {
    cols: i32,
    rows: i32,
    dirty: Vec<bool>,
    side: i32,
}

impl Tiles {
    fn new(size: Size<i32, Physical>) -> Self {
        let cols = (size.w + TILE - 1) / TILE;
        let rows = (size.h + TILE - 1) / TILE;
        let side = cols.max(rows).max(1).unsigned_abs().next_power_of_two().cast_signed();
        Self { cols, rows, dirty: vec![false; usize::try_from(cols * rows).unwrap_or(0)], side }
    }

    fn index(&self, col: i32, row: i32) -> usize {
        usize::try_from(row * self.cols + col).unwrap_or(0)
    }

    fn is_empty(&self) -> bool {
        !self.dirty.contains(&true)
    }

    fn clear(&mut self) {
        self.dirty.fill(false);
    }

    fn mark(&mut self, rect: Rect) {
        if rect.is_empty() {
            return;
        }
        let (c0, r0) = ((rect.loc.x / TILE).max(0), (rect.loc.y / TILE).max(0));
        let (c1, r1) = (((rect.loc.x + rect.size.w - 1) / TILE).min(self.cols - 1), ((rect.loc.y + rect.size.h - 1) / TILE).min(self.rows - 1));
        for row in r0..=r1 {
            for col in c0..=c1 {
                let i = self.index(col, row);
                self.dirty[i] = true;
            }
        }
    }

    fn state(&self, col: i32, row: i32, side: i32) -> Option<bool> {
        let mut any = false;
        let mut all = true;
        for r in row..(row + side).min(self.rows) {
            for c in col..(col + side).min(self.cols) {
                let d = self.dirty[self.index(c, r)];
                any |= d;
                all &= d;
            }
        }
        match (any, all) {
            (false, _) => Some(false),
            (true, true) => Some(true),
            _ => None,
        }
    }

    fn collect(&self, col: i32, row: i32, side: i32, screen: Rect, out: &mut Vec<Rect>) {
        if col >= self.cols || row >= self.rows {
            return;
        }
        match self.state(col, row, side) {
            Some(false) => {}
            Some(true) => out.extend(Rect::new((col * TILE, row * TILE).into(), (side * TILE, side * TILE).into()).intersection(screen)),
            None => {
                let half = side / 2;
                for (dc, dr) in [(0, 0), (half, 0), (0, half), (half, half)] {
                    self.collect(col + dc, row + dr, half, screen, out);
                }
            }
        }
    }

    fn take(&mut self, screen: Rect) -> Vec<Rect> {
        let mut out = Vec::new();
        self.collect(0, 0, self.side, screen, &mut out);
        self.clear();
        out
    }
}

impl RdpTarget {
    pub fn start(lh: &LoopHandle<'static, Compositor>) -> Result<(Backend, DrmNode), String> {
        let settings = RdpSettings::from_env()?;
        let path = Dri::render_node();
        let node = DrmNode::from_path(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let gbm = gbm::Device::new(DeviceFd::from(Dri::open(&path)?)).map_err(|e| format!("GBM: {e}"))?;
        let egl = unsafe { EGLDisplay::new(gbm.clone()) }.map_err(|e| format!("EGL: {e}"))?;
        let context = EGLContext::new(&egl).map_err(|e| format!("EGL context: {e}"))?;
        let mut renderer = unsafe { GlesRenderer::new(context) }.map_err(|e| format!("GLES: {e}"))?;

        let (w, h) = (i32::from(settings.size.width), i32::from(settings.size.height));
        let texture: GlesTexture = renderer.create_buffer(Fourcc::Abgr8888, (w, h).into()).map_err(|e| format!("离屏纹理: {e}"))?;
        let mode = Mode { size: (w, h).into(), refresh: REFRESH_MHZ };
        let output = Output::new("acde".into(), PhysicalProperties { size: (0, 0).into(), subpixel: Subpixel::Unknown, make: "acde".into(), model: "RDP".into() });
        output.change_current_state(Some(mode), None, None, Some((0, 0).into()));
        output.set_preferred(mode);
        let damage = OutputDamageTracker::from_output(&output);

        let updates = RdpUpdates::default();
        let (tx, rx): (Sender<RdpEvent>, Channel<RdpEvent>) = channel::channel();
        lh.insert_source(rx, |event, _, state| {
            if let channel::Event::Msg(event) = event {
                state.on_rdp(event);
            }
        })
        .map_err(|e| e.to_string())?;
        settings.serve(updates.clone(), Arc::new(move |event| {
            let _ = tx.send(event);
        }))?;

        let target = Target::Rdp(Box::new(Self { texture, damage, updates, rendered: false, full: true, pending: Tiles::new(mode.size), sent: 0 }));
        Ok((Backend::new(renderer, output, target), node))
    }
}

impl Compositor {
    fn on_rdp(&mut self, event: RdpEvent) {
        match event {
            RdpEvent::Input(input) => self.inject(input.into()),
            RdpEvent::Full => {
                if let Target::Rdp(rdp) = &mut self.backend.target {
                    rdp.full = true;
                }
                self.backend.damaged();
            }
            RdpEvent::Drained => {
                let size = self.backend.output.current_mode().map_or((0, 0).into(), |m| m.size);
                let Backend { renderer, target, .. } = &mut self.backend;
                if let Target::Rdp(rdp) = target {
                    rdp.flush(renderer, size);
                }
            }
        }
    }

    pub fn render_rdp(&mut self) {
        let output = self.backend.output.clone();
        let elements = self.screen_elements(&output, false);
        let Backend { renderer, target, .. } = &mut self.backend;
        let Target::Rdp(rdp) = target else { return };
        let connected = rdp.updates.slot() != RdpSlot::Closed;
        let age = usize::from(rdp.rendered);
        let started = std::time::Instant::now();
        let size = output.current_mode().map_or((0, 0).into(), |m| m.size);
        let (rects, states) = {
            let Ok(mut fb) = renderer.bind(&mut rdp.texture) else { return };
            let result = match rdp.damage.render_output(renderer, &mut fb, age, &elements, CLEAR) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("RDP 渲染失败: {e}");
                    return;
                }
            };
            let rects = match (connected, rdp.full) {
                (false, _) => Vec::new(),
                (true, true) => vec![Rectangle::from_size(size)],
                (true, false) => result.damage.cloned().unwrap_or_default(),
            };
            (rects, result.states)
        };
        rects.into_iter().for_each(|r| rdp.pending.mark(r));
        rdp.rendered = true;
        if connected {
            rdp.full = false;
        } else {
            rdp.pending.clear();
        }
        rdp.flush(renderer, size);
        log::debug!(target: "perf::compose", "rdp elements={} rects={} ms={:.3}", elements.len(), rdp.sent, acde_log::since_ms(started));
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

impl RdpTarget {
    fn flush(&mut self, renderer: &mut GlesRenderer, size: Size<i32, Physical>) {
        match self.updates.slot() {
            RdpSlot::Closed => return self.pending.clear(),
            RdpSlot::Busy => return,
            RdpSlot::Free if self.pending.is_empty() => return,
            RdpSlot::Free => {}
        }
        let rects = self.pending.take(Rectangle::from_size(size));
        self.sent = rects.len();
        let Ok(fb) = renderer.bind(&mut self.texture) else { return };
        let copies: Vec<_> = rects
            .into_iter()
            .filter_map(|rect| renderer.copy_framebuffer(&fb, Rectangle::new((rect.loc.x, rect.loc.y).into(), (rect.size.w, rect.size.h).into()), Fourcc::Abgr8888).inspect_err(|e| log::warn!("RDP 读回失败: {e}")).ok().map(|m| (rect, m)))
            .collect();
        let frame: Vec<RdpBitmap> = copies
            .into_iter()
            .filter_map(|(rect, mapping)| {
                let data = renderer.map_texture(&mapping).inspect_err(|e| log::warn!("RDP 读回失败: {e}")).ok()?.to_vec();
                Some(RdpBitmap { x: rect.loc.x, y: rect.loc.y, width: rect.size.w, height: rect.size.h, data })
            })
            .collect();
        self.updates.send(frame);
    }
}

