use std::num::NonZeroU32;
use std::rc::Rc;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::ActiveEventLoop;
use winit::keyboard::PhysicalKey;
use winit::platform::scancode::PhysicalKeyExtScancode;
use winit::window::{CustomCursor, Window, WindowId};

use super::display::{Event, Frame, Input};
use super::keys;

const WHEEL_UP: u32 = 3;
const WHEEL_DOWN: u32 = 4;

pub struct Viewer {
    title: String,
    frame: Arc<Mutex<Frame>>,
    inputs: Sender<Input>,
    shown: Option<Shown>,
    pointer: PhysicalPosition<f64>,
}

struct Shown {
    window: Rc<Window>,
    surface: Surface<Rc<Window>, Rc<Window>>,
    cursor: Option<CustomCursor>,
}

impl Viewer {
    pub fn new(title: String, frame: Arc<Mutex<Frame>>, inputs: Sender<Input>) -> Self {
        Self { title, frame, inputs, shown: None, pointer: PhysicalPosition::new(0.0, 0.0) }
    }

    fn send(&self, input: Input) {
        let _ = self.inputs.send(input);
    }

    fn draw(&mut self) {
        let Some(shown) = self.shown.as_mut() else { return };
        let size = shown.window.inner_size();
        let (Some(width), Some(height)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) else { return };
        if let Err(e) = shown.surface.resize(width, height) {
            log::warn!("resize: {e}");
            return;
        }
        let frame = self.frame.lock().unwrap();
        let mut buffer = match shown.surface.buffer_mut() {
            Ok(buffer) => buffer,
            Err(e) => return log::warn!("buffer: {e}"),
        };
        scale(&frame, &mut buffer, size.width, size.height);
        if let Err(e) = buffer.present() {
            log::warn!("present: {e}");
        }
    }

    fn redraw(&self) {
        if let Some(shown) = self.shown.as_ref() {
            shown.window.request_redraw();
        }
    }

    fn guest_point(&self) -> Option<(u32, u32)> {
        let shown = self.shown.as_ref()?;
        let size = shown.window.inner_size();
        let frame = self.frame.lock().unwrap();
        if size.width == 0 || size.height == 0 || frame.width == 0 {
            return None;
        }
        let x = self.pointer.x.max(0.0) * f64::from(frame.width) / f64::from(size.width);
        let y = self.pointer.y.max(0.0) * f64::from(frame.height) / f64::from(size.height);
        Some(((x as u32).min(frame.width - 1), (y as u32).min(frame.height - 1)))
    }

    fn key(&self, physical: PhysicalKey, state: ElementState) {
        let to_qnum: fn(u32) -> Option<u32> = if cfg!(windows) { keys::qnum_from_set1 } else { keys::qnum_from_evdev };
        let qnum = physical.to_scancode().and_then(to_qnum);
        match qnum {
            Some(qnum) => self.send(Input::Key { qnum, down: state.is_pressed() }),
            None => log::debug!("no QEMU key number for {physical:?}"),
        }
    }

    fn wheel(&self, delta: MouseScrollDelta) {
        let lines = match delta {
            MouseScrollDelta::LineDelta(_, y) => y,
            MouseScrollDelta::PixelDelta(position) => position.y as f32,
        };
        if lines != 0.0 {
            let button = if lines > 0.0 { WHEEL_UP } else { WHEEL_DOWN };
            self.send(Input::Button { button, down: true });
            self.send(Input::Button { button, down: false });
        }
    }

    fn fit_to_guest(&self) {
        let Some(shown) = self.shown.as_ref() else { return };
        let frame = self.frame.lock().unwrap();
        if frame.width > 0 && frame.height > 0 {
            let _ = shown.window.request_inner_size(PhysicalSize::new(frame.width, frame.height));
        }
    }
}

fn scale(frame: &Frame, buffer: &mut [u32], width: u32, height: u32) {
    if frame.width == 0 || frame.height == 0 {
        buffer.fill(0);
        return;
    }
    for y in 0..height {
        let from = (u64::from(y) * u64::from(frame.height) / u64::from(height)) as usize * frame.width as usize;
        let row = &mut buffer[y as usize * width as usize..(y as usize + 1) * width as usize];
        for (x, out) in row.iter_mut().enumerate() {
            *out = frame.pixels[from + (x as u64 * u64::from(frame.width) / u64::from(width)) as usize];
        }
    }
}

fn button(button: MouseButton) -> Option<u32> {
    match button {
        MouseButton::Left => Some(0),
        MouseButton::Middle => Some(1),
        MouseButton::Right => Some(2),
        MouseButton::Back => Some(5),
        MouseButton::Forward => Some(6),
        MouseButton::Other(_) => None,
    }
}

impl ApplicationHandler<Event> for Viewer {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.shown.is_some() {
            return;
        }
        let attributes = Window::default_attributes().with_title(self.title.clone()).with_inner_size(PhysicalSize::new(1280, 800));
        let window = match event_loop.create_window(attributes) {
            Ok(window) => Rc::new(window),
            Err(e) => {
                log::error!("window: {e}");
                return event_loop.exit();
            }
        };
        let surface = Context::new(window.clone()).and_then(|context| Surface::new(&context, window.clone()));
        match surface {
            Ok(surface) => self.shown = Some(Shown { window, surface, cursor: None }),
            Err(e) => {
                log::error!("surface: {e}");
                event_loop.exit();
            }
        }
        self.fit_to_guest();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::RedrawRequested => self.draw(),
            WindowEvent::Resized(_) => self.redraw(),
            WindowEvent::KeyboardInput { event, .. } => self.key(event.physical_key, event.state),
            WindowEvent::CursorMoved { position, .. } => {
                self.pointer = position;
                if let Some((x, y)) = self.guest_point() {
                    self.send(Input::Move { x, y });
                }
            }
            WindowEvent::MouseInput { state, button: pressed, .. } => {
                if let Some(button) = button(pressed) {
                    self.send(Input::Button { button, down: state.is_pressed() });
                }
            }
            WindowEvent::MouseWheel { delta, .. } => self.wheel(delta),
            _ => {}
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Event) {
        let Some(shown) = self.shown.as_mut() else { return };
        match event {
            Event::Resized => {
                self.fit_to_guest();
                self.redraw();
            }
            Event::Redraw => shown.window.request_redraw(),
            Event::Cursor { width, height, hot_x, hot_y, rgba } => match CustomCursor::from_rgba(rgba, width, height, hot_x, hot_y) {
                Ok(source) => {
                    let cursor = event_loop.create_custom_cursor(source);
                    shown.window.set_cursor(cursor.clone());
                    shown.cursor = Some(cursor);
                }
                Err(e) => log::warn!("cursor: {e}"),
            },
            Event::Pointer(on) => shown.window.set_cursor_visible(on),
            Event::Off => {
                self.frame.lock().unwrap().pixels.fill(0);
                shown.window.request_redraw();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaling_picks_the_nearest_guest_pixel() {
        let frame = Frame { width: 2, height: 1, pixels: vec![1, 2] };
        let mut out = vec![0; 4 * 2];
        scale(&frame, &mut out, 4, 2);
        assert_eq!(out, [1, 1, 2, 2, 1, 1, 2, 2]);
    }
}
