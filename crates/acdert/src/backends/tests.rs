use super::process::{self, Spec, quote};
use super::*;
use acde_runtime::channel::{DATA, Frame};
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn node() -> Option<PathBuf> {
    std::env::var("PATH").ok()?.split(';').map(|dir| PathBuf::from(dir).join("node.exe")).find(|exe| exe.is_file())
}

const ECHO: &str = r#"
const fs = require('fs')
const payload = Buffer.from(JSON.stringify({ channel: process.env.ACDE_APP_CHANNEL, root: process.env.SystemRoot, inherited: process.env.USERDOMAIN ?? null }))
const head = Buffer.alloc(9)
head.writeUInt8(2, 0); head.writeUInt32BE(7, 1); head.writeUInt32BE(payload.length, 5)
fs.writeSync(4, Buffer.concat([head, payload]))
const buf = Buffer.alloc(64)
let total = 0
for (;;) { const n = fs.readSync(3, buf); if (n === 0) break; total += n }
console.log('read ' + total)
"#;

#[test]
fn the_backend_gets_fd_3_and_4_and_a_built_environment() {
    let Some(node) = node() else { return eprintln!("skipped: no node on PATH") };
    let env = environment(vec![("PATH".into(), std::env::var("PATH").unwrap_or_default())], &[("ACDE_APP_CHANNEL", "fd".into())], |k| std::env::var(k).ok());
    let args = vec!["-e".to_owned(), ECHO.to_owned()];
    let started = process::start(&Spec { program: &node.to_string_lossy(), args: &args, cwd: None, env: &env }).expect("started");
    let mut from = started.from_backend;
    let frame = Frame::read(&mut from).expect("a frame").expect("not the end");
    assert_eq!((frame.kind, frame.stream), (DATA, 7));
    let seen: serde_json::Value = serde_json::from_slice(&frame.payload).expect("json");
    assert_eq!(seen["channel"], "fd");
    assert!(seen["root"].as_str().is_some_and(|root| !root.is_empty()), "{seen}");
    assert!(seen["inherited"].is_null(), "{seen}");
    let mut to = started.to_backend;
    std::io::Write::write_all(&mut to, b"abc").expect("write");
    drop(to);
    assert_eq!(started.process.wait(Some(10_000)), Some(0));
    let mut log = String::new();
    started.log.take(1024).read_to_string(&mut log).ok();
    assert!(log.contains("read 3"), "{log:?}");
}

#[test]
fn terminate_ends_the_backend_and_its_children() {
    let Some(node) = node() else { return eprintln!("skipped: no node on PATH") };
    let script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); \
                  require('fs').writeSync(4, String(c.pid) + '\\n'); setInterval(() => {}, 1000)";
    let env = environment(vec![], &[], |k| std::env::var(k).ok());
    let args = vec!["-e".to_owned(), script.to_owned()];
    let started = process::start(&Spec { program: &node.to_string_lossy(), args: &args, cwd: None, env: &env }).expect("started");
    let mut line = String::new();
    let mut from = started.from_backend;
    let mut byte = [0u8; 1];
    while from.read(&mut byte).expect("pid") == 1 && byte[0] != b'\n' {
        line.push(byte[0] as char);
    }
    let child: u32 = line.trim().parse().expect("a pid");
    assert_eq!(started.process.wait(Some(200)), None, "still running");
    started.process.terminate();
    assert!(started.process.wait(Some(10_000)).is_some(), "the backend ended");
    let until = Instant::now() + Duration::from_secs(10);
    while alive(child) {
        assert!(Instant::now() < until, "the backend's child {child} is still running");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let running = unsafe { WaitForSingleObject(handle, 0) } == WAIT_TIMEOUT;
    unsafe { CloseHandle(handle) };
    running
}

#[test]
fn transport_variables_come_from_the_runtime() {
    let given = vec![("acde_app_sockets".into(), "x".into()), ("PATH".into(), "p".into()), ("temp".into(), "mine".into())];
    let env = environment(given, &[("ACDE_APP_CHANNEL", "fd".into())], |key| Some(format!("sys-{key}")));
    assert!(!env.iter().any(|(k, _)| k == "acde_app_sockets"));
    assert!(env.contains(&("ACDE_APP_CHANNEL".into(), "fd".into())));
    assert!(env.contains(&("temp".into(), "mine".into())));
    assert!(!env.iter().any(|(k, _)| k == "TEMP"), "TEMP is set already, in another case");
    assert!(env.contains(&("SystemRoot".into(), "sys-SystemRoot".into())));
}

#[test]
fn arguments_are_quoted_for_the_crt() {
    assert_eq!(quote("plain"), "plain");
    assert_eq!(quote(""), "\"\"");
    assert_eq!(quote(r"C:\Program Files\node.exe"), r#""C:\Program Files\node.exe""#);
    assert_eq!(quote(r#"a "b" c\"#), r#""a \"b\" c\\""#);
    let block = process::environment(&[("b".into(), "2".into()), ("A".into(), "1".into())]);
    let text = String::from_utf16_lossy(&block);
    assert_eq!(text, "A=1\0b=2\0\0");
}
