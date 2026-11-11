# Check the setup

`acde doctor` checks what `acde dev` and `acde test` need on this machine and says how to fix what is wrong; `acde doctor --fix` fixes what acde may fix itself. Run it after installing, in a project you are about to work on, and whenever `acde dev`, `acde test` or the MCP `start` does not come up.

```sh
acde doctor
```

```text
ok     acde: 0.0.9 on Bun 1.4.4 (/Users/me/.acde/versions/0.0.9)
ok     PATH: acde on PATH is this one (/Users/me/.acde/bin/acde)
ok     Bun and Node.js: Bun 1.4+ at /Users/me/.bun/bin/bun; Node.js 22.3+ at /opt/homebrew/bin/node
ok     acdert: acdert 0.0.9 (contract level 1) at /Users/me/.acde/versions/0.0.9/bin/acdert (installed next to acde)
ok     contract level: level 1 on both sides (acdert 0.0.9, SDK 0.0.9)
ok     host files: /Users/me/.acde/versions/0.0.9/bin/app/dist
ok     gpu: Apple M3 Pro (Metal, integrated GPU): drew a test frame in 38 ms
ok     acde dev sessions: none running
ok     project: notes, app (acde.config.jsonc): acde check finds nothing wrong
ok     platform: macos (desktop, standalone) has every required capability
ok     dependencies: installed with bun (runs on Bun 1.4+), @dopame/acde-api 0.0.9
ok     git: .acde/ (the build output) is ignored
ok     agent skill: current in /Users/me/.agents/skills/acde, /Users/me/.claude/skills/acde
acde doctor: everything acde needs is here
```

Each line is `<status> <check>: <what it found>`:

| Status | Meaning |
| --- | --- |
| `ok` | Fine |
| `warn` | Works, but something will get in the way; a `fix:` line follows |
| `error` | `acde dev` or `acde test` will not work; a `fix:` line follows when there is one |
| `skip` | Not checked: there is no project here, or the check needs one that failed |

The last line counts errors and warnings. The exit code is 1 when any check is an error, else 0. `acde doctor <dir>` checks the project in `<dir>` instead of the current directory (a directory with no acde project is then an error), and `--online` adds whether a newer acde is out.

## What it checks

| Check | What it looks at |
| --- | --- |
| `acde` | The version of acde and the JavaScript runtime it runs on |
| `PATH` | Whether the `acde` on PATH is this one, not another install or checkout |
| `Bun and Node.js` | Bun 1.4+ and Node.js 22.3+ on PATH; `acde test` and projects that use bun need Bun |
| `acdert` | The runtime `acde dev` would run (`ACDERT`, else the one installed next to acde, else PATH), and whether it runs |
| `contract level` | Whether the runtime runs the contract level this acde builds, and whether it is the release this acde pairs with |
| `host files`, `gpu`, `display` | The runtime's own check, `acdert doctor`: its host files, the GPU (it draws a small frame and reads it back), and on Linux whether a host window can open |
| `acde dev sessions`, `approval` | The running `acde dev` sessions, and every app that waits for an approval, which opens no window until the prompt is answered |
| `project` | `acde check` of the project |
| `platform` | Whether this platform has every capability the project's apps require |
| `dependencies` | The project's dependencies are installed (also when a workspace keeps them in a parent directory), its runtime is on PATH, and its `@dopame/acde-api` is the version this acde is built with |
| `git` | Whether git ignores `.acde/` |
| `agent skill` | Whether the acde skill is installed for coding agents and current |
| `latest release` | With `--online`: whether a newer acde is out |

## Common findings

No runtime:

```text
error  acdert: acde dev needs the Dopame runtime (acdert) and found none: no /Users/me/.acde/versions/0.0.9/bin/acdert, which the acde installer puts there: run the installer again, set ACDERT to an acdert binary, or put acdert on PATH
       fix: run the installer again: curl -fsSL https://pkgs.dopame.ai/acde/install.sh | sh (it puts the acdert that pairs with acde next to it)
```

A runtime that does not start reports why: a missing system library (`it exited with code 127: … error while loading shared libraries: …`), a file that is not executable (`EACCES`), or on macOS a binary that a download left in quarantine, with `xattr -d com.apple.quarantine <path>` as the fix.

A runtime from before `acdert doctor` cannot check its files and the GPU:

```text
warn   runtime check: acdert 0.0.8 cannot check itself (it has no acdert doctor), so its GPU and host files were not checked
```

A runtime that cannot draw is an error of the `gpu` check, with the same reason `acde dev` would log at startup after `web layer unavailable:`. On Linux without the GPU's Vulkan driver:

```text
error  gpu: the system has a GPU (card0, kernel driver xe) but no usable Vulkan driver was found: install the GPU's Vulkan driver (for example vulkan-intel, vulkan-radeon, nvidia-utils) or point VK_DRIVER_FILES at its ICD (wgpu: No suitable graphics adapter found; …)
```

Install the driver (see [The runtime](../start/install.md#the-runtime)); there is no software fallback. When it works, the line names the GPU, the graphics API and the driver, such as `ok     gpu: Intel(R) Graphics (PTL) (Vulkan, integrated GPU, driver Intel open-source Mesa driver Mesa 26.2.5-arch3.1): drew a test frame in 41 ms`.

On Linux in a shell with no graphical session (over SSH, for example):

```text
warn   display: neither WAYLAND_DISPLAY nor DISPLAY is set, so acdert app and acdert desktop cannot open a host window here: they would try to start a session on the screen (DRM) instead
       fix: run acde dev --headless, or run it inside a graphical session
```

An app that waits for an approval:

```text
warn   approval: notes waits for approval of terminal in acde dev 4242, so it opens no window until the prompt is answered
       fix: acde allow (or acde deny): approving is the user's decision
```

## Fix what it can

`acde doctor --fix` runs the checks, prints them, then fixes what it can and checks again:

| Fix | When | Asks first |
| --- | --- | --- |
| `acde skills install` | The acde skill is not installed for any coding agent, or an installed one is outdated or broken | No |
| Add `.acde/` to the project's `.gitignore` | git does not ignore the build output | No |
| Remove and make again the sessions directory | It is a link or a file, not a directory | No |
| Run the installer of this acde version again (`install.sh --version <this version> --no-modify-path`, `install.ps1 -Version … -NoModifyPath` on Windows) | The runtime next to acde is missing, does not run, is of another contract level or release, or lacks its host files; only for an installed acde, and not when `ACDERT` names the runtime | Yes: it downloads the runtime and replaces the install, all or nothing, as the installer always does |
| The project's install (`bun install`, `npm install`, …) | Its dependencies are not installed | Yes: it downloads packages and runs their install scripts |
| `acde stop --session <pid>` | A running `acde dev` does not answer | Yes: it ends a process you started |

In a terminal it asks about each fix in the last column. Without a terminal (a script, a coding agent) it skips them and says so, `skipped: … (it asks first: pass --yes to allow it)`, unless it is given `--yes`. A coding agent passes `--yes` only when the user agreed.

It never touches what is the user's to decide: an app that waits for an approval, a GPU driver or a system library, a binary in macOS quarantine, another acde on PATH, the project's code and config. Those keep their `fix:` line.

```text
fixing: install the acde skill for the coding agents found here (acde skills install)
acde: skill linked to /Users/me/.agents/skills/acde (Cline, Codex, …)
fixed: install the acde skill for the coding agents found here (acde skills install)
skipped: install the project's dependencies (bun install in /Users/me/notes) (it asks first: pass --yes to allow it)
acde doctor: after fixing:
ok     acde: 0.0.9 on Bun 1.4.4 (/Users/me/.acde/versions/0.0.9)
…
```

## acde dev points here

When `acde dev` finds no runtime, its error ends with `(acde doctor checks the whole setup)`. When the runtime exits before the session is ready, `acde dev` prints the runtime's log line and then:

```text
acde: acdert exited (1) before it was ready; acde doctor checks the runtime, the GPU and this setup
```

## In scripts and agents

`acde doctor --json` prints one object:

```json
{
  "ok": false,
  "checks": [
    { "id": "acdert", "title": "acdert", "status": "error", "summary": "…", "fix": "…" }
  ]
}
```

`ok` is false when a check is an error. A check that `--fix` can repair carries `"repair": {"action", "target", "ask", "does"}` (`ask` is true for the fixes that ask first), and with `--fix` the object also has `"fixed": [{"repair", "result", "said"}]`, `result` being `fixed`, `failed` or `skipped`; the progress lines then go to stderr. The ids are `acde`, `path`, `runtimes`, `acdert`, `contract`, `runtime` (when the runtime cannot check itself), `runtime.host`, `runtime.gpu`, `runtime.display`, `sessions`, `approval`, `project`, `platform`, `dependencies`, `gitignore`, `skill` and `latest`; `fix` is left out when there is none. The MCP server has the same check as its `doctor` tool, and the fixes that do not ask as `doctor_fix` (it names the others and leaves them to the user); see [MCP](mcp.md).

The runtime's part also runs on its own, `acdert doctor` (or `acdert doctor --json`), with the same exit codes.
