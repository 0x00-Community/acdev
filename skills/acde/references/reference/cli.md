# CLI

```text
acde <command> [args]
```

On error, acde prints one line, `acde: <reason>`, and exits with code 1. A wrong argument (an action `act` does not know, a level `console` does not know, …) is answered with one line that names what is wrong and the `acde <command> --help` to read, such as `acde: console: --level loud: one of log, info, warn, error, debug, errors (acde console --help)`; a wrong option value always reads `acde: <command>: --<option> <value>: <what it takes> (acde <command> --help)`. The full usage is printed only by `acde` with no command.

Exit codes are the same for every command:

| Exit code | Meaning |
| --- | --- |
| 0 | Done (also an empty list, such as `acde console` with no entries) |
| 1 | An error: a wrong argument, something that failed, or something that stops it (a package in use) |
| 2 | Nothing done, but not an error: nothing matched (`acde query`, `acde inspect --find`) or nothing to remove (`acde uninstall`) |
| 3 | Cancelled or not confirmed: Ctrl+C in a question of `acde new` or during `acde sdk update`, a declined `acde uninstall`, or no terminal to ask in and no `--yes` |

What a command found goes to stdout; "nothing found", errors and notes go to stderr with the `acde:` prefix.

`acde --version` (or `-v`) prints the version of acde on the first line, then the SDK version and contract level it was built with, and the acdert it finds (`ACDERT`, the one installed next to acde, then PATH) with that runtime's version and contract level. `acde --help` (or `-h`) prints the usage; `acde <command> --help` and `acde help <command>` print that command only. An unknown command or argument prints one line that says what is wrong and which `--help` to read, and exits with code 1. Color is on when the stream written to is a terminal; `NO_COLOR` turns it off, `FORCE_COLOR` turns it on (`FORCE_COLOR=0` turns it off), and only labels such as `acde:`, `error:` and `warning:` are coloured. An error is one line, `acde: <what went wrong>`; with `ACDE_DEBUG=1` its stack trace follows.

## Setup

### acde doctor

```text
acde doctor [dir] [--json] [--online] [--fix [--yes]]
```

Checks what `acde dev` and `acde test` need on this machine: acde on PATH, Bun and Node.js, acdert (found, runs, runs the contract level this acde builds, is the release this acde pairs with), the runtime's own checks (`acdert doctor`: its host files, the GPU, and on Linux the display), running `acde dev` sessions and the approvals they wait for, the project in `dir` (default: the current directory; `acde check`, this platform, its dependencies, `.acde/` in `.gitignore`), and the acde skill for coding agents. See [Check the setup](../guide/doctor.md).

| Option | Description |
| --- | --- |
| `--json` | One JSON object instead of lines: `{"ok": …, "checks": [{"id", "title", "status", "summary", "fix", "repair"}]}`; with `--fix` also `"fixed"` |
| `--online` | Also ask the acde download site (`ACDE_DIST`) whether a newer acde is out |
| `--fix` | After the checks, fix what acde can: some fixes right away, the others after asking; then check again. See [Fix what it can](../guide/doctor.md#fix-what-it-can) |
| `--yes` | With `--fix`: do the fixes that ask first without asking |

It prints one line per check, `<status> <check>: <what it found>`, with `fix: …` on the next line for a problem, and a last line that counts errors and warnings. The status is `ok`, `warn`, `error` or `skip` (not checked: no project here, or an earlier check failed). It exits with code 1 when a check is an error, else 0. A `dir` that holds no acde project is an error.

With `--fix`, after the report it prints `fixing: <what>`, the output of what it runs, and `fixed: <what>` or `failed: <what>: <why>` for each fix, `skipped: <what>` for one that was not allowed, and then `acde doctor: after fixing:` and the checks again; the exit code follows the second run. When nothing can be fixed it says `acde doctor: nothing here it can fix; the fix lines say what to do`. `--yes` without `--fix` is an error.

## Projects

### acde new

```text
acde new [dir] [--template T] [--id ID] [--label NAME] [--backend] [--no-install] [--git] [--pm PM] [--yes]
```

Creates a project. In a terminal, it asks for whatever is missing; with `--yes`, or outside a terminal, it asks nothing (then `dir` is required, the template defaults to `html`, and no dependencies are installed and no repository is created).

| Option | Description |
| --- | --- |
| `--template` | `html` `desktop` `react` `vue` `svelte` `solid` `preact` `vanilla` `next` `nuxt` `sveltekit` `astro` |
| `--id` / `--label` | App id and display name |
| `--backend` | Add `server.ts`, a backend (`html` and the Vite templates; `next`, `nuxt`, `sveltekit` and `astro` have their own server, and a desktop has none) |
| `--no-install` | Do not install the dependencies (by default `acde new` installs them, the SDK included, with the package manager) |
| `--git` | `git init` and make the first commit (if a git user name and email are configured) |
| `--pm` | `bun` `npm` `pnpm` `yarn`; decides whether the project runs on Bun or Node.js |

### acde check

```text
acde check [dir] [--platform windows|macos|linux]
```

Checks the config (id, entry, icon, service modules, framework) and the manifest rules of the SDK, or the manifest and entry files of a handwritten package, and the `acde:` imports against the manifest. It prints `error:`, `warning:` and `note:` lines on stderr and exits with code 1 only when there is an error. A `note:` marks an import that the check lets pass but cannot verify, the namespace of a [desktop service](../guide/services.md#call-it) that is not the service's own name: `note: src/main.js:1: app "notes": acde:timer resolves only if the service Notes lists ("clock") provides the "timer" namespace`.

It also checks the app's declared capabilities against what a platform has, once for each way of running an app there (`desktop` and `standalone`, on Linux also `session`). That platform is the one `acde check` runs on, or the one `--platform` names:

- A required capability that the platform lacks is an error: `error: windows (desktop): app "notes" requires network, which this mode lacks`, followed by a hint on making it optional.
- An optional capability that it lacks is a note, and no error: `note: windows (desktop): app "notes" runs without optional camera, which this mode lacks`.
- When no required capability is missing, the last line is `ok: linux (session, desktop, standalone): every required capability is there`.

### acde build

```text
acde build [dir] [--out DIR]
```

Builds into `DIR` (default `.acde`). A relative `--out` is resolved against the project being built. The `acde:` imports are checked first, as in `acde check` (an error stops the build, a `note:` is printed), and the manifest of the output is checked again.

### acde install

```text
acde install [dir] [--out DIR]
```

Builds, then installs into `$XDG_DATA_HOME/acde/packages/<id>`; without `XDG_DATA_HOME`, `~/.local/share/acde/packages/<id>` (on Windows `%USERPROFILE%\.local\share\acde\packages\<id>`). See [Local install](../guide/install.md).

### acde uninstall

```text
acde uninstall [id|dir] [--yes]
```

Removes a package that `acde install` put into the packages directory, found by its id (its directory name there) or by the project directory it was installed from. For a handwritten package, installed as a link, it removes only the link; the project it points at stays. Before removing, it prints what it removes (`acde: removes <id>: <path> ...`) and, in a terminal, asks; `--yes` removes without asking, and outside a terminal nothing is removed without `--yes`. When an `acde dev` session runs the package's desktop or one of its apps, or runs a desktop while the package has apps, it removes nothing and names the session to stop first (`acde stop --session <pid>`). With no argument it lists the installed packages, one per line: the id and the path (for a link, `-> <project>`).

| Exit code | Meaning |
| --- | --- |
| 0 | Removed, or listed |
| 1 | In use by an `acde dev` session, or a wrong argument |
| 2 | Not installed |
| 3 | Not confirmed (the question was declined, or no terminal and no `--yes`) |

### acde sdk

```text
acde sdk [update] [dir]
```

Shows the project's `@dopame/acde-api` and the SDK version this acde pairs with. `acde sdk update` points the dependency at that version's tarball on `https://calbin-1318886512.cos.ap-beijing.myqcloud.com/pkgs/acdert/<version>/` and reinstalls with the project's package manager (from its lock file or `packageManager`). With npm 12 or later it also adds `allow-remote=root` to `.npmrc` (in the workspace root for a workspace member, where npm reads it; npm 12 refuses URL dependencies without it; projects `acde new` makes with npm 12 have it already). npm 11 does not need it and gets no `.npmrc`, so a project made with npm 11 needs one `acde sdk update` before npm 12 installs it. If the package manager is not on PATH it changes nothing. If the install fails or is interrupted (Ctrl+C), it puts `package.json`, the lock file and `.npmrc` back as they were and says so, naming any file it could not put back; run the install again to bring `node_modules` back in line. `acde check` also warns when `node_modules` holds another SDK version than `package.json` names. `acde check` and `acde dev` warn when the two differ, for example after upgrading acde.

### acde dev

```text
acde dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless] [--verbose] [--force]
```

Builds, starts acdert, and rebuilds and reloads on changes. `--headless` opens no window; use it on a machine without a display. `--verbose` also prints the runtime's own info log; by default the terminal shows what the pages and backends print, what happens to each app, and the runtime's warnings and errors. On Linux without `WAYLAND_DISPLAY` or `DISPLAY`, `acde dev` without `--headless` stops with `acde: no display here (no WAYLAND_DISPLAY or DISPLAY): run acde dev --headless` and exits with code 1. Only one `acde dev` runs a project at a time, even when two start at the same moment: a second one exits with code 1 before it builds and names the running one (`acde: acde dev <pid> already runs <dir>; stop it first (acde stop --session <pid>), or pass --force to start another`); `--force` starts it anyway. Ctrl+C, SIGINT and SIGTERM end the session and its runtime, and remove its files; files left by a session that was killed are removed by the next `acde dev` or session command. See [acde dev](../guide/dev.md) and [Without a display](../guide/tools.md#without-a-display).

## Running sessions

These work with a running `acde dev` session, and all of them accept `--session <pid>`. A `<web>` is one page: a web name from `acde webs`, an app id, or `desktop`; a `<ref>` is an element id from `acde inspect` or `acde query`, such as `w1.12`, or a window, such as `w1`. See [Debugging](../guide/tools.md).

| Command | Description |
| --- | --- |
| `acde webs` | Lists pages |
| `acde eval <web> <code\|->` | Runs code in a page and prints JSON |
| `acde shot <web> [-o, --output FILE]` | Window screenshot, default `./<web>.png` |
| `acde screen [-o, --output FILE]` | Full-screen screenshot, default `./screen.png` |
| `acde pointer <x> <y>` | Moves the pointer to screen coordinates, as a real move |
| `acde inspect [--window W] [--find TEXT] [--all] [--offscreen]` | The screen as text |
| `acde query <selector> [--window W] [--ref REF] [--limit N]` | The elements a CSS selector matches, each with a ref |
| `acde act <ref> <action> [arg]` | Performs an action on a ref |
| `acde console [--web W] [--level L] [--since S] [--follow]` | Page logs and errors; `--since reload` or `--since N` |
| `acde network [--web W] [--failed] [--since S] [--follow]` | Page requests; `--since reload` or `--since N`. With nothing to show, `console` and `network` print `acde: no console entries` / `acde: no requests` on stderr and exit 0 |
| `acde permissions` | The camera and microphone prompts that wait and the decisions made |
| `acde allow [<prompt id> \| <app> <capability>] [--all]` | Allows a waiting camera or microphone prompt |
| `acde deny [<prompt id> \| <app> <capability>] [--all]` | Denies a waiting camera or microphone prompt |
| `acde revoke <app> <capability>` | Takes back a decision |
| `acde stop` | Ends the session and its acdert; see [Stopping](../guide/dev.md#stopping) |
| `acde devtools [web]` | Opens the DevTools of Chrome or Edge on a page of the session (a web name, an app id, `desktop`, a window title, or `services` or a service name for the services; default: the focused page) and prints the DevTools address. It looks for Edge, then Chrome on Windows; the Chrome app, then the Edge app on macOS; `google-chrome`, `chrome`, `chromium`, `microsoft-edge` on `PATH` on Linux. The browser runs with a profile of its own in acde's cache directory (`acde/devtools/` under `%LOCALAPPDATA%`, `~/Library/Caches` or `~/.cache`), never your everyday one; it opens no window of its own and no sync prompt, only the DevTools window, and stays running for the next `acde devtools`. `ACDE_BROWSER` names another browser; `ACDE_BROWSER=none` opens nothing. Without a browser, or when it cannot be started or reached, it prints the address and why, to paste into the address bar of Chrome or Edge, and exits 0 |
| `acde mcp [--session PID]` | MCP server over stdio; see [MCP](../guide/mcp.md) |

| Option | Description |
| --- | --- |
| `--window` | `inspect`, `query`: this window (`w1`) instead of the focused one |
| `--ref` | `query`: search only under this element (`w1.12`) |
| `--limit` | `query`: list at most this many elements (1 to 3000, default 600) |
| `--all` | `inspect`: every window that is not marked `[minimized]`, and elements hidden by `opacity: 0` or `visibility`. `allow`, `deny`: every waiting prompt |

`acde query` prints `N in <window>:` and one line per element (exit code 0), or `acde: nothing in <window> matches "<selector>"` on stderr (exit code 2). `acde inspect --find TEXT` exits with code 2 when no element's name or value contains TEXT. Exit code 2 always means the command worked and found nothing; 1 means an error, such as a window or element that does not exist. `acde act` prints what it did and what changed; when the action was not done it prints the reason on stderr (`acde: act <ref>: <reason>`) and exits with code 1. A ref that no longer exists says `there is no such element (any more); acde inspect --find TEXT gives the current refs`.

`acde permissions` prints two blocks and exits with code 0:

```text
pending:
  2  recorder  microphone  (request)
decisions:
  recorder  camera  granted
```

A pending line is `<prompt id>  <app>  <capability>  (<reason>)`; the reason is always `request` (the running app asked: its `getUserMedia()` or `request()` waits for the answer); a decision line is `<app>  <capability>  <granted|denied>`. An empty block is `pending: none` or `decisions: none`.

`acde allow` and `acde deny` answer prompts that wait now. Without arguments they answer the only waiting prompt; when several wait they answer none, list them, and exit with code 1. `<prompt id>` names one prompt, `<app> <capability>` the prompt of that app for that capability, and `--all` every waiting prompt. Each answered prompt prints `allowed <app> <capability> (prompt <id>)` or `denied <app> <capability> (prompt <id>)`. When nothing waits, or nothing matches, they print one line that says so (`acde: no approval prompt is waiting`, `acde: no approval prompt 5 is waiting (waiting: 2)`) and exit with code 1.

`acde revoke <app> <capability>` prints `revoked <app> <capability>`; when there is no such decision it says so and exits with code 1.

While a camera or microphone prompt waits, `acde webs` prints one line per prompt after the table (the app's window is open; its `getUserMedia()` waits): `<app> waits for approval of <capability>: acde allow (or acde deny)`. See [Camera and microphone](../guide/tools.md#camera-and-microphone).

## Coding agents

```text
acde skills [install|remove|path] [--agent ID,...] [--dir DIR] [--copy]
```

| Command | Description |
| --- | --- |
| `acde skills` | Where the acde skill is installed, and whether each place is current |
| `acde skills install` | Links the skill into `~/.agents/skills` and the skills directory of every agent found |
| `acde skills remove` | Removes it from those places, and the directories `install` created that are now empty |
| `acde skills path` | Prints the skill's directory inside the acde install |

| Option | Description |
| --- | --- |
| `--agent` | These agents (comma-separated ids such as `claude-code`, `codex`, `cursor`) instead of the ones found |
| `--dir` | This skills directory instead; the skill goes into `DIR/acde` |
| `--copy` | Copy instead of link (`install` only) |

See [Coding agents](../guide/agents.md).

## Testing

```text
acde test [dir|file...] [--headed] [-t PATTERN] [--desktop ID|DIR] [--timeout MS] [--bail] [--trace] [-u]
          [--workers N] [--retries N] [--video[=on]]
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
| `--video` | Keep `video.png`, an animated PNG of the screen, for failing tests; `--video=on` keeps it for every test |

The run ends with one line that counts tests and files and names the failing files (`acde test: 5 tests in 2 files: 4 passed, 1 failed; failed: e2e/notes.e2e.ts`); see [Testing](../guide/testing.md#commands).
