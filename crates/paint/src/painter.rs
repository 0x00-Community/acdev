use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use smithay::backend::allocator::dmabuf::{AsDmabuf, Dmabuf};
use smithay::backend::allocator::gbm::{GbmAllocator, GbmBufferFlags};
use smithay::backend::allocator::{Allocator, Fourcc, Modifier};
use smithay::backend::renderer::utils::{CommitCounter, DamageBag};
use smithay::reexports::calloop::ping::Ping;
use smithay::reexports::gbm;
use smithay::utils::{DeviceFd, Rectangle};

use crate::plane::{Part, Pixels, Rect, Sheet};
use crate::raster::{Done, Job, Lost, Pass, Raster, Ready};

const FORMAT: Fourcc = Fourcc::Abgr8888;
const PAD: u32 = 64;
const CANVASES: usize = 3;
const MAX_REGIONS: usize = 48;

struct Canvas {
    dmabuf: Dmabuf,
    drawn: Option<CommitCounter>,
    held: bool,
}

struct Target {
    canvases: Vec<Canvas>,
    size: (u32, u32),
    current: usize,
    damage: DamageBag<i32, smithay::utils::Buffer>,
    generation: u64,
    stale: bool,
}

pub struct Drawn {
    pub plane: usize,
    pub canvas: usize,
    pub frame: u64,
    pub generation: u64,
    pub size: (u32, u32),
    pub damage: Option<Vec<Rect>>,
}

struct Inflight {
    drawn: Vec<Drawn>,
    started: Instant,
    trace: Option<acde_log::Trace>,
}

pub struct Finished {
    pub drawn: Vec<Drawn>,
    pub fence: Option<OwnedFd>,
    pub took: Duration,
    pub trace: Option<acde_log::Trace>,
}

pub struct Painter {
    jobs: mpsc::Sender<Job>,
    done: mpsc::Receiver<Done>,
    allocator: GbmAllocator<DeviceFd>,
    ready: Ready,
    lost: Lost,
    targets: HashMap<usize, Target>,
    inflight: Option<Inflight>,
    generation: u64,
    full: bool,
    dropped: bool,
    frames: u64,
}

impl Target {
    fn backdrop_reads(parts: &[Part], full: Rect) -> Vec<Rect> {
        parts.iter().filter_map(|p| p.backdrop.map(|b| Rect::covering(b.rect))).filter_map(|r| r.intersection(full)).collect()
    }

    fn add(regions: &mut Vec<Rect>, r: Rect) -> bool {
        let pieces = r.subtract_rects(regions.iter().copied());
        let grew = !pieces.is_empty();
        regions.extend(pieces);
        grew
    }

    fn cover_reads(regions: &mut Vec<Rect>, reads: &[Rect]) {
        let mut changed = true;
        while changed && regions.len() <= MAX_REGIONS {
            changed = false;
            for read in reads {
                if regions.iter().any(|r| r.overlaps(*read)) {
                    changed |= Self::add(regions, *read);
                }
            }
        }
    }

    fn spread(parts: &[Part], mut damage: Vec<Rect>, full: Rect) -> Vec<Rect> {
        Self::cover_reads(&mut damage, &Self::backdrop_reads(parts, full));
        damage
    }

    fn next(&self) -> Option<usize> {
        (1..=self.canvases.len()).map(|k| (self.current + k) % self.canvases.len()).find(|&i| i != self.current && !self.canvases[i].held)
    }

    fn region(&self, index: usize, parts: &[Part], damage: &[Rect], full: Rect) -> Option<Vec<Rect>> {
        let since = self.damage.damage_since(Some(self.canvases[index].drawn?))?;
        let mut regions: Vec<Rect> = Vec::new();
        for r in damage.iter().chain(since.iter()).filter_map(|r| r.intersection(full)) {
            Self::add(&mut regions, r);
        }
        Self::cover_reads(&mut regions, &Self::backdrop_reads(parts, full));
        let area: i32 = regions.iter().map(|r| r.size.w * r.size.h).sum();
        (regions.len() <= MAX_REGIONS && area * 2 < full.size.w * full.size.h).then_some(regions)
    }
}

impl Painter {
    pub fn new(gbm: gbm::Device<DeviceFd>, waker: Ping, lost: Lost) -> Result<Self, String> {
        let (jobs, jobs_rx) = mpsc::channel();
        let (done_tx, done) = mpsc::channel();
        let ready = Ready::default();
        Raster::spawn(jobs_rx, done_tx, ready.clone(), lost.clone(), waker).map_err(|e| format!("光栅化线程: {e}"))?;
        Ok(Self {
            jobs,
            done,
            allocator: GbmAllocator::new(gbm, GbmBufferFlags::RENDERING),
            ready,
            lost,
            targets: HashMap::new(),
            inflight: None,
            generation: 0,
            full: std::env::var_os("ACDE_PAGE_FULL").is_some(),
            dropped: false,
            frames: 0,
        })
    }

    fn failed(&self) -> bool {
        self.ready.get() == Some(&false)
    }

    pub fn busy(&self) -> bool {
        self.inflight.is_some()
    }

    pub fn lost(&self) -> bool {
        self.lost.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn ready(&self) -> bool {
        !self.busy() && !self.failed() && self.targets.values().all(|t| t.canvases.is_empty() || t.next().is_some())
    }

    pub fn generation(&self, plane: usize) -> u64 {
        self.targets.get(&plane).map_or(0, |t| t.generation)
    }

    pub fn canvases(&self, plane: usize) -> impl Iterator<Item = &Dmabuf> {
        self.targets.get(&plane).into_iter().flat_map(|t| t.canvases.iter().map(|c| &c.dmabuf))
    }

    pub fn hold(&mut self, plane: usize, canvas: usize, held: bool) {
        if let Some(c) = self.targets.get_mut(&plane).and_then(|t| t.canvases.get_mut(canvas)) {
            c.held = held;
        }
    }

    pub fn release(&mut self, plane: usize) {
        if self.targets.remove(&plane).is_some() {
            let _ = self.jobs.send(Job::Release(plane));
        }
    }

    pub fn draw(&mut self, sheets: Vec<(usize, Sheet, (u32, u32))>, trace: Option<acde_log::Trace>) -> Result<Option<u64>, String> {
        if self.busy() || self.failed() {
            return Ok(None);
        }
        let frame = self.frames + 1;
        let mut passes = Vec::new();
        let mut drawn = Vec::new();
        for (plane, sheet, size) in sheets {
            if size.0 == 0 || size.1 == 0 {
                continue;
            }
            let full = Rectangle::from_size((size.0 as i32, size.1 as i32).into());
            let fresh = self.targets.get(&plane).is_none_or(|t| t.size != size || t.stale);
            if !fresh && (sheet.parts.is_empty() || sheet.damage.is_empty()) {
                continue;
            }
            let damage = (!fresh).then(|| Target::spread(&sheet.parts, sheet.damage, full));
            if let Err(e) = self.ensure(plane, size) {
                for d in &drawn {
                    self.discard(d);
                }
                return Err(e);
            }
            let target = self.targets.get_mut(&plane).expect("ensured");
            let Some(next) = target.next() else { continue };
            let targets = damage.as_deref().filter(|_| !self.full).and_then(|d| target.region(next, &sheet.parts, d, full));
            log::trace!("网页重画 plane={plane} parts={} damage={damage:?} regions={targets:?}", sheet.parts.len());
            target.canvases[next].held = true;
            target.stale = false;
            let regions = targets.as_ref().map(|t| t.iter().map(Pixels::px).collect());
            passes.push(Pass { plane, size, parts: sheet.parts, next, targets: regions });
            drawn.push(Drawn { plane, canvas: next, frame, generation: target.generation, size, damage });
        }
        if passes.is_empty() {
            return Ok(None);
        }
        if self.jobs.send(Job::Draw(passes)).is_err() {
            for d in &drawn {
                self.discard(d);
            }
            return Err("光栅化线程退出了".to_string());
        }
        self.frames = frame;
        self.inflight = Some(Inflight { drawn, started: Instant::now(), trace });
        Ok(Some(frame))
    }

    pub fn finish(&mut self) -> Option<Finished> {
        let done = self.done.try_recv().ok()?;
        let inflight = self.inflight.take()?;
        let fence = match done {
            Ok(fence) => fence,
            Err(e) => {
                log::warn!("网页光栅化: {e}");
                for d in &inflight.drawn {
                    self.discard(d);
                }
                return None;
            }
        };
        for d in &inflight.drawn {
            let Some(target) = self.targets.get_mut(&d.plane).filter(|t| t.generation == d.generation) else { continue };
            let full = Rectangle::from_size((target.size.0 as i32, target.size.1 as i32).into());
            target.current = d.canvas;
            match &d.damage {
                Some(rects) => target.damage.add(rects.iter().copied()),
                None => target.damage.add([full]),
            }
            target.canvases[d.canvas].drawn = Some(target.damage.current_commit());
        }
        Some(Finished { drawn: inflight.drawn, fence, took: inflight.started.elapsed(), trace: inflight.trace })
    }

    pub fn discard(&mut self, drawn: &Drawn) {
        if let Some(target) = self.targets.get_mut(&drawn.plane).filter(|t| t.generation == drawn.generation) {
            target.canvases[drawn.canvas].held = false;
            for canvas in &mut target.canvases {
                canvas.drawn = None;
            }
            target.stale = true;
        }
        self.dropped = true;
    }

    pub fn icon(&mut self, scene: acde_render::acgpu::Scene, (w, h): (u32, u32)) -> Result<Dmabuf, String> {
        if self.failed() {
            return Err("网页图层不可用".to_string());
        }
        let bo = self.allocator.create_buffer(w, h, FORMAT, &[Modifier::Linear]).map_err(|e| format!("GBM 分配: {e}"))?;
        let dmabuf = bo.export().map_err(|e| format!("导出 dmabuf: {e}"))?;
        let (reply, answer) = mpsc::channel();
        self.jobs.send(Job::Icon { dmabuf: dmabuf.clone(), size: (w, h), scene, reply }).map_err(|_| "光栅化线程退出了".to_string())?;
        answer.recv_timeout(Duration::from_secs(3)).map_err(|_| "光栅化线程没有回应".to_string())??;
        Ok(dmabuf)
    }

    pub fn take_dropped(&mut self) -> bool {
        std::mem::take(&mut self.dropped)
    }

    fn ensure(&mut self, plane: usize, size: (u32, u32)) -> Result<(), String> {
        if self.targets.get(&plane).is_some_and(|t| t.size == size && !t.canvases.is_empty()) {
            return Ok(());
        }
        if let Some(target) = self.targets.get_mut(&plane).filter(|t| !t.canvases.is_empty() && Self::padded(t.size) == Self::padded(size)) {
            target.size = size;
            for canvas in &mut target.canvases {
                canvas.drawn = None;
            }
            return Ok(());
        }
        let (w, h) = Self::padded(size);
        let fresh = (0..CANVASES)
            .map(|_| {
                let bo = self.allocator.create_buffer(w, h, FORMAT, &[Modifier::Linear]).map_err(|e| format!("GBM 分配: {e}"))?;
                let dmabuf = bo.export().map_err(|e| format!("导出 dmabuf: {e}"))?;
                Ok(Canvas { dmabuf, drawn: None, held: false })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let _ = self.jobs.send(Job::Canvases(plane, fresh.iter().map(|c| c.dmabuf.clone()).collect(), (w, h)));
        self.generation += 1;
        self.targets.insert(plane, Target { canvases: fresh, size, current: 0, damage: DamageBag::new(8), generation: self.generation, stale: false });
        Ok(())
    }

    fn padded((w, h): (u32, u32)) -> (u32, u32) {
        (w.div_ceil(PAD) * PAD, h.div_ceil(PAD) * PAD)
    }
}
