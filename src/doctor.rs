use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use acdert::gpu::kurbo::{Affine, Rect};
use acdert::gpu::peniko::{Color, Fill};
use acdert::gpu::{Gpu, PaintRef, PaintScene, Scene, wgpu};
use acdert::vello::Offscreen;

pub const USAGE: &str = "usage: acdebin-dbg doctor [--json]";
const GPU_WAIT: Duration = Duration::from_secs(30);
const FRAME: (u32, u32) = (16, 16);
const PROBE: [u8; 4] = [0x33, 0x99, 0xcc, 0xff];
const TOLERANCE: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    Warn,
    Error,
}

impl Status {
    fn name(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Warn => "warn",
            Status::Error => "error",
        }
    }
}

struct Check {
    id: &'static str,
    title: &'static str,
    status: Status,
    summary: String,
    fix: Option<String>,
}

impl Check {
    fn new(id: &'static str, title: &'static str, status: Status, summary: impl Into<String>, fix: Option<&str>) -> Self {
        Self { id, title, status, summary: summary.into(), fix: fix.map(str::to_owned) }
    }
}

pub fn run(args: &[String]) -> i32 {
    let json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        [flag] if flag == "--help" || flag == "-h" => {
            println!("{USAGE}");
            println!("  checks what acdebin-dbg needs to run apps on this machine: its host files, the GPU (it draws a test frame),");
            println!("  and on Linux the display; --json: one JSON object on stdout. Exit code 1 when a check fails.");
            return 0;
        }
        [other, ..] => {
            eprintln!("acdebin-dbg doctor: unknown argument {other}");
            eprintln!("{USAGE}");
            return 2;
        }
    };
    let mut checks = vec![host()];
    checks.extend(display());
    checks.push(gpu());
    let version = env!("CARGO_PKG_VERSION");
    let exe = std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_default();
    if json {
        let list: Vec<_> =
            checks.iter().map(|c| serde_json::json!({"id": c.id, "title": c.title, "status": c.status.name(), "summary": c.summary, "fix": c.fix})).collect();
        let report = serde_json::json!({
            "acdebin-dbg": version,
            "level": acdert::API_LEVEL,
            "platform": std::env::consts::OS,
            "exe": exe,
            "checks": list,
        });
        println!("{report}");
    } else {
        println!("acdebin-dbg {version} (contract level {}): {exe}", acdert::API_LEVEL);
        for check in &checks {
            println!("{:<6} {}: {}", check.status.name(), check.title, check.summary);
            if let Some(fix) = &check.fix {
                println!("{:<6} fix: {fix}", "");
            }
        }
    }
    i32::from(checks.iter().any(|c| c.status == Status::Error))
}

fn host() -> Check {
    let dir = acdert::app_dir();
    let shown = resolved(&dir);
    let missing: Vec<&str> = ["broker.js", "web.js"].into_iter().filter(|file| !dir.join(file).is_file()).collect();
    if missing.is_empty() {
        return Check::new("host", "host files", Status::Ok, shown.display().to_string(), None);
    }
    let fix = if std::env::var_os("ACDE_APP").is_some() {
        "point ACDE_APP at the directory that holds broker.js and web.js, or unset it"
    } else {
        "install acdebin-dbg again with the acde installer, which puts its app/ directory next to the binary \
         (in a source checkout: cd web && bun install && bun run build)"
    };
    Check::new("host", "host files", Status::Error, format!("no {} in {}", missing.join(" or "), shown.display()), Some(fix))
}

fn resolved(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut at = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(at) {
            return missing.iter().rev().fold(plain(&real), |path: PathBuf, part| path.join(part));
        }
        let (Some(parent), Some(name)) = (at.parent(), at.file_name()) else { return path.to_path_buf() };
        missing.push(name.to_owned());
        at = parent;
    }
}

#[cfg(windows)]
fn plain(real: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut parts = real.components();
    let start = match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(disk) => format!("{}:", char::from(disk)),
            Prefix::VerbatimUNC(server, share) => format!(r"\\{}\{}", server.to_string_lossy(), share.to_string_lossy()),
            _ => return real.to_path_buf(),
        },
        _ => return real.to_path_buf(),
    };
    let mut plain = PathBuf::from(start);
    plain.push(std::path::MAIN_SEPARATOR_STR);
    plain.extend(parts.filter(|part| !matches!(part, Component::RootDir)));
    plain
}

#[cfg(not(windows))]
fn plain(real: &Path) -> PathBuf {
    real.to_path_buf()
}

#[cfg(target_os = "linux")]
fn display() -> Option<Check> {
    let named = |name: &str| std::env::var(name).ok().map(|value| format!("{name}={value}"));
    let check = if crate::outer() {
        let place = named("WAYLAND_DISPLAY").or_else(|| named("DISPLAY")).unwrap_or_else(|| "ACDE_HEADLESS".into());
        Check::new("display", "display", Status::Ok, format!("host windows can open here ({place})"), None)
    } else {
        Check::new(
            "display",
            "display",
            Status::Warn,
            "neither WAYLAND_DISPLAY nor DISPLAY is set, so acdebin-dbg app and acdebin-dbg desktop cannot open a host window here: \
             they would try to start a session on the screen (DRM) instead",
            Some("run acde dev --headless, or run it inside a graphical session"),
        )
    };
    Some(check)
}

#[cfg(not(target_os = "linux"))]
fn display() -> Option<Check> {
    None
}

fn gpu() -> Check {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("acde-doctor".into()).spawn(move || _ = tx.send(draw()));
    if let Err(e) = spawned {
        return Check::new("gpu", "gpu", Status::Error, format!("cannot start a thread for the test frame: {e}"), None);
    }
    match rx.recv_timeout(GPU_WAIT) {
        Ok(Ok((summary, false))) => Check::new("gpu", "gpu", Status::Ok, summary, None),
        Ok(Ok((summary, true))) => Check::new(
            "gpu",
            "gpu",
            Status::Warn,
            format!("{summary}; this is a software adapter, so pages render on the CPU and animate slowly"),
            Some(software_fix()),
        ),
        Ok(Err(summary)) => Check::new("gpu", "gpu", Status::Error, summary, None),
        Err(_) => Check::new(
            "gpu",
            "gpu",
            Status::Error,
            format!("the GPU did not finish a {}x{} test frame within {} s", FRAME.0, FRAME.1, GPU_WAIT.as_secs()),
            Some("update the GPU driver, or restart the machine if the GPU hangs"),
        ),
    }
}

fn software_fix() -> &'static str {
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    if release.to_lowercase().contains("microsoft") {
        "on WSL, WGPU_ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER=1 uses the GPU through Dozen \
         (Vulkan on Direct3D 12, not a conformant driver)"
    } else {
        "install or update the GPU's driver (on Linux its Vulkan driver), or run on a machine with a GPU"
    }
}

fn draw() -> Result<(String, bool), String> {
    let started = Instant::now();
    let (_, _, gpu) = Gpu::open("acde doctor")?;
    let info = gpu.info.clone();
    let driver = [info.driver.as_str(), info.driver_info.as_str()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let kind = match info.device_type {
        wgpu::DeviceType::IntegratedGpu => "integrated GPU",
        wgpu::DeviceType::DiscreteGpu => "discrete GPU",
        wgpu::DeviceType::VirtualGpu => "virtual GPU",
        wgpu::DeviceType::Cpu => "CPU",
        wgpu::DeviceType::Other => "GPU",
    };
    let api = match info.backend {
        wgpu::Backend::Dx12 => "Direct3D 12",
        wgpu::Backend::Metal => "Metal",
        wgpu::Backend::Vulkan => "Vulkan",
        other => other.to_str(),
    };
    let mut name = format!("{} ({api}, {kind}", info.name);
    if !driver.is_empty() {
        name.push_str(&format!(", driver {driver}"));
    }
    name.push(')');
    let mut offscreen = Offscreen::new(gpu.clone()).map_err(|e| format!("{name}: {e}"))?;
    let mut scene = Scene::new();
    let [r, g, b, a] = PROBE;
    let area = Rect::new(0.0, 0.0, f64::from(FRAME.0), f64::from(FRAME.1));
    scene.fill(Fill::NonZero, Affine::IDENTITY, PaintRef::Solid(Color::from_rgba8(r, g, b, a)), None, &area);
    let image = offscreen.draw(scene, FRAME, Affine::IDENTITY).map_err(|e| format!("{name}: drawing a test frame: {e}"))?;
    let pixel = gpu.read(&image.texture, [FRAME.0 / 2, FRAME.1 / 2, 1, 1]).map_err(|e| format!("{name}: reading the test frame back: {e}"))?;
    if pixel.len() != 4 || pixel.iter().zip(PROBE).any(|(got, want)| got.abs_diff(want) > TOLERANCE) {
        return Err(format!("{name} drew a test frame, but it read back {pixel:?} instead of {PROBE:?}"));
    }
    let software = info.device_type == wgpu::DeviceType::Cpu;
    Ok((format!("{name}: drew a test frame in {} ms", started.elapsed().as_millis()), software))
}

#[cfg(all(test, windows))]
mod tests {
    use super::plain;
    use std::path::Path;

    #[test]
    fn verbatim_paths_are_shown_plain() {
        assert_eq!(plain(Path::new(r"\\?\D:\Projects\app\dist")), Path::new(r"D:\Projects\app\dist"));
        assert_eq!(plain(Path::new(r"\\?\UNC\server\share\app")), Path::new(r"\\server\share\app"));
        assert_eq!(plain(Path::new(r"D:\plain")), Path::new(r"D:\plain"));
    }
}
