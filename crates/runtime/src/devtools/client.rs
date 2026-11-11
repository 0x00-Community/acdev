use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use super::DevToolsTarget;
use super::ws;
use crate::sync::Locked;

const QUEUE: usize = 256;
const WRITE_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Client(Arc<Connection>);

struct Connection {
    id: u64,
    target: Option<DevToolsTarget>,
    queue: Mutex<Option<SyncSender<(u8, Vec<u8>)>>>,
    socket: TcpStream,
}

impl Client {
    pub(super) fn new(target: Option<DevToolsTarget>, writer: TcpStream) -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        writer.set_write_timeout(Some(WRITE_WAIT))?;
        let socket = writer.try_clone()?;
        let (queue, frames) = sync_channel(QUEUE);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let client = Self(Arc::new(Connection { id, target, queue: Mutex::new(Some(queue)), socket }));
        let connection = Arc::downgrade(&client.0);
        std::thread::Builder::new().name("acde-devtools-send".into()).spawn(move || Self::write(&connection, writer, frames))?;
        Ok(client)
    }

    pub fn id(&self) -> u64 {
        self.0.id
    }

    pub fn target(&self) -> Option<&str> {
        self.0.target.as_ref().map(|t| t.id.as_str())
    }

    pub fn send(&self, message: &str) -> bool {
        self.queue(ws::TEXT, message.as_bytes().to_vec())
    }

    pub fn close(&self) {
        self.queue(ws::CLOSE, 1001u16.to_be_bytes().to_vec());
    }

    pub(super) fn pong(&self, payload: &[u8]) {
        self.queue(ws::PONG, payload.to_vec());
    }

    pub(super) fn answer_close(&self, payload: &[u8]) {
        self.queue(ws::CLOSE, payload.get(..2).unwrap_or(&[0x03, 0xe8]).to_vec());
    }

    fn queue(&self, opcode: u8, payload: Vec<u8>) -> bool {
        let mut queue = self.0.queue.locked();
        let Some(sender) = queue.as_ref() else { return false };
        let queued = match sender.try_send((opcode, payload)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                log::warn!("devtools: client {} does not read; disconnecting it", self.0.id);
                self.cut();
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        };
        if !queued || opcode == ws::CLOSE {
            *queue = None;
        }
        queued
    }

    fn cut(&self) {
        _ = self.0.socket.shutdown(Shutdown::Both);
    }

    fn write(connection: &Weak<Connection>, mut writer: TcpStream, frames: Receiver<(u8, Vec<u8>)>) {
        while let Ok((opcode, payload)) = frames.recv() {
            if ws::write(&mut writer, opcode, &payload).is_err() || opcode == ws::CLOSE {
                break;
            }
        }
        _ = writer.shutdown(Shutdown::Both);
        if let Some(connection) = connection.upgrade() {
            connection.queue.locked().take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::time::Instant;

    #[test]
    fn send_returns_at_once_when_the_peer_does_not_read() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let _peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        let client = Client::new(None, server).unwrap();
        let message = "x".repeat(64 << 10);
        let started = Instant::now();
        let sent = (0..QUEUE * 8).take_while(|_| client.send(&message)).count();
        assert!(started.elapsed() < Duration::from_secs(2), "send blocked for {:?}", started.elapsed());
        assert!(sent < QUEUE * 8, "a client that never reads is cut off once its queue is full");
        assert!(!client.send("after"), "nothing is queued after the cut");
    }

    #[test]
    fn frames_arrive_in_order_and_close_ends_the_socket() {
        use std::io::Read;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        let client = Client::new(None, server).unwrap();
        assert!(client.send("one"));
        assert!(client.send("two"));
        client.close();
        assert!(!client.send("three"));
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, [&[0x81, 3][..], b"one", &[0x81, 3], b"two", &[0x88, 2, 0x03, 0xe9]].concat());
    }
}
