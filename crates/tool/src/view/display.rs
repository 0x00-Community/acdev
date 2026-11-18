use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use serde_bytes::ByteBuf;
use winit::event_loop::EventLoopProxy;
use zbus::blocking::Connection;
use zbus::blocking::connection::Builder;

const PIXMAN_X8R8G8B8: u32 = 0x2002_0888;
const PIXMAN_A8R8G8B8: u32 = 0x2002_8888;
const LISTENER: &str = "/org/qemu/Display1/Listener";
const OUTPUT_WIDTH: u32 = 1280;
const OUTPUT_HEIGHT: u32 = 800;

#[derive(Default)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u32>,
}

impl Frame {
    fn replace(&mut self, width: u32, height: u32, stride: u32, data: &[u8]) {
        self.width = width;
        self.height = height;
        self.pixels = vec![0; width as usize * height as usize];
        self.blit(0, 0, width, height, stride, data);
    }

    fn blit(&mut self, x: u32, y: u32, width: u32, height: u32, stride: u32, data: &[u8]) {
        for row in 0..height.min(self.height.saturating_sub(y)) {
            let from = row as usize * stride as usize;
            let to = (y + row) as usize * self.width as usize + x as usize;
            for col in 0..width.min(self.width.saturating_sub(x)) as usize {
                let Some(px) = data.get(from + col * 4..from + col * 4 + 4) else { return };
                self.pixels[to + col] = u32::from_le_bytes([px[0], px[1], px[2], 0]);
            }
        }
    }
}

pub enum Event {
    Resized,
    Redraw,
    Cursor { width: u16, height: u16, hot_x: u16, hot_y: u16, rgba: Vec<u8> },
    Pointer(bool),
    Off,
}

pub enum Input {
    Key { qnum: u32, down: bool },
    Move { x: u32, y: u32 },
    Button { button: u32, down: bool },
}

#[zbus::proxy(interface = "org.qemu.Display1.Console", default_service = "org.qemu", default_path = "/org/qemu/Display1/Console_0")]
trait Console {
    fn register_listener(&self, listener: zbus::zvariant::Fd<'_>) -> zbus::Result<()>;

    #[zbus(name = "SetUIInfo")]
    fn set_ui_info(&self, width_mm: u16, height_mm: u16, xoff: i32, yoff: i32, width: u32, height: u32) -> zbus::Result<()>;
}

#[zbus::proxy(interface = "org.qemu.Display1.Keyboard", default_service = "org.qemu", default_path = "/org/qemu/Display1/Console_0")]
trait Keyboard {
    fn press(&self, keycode: u32) -> zbus::Result<()>;
    fn release(&self, keycode: u32) -> zbus::Result<()>;
}

#[zbus::proxy(interface = "org.qemu.Display1.Mouse", default_service = "org.qemu", default_path = "/org/qemu/Display1/Console_0")]
trait Mouse {
    fn press(&self, button: u32) -> zbus::Result<()>;
    fn release(&self, button: u32) -> zbus::Result<()>;
    fn set_abs_position(&self, x: u32, y: u32) -> zbus::Result<()>;
}

struct Listener {
    frame: Arc<Mutex<Frame>>,
    events: Mutex<EventLoopProxy<Event>>,
}

impl Listener {
    fn send(&self, event: Event) {
        let _ = self.events.lock().unwrap().send_event(event);
    }
}

fn readable(format: u32) -> bool {
    let ok = format == PIXMAN_X8R8G8B8 || format == PIXMAN_A8R8G8B8;
    if !ok {
        log::warn!("pixman format {format:#x} is not drawn");
    }
    ok
}

#[zbus::interface(name = "org.qemu.Display1.Listener")]
impl Listener {
    async fn scanout(&self, width: u32, height: u32, stride: u32, pixman_format: u32, data: ByteBuf) {
        if readable(pixman_format) {
            self.frame.lock().unwrap().replace(width, height, stride, &data);
            self.send(Event::Resized);
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn update(&self, x: i32, y: i32, width: i32, height: i32, stride: u32, pixman_format: u32, data: ByteBuf) {
        let place = [x, y, width, height].map(|n| u32::try_from(n).unwrap_or(0));
        if readable(pixman_format) {
            self.frame.lock().unwrap().blit(place[0], place[1], place[2], place[3], stride, &data);
            self.send(Event::Redraw);
        }
    }

    async fn disable(&self) {
        self.send(Event::Off);
    }

    async fn mouse_set(&self, _x: i32, _y: i32, on: i32) {
        self.send(Event::Pointer(on != 0));
    }

    async fn cursor_define(&self, width: i32, height: i32, hot_x: i32, hot_y: i32, data: ByteBuf) {
        let size = [width, height, hot_x, hot_y].map(|n| u16::try_from(n).unwrap_or(0));
        let rgba = data.as_chunks::<4>().0.iter().flat_map(|px| [px[2], px[1], px[0], px[3]]).collect();
        self.send(Event::Cursor { width: size[0], height: size[1], hot_x: size[2], hot_y: size[3], rgba });
    }

    #[zbus(property)]
    async fn interfaces(&self) -> Vec<String> {
        Vec::new()
    }
}

pub struct Display {
    _bus: Connection,
    _listener: Connection,
    pub inputs: mpsc::Sender<Input>,
}

pub fn connect(stream: UnixStream, frame: Arc<Mutex<Frame>>, events: EventLoopProxy<Event>) -> zbus::Result<Display> {
    let bus = Builder::async_io_unix_stream(stream).p2p().build()?;
    let (ours, theirs) = UnixStream::pair().map_err(zbus::Error::from)?;
    ConsoleProxyBlocking::new(&bus)?.register_listener((&theirs).into())?;
    drop(theirs);
    let listener = Builder::async_io_unix_stream(ours).p2p().serve_at(LISTENER, Listener { frame, events: Mutex::new(events) })?.build()?;
    let keyboard = KeyboardProxyBlocking::new(&bus)?;
    let mouse = MouseProxyBlocking::new(&bus)?;
    let (inputs, received) = mpsc::channel();
    thread::spawn(move || {
        for input in received {
            let pointer = matches!(input, Input::Move { .. });
            match forward(&keyboard, &mouse, input) {
                Err(e) if pointer => log::debug!("pointer: {e}"),
                Err(e) => log::warn!("input: {e}"),
                Ok(()) => {}
            }
        }
    });
    Ok(Display { _bus: bus, _listener: listener, inputs })
}

pub fn switch_on(stream: UnixStream, outputs: u32) -> zbus::Result<()> {
    let bus = Builder::async_io_unix_stream(stream).p2p().build()?;
    for head in 1..outputs {
        let console = ConsoleProxyBlocking::builder(&bus).path(format!("/org/qemu/Display1/Console_{head}"))?.build()?;
        let xoff = i32::try_from(head * OUTPUT_WIDTH).unwrap_or(i32::MAX);
        console.set_ui_info(0, 0, xoff, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT)?;
        log::info!("display {head} switched on ({OUTPUT_WIDTH}x{OUTPUT_HEIGHT})");
    }
    Ok(())
}

fn forward(keyboard: &KeyboardProxyBlocking<'_>, mouse: &MouseProxyBlocking<'_>, input: Input) -> zbus::Result<()> {
    match input {
        Input::Key { qnum, down: true } => keyboard.press(qnum),
        Input::Key { qnum, down: false } => keyboard.release(qnum),
        Input::Move { x, y } => mouse.set_abs_position(x, y),
        Input::Button { button, down: true } => mouse.press(button),
        Input::Button { button, down: false } => mouse.release(button),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scanout_and_an_update_land_as_0rgb_pixels() {
        let mut frame = Frame::default();
        let pixel = |b: u8, g: u8, r: u8| [b, g, r, 0xff];
        let data: Vec<u8> = [pixel(1, 2, 3), pixel(4, 5, 6), [0; 4], pixel(7, 8, 9), pixel(10, 11, 12), [0; 4]].concat();
        frame.replace(2, 2, 12, &data);
        assert_eq!(frame.pixels, [0x030201, 0x060504, 0x090807, 0x0c0b0a]);
        frame.blit(1, 1, 5, 5, 4, &pixel(0xaa, 0xbb, 0xcc));
        assert_eq!(frame.pixels[3], 0xccbbaa);
        frame.blit(9, 9, 1, 1, 4, &pixel(1, 1, 1));
        assert_eq!(frame.pixels.len(), 4);
    }
}
