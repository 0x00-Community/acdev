use std::os::unix::process::CommandExt;
use std::path::PathBuf;

const INSTALLED: &str = "acde-app/src/cli.ts";
const SOURCE: &str = "../../web/packages/acde-app/src/cli.ts";

fn locate() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok().and_then(|e| std::fs::canonicalize(e).ok())?;
    let bin = exe.parent()?;
    let cli = std::env::var_os("ACDE_APP_CLI").map(PathBuf::from).into_iter().chain([bin.join(INSTALLED), bin.join(SOURCE)]).find(|p| p.is_file())?;
    unsafe { std::env::set_var("ACDE_BIN", &exe) };
    Some(cli)
}

pub fn main(args: &[String]) -> i32 {
    let Some(cli) = locate() else {
        eprintln!("acde app: no acde-app beside acde ({INSTALLED} or {SOURCE}); ACDE_APP_CLI names its cli.ts");
        return 1;
    };
    let error = std::process::Command::new("bun").arg(&cli).args(args).exec();
    eprintln!("acde app: bun: {error} (acde app runs under bun)");
    1
}
