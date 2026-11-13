use std::env;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::time::UNIX_EPOCH;

const BUN_OK: &str = "const [a,b]=process.versions.bun.split('.').map(Number);process.exit(a>1||(a===1&&b>=4)?0:1)";
const NODE_OK: &str = concat!(
    "const [a,b]=process.versions.node.split('.').map(Number);",
    "process.exit(!process.versions.bun&&(a>22||(a===22&&b>=3))?0:1)"
);

#[link(name = "kernel32")]
extern "system" {
    fn GetCommandLineW() -> *const u16;
    fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
}

unsafe extern "system" fn ignore(_: u32) -> i32 {
    1
}

fn command_line() -> Vec<u16> {
    unsafe {
        let line = GetCommandLineW();
        let mut len = 0;
        while *line.add(len) != 0 {
            len += 1;
        }
        std::slice::from_raw_parts(line, len).to_vec()
    }
}

fn arguments(line: &[u16]) -> OsString {
    let blank = |c: u16| c == u16::from(b' ') || c == u16::from(b'\t');
    let mut at = 0;
    if line.first() == Some(&u16::from(b'"')) {
        at = 1;
        while at < line.len() && line[at] != u16::from(b'"') {
            at += 1;
        }
        at += 1;
    } else {
        while at < line.len() && !blank(line[at]) {
            at += 1;
        }
    }
    while at < line.len() && blank(line[at]) {
        at += 1;
    }
    OsString::from_wide(&line[at.min(line.len())..])
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|dir| {
        let dir = dir.to_string_lossy().trim_matches('"').to_string();
        let file = Path::new(&dir).join(name);
        (!dir.is_empty() && file.is_file()).then_some(file)
    })
}

fn fits(runtime: &Path, check: &str) -> bool {
    Command::new(runtime)
        .args(["-e", check])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn version(runtime: &Path) -> String {
    Command::new(runtime)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn stamp(runtime: Option<&Path>) -> String {
    let Some(runtime) = runtime else { return "-".into() };
    let Ok(meta) = runtime.metadata() else {
        return "-".into();
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{}|{}|{}", runtime.display(), modified, meta.len())
}

fn cache_key(bun: Option<&Path>, node: Option<&Path>) -> String {
    format!("bun {}\tnode {}", stamp(bun), stamp(node))
}

fn cached(file: &Path, key: &str) -> Option<PathBuf> {
    let text = std::fs::read_to_string(file).ok()?;
    let mut lines = text.lines();
    if lines.next()? != key {
        return None;
    }
    let chosen = PathBuf::from(lines.next()?);
    chosen.is_file().then_some(chosen)
}

fn remember(file: &Path, key: &str, chosen: &Path) {
    let _ = std::fs::write(file, format!("{key}\n{}\n", chosen.display()));
}

fn runtime(bun: Option<PathBuf>, node: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(bun) = bun.as_deref().filter(|b| fits(b, BUN_OK)) {
        return Ok(bun.to_path_buf());
    }
    if let Some(node) = node.as_deref().filter(|n| fits(n, NODE_OK)) {
        return Ok(node.to_path_buf());
    }
    Err(match (bun, node) {
        (Some(bun), _) => format!(
            "acde: needs Bun 1.4 or newer, and the bun on PATH is {}: update it (bun upgrade, or https://bun.sh)",
            version(&bun)
        ),
        (None, Some(node)) => format!(
            "acde: needs Node.js 22.3 or newer, and the node on PATH is {}: update it (https://nodejs.org)",
            version(&node)
        ),
        (None, None) => "acde: needs Bun 1.4+ or Node.js 22.3+ and there is neither on PATH: install one of them, \
                         Bun (https://bun.sh) or Node.js (https://nodejs.org)"
            .to_string(),
    })
}

fn main() {
    let cli = env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join(r"lib\acde\dist\cli.js")));
    let Some(cli) = cli else {
        eprintln!("acde: cannot tell where acde.exe is installed");
        exit(1);
    };
    let (bun, node) = (on_path("bun.exe"), on_path("node.exe"));
    let cache = cli
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|lib| lib.join("runtime-cache"));
    let key = cache_key(bun.as_deref(), node.as_deref());
    let runtime = match cache.as_deref().and_then(|file| cached(file, &key)) {
        Some(runtime) => runtime,
        None => match runtime(bun, node) {
            Ok(runtime) => {
                if let Some(file) = cache.as_deref() {
                    remember(file, &key, &runtime);
                }
                runtime
            }
            Err(message) => {
                eprintln!("{message}");
                exit(1);
            }
        },
    };
    let rest = arguments(&command_line());
    let mut command = Command::new(&runtime);
    command.arg(&cli);
    if !rest.is_empty() {
        command.raw_arg(&rest);
    }
    unsafe {
        SetConsoleCtrlHandler(Some(ignore), 1);
    }
    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("acde: cannot start {}: {error}", runtime.display());
            exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{arguments, cache_key, cached, remember};
    use std::path::Path;

    #[test]
    fn the_runtime_choice_is_kept_until_a_runtime_changes() {
        let dir = std::env::temp_dir().join(format!("acde-exe-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bun = dir.join("bun.exe");
        std::fs::write(&bun, "one").unwrap();
        let file = dir.join("runtime-cache");
        let key = cache_key(Some(&bun), None);
        assert_eq!(cached(&file, &key), None);
        remember(&file, &key, &bun);
        assert_eq!(cached(&file, &key), Some(bun.clone()));
        std::fs::write(&bun, "a newer bun").unwrap();
        assert_eq!(cached(&file, &cache_key(Some(&bun), None)), None);
        assert_eq!(
            cached(&file, &cache_key(Some(&bun), Some(Path::new("C:\\nowhere\\node.exe")))),
            None
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn the_program_name_is_dropped_and_the_rest_kept_as_typed() {
        let cases = [
            (
                r##""C:\a b\acde.exe" eval x "document.querySelector(\"#d\")""##,
                r##"eval x "document.querySelector(\"#d\")""##,
            ),
            (r#"acde  eval  'a "b"'  "#, r#"eval  'a "b"'  "#),
            (r#""acde""#, ""),
            ("acde", ""),
            ("acde\t-", "-"),
        ];
        for (line, rest) in cases {
            assert_eq!(arguments(&wide(line)), rest, "{line}");
        }
    }
}
