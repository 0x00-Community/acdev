# Check the setup

`acdev doctor` checks what `acdev dev` and `acdev test` need on this machine and says how to fix what is wrong; `acdev doctor --fix` fixes what acdev may fix itself. Run it after installing, in a project you are about to work on, and whenever `acdev dev`, `acdev test` or the MCP `start` does not come up.

```sh
acdev doctor
```

```text
ok     acdev: X.Y.Z on Bun 1.4.4 (/Users/me/.acdev/versions/X.Y.Z)
ok     PATH: acdev on PATH is this one (/Users/me/.acdev/bin/acdev)
ok     Bun and Node.js: Bun 1.4+ at /Users/me/.bun/bin/bun; Node.js 22.3+ at /opt/homebrew/bin/node
ok     runtime: acdev X.Y.Z (contract level 1) at /Users/me/.acdev/versions/X.Y.Z/libexec/acdev (installed next to acdev)
ok     contract level: level 1 on both sides (acdev runtime X.Y.Z, SDK X.Y.Z)
ok     gpu: Apple M3 Pro (Metal, integrated GPU): drew a test frame in 38 ms
ok     acdev dev sessions: none running
ok     project: notes, app (acde.config.jsonc): acdev check finds nothing wrong
ok     platform: macos (desktop, standalone) has every required capability
ok     dependencies: installed with bun (runs on Bun 1.4+), @acde/api X.Y.Z
ok     git: .acde/ (the build output) is ignored
ok     agent skill: current in /Users/me/.agents/skills/acdev, /Users/me/.claude/skills/acdev
acdev doctor: everything acdev needs is here
```

Each line is `<status> <check>: <what it found>`:

| Status | Meaning |
| --- | --- |
| `ok` | Fine |
| `warn` | Works, but something will get in the way; a `fix:` line follows |
| `error` | `acdev dev` or `acdev test` will not work; a `fix:` line follows when there is one |
| `skip` | Not checked: there is no project here, or the check needs one that failed |

The last line counts errors and warnings. The exit code is 1 when any check is an error, else 0. `acdev doctor <dir>` checks the project in `<dir>` instead of the current directory (a directory with no acde project is then an error), and `--online` adds whether a newer acdev is out.

## What it checks

| Check | What it looks at |
| --- | --- |
| `acdev` | The version of acdev and the JavaScript runtime it runs on |
| `PATH` | Whether the `acdev` on PATH is this one, not another install or checkout |
| `Bun and Node.js` | Bun 1.4+ and Node.js 22.3+ on PATH; `acdev test` and projects that use bun need Bun |
| `runtime` | The runtime binary `acdev dev` would run (`ACDEV_RUNTIME`, else `libexec/acdev` of the install), and whether it runs |
| `contract level` | Whether the runtime runs the contract level this acdev builds, and whether it is the release this acdev pairs with |
| `gpu`, `display` | The runtime binary's own check (`libexec/acdev doctor`): the GPU (it draws a small frame and reads it back), and on Linux whether a host window can open |
| `acdev dev sessions`, `approval` | The running `acdev dev` sessions, and every camera or microphone prompt that waits for an answer |
| `project` | `acdev check` of the project |
| `platform` | Whether this platform has every capability the project's apps require |
| `dependencies` | The project's dependencies are installed (also when a workspace keeps them in a parent directory), its runtime is on PATH, and its `@acde/api` (in `package.json` and installed) is the version this acdev is built with; an older SDK is reported here once, fixed by `acdev sdk update` (followed by the directory when `acdev doctor` was given one) |
| `git` | Whether git ignores `.acde/` |
| `agent skill` | Whether the acdev skill is installed for coding agents and current |
| `latest release` | With `--online`: whether a newer acdev is out |

## Common findings

No runtime:

```text
error  runtime: acdev dev needs the Dopame runtime (libexec/acdev of an install) and found none: no /Users/me/.acdev/versions/X.Y.Z/libexec/acdev, which the acdev installer puts there: run the installer again, or set ACDEV_RUNTIME to the runtime binary (target/release/acdev of an acdev checkout)
       fix: run the installer again: curl -fsSL https://pkgs.dopame.ai/acdev/install.sh | sh (it puts the acdev runtime that pairs with acdev next to it)
```

A runtime that does not start reports why: a missing system library (`it exited with code 127: … error while loading shared libraries: …`), a file that is not executable (`EACCES`), or on macOS a binary that a download left in quarantine, with `xattr -d com.apple.quarantine <path>` as the fix.

A runtime that cannot draw is an error of the `gpu` check, with the same reason `acdev dev` would log at startup after `web layer unavailable:`. On Linux without the GPU's Vulkan driver:

```text
error  gpu: the system has a GPU (card0, kernel driver xe) but no usable Vulkan driver was found: install the GPU's Vulkan driver (for example vulkan-intel, vulkan-radeon, nvidia-utils) or point VK_DRIVER_FILES at its ICD (wgpu: No suitable graphics adapter found; …)
```

Install the driver (see [The runtime](../start/install.md#the-runtime)). With only a software driver (lavapipe), `gpu` is a warning: pages render on the CPU, and a page that animates the whole screen (a live wallpaper) shows only a few frames a second. When it works, the line names the GPU, the graphics API and the driver, such as `ok     gpu: Intel(R) Graphics (PTL) (Vulkan, integrated GPU, driver Intel open-source Mesa driver Mesa 26.2.5-arch3.1): drew a test frame in 41 ms`.

On Linux in a shell with no graphical session (over SSH, for example):

```text
warn   display: neither WAYLAND_DISPLAY nor DISPLAY is set, so acdev app and acdev desktop cannot open a host window here: they would try to start a session on the screen (DRM) instead
       fix: run acdev dev --headless, or run it inside a graphical session
```

A camera or microphone prompt that waits:

```text
warn   approval: recorder waits for approval of microphone in acdev dev 4242, so its getUserMedia waits until the prompt is answered
       fix: acdev allow (or acdev deny): approving is the user's decision
```

## Fix what it can

`acdev doctor --fix` runs the checks, prints them, then fixes what it can and checks again:

| Fix | When | Asks first |
| --- | --- | --- |
| `acdev skills install` | The acdev skill is not installed for any coding agent, or an installed one is outdated or broken | No |
| Add `.acde/` to the project's `.gitignore` | git does not ignore the build output | No |
| Remove and make again the sessions directory | It is a link or a file, not a directory | No |
| Run the installer of this acdev version again (`install.sh --version <this version> --no-modify-path`, `install.ps1 -Version … -NoModifyPath` on Windows) | The runtime next to acdev is missing, does not run, or is of another contract level or release; only for an installed acdev, and not when `ACDEV_RUNTIME` names the runtime | Yes: it downloads the runtime and replaces the install, all or nothing, as the installer always does |
| The project's install (`bun install`, `npm install`, …) | Its dependencies are not installed | Yes: it downloads packages and runs their install scripts |
| `acdev stop --session <pid>` | A running `acdev dev` does not answer | Yes: it ends a process you started |

In a terminal it asks about each fix in the last column. Without a terminal (a script, a coding agent) it skips them and says so, `skipped: … (it asks first: pass --yes to allow it)`, unless it is given `--yes`. A coding agent passes `--yes` only when the user agreed.

It never touches what is the user's to decide: a camera or microphone prompt, a GPU driver or a system library, a binary in macOS quarantine, another acdev on PATH, the project's code and config. Those keep their `fix:` line.

```text
fixing: install the acdev skill for the coding agents found here (acdev skills install)
acdev: skill linked to /Users/me/.agents/skills/acdev (Cline, Codex, …)
fixed: install the acdev skill for the coding agents found here (acdev skills install)
skipped: install the project's dependencies (bun install in /Users/me/notes) (it asks first: pass --yes to allow it)
acdev doctor: after fixing:
ok     acdev: X.Y.Z on Bun 1.4.4 (/Users/me/.acdev/versions/X.Y.Z)
…
```

## acdev dev points here

When `acdev dev` finds no runtime, its error ends with `(acdev doctor checks the whole setup)`. When the runtime exits before the session is ready, `acdev dev` prints the runtime's log line and then:

```text
acdev: acdev runtime exited (1) before it was ready; acdev doctor checks the runtime, the GPU and this setup
```

## In scripts and agents

`acdev doctor --json` prints one object:

```json
{
  "ok": false,
  "checks": [
    { "id": "runtime.binary", "title": "runtime", "status": "error", "summary": "…", "fix": "…" }
  ]
}
```

`ok` is false when a check is an error. A check that `--fix` can repair carries `"repair": {"action", "target", "ask", "does"}` (`ask` is true for the fixes that ask first), and with `--fix` the object also has `"fixed": [{"repair", "result", "said"}]`, `result` being `fixed`, `failed` or `skipped`; the progress lines then go to stderr. The ids are `acdev`, `path`, `runtimes`, `runtime.binary` (the runtime binary; its title is `runtime`), `contract`, `runtime` (when the runtime's own check cannot run), `runtime.host`, `runtime.gpu`, `runtime.display`, `sessions`, `approval`, `project`, `platform`, `dependencies`, `gitignore`, `skill` and `latest`; `fix` is left out when there is none. The MCP server has the same check as its `doctor` tool, and the fixes that do not ask as `doctor_fix` (it names the others and leaves them to the user); see [MCP](mcp.md).

The runtime's part also runs on its own: the runtime binary's `doctor` (`libexec/acdev doctor`, or `libexec/acdev doctor --json`, in the install directory), with the same exit codes.
