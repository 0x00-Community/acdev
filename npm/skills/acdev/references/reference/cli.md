# CLI

```text
acdev <command> [args]
```

On error, acdev prints one line, `acdev: <reason>`, and exits with code 1. A wrong argument (an action `act` does not know, a level `console` does not know, …) is answered with one line that names what is wrong and the `acdev <command> --help` to read, such as `acdev: console: --level loud: one of log, info, warn, error, debug, errors (acdev console --help)`; a wrong option value always reads `acdev: <command>: --<option> <value>: <what it takes> (acdev <command> --help)`. The full usage is printed only by `acdev --help`.

After 0.0.9, exit codes are the same for every command:

| Exit code | Meaning |
| --- | --- |
| 0 | Done (also an empty list, such as `acdev console` with no entries) |
| 1 | An error: a wrong argument, something that failed, or something that stops it (a package in use) |
| 2 | Nothing done, but not an error: nothing matched (`acdev query`, `acdev inspect --find`) or nothing to remove (`acdev uninstall`) |
| 3 | Cancelled or not confirmed: Ctrl+C in a question of `acdev new` or during `acdev sdk update`, a declined `acdev uninstall`, or no terminal to ask in and no `--yes` |

What a command found goes to stdout; "nothing found", errors and notes go to stderr with the `acde:` prefix. In 0.0.9 some commands differ: `acdev query` prints "nothing in …" on stdout, and `acdev uninstall` exits 1 when the package is not installed and 2 when it is in use.

`acdev --version` (or `-v`, or `acdev version`) prints the version of acdev on the first line, then the SDK version and contract level it was built with, and the acdev runtime it finds (`ACDEV_RUNTIME`, the one installed next to acdev, then PATH) with that runtime's version and contract level. `acdev --help` (or `-h`, or `acdev help`) prints the usage of every command; `acdev <command> --help` and `acdev help <command>` print that command only. `acdev` with no arguments prints only its version, the three commands that start a project, and a pointer to `acdev --help`. An unknown command or argument prints one line that says what is wrong and which `--help` to read, and exits with code 1. Output is colored when it goes to a terminal; `NO_COLOR` (set and not empty) turns color off, and `FORCE_COLOR` (set and not `0` or `false`) turns it on. Only labels are colored: `acde:`, `error:`, `warning:`, the statuses of `acdev doctor` and the headings of the help. An error is one line, `acdev: <what went wrong>`; with `ACDEV_DEBUG=1` its stack trace follows (after 0.0.9).

## Setup

### acdev doctor

```text
acdev doctor [dir] [--json] [--online] [--fix [--yes]]
```

Checks what `acdev dev` and `acdev test` need on this machine: acdev on PATH, Bun and Node.js, acdev runtime (found, runs, runs the contract level this acdev builds, is the release this acdev pairs with), the runtime's own checks (`acdev runtime doctor`: its host files, the GPU, and on Linux the display), running `acdev dev` sessions and the approvals they wait for, the project in `dir` (default: the current directory; `acdev check`, this platform, its dependencies, `.acde/` in `.gitignore`), and the acdev skill for coding agents. See [Check the setup](../guide/doctor.md).

| Option | Description |
| --- | --- |
| `--json` | One JSON object instead of lines: `{"ok": …, "checks": [{"id", "title", "status", "summary", "fix", "repair"}]}`; with `--fix` also `"fixed"` |
| `--online` | Also ask the acdev download site (`ACDEV_DIST`) whether a newer acdev is out |
| `--fix` | After the checks, fix what acdev can: some fixes right away, the others after asking; then check again. See [Fix what it can](../guide/doctor.md#fix-what-it-can) |
| `--yes` | With `--fix`: do the fixes that ask first without asking |

It prints one line per check, `<status> <check>: <what it found>`, with `fix: …` on the next line for a problem, and a last line that counts errors and warnings. The status is `ok`, `warn`, `error` or `skip` (not checked: no project here, or an earlier check failed). It exits with code 1 when a check is an error, else 0. A `dir` that holds no acde project is an error.

With `--fix`, after the report it prints `fixing: <what>`, the output of what it runs, and `fixed: <what>` or `failed: <what>: <why>` for each fix, `skipped: <what>` for one that was not allowed, and then `acdev doctor: after fixing:` and the checks again; the exit code follows the second run. When nothing can be fixed it says `acdev doctor: nothing here it can fix; the fix lines say what to do`. `--yes` without `--fix` is an error.

## Projects

### acdev new

```text
acdev new [dir] [--template T] [--id ID] [--label NAME] [--backend] [--install|--no-install] [--git] [--pm PM] [--yes]
```

Creates a project. In a terminal, it asks for whatever is missing; with `--yes`, or outside a terminal, it asks nothing (then `dir` is required, the template defaults to `html`, the dependencies are installed unless `--no-install` is given, and no repository is created unless `--git` is given).

| Option | Description |
| --- | --- |
| `--template` | `html` `desktop` `react` `vue` `svelte` `solid` `preact` `vanilla` `next` `nuxt` `sveltekit` `astro` |
| `--id` / `--label` | App id and display name |
| `--backend` | Add `server.ts`, a backend. In 0.0.9, `html` only (the other templates ignore it); after 0.0.9, `html` and the Vite templates, and `next`, `nuxt`, `sveltekit`, `astro` (which have their own server) and `desktop` (which has none) refuse it |
| `--install` / `--no-install` | Install the dependencies, the SDK included, with the package manager, or do not; without either, `acdev new` asks in a terminal and installs them otherwise |
| `--git` | `git init` and make the first commit (if a git user name and email are configured) |
| `--pm` | `bun` `npm` `pnpm` `yarn`; decides whether the project runs on Bun or Node.js (default: `bun` when acdev runs on Bun, else `npm`; in a terminal with both installed, it asks) |

### acdev check

```text
acdev check [dir] [--platform windows|macos|linux]
```

Checks the config (id, entry, icon, service modules, framework) and the manifest rules of the SDK, or the manifest and entry files of a handwritten package, and the `acde:` imports against the manifest. It prints `error:`, `warning:` and `note:` lines on stderr and exits with code 1 only when there is an error. A `note:` marks an import that the check lets pass but cannot verify, the namespace of a [desktop service](../guide/services.md#call-it) that is not the service's own name: `note: src/main.js:1: app "notes": acde:timer resolves only if the service Notes lists ("clock") provides the "timer" namespace`.

It also checks the app's declared capabilities against what a platform has, once for each way of running an app there (`desktop` and `standalone`, on Linux also `session`). That platform is the one `acdev check` runs on, or the one `--platform` names:

- A required capability that the platform lacks is an error: `error: windows (desktop): app "notes" requires network, which this mode lacks`, followed by a hint on making it optional.
- An optional capability that it lacks is a note, and no error: `note: windows (desktop): app "notes" runs without optional camera, which this mode lacks`.
- When no required capability is missing, the last line is `ok: linux (session, desktop, standalone): every required capability is there`.

### acdev build

```text
acdev build [dir] [--out DIR]
```

Builds into `DIR` (default `.acde`). A relative `--out` is resolved against the project being built. The `acde:` imports are checked first, as in `acdev check` (an error stops the build, a `note:` is printed), and the manifest of the output is checked again.

### acdev install

```text
acdev install [dir] [--out DIR]
```

Builds, then installs into `$XDG_DATA_HOME/acde/packages/<id>`; without `XDG_DATA_HOME`, `~/.local/share/acde/packages/<id>` (on Windows `%USERPROFILE%\.local\share\acdev\packages\<id>`). See [Local install](../guide/install.md).

### acdev uninstall

```text
acdev uninstall [id|dir] [--yes] [--data | --keep-data]
```

Removes a package that `acdev install` put into the packages directory, found by its id (its directory name there) or by the project directory it was installed from. For a handwritten package, installed as a link, it removes only the link; the project it points at stays. Before removing, it prints what it removes (`acdev: removes <id>: <path> ...`) and, in a terminal, asks; `--yes` removes without asking, and outside a terminal nothing is removed without `--yes`. When an `acdev dev` session runs the package's desktop or one of its apps, or runs a desktop while the package has apps, it removes nothing and names the session to stop first (`acdev stop --session <pid>`). With no argument it lists the installed packages, one per line: the id and the path (for a link, `-> <project>`).

The data of the package's apps and desktops (`storage/app-<id>/`, `storage/desktop-<id>/` and `apps/<id>/` under `$XDG_DATA_HOME/acde`, or under `ACDE_STORAGE` for the storage) is removed with `--data` and kept with `--keep-data` (after 0.0.9; 0.0.9 keeps it); with neither, a terminal is asked and `--yes` keeps it, printing `acdev: kept its data (…): <paths>`. Both together is a wrong argument (exit code 1).

| Exit code | Meaning |
| --- | --- |
| 0 | Removed, or listed |
| 1 | In use by an `acdev dev` session, or a wrong argument |
| 2 | Not installed |
| 3 | Not confirmed (the question was declined, or no terminal and no `--yes`) |

### acdev sdk

```text
acdev sdk [update] [dir]
```

Shows the project's `@dopame/acde-api` and the SDK version this acdev pairs with. `acdev sdk update` points the dependency at this acdev's own SDK by its path on this machine (`file:...`) and reinstalls with the project's package manager (from its lock file or `packageManager`). If the package manager is not on PATH it changes nothing. If the install fails or is interrupted (Ctrl+C), it puts `package.json`, the lock file and `.npmrc` back as they were and says so, naming any file it could not put back; run the install again to bring `node_modules` back in line. `acdev check` also warns when `node_modules` holds another SDK version than `package.json` names. `acdev check` and `acdev dev` warn when the two differ, for example after upgrading acde.

### acdev dev

```text
acdev dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless] [--verbose] [--force]
```

Builds, starts acdev runtime, and rebuilds and reloads on changes. `--headless` opens no window; use it on a machine without a display. `--verbose` (after 0.0.9) also prints the runtime's own info log; by default the terminal shows what the pages and backends print, what happens to each app, and the runtime's warnings and errors. On Linux without `WAYLAND_DISPLAY` or `DISPLAY`, `acdev dev` without `--headless` stops with `acdev: no display here (no WAYLAND_DISPLAY or DISPLAY): run acdev dev --headless` and exits with code 1. After 0.0.9, only one `acdev dev` runs a project at a time, even when two start at the same moment: a second one exits with code 1 before it builds and names the running one (`acdev: acdev dev <pid> already runs <dir>; stop it first (acdev stop --session <pid>), or pass --force to start another`); `--force` starts it anyway. Ctrl+C, SIGINT and SIGTERM end the session and its runtime, and remove its files (in 0.0.9, a SIGINT sent to `acdev dev` alone, not through the terminal, is ignored); after 0.0.9, files left by a session that was killed are removed by the next `acdev dev` or session command. See [acdev dev](../guide/dev.md) and [Without a display](../guide/tools.md#without-a-display).

## Running sessions

These work with a running `acdev dev` session, and all of them accept `--session <pid>`. A `<web>` is one page: a web name from `acdev webs`, an app id, or `desktop`; a `<ref>` is an element id from `acdev inspect` or `acdev query`, such as `w1.12`, a window, such as `w1`, or (after 0.0.9) a menu on a window's title bar, such as `w1.m1`, or an item of it, `w1.m1.2`. See [Debugging](../guide/tools.md).

| Command | Description |
| --- | --- |
| `acdev webs` | Lists pages |
| `acdev eval <web> <code\|->` | Runs code in a page and prints JSON |
| `acdev shot <web> [-o, --output FILE]` | Window screenshot, default `./<web>.png` |
| `acdev screen [-o, --output FILE]` | Full-screen screenshot, default `./screen.png` |
| `acdev pointer <x> <y>` | Moves the pointer to screen coordinates, as a real move |
| `acdev inspect [--window W] [--find TEXT] [--all] [--offscreen]` | The screen as text |
| `acdev query <selector> [--window W] [--ref REF] [--limit N]` | The elements a CSS selector matches, each with a ref |
| `acdev act <ref> <action> [arg]` | Performs an action on a ref |
| `acdev input <web> <events\|->` | Sends a JSON array of raw mouse and keyboard events to a page, in its CSS pixels: `move` / `down` / `up` (`x`, `y`, `button`), `wheel` (`x`, `y`, `dx`, `dy`), `keydown` / `keyup` (`key`), `text` (`text`), `wait` (`ms`, up to 10000). Moves are a frame apart, so moves with the button down draw a path; `keydown`, `wait`, `keyup` holds a key (after 0.0.9). In 0.0.9, `down`, `up` and `wheel` happen where the pointer is, whatever their `x` and `y`: send a `move` there first; after 0.0.9 they move the pointer to their `x` and `y` |
| `acdev console [--web W] [--level L] [--since S] [--follow]` | Page logs and errors; `--since reload` or `--since N` |
| `acdev network [--web W] [--failed] [--since S] [--follow]` | Page requests; `--since reload` or `--since N`. With nothing to show, `console` and `network` print `acdev: no console entries` / `acdev: no requests` on stderr and exit 0 (after 0.0.9) |
| `acdev choose <folder\|open\|save> [path...] [--cancel]` | (after 0.0.9) Answers the next folder, file or save picker the page opens: one folder, one or more files, or the file to write; `--cancel` answers it as cancelled. Prints `the next folder picker answers <path>`. A headless session shows no picker, so answer it before the action that opens it |
| `acdev drop <web> <file...> [--at X,Y]` | (after 0.0.9) Drops files onto a page as a drag from the system would (`dragenter`, `dragover`, `drop` with the files), at `X,Y` in its CSS pixels or in the middle. Prints `dropped N files onto <web>` |
| `acdev permissions` | The camera and microphone prompts that wait and the decisions made |
| `acdev allow [<prompt id> \| <app> <capability>] [--all]` | Allows a waiting camera or microphone prompt |
| `acdev deny [<prompt id> \| <app> <capability>] [--all]` | Denies a waiting camera or microphone prompt |
| `acdev revoke <app> <capability>` | Takes back a decision |
| `acdev stop` | Ends the session and its acdev runtime; see [Stopping](../guide/dev.md#stopping) |
| `acdev devtools [web]` | Opens the DevTools of Chrome or Edge on a page of the session (a web name, an app id, `desktop`, a window title, or `services` or a service name for the services; default: the focused page) and prints the DevTools address. It looks for Edge, then Chrome on Windows; the Chrome app, then the Edge app on macOS; `google-chrome`, `chrome`, `chromium`, `microsoft-edge` on `PATH` on Linux. The browser runs with a profile of its own in acdev's cache directory (`acde/devtools/` under `%LOCALAPPDATA%`, `~/Library/Caches` or `~/.cache`), never your everyday one; it opens no window of its own and no sync prompt, only the DevTools window, and stays running for the next `acdev devtools`. `ACDEV_BROWSER` names another browser; `ACDEV_BROWSER=none` opens nothing. Without a browser, or when it cannot be started or reached, it prints the address and why, to paste into the address bar of Chrome or Edge, and exits 0. Asked again for a page whose DevTools are open, it brings them to the front. F12 in a window of `acdev dev` (fn+F12 on a Mac keyboard) does the same for the page in that window, and the page never sees that F12; F12 with a modifier still reaches the page (after 0.0.9) |
| `acdev mcp [--session PID]` | MCP server over stdio; see [MCP](../guide/mcp.md) |

| Option | Description |
| --- | --- |
| `--window` | `inspect`, `query`: this window (`w1`) instead of the focused one |
| `--ref` | `query`: search only under this element (`w1.12`) |
| `--limit` | `query`: list at most this many elements (1 to 3000, default 600) |
| `--all` | `inspect`: every window that is not marked `[minimized]`, and elements hidden by `opacity: 0` or `visibility`. `allow`, `deny`: every waiting prompt |
| `--cancel` | `choose`: answer the picker as cancelled |
| `--at` | `drop`: where to drop, `X,Y` in the page's CSS pixels |

`acdev query` prints `N in <window>:` and one line per element (exit code 0), or `acdev: nothing in <window> matches "<selector>"` on stderr (exit code 2; in 0.0.9 on stdout, without `acdev: `). `acdev inspect --find TEXT` exits with code 2 when no element's name or value contains TEXT. Exit code 2 always means the command worked and found nothing; 1 means an error, such as a window or element that does not exist. `acdev act` prints what it did and what changed; when the action was not done it prints the reason on stderr (`acdev: act <ref>: <reason>`) and exits with code 1. A ref that no longer exists says `there is no such element (any more); acdev inspect --find TEXT gives the current refs`.

`acdev permissions` prints two blocks and exits with code 0:

```text
pending:
  2  recorder  microphone  (request)
decisions:
  recorder  camera  granted
```

A pending line is `<prompt id>  <app>  <capability>  (<reason>)`; the reason is always `request` (the running app asked: its `getUserMedia()` or `request()` waits for the answer); a decision line is `<app>  <capability>  <granted|denied>`. An empty block is `pending: none` or `decisions: none`.

`acdev allow` and `acdev deny` answer prompts that wait now. Without arguments they answer the only waiting prompt; when several wait they answer none, list them, and exit with code 1. `<prompt id>` names one prompt, `<app> <capability>` the prompt of that app for that capability, and `--all` every waiting prompt. Each answered prompt prints `allowed <app> <capability> (prompt <id>)` or `denied <app> <capability> (prompt <id>)`. When nothing waits, or nothing matches, they print one line that says so (`acdev: no approval prompt is waiting`, `acdev: no approval prompt 5 is waiting (waiting: 2)`) and exit with code 1.

`acdev revoke <app> <capability>` prints `revoked <app> <capability>`; when there is no such decision it says so and exits with code 1.

While a camera or microphone prompt waits, `acdev webs` prints one line per prompt after the table (the app's window is open; its `getUserMedia()` waits): `<app> waits for approval of <capability>: acdev allow (or acdev deny)`. See [Camera and microphone](../guide/tools.md#camera-and-microphone).

## Coding agents

```text
acdev skills [install|remove|path] [--agent ID,...] [--dir DIR] [--copy]
```

| Command | Description |
| --- | --- |
| `acdev skills` | Where the acdev skill is installed, and whether each place is current |
| `acdev skills install` | Links the skill into `~/.agents/skills` and the skills directory of every agent found |
| `acdev skills remove` | Removes it from those places, and the directories `install` created that are now empty |
| `acdev skills path` | Prints the skill's directory inside the acdev install |

| Option | Description |
| --- | --- |
| `--agent` | These agents (comma-separated ids such as `claude-code`, `codex`, `cursor`) instead of the ones found |
| `--dir` | This skills directory instead; the skill goes into `DIR/acde` |
| `--copy` | Copy instead of link (`install` only) |

See [Coding agents](../guide/agents.md).

## Emulator

### acdev vm

A Dopame OS guest under QEMU on a Linux host with KVM (the emulator's first piece; Windows and macOS come later). `acdev vm fetch` downloads the newest x86_64 disk image; `acdev vm start [--headless | --vnc] [--share DIR] [--image FILE] [--fresh] [--wait SECONDS] [--gl]` boots it in the background under an overlay disk (the image is not changed) and waits until the guest is ready (`--gl`: virgl, kept as an option, not on the roadmap); `acdev vm stop` powers it off; `acdev vm status`, `acdev vm wait [SECONDS]`. `acdev vm screenshot FILE.png` takes the guest screen, also without a window. `acdev vm start` also installs acdevd, the device daemon, in the guest and reaches it over vsock: `acdev vm run -- COMMAND` runs a command as root in the guest, streams its output and exits with its exit code (`--detach`: in the background, output in `/var/log/acdevd/<pid>.log`; `acdev vm kill PID [--force]` stops it); `acdev vm shell [-- COMMAND]` opens an interactive terminal on a pty that follows the window size and exits with the shell's exit code (no command: root's login shell); `acdev vm logs [SOURCE] [--follow] [--grep REGEX] [--lines N]` shows the guest journal, or a systemd unit's, a guest file, or the log of a `--detach` program by its process group id, the last 50 lines first, following with `--follow`, keeping only the lines that match `--grep` (ignoring case); `acdev vm dev [DIR] [--bin A,B] [--run COMMAND]` builds the Cargo project in DIR (default `.`) with `cargo build --release`, pushes its binaries to `/opt/acdev/bin`, runs `--run` (default: the first binary) in the background with that directory on `PATH` and shows its output, then on every source change builds again, and if that works stops the program, pushes and starts it again; Ctrl+C stops it; `acdev vm push LOCAL [REMOTE]` copies a file or a directory in (default `/opt/acdev/<name>`); `acdev vm mount` mounts the `--share` directory at `/mnt/acdev`; `acdev vm console` makes the guest kernel log to the serial port from the next boot. Everything lives in `$ACDEV_VM_DIR` (default `~/.local/share/acdev/vm`): the images, the overlay disk, the sockets and `logs/serial.log`. Needs `qemu-system-x86_64`, `qemu-img` and OVMF; without access to `/dev/kvm` it emulates, much slower.

## Testing

```text
acdev test [dir|file...] [--headed] [-t PATTERN] [--desktop ID|DIR] [--timeout MS] [--bail] [--trace] [-u]
          [--workers N] [--retries N] [--video[=on|failed|off]]
```

| Option | Description |
| --- | --- |
| `--headed` | Open windows (headless by default) |
| `-t`, `--test-name-pattern` | Run only tests whose names match |
| `--desktop` | Run the app in this desktop |
| `--timeout` | Timeout per test, including the start of its session (milliseconds, default 60000) |
| `--bail` | Stop at the first failure |
| `--trace` | Leave a `trace.html` for every test |
| `-u`, `--update-screenshots` | Rewrite screenshot baselines |
| `--workers` | How many test files run at once (default: half the cores, at most 4; 1 with `--headed` or `--bail`) |
| `--retries` | Run a failing test again this many times, each on a fresh session; a test that passes later is reported as flaky (default 0) |
| `--video` | Keep `video.png`, an animated PNG of the screen, for failing tests (the same as `--video=failed`); `--video=on` keeps it for every test, `--video=off` for none (the default) |

The run ends with one line that counts tests and files and names the failing files (after 0.0.9; 0.0.9 prints a line for tests and one for files) (`acdev test: 5 tests in 2 files: 4 passed, 1 failed; failed: e2e/notes.e2e.ts`); see [Testing](../guide/testing.md#commands).
