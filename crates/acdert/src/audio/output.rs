use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use pipewire as pw;
#[cfg(target_os = "linux")]
use pw::spa;

use super::mixer::{Cmd, Mixer, RATE};
use crate::rt::Msg;

pub const IDLE: Duration = Duration::from_secs(3);

pub enum Ctl {
    Open { web: u64, name: String, notify: mpsc::Sender<Msg> },
    Cmd(u64, Cmd),
    Close(u64),
    Idle(u64),
}

enum Sender {
    #[cfg(target_os = "linux")]
    Pw(pw::channel::Sender<Ctl>),
    Std(mpsc::Sender<Ctl>),
}

static OUTPUT: OnceLock<Option<Sender>> = OnceLock::new();

pub fn send(ctl: Ctl) -> bool {
    match OUTPUT.get_or_init(start) {
        #[cfg(target_os = "linux")]
        Some(Sender::Pw(tx)) => tx.send(ctl).is_ok(),
        Some(Sender::Std(tx)) => tx.send(ctl).is_ok(),
        None => false,
    }
}

fn start() -> Option<Sender> {
    let (tx, rx) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new().name("acde-audio".into()).spawn(move || {
        if std::env::var("ACDE_AUDIO").is_ok_and(|v| v == "null") {
            log::info!("ACDE_AUDIO=null, sound plays nowhere");
        } else {
            #[cfg(target_os = "linux")]
            match PwOutput::new() {
                Ok((output, sender)) => {
                    _ = tx.send(Sender::Pw(sender));
                    output.run();
                    return;
                }
                Err(e) => log::warn!("no PipeWire ({e}): sound plays nowhere"),
            }
            #[cfg(not(target_os = "linux"))]
            match super::output_cpal::Device::open() {
                Ok(device) => {
                    let (stx, srx) = mpsc::channel();
                    _ = tx.send(Sender::Std(stx.clone()));
                    device.run(stx, srx);
                    return;
                }
                Err(e) => log::warn!("no sound output ({e}): sound plays nowhere"),
            }
        }
        let (stx, srx) = mpsc::channel();
        _ = tx.send(Sender::Std(stx));
        null_loop(srx);
    });
    if let Err(e) = spawned {
        log::error!("{e}");
        return None;
    }
    rx.recv_timeout(Duration::from_secs(5)).ok()
}

struct Web<O> {
    mixer: Rc<RefCell<Mixer>>,
    notify: mpsc::Sender<Msg>,
    name: String,
    out: Option<O>,
}

pub fn deliver(mixer: &mut Mixer, notify: &mpsc::Sender<Msg>) {
    let notes = mixer.take_notes();
    if !notes.is_empty() {
        _ = notify.send(Msg::Task(Box::new(move |scope| super::deliver(scope, notes))));
    }
}

fn command<O>(web: &mut Web<O>, cmd: Cmd) -> bool {
    let rendering = web.out.is_some();
    apply(&mut web.mixer.borrow_mut(), rendering, cmd)
}

pub fn apply(mixer: &mut Mixer, rendering: bool, cmd: Cmd) -> bool {
    if !rendering {
        mixer.catch_up();
    }
    let restart = match &cmd {
        Cmd::CreateContext { ctx, .. } | Cmd::Running { ctx, running: true } => Some(*ctx),
        _ => None,
    };
    mixer.apply(cmd);
    if let Some(ctx) = restart {
        mixer.restart_clock(ctx, rendering);
    }
    !rendering && mixer.active()
}

#[cfg(target_os = "linux")]
struct PwOutput {
    main: pw::main_loop::MainLoopRc,
    _context: pw::context::ContextRc,
    core: pw::core::CoreRc,
    rx: pw::channel::Receiver<Ctl>,
    tx: pw::channel::Sender<Ctl>,
}

#[cfg(target_os = "linux")]
struct PwStream {
    _listener: pw::stream::StreamListener<Process>,
    _stream: pw::stream::StreamRc,
}

#[cfg(target_os = "linux")]
struct Process {
    web: u64,
    mixer: Rc<RefCell<Mixer>>,
    notify: mpsc::Sender<Msg>,
    ctl: pw::channel::Sender<Ctl>,
    scratch: Vec<f32>,
    idle: u64,
    idle_sent: bool,
}

#[cfg(target_os = "linux")]
impl Process {
    fn process(&mut self, stream: &pw::stream::Stream) {
        let Some(mut buffer) = stream.dequeue_buffer() else { return };
        let requested = buffer.requested() as usize;
        let Some(data) = buffer.datas_mut().first_mut() else { return };
        let mut frames = 0;
        if let Some(bytes) = data.data() {
            let max = bytes.len() / 8;
            frames = if requested > 0 { requested.min(max) } else { max.min(1024) };
            self.scratch.resize(frames * 2, 0.0);
            match self.mixer.try_borrow_mut() {
                Ok(mut mixer) => {
                    mixer.render(&mut self.scratch);
                    deliver(&mut mixer, &self.notify);
                    if mixer.active() {
                        self.idle = 0;
                        self.idle_sent = false;
                    } else {
                        self.idle += frames as u64;
                    }
                }
                Err(_) => self.scratch.fill(0.0),
            }
            for (out, v) in bytes[..frames * 8].as_chunks_mut::<4>().0.iter_mut().zip(&self.scratch) {
                out.copy_from_slice(&v.to_le_bytes());
            }
            if !self.idle_sent && self.idle as f64 >= IDLE.as_secs_f64() * RATE {
                self.idle_sent = self.ctl.send(Ctl::Idle(self.web)).is_ok();
            }
        }
        let chunk = data.chunk_mut();
        *chunk.offset_mut() = 0;
        *chunk.stride_mut() = 8;
        *chunk.size_mut() = (frames * 8) as u32;
    }
}

#[cfg(target_os = "linux")]
impl PwOutput {
    fn new() -> Result<(PwOutput, pw::channel::Sender<Ctl>), pw::Error> {
        pw::init();
        let main = pw::main_loop::MainLoopRc::new(None)?;
        let context = pw::context::ContextRc::new(&main, None)?;
        let core = context.connect_rc(None)?;
        let (tx, rx) = pw::channel::channel();
        Ok((PwOutput { main, _context: context, core, rx, tx: tx.clone() }, tx))
    }

    fn run(self) {
        let PwOutput { main, _context, core, rx, tx } = self;
        let webs: RefCell<HashMap<u64, Web<PwStream>>> = RefCell::default();
        let _errors = core
            .add_listener_local()
            .error(|id, _seq, res, message| log::warn!("PipeWire error {res} (object {id}): {message}"))
            .register();
        let stream_core = core.clone();
        let _rx = rx.attach(main.loop_(), move |ctl| {
            let mut webs = webs.borrow_mut();
            match ctl {
                Ctl::Open { web, name, notify } => {
                    webs.insert(web, Web { mixer: Rc::default(), notify, name, out: None });
                }
                Ctl::Cmd(id, cmd) => {
                    let Some(web) = webs.get_mut(&id) else { return };
                    if command(web, cmd) {
                        match pw_stream(&stream_core, &tx, id, web) {
                            Ok(stream) => {
                                web.mixer.borrow_mut().set_rendering(true);
                                web.out = Some(stream);
                            }
                            Err(e) => log::warn!("[{}] no stream: {e}", web.name),
                        }
                    }
                }
                Ctl::Close(id) => {
                    webs.remove(&id);
                }
                Ctl::Idle(id) => {
                    if let Some(web) = webs.get_mut(&id)
                        && web.out.is_some()
                        && !web.mixer.borrow().active()
                    {
                        web.out = None;
                        web.mixer.borrow_mut().set_rendering(false);
                    }
                }
            }
        });
        main.run();
    }
}

#[cfg(target_os = "linux")]
fn pw_stream(core: &pw::core::CoreRc, ctl: &pw::channel::Sender<Ctl>, id: u64, web: &Web<PwStream>) -> Result<PwStream, pw::Error> {
    let props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Playback",
        *pw::keys::APP_NAME => "acde",
        *pw::keys::NODE_NAME => format!("acde.{}", web.name),
        *pw::keys::MEDIA_NAME => web.name.as_str(),
        *pw::keys::NODE_LATENCY => format!("512/{}", RATE as u32),
    };
    let stream = pw::stream::StreamRc::new(core.clone(), &web.name, props)?;
    let process = Process { web: id, mixer: web.mixer.clone(), notify: web.notify.clone(), ctl: ctl.clone(), scratch: Vec::new(), idle: 0, idle_sent: false };
    let listener = stream.add_local_listener_with_user_data(process).process(|stream, p| p.process(stream)).register()?;

    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    info.set_rate(RATE as u32);
    info.set_channels(2);
    let mut position = [0; spa::param::audio::MAX_CHANNELS];
    position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
    position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
    info.set_position(position);
    let object = spa::pod::Value::Object(spa::pod::Object { type_: spa::sys::SPA_TYPE_OBJECT_Format, id: spa::sys::SPA_PARAM_EnumFormat, properties: info.into() });
    let bytes = spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &object)
        .map_err(|_| pw::Error::CreationFailed)?
        .0
        .into_inner();
    let pod = spa::pod::Pod::from_bytes(&bytes).ok_or(pw::Error::CreationFailed)?;
    stream.connect(spa::utils::Direction::Output, None, pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS, &mut [pod])?;
    Ok(PwStream { _listener: listener, _stream: stream })
}

struct NullOut {
    start: Instant,
    rendered: u64,
    idle: u64,
}

fn null_loop(rx: mpsc::Receiver<Ctl>) {
    let mut webs: HashMap<u64, Web<NullOut>> = HashMap::new();
    let mut scratch = vec![0.0f32; 2 * 1024];
    loop {
        let rendering = webs.values().any(|w| w.out.is_some());
        let ctl = if rendering {
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(ctl) => Some(ctl),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match rx.recv() {
                Ok(ctl) => Some(ctl),
                Err(_) => return,
            }
        };
        match ctl {
            Some(Ctl::Open { web, name, notify }) => {
                webs.insert(web, Web { mixer: Rc::default(), notify, name, out: None });
            }
            Some(Ctl::Cmd(id, cmd)) => {
                if let Some(web) = webs.get_mut(&id)
                    && command(web, cmd)
                {
                    log::debug!("[{}] sound renders into nothing", web.name);
                    web.mixer.borrow_mut().set_rendering(true);
                    web.out = Some(NullOut { start: Instant::now(), rendered: 0, idle: 0 });
                }
            }
            Some(Ctl::Close(id)) => {
                webs.remove(&id);
            }
            Some(Ctl::Idle(_)) | None => {}
        }
        for web in webs.values_mut() {
            let Some(out) = &mut web.out else { continue };
            let mut mixer = web.mixer.borrow_mut();
            let due = (out.start.elapsed().as_secs_f64() * RATE) as u64;
            while out.rendered < due {
                let frames = (due - out.rendered).min(1024) as usize;
                mixer.render(&mut scratch[..frames * 2]);
                out.rendered += frames as u64;
                if mixer.active() {
                    out.idle = 0;
                } else {
                    out.idle += frames as u64;
                }
            }
            deliver(&mut mixer, &web.notify);
            if out.idle as f64 >= IDLE.as_secs_f64() * RATE {
                mixer.set_rendering(false);
                drop(mixer);
                web.out = None;
            }
        }
    }
}
