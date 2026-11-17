use super::dir;
use super::process::{self, Spec, quote};
use super::*;
use crate::runtime::channel::{DATA, Frame};
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

#[test]
fn the_socket_directory_is_only_for_system_and_the_user() {
    let sid = dir::user_sid().expect("the user's SID");
    assert!(sid.starts_with("S-1-5-"), "{sid}");
    let parent = std::env::temp_dir().join(format!("acde-dir-{}", std::process::id()));
    std::fs::create_dir_all(&parent).expect("parent");
    let made = parent.join(dir::generation_name());
    dir::create_protected(&made, &dir::sddl(&sid)).expect("created");
    let dacl = read_dacl(&made).expect("the DACL");
    assert!(dacl.starts_with("D:P"), "protected from inheritance: {dacl}");
    let mut aces: Vec<&str> = dacl.trim_start_matches("D:P").split_inclusive(')').collect();
    aces.sort();
    let mut want = vec!["(A;OICI;FA;;;SY)".to_owned(), format!("(A;OICI;FA;;;{sid})")];
    want.sort();
    assert_eq!(aces, want, "{dacl}");
    std::fs::write(made.join("3000.sock"), b"").expect("a file inside");
    let inner = read_dacl(&made.join("3000.sock")).expect("the file's DACL");
    assert!(inner.contains(&format!("(A;ID;FA;;;{sid})")) && inner.contains("(A;ID;FA;;;SY)") && inner.matches('(').count() == 2, "{inner}");
    assert!(dir::create_protected(&made, &dir::sddl(&sid)).is_err(), "an existing directory is not reused");
    std::fs::remove_dir_all(&parent).ok();
}

#[test]
fn socket_paths_fit_sun_path_and_old_generations_are_swept() {
    let temp = PathBuf::from(r"Y:\Users\someone\AppData\Local\Temp");
    assert_eq!(dir::base(Some(r"X:\run".as_ref()), &temp), PathBuf::from(r"X:\run\acde\b"));
    assert_eq!(dir::base(Some("".as_ref()), &temp), temp.join(r"acde\b"));
    assert_eq!(dir::base(None, &temp), temp.join(r"acde\b"));
    let name = dir::generation_name();
    let (pid, tag) = name.split_once('.').expect("pid.tag");
    assert_eq!((pid.parse::<u32>().ok(), tag.len()), (Some(std::process::id()), 6));
    assert!(dir::fits(&PathBuf::from(r"C:\Users\someone\AppData\Local\Temp\acde\b\12345.abcdef")));
    assert!(!dir::fits(&PathBuf::from(format!(r"C:\{}", "x".repeat(94)))));
    assert!(dir::fits(&PathBuf::from(format!(r"C:\{}", "x".repeat(93)))));

    let base = std::env::temp_dir().join(format!("acde-sweep-{}", std::process::id()));
    for name in ["111.abcdef", "222.abcdef", "333.notahex", "notapid.abcdef", &format!("{}.abcdef", std::process::id())] {
        std::fs::create_dir_all(base.join(name)).expect("dir");
    }
    let removed = dir::sweep(&base, |pid| pid == 222);
    assert_eq!(removed, vec![base.join("111.abcdef")]);
    let left: Vec<String> = std::fs::read_dir(&base).expect("base").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left.len(), 4, "{left:?}");
    assert!(dir::alive(std::process::id()));
    std::fs::remove_dir_all(&base).ok();
}

fn started(script: &str) -> Option<Arc<Running>> {
    started_with(script, "stop.test", None)
}

fn started_with(script: &str, app: &str, sockets: Option<PathBuf>) -> Option<Arc<Running>> {
    let node = node()?;
    let env = environment(vec![], &[("ACDE_APP_CONTROL", "fd".into())], |k| std::env::var(k).ok());
    let args = vec!["-e".to_owned(), script.to_owned()];
    let started = process::start(&Spec { program: &node.to_string_lossy(), args: &args, cwd: None, env: &env }).expect("started");
    let mux = Mux::start(started.to_backend, started.from_backend).expect("mux");
    let generation = match &sockets {
        Some(dir) => channel::register(app, Route::Sockets(dir.clone())),
        None => 0,
    };
    Some(Arc::new(Running { app: app.into(), generation, process: started.process, mux, sockets }))
}

#[test]
fn stop_asks_the_backend_to_shut_down_first() {
    let script = "const s = new (require('net').Socket)({ fd: 3, readable: true, writable: false }); \
                  s.on('data', (b) => { if (b[0] === 6) process.exit(7) }); setInterval(() => {}, 1000)";
    let Some(backend) = started(script) else { return eprintln!("skipped: no node on PATH") };
    std::thread::sleep(Duration::from_millis(300));
    let begun = Instant::now();
    stop_running(backend.clone(), 5000).expect("stop");
    assert_eq!(backend.process.wait(Some(10_000)), Some(7), "the backend left on SHUTDOWN");
    assert!(begun.elapsed() < Duration::from_secs(4), "{:?}", begun.elapsed());
}

#[test]
fn stop_terminates_a_backend_that_does_not_leave() {
    let Some(backend) = started("setInterval(() => {}, 1000)") else { return eprintln!("skipped: no node on PATH") };
    let begun = Instant::now();
    stop_running(backend.clone(), 500).expect("stop");
    assert_eq!(backend.process.wait(Some(10_000)), Some(1), "terminated with code 1");
    assert!(begun.elapsed() >= Duration::from_millis(450), "{:?}", begun.elapsed());
}

#[test]
fn only_a_preload_with_the_channel_mark_starts_node() {
    let dir = std::env::temp_dir().join(format!("acde-preload-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join("new.js"), "const CHANNEL_MARK = 'acde-listen-channel/1'\n").expect("new");
    std::fs::write(dir.join("old.js"), "export {}\n").expect("old");
    assert!(supports_channel(&dir.join("new.js")));
    assert!(!supports_channel(&dir.join("old.js")));
    assert!(!supports_channel(&dir.join("missing.js")));
    assert_eq!(OLD_PRELOAD, "acde-listen.js does not support the Windows channel (built by an older acde: acde build it again)");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn stop_all_ends_backends_and_removes_their_directories() {
    let dir = std::env::temp_dir().join(format!("acde-stop-all-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let Some(backend) = started_with("setInterval(() => {}, 1000)", "stop-all.test", Some(dir.clone())) else {
        return eprintln!("skipped: no node on PATH");
    };
    let pid = backend.process.pid;
    running().insert(pid, backend.clone());
    stop_all();
    assert!(backend.process.wait(Some(0)).is_some(), "the backend ended");
    assert!(!dir.exists(), "its directory is gone");
    assert!(channel::lookup("stop-all.test").is_none());
    assert!(!running().contains_key(&pid));
}

#[test]
fn stop_all_waits_for_a_backend_that_is_being_finished() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = std::env::temp_dir().join(format!("acde-finishing-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let held = std::fs::OpenOptions::new().write(true).create(true).share_mode(0).open(dir.join("3000.sock")).expect("held");
    let Some(backend) = started_with("setInterval(() => {}, 1000)", "finishing.test", Some(dir.clone())) else {
        return eprintln!("skipped: no node on PATH");
    };
    let pid = backend.process.pid;
    running().insert(pid, backend.clone());
    backend.process.terminate();
    let finishing = std::thread::spawn(move || finish(pid));
    std::thread::sleep(Duration::from_millis(150));
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        drop(held);
    });
    stop_all();
    assert!(!dir.exists(), "stop_all returned before the directory was removed");
    finishing.join().expect("finish");
    release.join().expect("release");
}

fn read_dacl(path: &std::path::Path) -> std::io::Result<String> {
    use dir::{Local, from_wide, os_error, wide};
    use std::ptr::null_mut;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(wide(path).as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), null_mut(), null_mut(), &mut descriptor)
    };
    let descriptor = Local(descriptor);
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let mut text = Local(null_mut::<u16>());
    if unsafe { ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor.0, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text.0, null_mut()) } == 0 {
        return Err(os_error("ConvertSecurityDescriptorToStringSecurityDescriptorW"));
    }
    Ok(from_wide(text.0))
}
