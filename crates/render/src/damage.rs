use std::collections::{HashMap, HashSet};

use acde_gpu::RenderCommand;
use blitz_dom::NodeId;
use blitz_paint::{Change, PaintCache, Run};
use kurbo::{Affine, Rect, Shape};

use crate::Plane;
use crate::commands::Commands;
use crate::layers::Split;

const PAD: f64 = 2.0;

#[derive(Default)]
pub(crate) struct Damage {
    previous: Option<Previous>,
    draw: Vec<Rect>,
    sequence: Option<u64>,
}

struct Previous {
    kinds: Vec<Kind>,
    loose: HashMap<usize, RenderCommand>,
    commands: Option<Vec<RenderCommand>>,
    viewport: Rect,
    tolerance: f64,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Push { clip: Rect, filter: bool, backdrop: bool },
    Pop,
    Draw,
}

impl Kind {
    pub(crate) fn of(command: &RenderCommand, t: Affine) -> Self {
        match command {
            RenderCommand::PushLayer(l) => Kind::Push {
                clip: (t * l.transform).transform_rect_bbox(l.clip.bounding_box()),
                filter: l.filter.is_some() || l.backdrop_filter.is_some(),
                backdrop: l.backdrop_filter.is_some(),
            },
            RenderCommand::PushClipLayer(c) => {
                Kind::Push { clip: (t * c.transform).transform_rect_bbox(c.clip.bounding_box()), filter: false, backdrop: false }
            }
            RenderCommand::PopLayer => Kind::Pop,
            _ => Kind::Draw,
        }
    }
}

const WINDOW: usize = 48;

const MAX_RECTS: usize = 8;

struct Changed<'a> {
    kinds: &'a [Kind],
    draw: &'a [Rect],
    mask: Option<&'a [bool]>,
    layers: bool,
}

struct Layer {
    bounds: Rect,
    filter: bool,
}

impl Damage {
    pub(crate) fn update(&mut self, b: &Commands, tolerance: f64, viewport: Rect, cache: Option<&PaintCache>, verify: bool) -> (Vec<Rect>, bool, bool) {
        let given = cache;
        let sequence = std::mem::replace(&mut self.sequence, cache.map(PaintCache::sequence));
        let cache = cache.filter(|c| self.previous.is_some() && c.previous().is_some() && c.previous() == sequence);
        let draw = match cache {
            Some(cache) => Self::reuse_draw(cache, &self.draw, b),
            None => b.iter().map(|(c, t)| draw_bounds(c, t)).collect(),
        };
        let old_draw = std::mem::replace(&mut self.draw, draw);
        let kinds: Vec<Kind> = b.iter().map(|(c, t)| Kind::of(c, t)).collect();
        let loose: HashMap<usize, RenderCommand> = match given {
            Some(c) => Self::uncovered(c.runs(), b.len()).filter_map(|i| Some((i, Self::placed_at(b, i)?))).collect(),
            None => HashMap::new(),
        };
        let previous = self.previous.replace(Previous { kinds, loose, commands: verify.then(|| b.to_vec()), viewport, tolerance });
        let new = self.previous.as_ref().expect("just stored");
        let Some(old) = previous else {
            return (vec![viewport], false, false);
        };
        if old.viewport != viewport || old.tolerance != tolerance {
            return (vec![viewport], false, false);
        }
        let draws = (&old_draw[..], &self.draw[..]);
        let kinds = (&old.kinds[..], &new.kinds[..]);
        let Some(cache) = cache else {
            return match (&old.commands, &new.commands) {
                (Some(a), Some(b)) => (Self::rects(kinds, draws, Self::diff(a, b), viewport), false, false),
                _ => (vec![viewport], false, false),
            };
        };
        let rects = Self::rects(kinds, draws, Self::by_fragment(cache, (old.kinds.len(), &old.loose), b), viewport);
        let (Some(a), Some(b)) = (old.commands.as_ref(), new.commands.as_deref()) else {
            return (rects, true, false);
        };
        if log::log_enabled!(log::Level::Trace) {
            let reference = Self::rects(kinds, draws, Self::diff(a, b), viewport);
            log::trace!("按片段 {rects:?}, 整帧逐条比 {reference:?}");
        }
        let Some((i, j)) = Self::unchanged_claims_fail(cache, a, b) else {
            return (rects, true, false);
        };
        log::warn!(
            "按片段算脏区时说没变的命令变了: 这一帧第 {j} 条 (片段 {:?}) / 上一帧第 {i} 条\n  上一帧: {:?}\n  这一帧: {:?}",
            cache.owner(j),
            a.get(i),
            b.get(j),
        );
        let reference = Self::rects(kinds, draws, Self::diff(a, b), viewport);
        let merged = Self::merge(rects.into_iter().chain(reference).collect());
        (merged.into_iter().map(|r| r.intersect(viewport)).collect(), true, true)
    }

    fn placed_at(b: &Commands, i: usize) -> Option<RenderCommand> {
        b.get(i).map(|(c, t)| Commands::placed(c, t))
    }

    fn uncovered(runs: &[blitz_paint::Run], len: usize) -> impl Iterator<Item = usize> {
        let mut covered = vec![false; len];
        for run in runs {
            if let Some(c) = covered.get_mut(run.start..run.start + run.len) {
                c.fill(true);
            }
        }
        (0..len).filter(move |&i| !covered[i])
    }

    fn unchanged(cache: &PaintCache) -> Vec<(usize, Option<usize>, usize)> {
        let key = |r: &Run| (r.node.as_u64(), r.local);
        let mut old: Vec<&Run> = cache.previous_runs().iter().collect();
        old.sort_unstable_by_key(|r| key(r));
        let mut out = Vec::new();
        for run in cache.runs().iter().filter(|r| matches!(cache.change(r.node), Change::Same)) {
            let (node, end) = (run.node.as_u64(), run.local + run.len);
            let mut local = run.local;
            while local < end {
                let k = old.partition_point(|r| key(r) <= (node, local));
                let found = k.checked_sub(1).map(|k| old[k]).filter(|r| r.node == run.node && local < r.local + r.len);
                let (from, len) = match found {
                    Some(r) => (Some(r.start + (local - r.local)), (r.local + r.len).min(end) - local),
                    None => (None, old.get(k).filter(|r| r.node == run.node).map_or(end, |r| r.local.min(end)) - local),
                };
                out.push((run.start + (local - run.local), from, len));
                local += len;
            }
        }
        out.sort_unstable_by_key(|&(j, ..)| j);
        out
    }

    fn unchanged_claims_fail(cache: &PaintCache, a: &[RenderCommand], b: &[RenderCommand]) -> Option<(usize, usize)> {
        Self::unchanged(cache).into_iter().find_map(|(j, i, len)| {
            (0..len).find_map(|k| match i {
                Some(i) if a.get(i + k) == b.get(j + k) => None,
                Some(i) => Some((i + k, j + k)),
                None => Some((usize::MAX, j + k)),
            })
        })
    }

    fn reuse_draw(cache: &PaintCache, old: &[Rect], commands: &Commands) -> Vec<Rect> {
        let mut draw = Vec::with_capacity(commands.len());
        let fresh = |draw: &mut Vec<Rect>, end: usize| {
            let start = draw.len();
            draw.extend(commands.iter_range(start..end).map(|(c, t)| draw_bounds(c, t)));
        };
        for (j, i, len) in Self::unchanged(cache) {
            let end = (j + len).min(commands.len());
            if j < draw.len() || j >= end {
                continue;
            }
            fresh(&mut draw, j);
            match i.and_then(|i| old.get(i..i + (end - j))) {
                Some(same) => draw.extend_from_slice(same),
                None => fresh(&mut draw, end),
            }
        }
        fresh(&mut draw, commands.len());
        draw
    }

    pub(crate) fn draw(&self) -> &[Rect] {
        &self.draw
    }

    pub(crate) fn kinds(&self) -> &[Kind] {
        self.previous.as_ref().map_or(&[], |p| &p.kinds)
    }

    fn rects((a, b): (&[Kind], &[Kind]), (da, db): (&[Rect], &[Rect]), (ma, mb): (Vec<bool>, Vec<bool>), viewport: Rect) -> Vec<Rect> {
        let mut rects: Vec<Rect> =
            [Changed { kinds: a, draw: da, mask: Some(&ma), layers: true }, Changed { kinds: b, draw: db, mask: Some(&mb), layers: true }]
                .iter()
                .flat_map(|c| c.rects(viewport))
                .collect();
        let backdrops: Vec<Rect> = [a, b]
            .into_iter()
            .flatten()
            .filter_map(|k| match k {
                Kind::Push { clip, backdrop: true, .. } => Some(*clip),
                _ => None,
            })
            .collect();
        let hit: Vec<Rect> = backdrops.into_iter().filter(|r| rects.iter().any(|d| r.overlaps(*d))).collect();
        rects.extend(hit);
        Self::merge(rects).into_iter().map(|r| r.inflate(PAD, PAD).intersect(viewport)).filter(|r| r.area() > 0.0).collect()
    }

    fn merge(rects: Vec<Rect>) -> Vec<Rect> {
        let mut out: Vec<Rect> = Vec::new();
        for r in rects {
            let mut r = r.inflate(PAD, PAD);
            while let Some(k) = out.iter().position(|o| o.overlaps(r)) {
                r = r.union(out.swap_remove(k));
            }
            out.push(r);
        }
        if out.len() > MAX_RECTS * 8 {
            return out.into_iter().reduce(|x, y| x.union(y)).into_iter().collect();
        }
        while out.len() > MAX_RECTS {
            let waste = |x: Rect, y: Rect| x.union(y).area() - x.area() - y.area();
            let (i, j) = (0..out.len())
                .flat_map(|i| (i + 1..out.len()).map(move |j| (i, j)))
                .min_by(|&(a, b), &(c, d)| waste(out[a], out[b]).total_cmp(&waste(out[c], out[d])))
                .unwrap();
            let taken = out.swap_remove(j);
            out[i] = out[i].union(taken);
        }
        out
    }

    fn by_fragment(cache: &PaintCache, (old_len, old_loose): (usize, &HashMap<usize, RenderCommand>), b: &Commands) -> (Vec<bool>, Vec<bool>) {
        let (mut ma, mut mb) = (vec![false; old_len], vec![false; b.len()]);
        let reordered = Self::reordered(cache);
        let mut diffs: HashMap<NodeId, (Vec<bool>, Vec<bool>)> = HashMap::new();
        for (runs, mask, old_side) in [(cache.previous_runs(), &mut ma, true), (cache.runs(), &mut mb, false)] {
            let mut covered = vec![false; mask.len()];
            for run in runs {
                let Some(dst) = mask.get_mut(run.start..run.start + run.len) else {
                    mask.fill(true);
                    break;
                };
                covered[run.start..run.start + run.len].fill(true);
                match cache.change(run.node) {
                    _ if reordered.contains(&run.node) => dst.fill(true),
                    Change::Same => {}
                    Change::Moved => dst.fill(true),
                    Change::Recorded { old, new } => {
                        let (da, db) = diffs.entry(run.node).or_insert_with(|| Self::diff(old, new));
                        let src = if old_side { &da[..] } else { &db[..] };
                        match src.get(run.local..run.local + run.len) {
                            Some(src) => dst.copy_from_slice(src),
                            None => dst.fill(true),
                        }
                    }
                }
            }
            for (i, _) in covered.iter().enumerate().filter(|(_, c)| !**c) {
                let now = Self::placed_at(b, i);
                mask[i] |= match old_side {
                    true => old_loose.get(&i).is_none_or(|c| now.as_ref() != Some(c)),
                    false => old_loose.get(&i) != now.as_ref(),
                };
            }
        }
        (ma, mb)
    }

    fn reordered(cache: &PaintCache) -> HashSet<NodeId> {
        let firsts = |runs: &[blitz_paint::Run]| {
            let mut seen = HashSet::new();
            runs.iter().filter(|r| seen.insert(r.node)).map(|r| r.node).collect::<Vec<_>>()
        };
        let old: HashMap<NodeId, usize> = firsts(cache.previous_runs()).into_iter().enumerate().map(|(i, n)| (n, i)).collect();
        let seq: Vec<(NodeId, usize)> = firsts(cache.runs()).into_iter().filter_map(|n| old.get(&n).map(|&p| (n, p))).collect();
        let (mut tails, mut prev): (Vec<usize>, Vec<Option<usize>>) = (Vec::new(), vec![None; seq.len()]);
        for (i, &(_, p)) in seq.iter().enumerate() {
            let k = tails.partition_point(|&t| seq[t].1 < p);
            prev[i] = k.checked_sub(1).map(|k| tails[k]);
            match tails.get_mut(k) {
                Some(t) => *t = i,
                None => tails.push(i),
            }
        }
        let mut kept = HashSet::new();
        let mut at = tails.last().copied();
        while let Some(i) = at {
            kept.insert(seq[i].0);
            at = prev[i];
        }
        seq.into_iter().map(|(n, _)| n).filter(|n| !kept.contains(n)).collect()
    }

    fn depths(commands: &[RenderCommand]) -> Vec<usize> {
        let mut depth = 0usize;
        commands
            .iter()
            .map(|c| {
                let here = depth;
                match c {
                    RenderCommand::PushLayer(_) | RenderCommand::PushClipLayer(_) => depth += 1,
                    RenderCommand::PopLayer => depth = depth.saturating_sub(1),
                    _ => {}
                }
                here
            })
            .collect()
    }

    fn diff(a: &[RenderCommand], b: &[RenderCommand]) -> (Vec<bool>, Vec<bool>) {
        let (da, db) = (Self::depths(a), Self::depths(b));
        let same = |i: usize, j: usize| da[i] == db[j] && a[i] == b[j];
        let (mut ma, mut mb) = (vec![false; a.len()], vec![false; b.len()]);
        let (mut i, mut j) = (0, 0);
        while i < a.len() && j < b.len() {
            if same(i, j) {
                i += 1;
                j += 1;
                continue;
            }
            let resync = (1..=2 * WINDOW).find_map(|sum| {
                (sum.saturating_sub(WINDOW)..=sum.min(WINDOW))
                    .map(|di| (di, sum - di))
                    .find(|&(di, dj)| i + di < a.len() && j + dj < b.len() && same(i + di, j + dj))
            });
            let Some((di, dj)) = resync else { break };
            ma[i..i + di].fill(true);
            mb[j..j + dj].fill(true);
            i += di;
            j += dj;
        }
        ma[i..].fill(true);
        mb[j..].fill(true);
        (ma, mb)
    }

    pub(crate) fn content_bounds(kinds: &[Kind], draw: &[Rect], viewport: Rect) -> Option<Rect> {
        let bounds = Self::bounds_of(kinds, draw, viewport)?;
        Some(bounds.inflate(PAD, PAD).intersect(viewport))
    }

    pub(crate) fn painted_bounds(commands: &[RenderCommand], viewport: Rect) -> Option<Rect> {
        let kinds: Vec<Kind> = commands.iter().map(|c| Kind::of(c, Affine::IDENTITY)).collect();
        let draw: Vec<Rect> = commands.iter().map(|c| draw_bounds(c, Affine::IDENTITY)).collect();
        Self::bounds_of(&kinds, &draw, viewport)
    }

    fn bounds_of(kinds: &[Kind], draw: &[Rect], viewport: Rect) -> Option<Rect> {
        Changed { kinds, draw, mask: None, layers: false }.bounds(viewport)
    }
}

impl Damage {
    pub(crate) fn plane(&mut self, commands: Commands, rects: Vec<Rect>, scale: f64, viewport: Rect) -> Plane {
        let tolerance = acde_gpu::Scene::new().tolerance;
        let union = rects.iter().copied().reduce(|x, y| x.union(y)).unwrap_or(Rect::ZERO);
        let bounds = Damage::content_bounds(self.kinds(), self.draw(), viewport).map(crate::Rect::from);
        let (commands, layers, draw) = match Split::layers(commands, tolerance, self.kinds(), self.draw(), scale, viewport) {
            Ok(layers) => (Commands::default(), layers, Vec::new()),
            Err(commands) => (commands, Vec::new(), self.draw().to_vec()),
        };
        Plane { commands, tolerance, layers, damage: union.into(), damage_rects: rects.into_iter().map(crate::Rect::from).collect(), bounds, draw }
    }
}

impl Changed<'_> {
    fn bounds(&self, viewport: Rect) -> Option<Rect> {
        self.rects(viewport).into_iter().reduce(|x, y| x.union(y))
    }

    fn rects(&self, viewport: Rect) -> Vec<Rect> {
        let mut stack = vec![Layer { bounds: viewport, filter: false }];
        let mut damage: Vec<Rect> = Vec::new();
        let mut add = |r: Rect| {
            if r.area() > 0.0 {
                damage.push(r);
            }
        };
        let end = match self.mask {
            Some(mask) => mask.iter().rposition(|&m| m).map_or(0, |i| i + 1),
            None => self.kinds.len(),
        };
        for (i, kind) in self.kinds[..end].iter().enumerate() {
            let inside = self.mask.is_none_or(|m| m[i]);
            let layer_inside = inside && self.layers;
            let top = stack.last().unwrap();
            let spread = stack.iter().find(|l| l.filter).map(|l| l.bounds);
            match *kind {
                Kind::Push { clip, filter, .. } => {
                    let bounds = clip.intersect(top.bounds);
                    if layer_inside {
                        add(spread.unwrap_or(bounds));
                    }
                    stack.push(Layer { bounds, filter });
                }
                Kind::Pop => {
                    if stack.len() > 1 {
                        stack.pop();
                    }
                }
                Kind::Draw if inside => add(spread.unwrap_or_else(|| self.draw[i].intersect(top.bounds))),
                Kind::Draw => {}
            }
        }
        damage
    }
}

pub(crate) fn draw_bounds(command: &RenderCommand, t: Affine) -> Rect {
    match command {
        RenderCommand::Fill(f) => (t * f.transform).transform_rect_bbox(f.shape.bounding_box()),
        RenderCommand::Stroke(s) => {
            let out = s.style.width * s.style.miter_limit.max(1.0) / 2.0;
            (t * s.transform).transform_rect_bbox(s.shape.bounding_box().inflate(out, out))
        }
        RenderCommand::GlyphRun(g) => {
            let (fs, bold) = (f64::from(g.font_size), g.embolden.x.abs().max(g.embolden.y.abs()));
            let origins = g.glyphs.iter().map(|gl| Rect::new(gl.x.into(), gl.y.into(), gl.x.into(), gl.y.into()));
            let Some(origins) = origins.reduce(|a, b| a.union(b)) else {
                return Rect::ZERO;
            };
            let run = Rect::new(origins.x0 - fs, origins.y0 - 2.0 * fs, origins.x1 + 2.0 * fs, origins.y1 + fs);
            let run = g.glyph_transform.map_or(run, |t| t.transform_rect_bbox(run));
            (t * g.transform).transform_rect_bbox(run.inflate(bold, bold))
        }
        RenderCommand::BoxShadow(b) => {
            let out = b.radius + 3.0 * b.std_dev;
            (t * b.transform).transform_rect_bbox(b.rect.inflate(out, out))
        }
        _ => Rect::ZERO,
    }
}
