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

use crate::plane::{Pixels, Rect, Sheet};
use crate::raster::{Done, Job, Pass, Raster, Status};

const FORMAT: Fourcc = Fourcc::Abgr8888;
const PAD: u32 = 64;
const CANVASES: usize = 3;

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
    status: std::sync::Arc<Status>,
    targets: HashMap<usize, Target>,
    inflight: Option<Inflight>,
    generation: u64,
    full: bool,
    dropped: bool,
    frames: u64,
}

impl Target {
    fn spread(parts: &[crate::plane::Part], mut damage: Vec<Rect>, full: Rect) -> Vec<Rect> {
        const MAX: usize = 48;
        let reads: Vec<Rect> = parts.iter().filter_map(|p| p.backdrop.map(|b| Rect::covering(b.rect))).filter_map(|r| r.intersection(full)).collect();
        let mut changed = true;
        while changed && damage.len() <= MAX {
            changed = false;
            for read in &reads {
                if damage.iter().any(|r| r.overlaps(*read)) {
                    let pieces = read.subtract_rects(damage.iter().copied());
                    changed |= !pieces.is_empty();
                    damage.extend(pieces);
                }
            }
        }
        damage
    }

    fn next(&self) -> Option<usize> {
        (1..=self.canvases.len()).map(|k| (self.current + k) % self.canvases.len()).find(|&i| i != self.current && !self.canvases[i].held)
    }

    fn region(&self, index: usize, parts: &[crate::plane::Part], damage: Option<&[Rect]>, full: Rect, whole: bool) -> Option<Vec<Rect>> {
        const MAX: usize = 48;
        if whole {
            return None;
        }
        let since = self.damage.damage_since(Some(self.canvases[index].drawn?))?;
        let reads: Vec<Rect> = parts.iter().filter_map(|p| p.backdrop.map(|b| Rect::covering(b.rect))).filter_map(|r| r.intersection(full)).collect();
        let mut regions: Vec<Rect> = Vec::new();
        let add = |regions: &mut Vec<Rect>, r: Rect| {
            let pieces = r.subtract_rects(regions.iter().copied());
            regions.extend(pieces.iter().copied());
            !pieces.is_empty()
        };
        for r in damage?.iter().chain(since.iter()).filter_map(|r| r.intersection(full)) {
            add(&mut regions, r);
        }
        let mut changed = true;
        while changed && regions.len() <= MAX {
            changed = false;
            for read in &reads {
                if regions.iter().any(|r| r.overlaps(*read)) {
                    changed |= add(&mut regions, *read);
                }
            }
        }
        let area: i32 = regions.iter().map(|r| r.size.w * r.size.h).sum();
        (regions.len() <= MAX && area * 2 < full.size.w * full.size.h).then_some(regions)
    }
}

impl Painter {
    pub fn new(gbm: gbm::Device<DeviceFd>, waker: Ping) -> Result<Self, String> {
        let (jobs, jobs_rx) = mpsc::channel();
        let (done_tx, done) = mpsc::channel();
        let status = std::sync::Arc::new(Status::default());
        Raster::spawn(jobs_rx, done_tx, status.clone(), waker).map_err(|e| format!("光栅化线程: {e}"))?;
        Ok(Self {
            jobs,
            done,
            allocator: GbmAllocator::new(gbm, GbmBufferFlags::RENDERING),
            status,
            targets: HashMap::new(),
            inflight: None,
            generation: 0,
            full: std::env::var_os("ACDE_WEB_FULL").is_some(),
            dropped: false,
            frames: 0,
        })
    }

    fn failed(&self) -> bool {
        self.status.ready.get() == Some(&false)
    }

    pub fn busy(&self) -> bool {
        self.inflight.is_some()
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

    pub fn size(&self, plane: usize) -> (u32, u32) {
        self.targets.get(&plane).map_or((0, 0), |t| t.size)
    }

    pub fn hold(&mut self, plane: usize, canvas: usize, held: bool) {
        if let Some(c) = self.targets.get_mut(&plane).and_then(|t| t.canvases.get_mut(canvas)) {
            c.held = held;
        }
    }

    pub fn release(&mut self, plane: usize) {
        if self.targets.remove(&plane).is_some() {
            let _ = self.jobs.send(Job::Release(vec![plane]));
        }
    }

    pub fn draw(&mut self, sheets: Vec<(usize, Sheet, (u32, u32))>, trace: Option<acde_log::Trace>) -> Result<Option<u64>, String> {
        if self.busy() || self.failed() {
            return Ok(None);
        }
        let frame = self.frames + 1;
        let mut surfaces = Vec::new();
        let mut drawn = Vec::new();
        for (plane, sheet, size) in sheets {
            if size.0 == 0 || size.1 == 0 {
                continue;
            }
            let full = Rectangle::from_size((size.0 as i32, size.1 as i32).into());
            let damage = sheet.damage.map(|d| d.into_iter().filter(|r| !r.is_empty()).collect::<Vec<_>>());
            let fresh = self.targets.get(&plane).is_none_or(|t| t.size != size || t.stale);
            if !fresh && (sheet.parts.is_empty() || damage.as_ref().is_some_and(Vec::is_empty)) {
                continue;
            }
            let damage = if fresh { None } else { damage.map(|d| Target::spread(&sheet.parts, d, full)) };
            if let Err(e) = self.ensure(plane, size) {
                for d in &drawn {
                    self.discard(d);
                }
                return Err(e);
            }
            let whole = self.full || damage.is_none();
            let target = self.targets.get_mut(&plane).expect("ensured");
            let Some(next) = target.next() else { continue };
            let targets = target.region(next, &sheet.parts, damage.as_deref(), full, whole);
            log::trace!("网页重画 plane={plane} parts={} damage={damage:?} regions={targets:?}", sheet.parts.len());
            target.canvases[next].held = true;
            target.stale = false;
            surfaces.push((vec![Pass { plane, parts: sheet.parts, next, targets }], size));
            drawn.push(Drawn { plane, canvas: next, frame, generation: target.generation, size, damage });
        }
        if surfaces.is_empty() {
            return Ok(None);
        }
        if self.jobs.send(Job::Draw { surfaces }).is_err() {
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
        let (fence, partial) = match done {
            Ok(drew) => (drew.fence, drew.partial),
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
            target.canvases[d.canvas].drawn = (!partial).then(|| target.damage.current_commit());
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

    pub fn icon(&mut self, scene: acde_render::anyrender::Scene, (w, h): (u32, u32)) -> Result<Dmabuf, String> {
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
