use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::FileExt;

use acde_wire::acompositor::desktop::acompositor_capture_v1::{self, AcompositorCaptureV1};
use acde_wire::acompositor::desktop::acompositor_desktop_v1::CaptureKind;
use acde_wire::channel::base64;
use serde_json::{Value, json};
use wayland_client::protocol::wl_shm;
use wayland_client::{Connection, Dispatch, QueueHandle};

use super::{State, Worker};

#[derive(Default)]
pub(super) struct Capture {
    size: Option<(u32, u32)>,
    ready: bool,
    failed: Option<String>,
}

type Picture = (Vec<u8>, (u32, u32));

impl Worker {
    pub(super) fn screen(&mut self, path: Option<String>) -> Result<Value, String> {
        let (pixels, size) = self.capture(None)?;
        let png = png(&pixels, size)?;
        match path {
            Some(path) => {
                std::fs::write(&path, png).map_err(|e| format!("{path}: {e}"))?;
                Ok(json!({ "path": path, "width": size.0, "height": size.1 }))
            }
            None => Ok(json!({ "png": base64(&png), "width": size.0, "height": size.1 })),
        }
    }

    pub(super) fn shot(&mut self, toplevel: Option<u64>, max: Option<u32>) -> Result<Value, String> {
        let (pixels, size) = self.capture(toplevel)?;
        let (pixels, size) = match max {
            Some(max) => shrunk(&pixels, size, max),
            None => (pixels, size),
        };
        let mut shot = json!({ "png": base64(&png(&pixels, size)?), "width": size.0, "height": size.1 });
        if let Some((x, y, width, height)) = self.geometry(toplevel)? {
            shot["window"] = json!({ "x": x, "y": y, "width": width, "height": height });
        }
        Ok(shot)
    }

    fn capture(&mut self, toplevel: Option<u64>) -> Result<Picture, String> {
        let proxy = match toplevel {
            Some(n) => Some(self.state.row(n).map(|(p, _)| p.clone()).ok_or("the window is gone")?),
            None => None,
        };
        let kind = if proxy.is_some() { CaptureKind::Window } else { CaptureKind::Screen };
        self.state.capture = Capture::default();
        let capture = self.globals.desktop.capture(kind, proxy.as_ref(), &self.qh, ());
        self.wait(|s| s.capture.size.is_some() || s.capture.failed.is_some())?;
        let picture = self.copy(&capture);
        capture.destroy();
        picture
    }

    fn copy(&mut self, capture: &AcompositorCaptureV1) -> Result<Picture, String> {
        if let Some(why) = self.state.capture.failed.take() {
            return Err(format!("acompositor could not capture: {why}"));
        }
        let (width, height) = self.state.capture.size.filter(|(w, h)| *w > 0 && *h > 0).ok_or("acompositor has no picture of it")?;
        let bytes = width as usize * height as usize * 4;
        let fd: OwnedFd = rustix::fs::memfd_create("acdev-agent-shot", rustix::fs::MemfdFlags::CLOEXEC).map_err(|e| format!("memfd: {e}"))?;
        let file = std::fs::File::from(fd);
        file.set_len(bytes as u64).map_err(|e| format!("memfd: {e}"))?;
        let pool = self.globals.shm.create_pool(file.as_fd(), bytes as i32, &self.qh, ());
        let buffer = pool.create_buffer(0, width as i32, height as i32, width as i32 * 4, wl_shm::Format::Argb8888, &self.qh, ());
        capture.copy(&buffer);
        let waited = self.wait(|s| s.capture.ready || s.capture.failed.is_some());
        buffer.destroy();
        pool.destroy();
        waited?;
        if let Some(why) = self.state.capture.failed.take() {
            return Err(format!("acompositor could not capture: {why}"));
        }
        let mut pixels = vec![0u8; bytes];
        file.read_exact_at(&mut pixels, 0).map_err(|e| format!("the picture: {e}"))?;
        Ok((pixels, (width, height)))
    }
}

fn png(pixels: &[u8], (width, height): (u32, u32)) -> Result<Vec<u8>, String> {
    let rgba: Vec<u8> = pixels.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| format!("png: {e}"))?;
    writer.write_image_data(&rgba).map_err(|e| format!("png: {e}"))?;
    writer.finish().map_err(|e| format!("png: {e}"))?;
    Ok(out)
}

fn shrunk(pixels: &[u8], (width, height): (u32, u32), max: u32) -> Picture {
    let side = width.max(height);
    if max == 0 || side <= max {
        return (pixels.to_vec(), (width, height));
    }
    let to = |n: u32| (u64::from(n) * u64::from(max) / u64::from(side)).max(1) as u32;
    let (w, h) = (to(width), to(height));
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for y in 0..h {
        let (y0, y1) = (y * height / h, ((y + 1) * height / h).max(y * height / h + 1));
        for x in 0..w {
            let (x0, x1) = (x * width / w, ((x + 1) * width / w).max(x * width / w + 1));
            let mut sum = [0u64; 4];
            for sy in y0..y1 {
                let row = sy as usize * width as usize * 4;
                for sx in x0..x1 {
                    let at = row + sx as usize * 4;
                    for (total, byte) in sum.iter_mut().zip(&pixels[at..at + 4]) {
                        *total += u64::from(*byte);
                    }
                }
            }
            let count = u64::from((y1 - y0) * (x1 - x0));
            out.extend(sum.map(|total| (total / count) as u8));
        }
    }
    (out, (w, h))
}

impl Dispatch<AcompositorCaptureV1, ()> for State {
    fn event(state: &mut Self, _: &AcompositorCaptureV1, event: acompositor_capture_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            acompositor_capture_v1::Event::BufferSize { width, height } => state.capture.size = Some((width, height)),
            acompositor_capture_v1::Event::Ready => state.capture.ready = true,
            acompositor_capture_v1::Event::Failed { reason } => state.capture.failed = Some(reason),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_shrinks_to_its_longest_side_by_averaging() {
        let pixels: Vec<u8> = [[0u8, 0, 0, 255], [200, 100, 50, 255]].repeat(8).concat();
        let (out, size) = shrunk(&pixels, (4, 4), 2);
        assert_eq!(size, (2, 2));
        assert_eq!(&out[..4], &[100, 50, 25, 255]);
        let (same, kept) = shrunk(&pixels, (4, 4), 0);
        assert_eq!((same.len(), kept), (pixels.len(), (4, 4)));
    }
}
