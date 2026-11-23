# CLI

```text
acdev <command> [args]
```

On error, acdev prints one line, `acdev: <reason>`, and exits with code 1. A wrong argument (an action `act` does not know, a level `console` does not know, …) is answered with one line that names what is wrong and the `acdev <command> --help` to read, such as `acdev: console: --level loud: one of log, info, warn, error, debug, errors (acdev console --help)`; a wrong option value always reads `acdev: <command>: --<option> <value>: <what it takes> (acdev <command> --help)`. The full usage is printed only by `acdev --help`.

Exit codes are the same for every command:

| Exit code | Meaning |
| --- | --- |
| 0 | Done (also an empty list, such as `acdev console` with no entries) |
| 1 | An error: a wrong argument, something that failed, or something that stops it (a package in use) |
| 2 | Nothing done, but not an error: nothing matched (`acdev query`, `acdev inspect --find`) or nothing to remove (`acdev uninstall`) |
| 3 | Cancelled or not confirmed: Ctrl+C in a question of `acdev new` or during `acdev sdk update`, a declined `acdev uninstall`, or no terminal to ask in and no `--yes` |

What a command found goes to stdout; "nothing found", errors and notes go to stderr with the `acdev:` prefix.

`acdev --version` (or `-v`, or `acdev version`) prints the version of acdev on the first line, then the SDK version and contract level it was built with, and the runtime binary it finds (`ACDEV_RUNTIME`, else `libexec/acdev` of the install) with that runtime's version and contract level. `acdev --help` (or `-h`, or `acdev help`) prints the usage of every command; `acdev <command> --help` and `acdev help <command>` print that command only. `acdev` with no arguments prints only its version, the three commands that start a project, and a pointer to `acdev --help`. An unknown command or argument prints one line that says what is wrong and which `--help` to read, and exits with code 1. Output is colored when it goes to a terminal; `NO_COLOR` (set and not empty) turns color off, and `FORCE_COLOR` (set and not `0` or `false`) turns it on. Only labels are colored: `acdev:`, `error:`, `warning:`, the statuses of `acdev doctor` and the headings of the help. An error is one line, `acdev: <what went wrong>`; with `ACDEV_DEBUG=1` its stack trace follows.

## Setup

### acdev doctor

```text
acdev doctor [dir] [--json] [--online] [--fix [--yes]]
```

Checks what `acdev dev` and `acdev test` need on this machine: acdev on PATH, Bun and Node.js, the runtime binary (found, runs, runs the contract level this acdev builds, is the release this acdev pairs with), the runtime binary's own checks (its `doctor`: the GPU, and on Linux the display), running `acdev dev` sessions and the approvals they wait for, the project in `dir` (default: the current directory; `acdev check`, this platform, its dependencies, `.acde/` in `.gitignore`), and the acdev skill for coding agents. See [Check the setup](../guide/doctor.md).

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
| `--backend` | Add `server.ts`, a backend. For `html` and the Vite templates; `next`, `nuxt`, `sveltekit`, `astro` (which have their own server) and `desktop` (which has none) refuse it |
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

The data of the package's apps and desktops (`storage/app-<id>/`, `storage/desktop-<id>/` and `apps/<id>/` under `$XDG_DATA_HOME/acde`, or under `ACDE_STORAGE` for the storage) is removed with `--data` and kept with `--keep-data`; with neither, a terminal is asked and `--yes` keeps it, printing `acdev: kept its data (…): <paths>`. Both together is a wrong argument (exit code 1).

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

Shows the project's `@acde/api` and the SDK version this acdev pairs with. `acdev sdk update` points the dependency at this acdev's own SDK by its path on this machine (`file:...`) and reinstalls with the project's package manager (from its lock file or `packageManager`). If the package manager is not on PATH it changes nothing. If the install fails or is interrupted (Ctrl+C), it puts `package.json`, the lock file and `.npmrc` back as they were and says so, naming any file it could not put back; run the install again to bring `node_modules` back in line. `acdev check` also warns when `node_modules` holds another SDK version than `package.json` names. `acdev check` and `acdev dev` warn when the two differ, for example after upgrading acde.

### acdev dev

```text
acdev dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless] [--verbose] [--force] [--keep] [--lock]
```

Builds, starts acdev runtime, and rebuilds and reloads on changes. `--headless` opens no window; use it on a machine without a display. `--verbose` also prints the runtime's own info log; by default the terminal shows what the pages and backends print, what happens to each app, and the runtime's warnings and errors. On Linux without `WAYLAND_DISPLAY` or `DISPLAY`, `acdev dev` without `--headless` stops with `acdev: no display here (no WAYLAND_DISPLAY or DISPLAY): run acdev dev --headless` and exits with code 1. Only one `acdev dev` runs a project at a time, even when two start at the same moment: a second one exits with code 1 before it builds and names the running one (`acdev: acdev dev <pid> already runs <dir>; stop it first (acdev stop --session <pid>), or pass --force to start another`); `--force` starts it anyway. The shared places an app declares in `fs.roots` (Documents, Downloads and the others) are folders made for the session (under the system temp folder), not your own; `--keep` keeps them after the session and prints where. `--lock` opens the lock page of a desktop project (`lock` in its manifest) alone, with a stand-in `acde:lock`: `user()` is a fixed user without an avatar, `unlock('right-password')` unlocks, `wrong-password` fails with code `auth`, `busy-password` with `busy`, `throttled-password` with `throttled` and `retryAfter` 3, any other password with `auth`. Ctrl+C, SIGINT and SIGTERM end the session and its runtime, and remove its files; files left by a session that was killed are removed by the next `acdev dev` or session command. See [acdev dev](../guide/dev.md) and [Without a display](../guide/tools.md#without-a-display).

## Running sessions

These work with a running `acdev dev` session, and all of them accept `--session <pid>`, or `--session vm` for the logged-in session in the guest of [`acdev vm`](#acdev-vm). A `<web>` is one page: a web name from `acdev webs`, an app id, or `desktop`; a `<ref>` is an element id from `acdev inspect` or `acdev query`, such as `w1.12`, a window, such as `w1`, or a menu on a window's title bar, such as `w1.m1`, or an item of it, `w1.m1.2`. See [Debugging](../guide/tools.md).

| Command | Description |
| --- | --- |
| `acdev webs` | Lists pages |
| `acdev eval <web> <code\|->` | Runs code in a page and prints JSON |
| `acdev shot <web> [-o, --output FILE] [--ref REF \| --rect X,Y,W,H]` | Window screenshot, default `./<web>.png`; `--ref` keeps only that element of the window, `--rect` only that area (logical pixels from the window's top left) |
| `acdev screen [-o, --output FILE] [--ref REF \| --rect X,Y,W,H]` | Full-screen screenshot, default `./screen.png`; `--ref` keeps only that element or window, `--rect` only that area (the screen's logical pixels); works with `--session vm` too |
| `acdev appearance [--dark \| --light] [--glass-level N] [--reduced-transparency on\|off]` | Prints the appearance, or sets it: in a guest session (`--session vm`) the system setting (desktop, apps and lock page follow; the login page follows the time of day), in a host session only this session |
| `acdev open <app\|path\|url> [path\|url]` | Opens an app, or a file, folder or http(s) link with its default app or the app named first, as `acde:open` does; in a guest session paths are the guest's and absolute |
| `acdev pointer <x> <y>` | Moves the pointer to screen coordinates, as a real move |
| `acdev inspect [--window W] [--find TEXT] [--all] [--offscreen]` | The screen as text |
| `acdev query <selector> [--window W] [--ref REF] [--limit N]` | The elements a CSS selector matches, each with a ref |
| `acdev act <ref> <action> [arg]` | Performs an action on a ref; on a window ref also `move X,Y`, `resize WxH`, `raise` |
| `acdev input <web> <events\|->` | Sends a JSON array of raw mouse and keyboard events to a page, in its CSS pixels: `move` / `down` / `up` (`x`, `y`, `button`), `wheel` (`x`, `y`, `dx`, `dy`), `keydown` / `keyup` (`key`), `text` (`text`), `wait` (`ms`, up to 10000). Moves are a frame apart, so moves with the button down draw a path; `keydown`, `wait`, `keyup` holds a key. `down`, `up` and `wheel` move the pointer to their `x` and `y`. A `move` right after a `down` waits 150 ms first and an `up` right after a `move` waits a frame, unless a `wait` is already there; see [input](../guide/tools.md#input) |
| `acdev console [--web W] [--level L] [--since S] [--follow]` | Page logs and errors; `--since reload`, `--since N`, or in a guest session without `--web` the printed cursor `key=seq,...` (every page process is merged in time order) |
| `acdev network [--web W] [--failed] [--since S] [--follow]` | Page requests; `--since reload` or `--since N` (or the cursor, as for console). With nothing to show, `console` and `network` print `acdev: no console entries` / `acdev: no requests` on stderr and exit 0 |
| `acdev choose <folder\|open\|save> [path...] [--cancel]` | Answers the next folder, file or save picker the page opens: one folder, one or more files, or the file to write; `--cancel` answers it as cancelled. Prints `the next folder picker answers <path>`. A headless session shows no picker, so answer it before the action that opens it |
| `acdev drop <web> <file...> [--at X,Y]` | Drops files onto a page as a drag from the system would (`dragenter`, `dragover`, `drop` with the files), at `X,Y` in its CSS pixels or in the middle. Prints `dropped N files onto <web>` |
| `acdev permissions` | The camera and microphone prompts that wait and the decisions made |
| `acdev allow [<prompt id> \| <app> <capability>] [--all]` | Allows a waiting camera or microphone prompt |
| `acdev deny [<prompt id> \| <app> <capability>] [--all]` | Denies a waiting camera or microphone prompt |
| `acdev revoke <app> <capability>` | Takes back a decision |
| `acdev call <manager\|desktop> <method> [params\|-]` | Calls the session manager or the Dopame backend of a session in the guest and prints the result as JSON; see [call](../guide/tools.md#call) |
| `acdev approvals [show <id>]` | Lists the system confirms that wait in a session in the guest, or puts one on the screen; see [System confirms](../guide/tools.md#system-confirms) |
| `acdev hit <x> <y> [--json]` | What lies under a screen point: the window, its part, and on a page the element a click reaches; see [Hit and render](../guide/tools.md#hit-and-render) |
| `acdev render [--web W] [--window W] [--json]` | The path each page draws on, and how each glass or frost layer is drawn; see [Hit and render](../guide/tools.md#hit-and-render) |
| `acdev wait <condition> [args] [--timeout MS] [--quiet MS] [--web W] [--app ID] [--window W] [--ref R] [--selector S] [--focused] [--gone]` | Waits until a condition holds and prints the value it ended on as JSON; see [Waiting](../guide/tools.md#waiting) |
| `acdev evidence [label] [--since T] [--output DIR]` | Keeps what the session shows now (screen, webs, element tree, console, network, the guest journal) in a new folder; see [Evidence](../guide/tools.md#evidence) |
| `acdev stop` | Ends the session and its acdev runtime; see [Stopping](../guide/dev.md#stopping) |
| `acdev devtools [web]` | Opens the DevTools of Chrome or Edge on a page of the session (a web name, an app id, `desktop`, a window title, or `services` or a service name for the services; default: the focused page) and prints the DevTools address. It looks for Edge, then Chrome on Windows; the Chrome app, then the Edge app on macOS; `google-chrome`, `chrome`, `chromium`, `microsoft-edge` on `PATH` on Linux. The browser runs with a profile of its own in acdev's cache directory (`acde/devtools/` under `%LOCALAPPDATA%`, `~/Library/Caches` or `~/.cache`), never your everyday one; it opens no window of its own and no sync prompt, only the DevTools window, and stays running for the next `acdev devtools`. `ACDEV_BROWSER` names another browser; `ACDEV_BROWSER=none` opens nothing. Without a browser, or when it cannot be started or reached, it prints the address and why, to paste into the address bar of Chrome or Edge, and exits 0. Asked again for a page whose DevTools are open, it brings them to the front. F12 in a window of `acdev dev` (fn+F12 on a Mac keyboard) does the same for the page in that window, and the page never sees that F12; F12 with a modifier still reaches the page |
| `acdev mcp [--session PID\|vm]` | MCP server over stdio; see [MCP](../guide/mcp.md) |

| Option | Description |
| --- | --- |
| `--window` | `inspect`, `query`: this window (`w1`) instead of the focused one |
| `--ref` | `query`: search only under this element (`w1.12`) |
| `--limit` | `query`: list at most this many elements (1 to 3000, default 600) |
| `--all` | `inspect`: every window that is not marked `[minimized]`, and elements hidden by `opacity: 0` or `visibility`. `allow`, `deny`: every waiting prompt |
| `--cancel` | `choose`: answer the picker as cancelled |
| `--at` | `drop`: where to drop, `X,Y` in the page's CSS pixels |

`acdev query` prints `N in <window>:` and one line per element (exit code 0), or `acdev: nothing in <window> matches "<selector>"` on stderr (exit code 2). `acdev inspect --find TEXT` exits with code 2 when no element's name or value contains TEXT. Exit code 2 always means the command worked and found nothing; 1 means an error, such as a window or element that does not exist. `acdev act` prints what it did and what changed (`acdev act w1 move 100,80` and `acdev act w1 resize 800x600` print the window's new rectangle, in screen logical pixels; `acdev act w1 raise` brings it to the front; only a normal window moves or resizes, see [inspect and act](../guide/tools.md#inspect-and-act)); when the action was not done it prints the reason on stderr (`acdev: act <ref>: <reason>`) and exits with code 1. A ref that no longer exists says `there is no such element (any more); acdev inspect --find TEXT gives the current refs`.

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

`acdev call` works only with `--session vm` (a session in the guest started by `acdev vm`, or a machine with the dev packages): it sends one call through the session manager's dev connection and prints the result as JSON, exit code 0. `params` is JSON; `-` reads it from stdin. An error prints as it came, with its code: `acdev: call desktop secrets.get: <error> (code <code>)`, exit code 1. A session on this machine has no session manager and no Dopame backend, so `call` refuses there: `acdev: call: only in a session in the guest (--session vm): …`.

`acdev approvals` (only with `--session vm`) prints one line per system confirm that waits, `<id>  <op>  (from an agent|from the person)`, or `no system confirm waits`, exit code 0. `acdev approvals show <id>` prints `the system confirm page shows <id>: …`, or `<id> shows once the confirm on the screen now is answered` when another one is showing; an id that does not wait is an error (exit code 1). It never answers: allow, deny and the password are `act` steps on the confirm window.

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

A Dopame OS guest under QEMU: KVM on Linux, WHPX on Windows (enable the Windows Hypervisor Platform feature first), HVF on macOS; without them it emulates (TCG). On Windows `--share` and `--viewer` are not available; on macOS QEMU's own window is Cocoa (without 3D), and on Apple silicon (any arm64 host) the guest is aarch64 (`ACDEV_VM_ARCH` picks x86_64 or aarch64; `fetch` then takes the aarch64 image). `acdev vm fetch` gets the newest x86_64 disk image: the published image, or, when the published ISO is newer, the ISO installed into an image in a VM of its own (once per ISO, minutes, with progress lines; `--from-iso` / `--qcow2` force one way; there is no aarch64 ISO yet, so on Apple silicon it says so: start with `--image FILE` instead); `acdev vm start [--headless | --vnc | --viewer | --sdl | --gtk] [--outputs N] [--vga virtio|std] [--resolution WxH] [--audio none|wav] [--share DIR] [--image FILE] [--fresh] [--wait SECONDS] [--no-gl | --gl]` boots it in the background under an overlay disk (the image is not changed) and waits until the guest is ready. While it waits it prints a line every 15 s (what it waits for, for how long, why the last try failed, where the serial log is); if QEMU ends meanwhile it stops at once and names `qemu.log`; after the `--wait` seconds the guest keeps running and the message says what to look at next (`serial.log`, `qemu.log`, `acdev vm status`, `acdev vm wait`). Ctrl-C stops only the waiting: QEMU keeps running and `acdev vm wait` waits on. Sockets a previous run left behind that Windows will not let it delete do not stop a new start (it takes a fresh socket directory). In a window the guest has 3D (virgl) by default: the virtio GPU with GL (`virtio-vga-gl`) in an OpenGL window; `--no-gl` turns it off. `--headless` is without 3D unless `--gl` (rendered off screen, `egl-headless`), since QEMU cannot read a 3D screen back for `vm screenshot`. acdev turns it off by itself, with a note, where it is not wired up or cannot work: on macOS and Windows hosts (not wired up yet), with `--vnc`, `--viewer` or `--headless --outputs` above 1, with `--vga std`, when QEMU has no GL GPU or the host no GPU render node (`/dev/dri/renderD*`), or when QEMU fails to start GL (then it starts again without it). `acdev vm stop` powers it off; `acdev vm status`, `acdev vm wait [SECONDS]`. `acdev vm screenshot FILE.png [--output K]` takes the guest screen, also without a window; with 3D (a window, or `--headless --gl`) QEMU cannot read the screen back, so it says to use `acdev screen --session vm -o FILE.png` (the logged-in session), `--no-gl`, or `--headless` without `--gl`. `--outputs N` (1 to 16) gives the guest N displays: QEMU's window shows one tab each; with `--headless` QEMU gets its D-Bus display instead of none and `acdevtool view` switches the other displays on (without that they stay disconnected); `screenshot --output K` takes display K (from 0); `--vnc` and `--viewer` show only the first, so they refuse `--outputs` above 1. `acdev vm start` also installs acdevd, the device daemon, in the guest and reaches it over vsock on Linux, elsewhere over a QEMU port forward on 127.0.0.1 (`ACDEV_VM_TRANSPORT=vsock|unix|tcp` forces one; `unix` needs a recent QEMU, see `ACDEV_VM_TRANSPORT` in env.md), with a fresh key each start: `acdev vm run -- COMMAND` runs a command as root in the guest, streams its output and exits with its exit code (`--detach`: in the background, output in `/var/log/acdevd/<pid>.log`; `acdev vm kill PID [--force]` stops it); `acdev vm shell [-- COMMAND]` opens an interactive terminal on a pty that follows the window size and exits with the shell's exit code (no command: root's login shell); `acdev vm logs [SOURCE] [--follow] [--grep REGEX] [--lines N]` shows the guest journal, or a systemd unit's, a guest file, or the log of a `--detach` program by its process group id, the last 50 lines first, following with `--follow`, keeping only the lines that match `--grep` (ignoring case); `acdev vm dev [DIR] [--bin A,B] [--run COMMAND] [--profile NAME]` builds the Cargo project in DIR (default `.`) with `cargo build --profile NAME` (default: `guest` when the project defines that profile, else `release`), pushes its binaries to `/opt/acdev/bin`, runs `--run` (default: the first binary) in the background with that directory on `PATH` and shows its output, then on every source change builds again, and if that works stops the program, pushes and starts it again; Ctrl+C stops it; `acdev vm push LOCAL [REMOTE]` copies a file or a directory in, executable files as 755 and the rest 644 (on Windows, whose files have no execute bit, ELF programs and `#!` scripts count as executable) (default `/opt/acdev/<name>`; a file goes into `REMOTE/<name>` when REMOTE ends with `/` or is a guest directory, as with `cp`); `acdev vm pull REMOTE [LOCAL]` copies a guest file or directory out with its rwx permission bits (no setuid, setgid or sticky bit) (default `./<name>`; into `LOCAL/<name>` when LOCAL is a directory); `acdev vm start --viewer` shows the guest in acdev's own window (QEMU's D-Bus display, Linux for now) instead of QEMU's, and `acdev vm view` opens that window again after it was closed; `acdev vm mount` mounts the `--share` directory at `/mnt/acdev`; `acdev vm console` makes the guest kernel log to the serial port from the next boot. `start`'s window on Linux is QEMU's SDL window by default (`--sdl`): the guest starts at 1280x800 and follows the window when you resize it; a QEMU built without SDL falls back to GTK. `--gtk` picks QEMU's GTK window, which hands its first, small size to the guest, so the guest starts small until you enlarge the window; with `--outputs` above 1 the window is GTK, one tab each. `--vga virtio` (the default) is the virtio GPU: it resizes with the window, has more displays and 3D; `--vga std` is the standard VGA (bochs-drm in the guest; one display of a fixed size), for sleep and wake, which the virtio GPU does not survive. `--resolution WxH` is the display size the guest starts with (default 1280x800). `--audio none` (the default) plays the guest sound card nowhere, `--audio wav` into `audio.wav` in the logs directory. `--fresh` also drops the UEFI variables; run `provision` again after it. `acdev vm usb add IMAGE [--size SIZE]` plugs a disk image in as a USB stick (a new image is made, `--size` like `256M` or `2G`, default `256M`, and formatted FAT, which needs `mkfs.vfat` or `mkfs.exfat`); `acdev vm usb remove [IMAGE|ID]` pulls one out (default: the last one plugged in); `acdev vm usb list` shows them. `acdev vm wake` wakes a guest that went to sleep (S3). `acdev vm login [USER]` logs USER (default `tester`, password `ACDEV_VM_PASSWORD`, default `dopame-dev`) in at the guest's login page, with no keys typed (acdes `greeter login`, guests acdev started only); `acdev test --vm` does it first by itself. `acdev vm provision` sets the guest up for testing and can be run again: the test user (`--user NAME`, default `tester`; its password is `ACDEV_VM_PASSWORD`, default `dopame-dev`), greetd on the acdes login screen, acdes (its compositor included) laid out by the acdes PKGBUILD (`--acdes DIR`, the acdes checkout, with `--acdes-bin FILE`, its guest build, `--system-agent-bin FILE` when the acdes PKGBUILD also installs `system-agent`; and `--manager-node FILE`, the `libacdes_manager_node.so` build, when it installs the manager's Node-API module as `/usr/lib/acdes/manager.node`; and `--proxy-bin FILE`, the `acde-proxy` build, when it installs the system proxy as `/usr/lib/acdes/proxy`), `--libacde DIR` (the libacde checkout, for its LICENSE) and `--harness FILE` (the dopame-harness build); `--pkgs DIR` installs every `*.pkg.tar.zst` in DIR (for example acdes and dopame from the artifact site) with `pacman -U` after syncing the package database, removing the old `acdebin-system` and `acde-dopame` first; the Dopame desktop goes in this way, as its own package. In this development guest it first installs from the repositories what the packages depend on and is missing (`pacman -T`), leaving out the acdes provision lays out without pacman and the packages of the batch, then installs the batch with `pacman -U --nodeps --nodeps --overwrite '*'`, so an acdes not known to pacman is no missing dependency and files an earlier layout left are replaced. `--dopame DIR` is removed (it laid out only part of the dopame package): given, provision stops with exit code 1 and says to use `--pkgs DIR` with the dopame `.pkg.tar.zst`. It also gives the test user passwordless sudo for exactly the five commands the dopame guest checks use to swap the environment of its session agent unit (`/etc/sudoers.d/acdev-dev`, checked with `visudo`; development guests only). Either way, once acdes is in, provision enables and starts its `acdes-system-agent` (the system agent) and `acdes-proxy` (the system proxy) services, which the acdes package leaves off. A step that failed but did not stop provision (a package that would not install, btvirt that did not build, a unit that did not start) prints a warning, and provision then exits 4 listing them. By default it restarts greetd and starts a simulated Wi-Fi (two access points over mac80211_hwsim), simulated Bluetooth controllers (btvirt) and a simulated battery (100%, charging); `--no-restart`, `--no-wifi`, `--no-bluetooth` and `--no-battery` leave each out, and `--btvirt FILE` gives a btvirt build for the guest (without it, provision builds one in the guest). `--wifi`, `--bluetooth` and `--battery` are accepted and change nothing, since all three are on by default. The guest's driver pruning removes `mac80211_hwsim` (and can remove `bochs`) with their module packages; provision tries to install them back with `pacman -S` (only a warning when no repository has them), and `--kernel-pkgs DIR` installs them from a host directory instead (the `linux-ackernel-<group>-*.pkg.tar.zst` of the ackernel build that matches the guest's `linux-ackernel` version; another version stops provision with both versions named). Everything lives in `$ACDEV_VM_DIR` (default `~/.local/share/acdev/vm`): the images, the overlay disk, the sockets and `logs/serial.log`. Needs `qemu-system-x86_64`, `qemu-img` and OVMF; without access to `/dev/kvm` it emulates, much slower.

## Testing

```text
acdev test [dir|file...] [--headed] [-t PATTERN] [--desktop ID|DIR] [--vm] [--timeout MS] [--bail] [--trace] [-u]
          [--workers N] [--retries N] [--last-failed] [--video[=on|failed|off]]
```

| Option | Description |
| --- | --- |
| `--headed` | Open windows (headless by default) |
| `-t`, `--test-name-pattern` | Run only tests whose names match |
| `--desktop` | Run the app in this desktop |
| `--vm` | Run in the logged-in session in the guest of [`acdev vm`](#acdev-vm): one file at a time, every test in the same session, home is that user's `HOME`; the user's password is set to `ACDEV_VM_PASSWORD` (default `dopame-dev`) and its failed-login lock reset first |
| `--timeout` | Timeout per test, including the start of its session (milliseconds, default 60000) |
| `--bail` | Stop at the first failure |
| `--trace` | Leave a `trace.html` for every test |
| `-u`, `--update-screenshots` | Rewrite screenshot baselines |
| `--workers` | How many test files run at once (default: half the cores, at most 4; 1 with `--headed` or `--bail`) |
| `--retries` | Run a failing test again this many times, each on a fresh session; a test that passes later is reported as flaky (default 0) |
| `--last-failed` | Run only the tests that failed in the last run |
| `--video` | Keep `video.png`, an animated PNG of the screen, for failing tests (the same as `--video=failed`); `--video=on` keeps it for every test, `--video=off` for none (the default) |

The run ends with one line that counts tests and files and names the failing files (`acdev test: 5 tests in 2 files: 4 passed, 1 failed; failed: e2e/notes.e2e.ts`); see [Testing](../guide/testing.md#commands).
