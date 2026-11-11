#![cfg(target_os = "linux")]

use std::path::Path;
use std::time::{Duration, Instant};

use jsrt::{Events, Isolate, Kind, Options, Waiter};

fn v8() -> Option<Isolate> {
    if !Path::new("/dev/jsrt").exists() {
        eprintln!("skipped: no /dev/jsrt");
        return None;
    }
    let iso = Isolate::create(&Options {
        name: "test".into(),
        ..Options::default()
    })
    .expect("create");
    iso.eval("console.log(typeof globalThis)", "probe", false)
        .expect("eval");
    let mut buf = Vec::new();
    loop {
        if let Some(m) = iso.recv(&mut buf) {
            if m.kind == Kind::Console && buf == b"object" {
                return Some(iso);
            }
            eprintln!("skipped: the engine is not V8");
            return None;
        }
        iso.wait(Some(Duration::from_secs(10))).expect("wait");
    }
}

#[test]
fn messages_and_calls() {
    let Some(iso) = v8() else { return };
    let mut waiter = Waiter::new().expect("io_uring");
    iso.eval(
        "import { call } from 'jsrt:host';\
         onmessage = e => postMessage(call(e.data));",
        "main.js",
        true,
    )
    .expect("eval");
    let mut buf = Vec::new();
    let start = Instant::now();
    let rounds = 1000;
    for n in 0..rounds {
        let text = format!("m{n}");
        iso.send(Kind::String, 0, text.as_bytes()).expect("send");
        let mut kick = true;
        loop {
            let events = waiter.kick_and_wait(&iso, kick).expect("wait");
            kick = false;
            assert!(!events.contains(Events::EXIT), "ended: {}", iso.exit_code());
            let mut done = false;
            while let Some(m) = iso.recv(&mut buf) {
                match m.kind {
                    Kind::Call => {
                        assert_eq!(m.flags & 1, 1);
                        iso.reply(&[&buf[..], b"?"].concat()).expect("reply");
                        kick = true;
                    }
                    Kind::String => {
                        assert_eq!(buf, format!("{text}?").as_bytes());
                        done = true;
                    }
                    other => panic!("{other:?}: {}", String::from_utf8_lossy(&buf)),
                }
            }
            if done {
                break;
            }
        }
    }
    eprintln!("{:?} per message and call", start.elapsed() / rounds);
    drop(iso);
}

/// Messages many times the ring (4 KiB): a call, its reply, a message.
#[test]
fn long_messages() {
    if v8().is_none() {
        return;
    }
    let iso = Isolate::create(&Options {
        name: "long".into(),
        ring_size: 4096,
        ..Options::default()
    })
    .expect("create");
    iso.eval(
        "import { call } from 'jsrt:host';\
         onmessage = e => { const r = new Uint8Array(call(e.data)); \
         postMessage(r.length + ' ' + r[r.length - 1]); };",
        "main.js",
        true,
    )
    .expect("eval");
    let out: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
    let mut sent = 0;
    while iso.send_from(Kind::Binary, 0, &out, &mut sent).is_err() {
        iso.kick().expect("kick");
        iso.wait(Some(Duration::from_secs(10))).expect("wait");
    }
    iso.kick().expect("kick");
    let mut buf = Vec::new();
    loop {
        match iso.recv(&mut buf) {
            Some(m) if m.kind == Kind::Call => {
                assert_eq!(buf, out);
                let reply = vec![9u8; 300_000];
                iso.reply(&reply).expect("reply");
                iso.kick().expect("kick");
            }
            Some(m) => {
                assert_eq!(m.kind, Kind::String);
                assert_eq!(buf, b"300000 9");
                return;
            }
            None => {
                iso.kick().expect("kick");
                let events = iso.wait(Some(Duration::from_secs(10))).expect("wait");
                assert!(!events.is_some_and(|e| e.contains(Events::EXIT)), "ended: {}", iso.exit_code());
            }
        }
    }
}

#[test]
fn close_ends_it() {
    let Some(iso) = v8() else { return };
    let mut waiter = Waiter::new().expect("io_uring");
    iso.eval("close()", "close.js", false).expect("eval");
    let mut events = Events::empty();
    while !events.contains(Events::EXIT) {
        events = waiter.kick_and_wait(&iso, false).expect("wait");
    }
    assert_eq!(iso.exit_code(), 0);
}
