use std::io::{Read, Write};
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use serde_json::{Value, json};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::ext::data_control::v1::client::{ext_data_control_device_v1, ext_data_control_offer_v1, ext_data_control_source_v1};

use super::{State, Worker};

const WAIT: Duration = Duration::from_secs(2);
const TEXT: [&str; 2] = ["text/plain;charset=utf-8", "text/plain"];

type Offer = (ext_data_control_offer_v1::ExtDataControlOfferV1, Vec<String>);

#[derive(Default)]
pub(super) struct Clip {
    text: Option<String>,
    selection: Option<Offer>,
    offers: Vec<Offer>,
}

impl Worker {
    pub(super) fn clipboard(&mut self, text: Option<&str>) -> Result<Value, String> {
        let Some((control, device)) = &self.globals.clipboard else {
            return Err("acompositor offers no ext-data-control".into());
        };
        if let Some(text) = text {
            let source = control.create_data_source(&self.qh, ());
            for mime in TEXT {
                source.offer(mime.to_string());
            }
            device.set_selection(Some(&source));
            self.state.clip.text = Some(text.to_string());
            self.settle()?;
            return Ok(json!({ "text": text }));
        }
        self.settle()?;
        let Some((offer, mimes)) = self.state.clip.selection.clone() else { return Ok(json!({ "text": "" })) };
        let Some(mime) = TEXT.iter().find(|m| mimes.iter().any(|x| x == *m)) else { return Ok(json!({ "text": "" })) };
        let (read, write) = UnixStream::pair().map_err(|e| format!("the clipboard: {e}"))?;
        read.set_nonblocking(true).map_err(|e| format!("the clipboard: {e}"))?;
        offer.receive(mime.to_string(), write.as_fd());
        drop(write);
        let bytes = self.read_serving(&read)?;
        Ok(json!({ "text": String::from_utf8_lossy(&bytes) }))
    }

    fn read_serving(&mut self, mut read: &UnixStream) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + WAIT;
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 << 10];
        loop {
            match read.read(&mut chunk) {
                Ok(0) => return Ok(bytes),
                Ok(n) => {
                    bytes.extend_from_slice(&chunk[..n]);
                    continue;
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
                Err(e) => return Err(format!("the clipboard: {e}")),
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!("the clipboard: no answer within {} s", WAIT.as_secs()));
            }
            self.queue.flush().map_err(|e| format!("acompositor: {e}"))?;
            let Some(guard) = self.queue.prepare_read() else {
                self.queue.dispatch_pending(&mut self.state).map_err(|e| format!("acompositor: {e}"))?;
                continue;
            };
            let readable = {
                let conn = guard.connection_fd();
                let mut fds = [PollFd::new(&conn, PollFlags::IN), PollFd::new(&read, PollFlags::IN)];
                let timeout = Timespec { tv_sec: left.as_secs() as i64, tv_nsec: i64::from(left.subsec_nanos()) };
                _ = poll(&mut fds, Some(&timeout));
                !fds[0].revents().is_empty()
            };
            if readable {
                guard.read().map_err(|e| format!("acompositor: {e}"))?;
            } else {
                drop(guard);
            }
            self.queue.dispatch_pending(&mut self.state).map_err(|e| format!("acompositor: {e}"))?;
        }
    }
}

impl Dispatch<ext_data_control_source_v1::ExtDataControlSourceV1, ()> for State {
    fn event(
        state: &mut Self,
        source: &ext_data_control_source_v1::ExtDataControlSourceV1,
        event: ext_data_control_source_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            ext_data_control_source_v1::Event::Send { fd, .. } => {
                _ = std::fs::File::from(fd).write_all(state.clip.text.as_deref().unwrap_or_default().as_bytes());
            }
            ext_data_control_source_v1::Event::Cancelled => source.destroy(),
            _ => {}
        }
    }
}

impl Dispatch<ext_data_control_device_v1::ExtDataControlDeviceV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &ext_data_control_device_v1::ExtDataControlDeviceV1,
        event: ext_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let clip = &mut state.clip;
        match event {
            ext_data_control_device_v1::Event::DataOffer { id } => clip.offers.push((id, Vec::new())),
            ext_data_control_device_v1::Event::Selection { id } => {
                if let Some((old, _)) = clip.selection.take()
                    && Some(&old) != id.as_ref()
                {
                    old.destroy();
                }
                clip.selection = id.and_then(|id| {
                    let at = clip.offers.iter().position(|(o, _)| *o == id)?;
                    Some(clip.offers.remove(at))
                });
            }
            _ => {}
        }
    }

    wayland_client::event_created_child!(State, ext_data_control_device_v1::ExtDataControlDeviceV1, [
        ext_data_control_device_v1::EVT_DATA_OFFER_OPCODE => (ext_data_control_offer_v1::ExtDataControlOfferV1, ()),
    ]);
}

impl Dispatch<ext_data_control_offer_v1::ExtDataControlOfferV1, ()> for State {
    fn event(
        state: &mut Self,
        offer: &ext_data_control_offer_v1::ExtDataControlOfferV1,
        event: ext_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let ext_data_control_offer_v1::Event::Offer { mime_type } = event
            && let Some((_, mimes)) = state.clip.offers.iter_mut().find(|(o, _)| o == offer)
        {
            mimes.push(mime_type);
        }
    }
}
