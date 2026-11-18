mod relay;
#[cfg(unix)]
mod view;

use std::process::ExitCode;

const USAGE: &str = "usage: acdevtool relay SOCKET                                   (join stdin and stdout to the Unix socket SOCKET)
       acdevtool view --qmp QMP_SOCKET [--title TITLE]          (show a QEMU guest started with -display dbus,p2p=yes)
       acdevtool view --qmp QMP_SOCKET --outputs N              (no window: switch the guest's displays 1 to N-1 on, then exit)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((command, rest)) if command == "relay" => relay::main(rest),
        #[cfg(unix)]
        Some((command, rest)) if command == "view" => view::main(rest),
        #[cfg(not(unix))]
        Some((command, _)) if command == "view" => {
            eprintln!("acdevtool view: not on this platform yet");
            ExitCode::from(2)
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
