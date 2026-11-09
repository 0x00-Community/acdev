use super::*;
use ntex::codec::BytesCodec;
use std::io::{PipeReader, PipeWriter};
use std::time::Duration;

struct Peer {
    from_mux: PipeReader,
    to_mux: PipeWriter,
    frames: Receiver<Frame>,
}

impl Peer {
    fn new() -> (Arc<Mux>, Self) {
        let (from_mux_read, to_peer) = std::io::pipe().expect("pipe");
        let (from_peer, to_mux) = std::io::pipe().expect("pipe");
        let mux = Mux::start(to_peer, from_peer).expect("mux");
        let (tx, frames) = channel();
        let mut reader = from_mux_read.try_clone().expect("clone");
        thread::spawn(move || {
            while let Ok(Some(frame)) = Frame::read(&mut reader) {
                if tx.send(frame).is_err() {
                    return;
                }
            }
        });
        (mux, Self { from_mux: from_mux_read, to_mux, frames })
    }

    fn send(&mut self, frame: Frame) {
        self.to_mux.write_all(&frame.encode()).expect("to the mux");
    }

    fn next(&self) -> Frame {
        self.frames.recv_timeout(Duration::from_secs(10)).expect("a frame in time")
    }

    fn quiet(&self) -> bool {
        self.frames.recv_timeout(Duration::from_millis(200)).is_err()
    }

    fn data(&self, stream: u32, want: usize) -> Vec<u8> {
        let mut got = Vec::new();
        while got.len() < want {
            let frame = self.next();
            assert_eq!((frame.kind, frame.stream), (DATA, stream), "{frame:?}");
            assert!(frame.payload.len() <= CHUNK, "{} bytes in one DATA", frame.payload.len());
            got.extend(frame.payload);
        }
        got
    }
}

fn local<F: Future<Output = ()> + 'static>(make: impl FnOnce() -> F + Send + 'static) {
    crate::rt::block_on(crate::rt::local(make)).flatten().expect("the test ran to the end");
}

fn opened(peer: &Peer, port: u16) -> u32 {
    let frame = peer.next();
    assert_eq!((frame.kind, frame.payload.as_slice()), (OPEN, port.to_be_bytes().as_slice()));
    frame.stream
}

#[test]
fn frames_round_trip_and_are_bounded() {
    let frame = Frame::new(DATA, 7, b"hello".to_vec());
    let bytes = frame.encode();
    assert_eq!(&bytes[..HEADER], &[DATA, 0, 0, 0, 7, 0, 0, 0, 5]);
    assert_eq!(Frame::read(&mut bytes.as_slice()).expect("a frame"), Some(frame));
    assert_eq!(Frame::read(&mut [].as_slice()).expect("the end"), None);
    assert!(Frame::read(&mut [DATA, 0, 0].as_slice()).is_err(), "a cut header");
    let mut big = vec![DATA, 0, 0, 0, 1];
    big.extend_from_slice(&(MAX_PAYLOAD as u32 + 1).to_be_bytes());
    assert_eq!(Frame::read(&mut big.as_slice()).expect_err("too large").kind(), io::ErrorKind::InvalidData);
}

#[test]
fn opens_streams_with_new_ids_and_asks_for_shutdown() {
    let (mux, peer) = Peer::new();
    let opener = mux.clone();
    local(move || async move {
        let a = opener.open(3000).expect("open");
        let b = opener.open(8080).expect("open");
        drop((a, b));
    });
    let a = opened(&peer, 3000);
    let b = opened(&peer, 8080);
    assert!(b > a, "stream ids grow: {a} {b}");
    mux.shutdown().expect("shutdown");
    loop {
        let frame = peer.next();
        if frame.kind == SHUTDOWN {
            break;
        }
        assert!(matches!(frame.kind, FIN | RST), "{frame:?}");
    }
}

#[test]
fn writes_are_chunked_and_wait_for_credit() {
    let (mux, mut peer) = Peer::new();
    let total = CREDIT as usize + 44 * 1024;
    let body: Vec<u8> = (0..total).map(|i| i as u8).collect();
    let (done, finished) = channel();
    let sent = body.clone();
    thread::spawn(move || {
        local(move || async move {
            let io = mux.open(3000).expect("open");
            io.send(sent.into(), &BytesCodec).await.expect("send");
            poll_fn(|cx| io.poll_flush(cx, true)).await.expect("flushed");
            _ = done.send(());
            io.close();
            poll_fn(|cx| io.poll_shutdown(cx)).await.ok();
        })
    });
    let id = opened(&peer, 3000);
    let first = peer.data(id, CREDIT as usize);
    assert_eq!(first, body[..CREDIT as usize]);
    assert!(peer.quiet(), "nothing past the credit");
    peer.send(Frame::new(WINDOW, id, (64 * 1024u32).to_be_bytes()));
    let rest = peer.data(id, total - CREDIT as usize);
    assert_eq!(rest, body[CREDIT as usize..]);
    finished.recv_timeout(Duration::from_secs(10)).expect("the write finished");
    assert_eq!(peer.next(), Frame::new(FIN, id, []));
}

#[test]
fn reads_return_credit_and_end_at_fin() {
    let (mux, mut peer) = Peer::new();
    let (got, received) = channel();
    thread::spawn(move || {
        local(move || async move {
            let io = mux.open(3000).expect("open");
            let mut all = Vec::new();
            while let Some(chunk) = io.recv(&BytesCodec).await.expect("recv") {
                all.extend_from_slice(&chunk);
            }
            _ = got.send(all);
            io.close();
            poll_fn(|cx| io.poll_shutdown(cx)).await.ok();
        })
    });
    let id = opened(&peer, 3000);
    peer.send(Frame::new(DATA, id, b"hello ".to_vec()));
    peer.send(Frame::new(99, id, b"ignored".to_vec()));
    peer.send(Frame::new(DATA, id, b"world".to_vec()));
    peer.send(Frame::new(FIN, id, []));
    assert_eq!(received.recv_timeout(Duration::from_secs(10)).expect("read to the end"), b"hello world");
    let mut granted = 0;
    loop {
        let frame = peer.next();
        match frame.kind {
            WINDOW => granted += frame.credit().expect("u32 credit"),
            FIN => break,
            _ => panic!("{frame:?}"),
        }
    }
    assert_eq!(granted, 11);
    peer.send(Frame::new(DATA, id, b"late".to_vec()));
    assert_eq!(peer.next(), Frame::new(RST, id, "no such stream"));
}

#[test]
fn reset_fails_the_stream() {
    let (mux, mut peer) = Peer::new();
    let (got, received) = channel();
    thread::spawn(move || {
        local(move || async move {
            let io = mux.open(3000).expect("open");
            let error = loop {
                match io.recv(&BytesCodec).await {
                    Ok(Some(_)) => {}
                    Ok(None) => break String::from("eof"),
                    Err(e) => break format!("{e:?}"),
                }
            };
            _ = got.send(error);
        })
    });
    let id = opened(&peer, 3000);
    peer.send(Frame::new(RST, id, "no server on port 3000"));
    let error = received.recv_timeout(Duration::from_secs(10)).expect("the stream failed");
    assert!(error.contains("no server on port 3000"), "{error}");
    assert!(peer.quiet(), "no RST answers an RST");
}

#[test]
fn unknown_streams_are_reset() {
    let (_mux, mut peer) = Peer::new();
    peer.send(Frame::new(DATA, 41, b"x".to_vec()));
    assert_eq!(peer.next(), Frame::new(RST, 41, "no such stream"));
    peer.send(Frame::new(FIN, 42, []));
    assert_eq!(peer.next(), Frame::new(RST, 42, "no such stream"));
    peer.send(Frame::new(RST, 43, "x"));
    peer.send(Frame::new(WINDOW, 44, 5u32.to_be_bytes()));
    peer.send(Frame::new(77, 45, []));
    assert!(peer.quiet(), "RST, WINDOW and unknown types on unknown streams are ignored");
}

#[test]
fn a_closed_link_resets_late_data() {
    let (mux, mut peer) = Peer::new();
    let (closed, done) = channel();
    thread::spawn(move || {
        local(move || async move {
            let io = mux.open(3000).expect("open");
            io.close();
            poll_fn(|cx| io.poll_shutdown(cx)).await.ok();
            _ = closed.send(());
        })
    });
    let id = opened(&peer, 3000);
    done.recv_timeout(Duration::from_secs(10)).expect("closed");
    assert_eq!(peer.next(), Frame::new(FIN, id, []));
    peer.send(Frame::new(DATA, id, b"more".to_vec()));
    assert_eq!(peer.next(), Frame::new(RST, id, "the stream is closed"));
}

#[test]
fn the_backend_going_away_fails_streams_and_opens() {
    let (mux, peer) = Peer::new();
    let (got, received) = channel();
    let held = mux.clone();
    thread::spawn(move || {
        local(move || async move {
            let io = held.open(3000).expect("open");
            _ = got.send(format!("{:?}", io.recv(&BytesCodec).await));
        })
    });
    opened(&peer, 3000);
    drop(peer.to_mux);
    let result = received.recv_timeout(Duration::from_secs(10)).expect("the stream failed");
    assert!(result.contains("closed its channel"), "{result}");
    assert!(mux.is_closed());
    let opened = crate::rt::block_on(crate::rt::local(move || async move { mux.open(1).err().map(|e| e.kind()) })).flatten().flatten();
    assert_eq!(opened, Some(io::ErrorKind::BrokenPipe));
    drop(peer.from_mux);
}

#[test]
fn the_registry_keeps_the_current_generation() {
    let (old, _a) = Peer::new();
    let (new, _b) = Peer::new();
    register("chan.test", old.clone());
    register("chan.test", new.clone());
    unregister("chan.test", &old);
    assert!(lookup("chan.test").is_some_and(|mux| Arc::ptr_eq(&mux, &new)));
    new.close("stopped");
    assert!(lookup("chan.test").is_none(), "a closed generation is not dialled");
    unregister("chan.test", &new);
}
