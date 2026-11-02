use std::fs::File;
use std::os::fd::AsFd;
use std::time::{Duration, Instant};

use memmap2::MmapMut;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{MemfdFlags, ftruncate, memfd_create};
use rustix::time::{ClockId, clock_gettime};
use wayland_client::protocol::{wl_buffer, wl_callback, wl_compositor, wl_registry, wl_shm, wl_shm_pool, wl_surface};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle, WEnum, delegate_noop};
use wayland_protocols::wp::presentation_time::client::{wp_presentation, wp_presentation_feedback};
use wayland_protocols::xdg::decoration::zv1::client::{zxdg_decoration_manager_v1, zxdg_toplevel_decoration_v1};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

use wp_presentation_feedback::Kind;

struct Args {
    seconds: u64,
    size: (i32, i32),
    label: String,
    fullscreen: bool,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut args = Args { seconds: 0, size: (640, 360), label: String::new(), fullscreen: false };
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            let mut value = || it.next().ok_or(format!("{arg} needs a value"));
            match arg.as_str() {
                "--seconds" => args.seconds = value()?.parse().map_err(|_| "--seconds takes a number")?,
                "--label" => args.label = value()?,
                "--fullscreen" => args.fullscreen = true,
                "--size" => {
                    let v = value()?;
                    let (w, h) = v.split_once('x').ok_or("--size takes WxH")?;
                    args.size = (w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?);
                }
                "-h" | "--help" => {
                    println!("fps-probe [--seconds N] [--size WxH] [--label NAME] [--fullscreen]");
                    std::process::exit(0);
                }
                _ => return Err(format!("unknown option {arg}")),
            }
        }
        Ok(args)
    }
}

#[derive(Default)]
struct Stats {
    callbacks: u64,
    commits: u64,
    presented: u64,
    discarded: u64,
    missed: u64,
    vsync: u64,
    hw_clock: u64,
    zero_copy: u64,
    intervals: Vec<f64>,
    latency: Vec<f64>,
}

impl Stats {
    fn add(&mut self, other: &Stats) {
        self.callbacks += other.callbacks;
        self.commits += other.commits;
        self.presented += other.presented;
        self.discarded += other.discarded;
        self.missed += other.missed;
        self.vsync += other.vsync;
        self.hw_clock += other.hw_clock;
        self.zero_copy += other.zero_copy;
        self.intervals.extend_from_slice(&other.intervals);
        self.latency.extend_from_slice(&other.latency);
    }

    fn percentiles(values: &[f64]) -> String {
        if values.is_empty() {
            return "null".into();
        }
        let mut v = values.to_vec();
        v.sort_by(f64::total_cmp);
        let at = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        format!("{{\"mean\":{mean:.2},\"p50\":{:.2},\"p95\":{:.2},\"p99\":{:.2},\"max\":{:.2}}}", at(0.5), at(0.95), at(0.99), at(1.0))
    }

    fn json(&self, probe: &Probe, seconds: f64, summary: bool) -> String {
        let per = |n: u64| n as f64 / seconds.max(1e-9);
        let refresh = match probe.refresh_ns {
            0 => "null".into(),
            ns => format!("{:.2}", 1e9 / f64::from(ns)),
        };
        format!(
            "{{\"label\":{:?},\"desktop\":{:?},\"summary\":{summary},\"seconds\":{seconds:.2},\"size\":[{},{}],\"refreshHz\":{refresh},\
             \"fps\":{:.2},\"callbacksPerSecond\":{:.2},\"commits\":{},\"presented\":{},\"discarded\":{},\"missedVblanks\":{},\
             \"intervalMs\":{},\"latencyMs\":{},\"flags\":{{\"vsync\":{},\"hwClock\":{},\"zeroCopy\":{}}}}}",
            probe.label,
            probe.desktop,
            probe.size.0,
            probe.size.1,
            per(self.presented),
            per(self.callbacks),
            self.commits,
            self.presented,
            self.discarded,
            self.missed,
            Self::percentiles(&self.intervals),
            Self::percentiles(&self.latency),
            self.vsync,
            self.hw_clock,
            self.zero_copy,
        )
    }
}

struct Buffer {
    buffer: wl_buffer::WlBuffer,
    map: MmapMut,
    busy: bool,
}

struct Probe {
    label: String,
    desktop: String,
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    wm_base: Option<xdg_wm_base::XdgWmBase>,
    presentation: Option<wp_presentation::WpPresentation>,
    decorations: Option<zxdg_decoration_manager_v1::ZxdgDecorationManagerV1>,
    surface: Option<wl_surface::WlSurface>,
    clock: ClockId,
    size: (i32, i32),
    pending_size: Option<(i32, i32)>,
    configured: bool,
    closed: bool,
    waiting: bool,
    buffers: Vec<Buffer>,
    frame: u64,
    last_presented: Option<(u64, u64)>,
    refresh_ns: u32,
    window: Stats,
    total: Stats,
}

impl Probe {
    fn now_ns(&self) -> u64 {
        let t = clock_gettime(self.clock);
        t.tv_sec as u64 * 1_000_000_000 + t.tv_nsec as u64
    }

    fn resize(&mut self, qh: &QueueHandle<Self>) -> Result<(), String> {
        for b in self.buffers.drain(..) {
            b.buffer.destroy();
        }
        let shm = self.shm.as_ref().ok_or("no wl_shm")?;
        let (w, h) = self.size;
        let len = (w * h * 4) as usize;
        for index in 0..3 {
            let fd = memfd_create(c"fps-probe", MemfdFlags::CLOEXEC).map_err(|e| format!("memfd: {e}"))?;
            ftruncate(&fd, len as u64).map_err(|e| format!("ftruncate: {e}"))?;
            let file = File::from(fd);
            let map = unsafe { MmapMut::map_mut(&file) }.map_err(|e| format!("mmap: {e}"))?;
            let pool = shm.create_pool(file.as_fd(), len as i32, qh, ());
            let buffer = pool.create_buffer(0, w, h, w * 4, wl_shm::Format::Xrgb8888, qh, index);
            pool.destroy();
            self.buffers.push(Buffer { buffer, map, busy: false });
        }
        Ok(())
    }

    fn paint(pixels: &mut [u8], (w, h): (i32, i32), frame: u64) {
        let phase = (frame % 240) as f64 / 240.0;
        let bar = (phase * f64::from(w)) as i32;
        let base = [(40.0 + 60.0 * phase) as u8, (90.0 - 50.0 * phase) as u8, (150.0 + 80.0 * phase) as u8];
        for (y, row) in pixels.chunks_exact_mut((w * 4) as usize).enumerate() {
            let band = (y as i32 * 8 / h.max(1)) as u8;
            for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let on_bar = (x as i32 - bar).rem_euclid(w) < 24;
                let shade = if on_bar { [255, 255, 255] } else { [base[0].wrapping_add(band * 6), base[1], base[2]] };
                *px = [shade[2], shade[1], shade[0], 255];
            }
        }
    }

    fn draw(&mut self, qh: &QueueHandle<Self>) {
        let Some(index) = self.buffers.iter().position(|b| !b.busy) else { return };
        let (Some(surface), Some(presentation)) = (self.surface.clone(), self.presentation.clone()) else { return };
        let size = self.size;
        let frame = self.frame;
        let b = &mut self.buffers[index];
        Self::paint(&mut b.map, size, frame);
        b.busy = true;
        surface.attach(Some(&b.buffer), 0, 0);
        surface.damage_buffer(0, 0, size.0, size.1);
        surface.frame(qh, ());
        presentation.feedback(&surface, qh, self.now_ns());
        surface.commit();
        self.frame += 1;
        self.waiting = true;
        self.window.commits += 1;
    }

    fn presented(&mut self, at: u64, refresh: u32, seq: u64, kind: Kind, committed: u64) {
        let w = &mut self.window;
        w.presented += 1;
        w.vsync += u64::from(kind.contains(Kind::Vsync));
        w.hw_clock += u64::from(kind.contains(Kind::HwClock));
        w.zero_copy += u64::from(kind.contains(Kind::ZeroCopy));
        w.latency.push(at.saturating_sub(committed) as f64 / 1e6);
        if refresh > 0 {
            self.refresh_ns = refresh;
        }
        if let Some((last_at, last_seq)) = self.last_presented
            && at > last_at
        {
            let interval = (at - last_at) as f64;
            w.intervals.push(interval / 1e6);
            let skipped = match (seq, last_seq) {
                (s, l) if s > l && l > 0 && kind.contains(Kind::Vsync) => s - l - 1,
                _ if self.refresh_ns > 0 => (interval / f64::from(self.refresh_ns)).round().max(1.0) as u64 - 1,
                _ => 0,
            };
            w.missed += skipped;
        }
        self.last_presented = Some((at, seq));
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Probe {
    fn event(state: &mut Self, registry: &wl_registry::WlRegistry, event: wl_registry::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        let wl_registry::Event::Global { name, interface, version } = event else { return };
        match interface.as_str() {
            "wl_compositor" => state.compositor = Some(registry.bind(name, version.min(4), qh, ())),
            "wl_shm" => state.shm = Some(registry.bind(name, 1, qh, ())),
            "xdg_wm_base" => state.wm_base = Some(registry.bind(name, 1, qh, ())),
            "wp_presentation" => state.presentation = Some(registry.bind(name, 1, qh, ())),
            "zxdg_decoration_manager_v1" => state.decorations = Some(registry.bind(name, 1, qh, ())),
            _ => {}
        }
    }
}

impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Probe {
    fn event(_: &mut Self, base: &xdg_wm_base::XdgWmBase, event: xdg_wm_base::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let xdg_wm_base::Event::Ping { serial } = event {
            base.pong(serial);
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, ()> for Probe {
    fn event(state: &mut Self, surface: &xdg_surface::XdgSurface, event: xdg_surface::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        let xdg_surface::Event::Configure { serial } = event else { return };
        surface.ack_configure(serial);
        let size = state.pending_size.take().unwrap_or(state.size);
        if size != state.size || state.buffers.is_empty() {
            state.size = size;
            if let Err(e) = state.resize(qh) {
                eprintln!("fps-probe: {e}");
                state.closed = true;
            }
        }
        if !state.configured {
            state.configured = true;
            state.waiting = false;
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Probe {
    fn event(state: &mut Self, _: &xdg_toplevel::XdgToplevel, event: xdg_toplevel::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            xdg_toplevel::Event::Configure { width, height, .. } if width > 0 && height > 0 => state.pending_size = Some((width, height)),
            xdg_toplevel::Event::Close => state.closed = true,
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, ()> for Probe {
    fn event(state: &mut Self, _: &wl_callback::WlCallback, event: wl_callback::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let wl_callback::Event::Done { .. } = event {
            state.window.callbacks += 1;
            state.waiting = false;
        }
    }
}

impl Dispatch<wl_buffer::WlBuffer, usize> for Probe {
    fn event(state: &mut Self, _: &wl_buffer::WlBuffer, event: wl_buffer::Event, index: &usize, _: &Connection, _: &QueueHandle<Self>) {
        if let (wl_buffer::Event::Release, Some(b)) = (event, state.buffers.get_mut(*index)) {
            b.busy = false;
        }
    }
}

impl Dispatch<wp_presentation::WpPresentation, ()> for Probe {
    fn event(state: &mut Self, _: &wp_presentation::WpPresentation, event: wp_presentation::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let wp_presentation::Event::ClockId { clk_id } = event {
            state.clock = match clk_id {
                4 => ClockId::MonotonicRaw,
                7 => ClockId::Boottime,
                _ => ClockId::Monotonic,
            };
        }
    }
}

impl Dispatch<wp_presentation_feedback::WpPresentationFeedback, u64> for Probe {
    fn event(
        state: &mut Self,
        _: &wp_presentation_feedback::WpPresentationFeedback,
        event: wp_presentation_feedback::Event,
        committed: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wp_presentation_feedback::Event::Presented { tv_sec_hi, tv_sec_lo, tv_nsec, refresh, seq_hi, seq_lo, flags } => {
                let at = ((u64::from(tv_sec_hi) << 32) | u64::from(tv_sec_lo)) * 1_000_000_000 + u64::from(tv_nsec);
                let seq = (u64::from(seq_hi) << 32) | u64::from(seq_lo);
                let kind = match flags {
                    WEnum::Value(k) => k,
                    WEnum::Unknown(bits) => Kind::from_bits_truncate(bits),
                };
                state.presented(at, refresh, seq, kind, *committed);
            }
            wp_presentation_feedback::Event::Discarded => state.window.discarded += 1,
            _ => {}
        }
    }
}

delegate_noop!(Probe: ignore wl_compositor::WlCompositor);
delegate_noop!(Probe: ignore wl_shm::WlShm);
delegate_noop!(Probe: ignore wl_shm_pool::WlShmPool);
delegate_noop!(Probe: ignore wl_surface::WlSurface);
delegate_noop!(Probe: ignore zxdg_decoration_manager_v1::ZxdgDecorationManagerV1);
delegate_noop!(Probe: ignore zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1);

fn wait(queue: &mut EventQueue<Probe>, probe: &mut Probe, timeout: Duration) -> Result<(), String> {
    queue.flush().map_err(|e| format!("flush: {e}"))?;
    queue.dispatch_pending(probe).map_err(|e| format!("dispatch: {e}"))?;
    if let Some(guard) = queue.prepare_read() {
        let ready = {
            let fd = guard.connection_fd();
            let mut fds = [PollFd::new(&fd, PollFlags::IN)];
            let ts = Timespec { tv_sec: timeout.as_secs() as _, tv_nsec: timeout.subsec_nanos() as _ };
            poll(&mut fds, Some(&ts)).map_err(|e| format!("poll: {e}"))? > 0
        };
        if ready {
            guard.read().map_err(|e| format!("read: {e}"))?;
        }
    }
    queue.dispatch_pending(probe).map_err(|e| format!("dispatch: {e}"))?;
    Ok(())
}

fn run(args: Args) -> Result<(), String> {
    let conn = Connection::connect_to_env().map_err(|e| format!("no Wayland display: {e}"))?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let mut probe = Probe {
        label: args.label,
        desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
        compositor: None,
        shm: None,
        wm_base: None,
        presentation: None,
        decorations: None,
        surface: None,
        clock: ClockId::Monotonic,
        size: args.size,
        pending_size: None,
        configured: false,
        closed: false,
        waiting: true,
        buffers: Vec::new(),
        frame: 0,
        last_presented: None,
        refresh_ns: 0,
        window: Stats::default(),
        total: Stats::default(),
    };
    queue.roundtrip(&mut probe).map_err(|e| format!("roundtrip: {e}"))?;
    let compositor = probe.compositor.clone().ok_or("compositor has no wl_compositor")?;
    let wm_base = probe.wm_base.clone().ok_or("compositor has no xdg_wm_base")?;
    probe.presentation.as_ref().ok_or("compositor has no wp_presentation")?;
    probe.shm.as_ref().ok_or("compositor has no wl_shm")?;
    let surface = compositor.create_surface(&qh, ());
    let xdg = wm_base.get_xdg_surface(&surface, &qh, ());
    let toplevel = xdg.get_toplevel(&qh, ());
    toplevel.set_title("fps-probe".into());
    toplevel.set_app_id("fps-probe".into());
    if let Some(decorations) = &probe.decorations {
        decorations.get_toplevel_decoration(&toplevel, &qh, ()).set_mode(zxdg_toplevel_decoration_v1::Mode::ServerSide);
    }
    if args.fullscreen {
        toplevel.set_fullscreen(None);
    }
    surface.commit();
    probe.surface = Some(surface);
    queue.roundtrip(&mut probe).map_err(|e| format!("roundtrip: {e}"))?;

    let started = Instant::now();
    let mut window_start = started;
    let deadline = (args.seconds > 0).then(|| started + Duration::from_secs(args.seconds));
    while !probe.closed && deadline.is_none_or(|d| Instant::now() < d) {
        if probe.configured && !probe.waiting {
            probe.draw(&qh);
        }
        let next = window_start + Duration::from_secs(1);
        wait(&mut queue, &mut probe, next.saturating_duration_since(Instant::now()))?;
        if Instant::now() >= next {
            let window = std::mem::take(&mut probe.window);
            println!("{}", window.json(&probe, window_start.elapsed().as_secs_f64(), false));
            probe.total.add(&window);
            window_start = Instant::now();
        }
    }
    let window = std::mem::take(&mut probe.window);
    probe.total.add(&window);
    let total = std::mem::take(&mut probe.total);
    println!("{}", total.json(&probe, started.elapsed().as_secs_f64(), true));
    Ok(())
}

fn main() {
    let result = Args::parse().and_then(run);
    if let Err(e) = result {
        eprintln!("fps-probe: {e}");
        std::process::exit(1);
    }
}
