use std::os::unix::process::CommandExt;
use std::path::PathBuf;

pub struct AppTool {
    cli: PathBuf,
}

impl AppTool {
    const INSTALLED: &str = "acde-app/src/cli.ts";
    const SOURCE: &str = "../../web/packages/acde-app/src/cli.ts";

    pub fn locate() -> Option<Self> {
        let exe = std::env::current_exe().ok().and_then(|e| std::fs::canonicalize(e).ok())?;
        let bin = exe.parent()?;
        let cli = std::env::var_os("ACDE_APP_CLI").map(PathBuf::from).into_iter().chain([bin.join(Self::INSTALLED), bin.join(Self::SOURCE)]).find(|p| p.is_file())?;
        unsafe { std::env::set_var("ACDE_BIN", &exe) };
        Some(Self { cli })
    }

    pub fn main(args: &[String]) -> i32 {
        let Some(tool) = Self::locate() else {
            eprintln!("acde app: no acde-app beside acde ({} or {}); ACDE_APP_CLI names its cli.ts", Self::INSTALLED, Self::SOURCE);
            return 1;
        };
        let error = std::process::Command::new("bun").arg(&tool.cli).args(args).exec();
        eprintln!("acde app: bun: {error} (acde app runs under bun)");
        1
    }
}
