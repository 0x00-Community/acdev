# acde dev

```sh
acde dev
```

This does three things:

1. Builds the project (into `.acde/`).
2. Starts acdert, which opens **one** window on your computer: the **host window**, standing in for the screen of a Dopame OS machine.
3. Watches the project's files, and on every change rebuilds and reloads the affected windows.

A running `acde dev` is a **dev session**: the [debugging commands](tools.md), [MCP](mcp.md), and `acde test` all work with one.

## What runs

| Command | What you get |
| --- | --- |
| `acde dev` (app project) | Just this app, filling the host window; closing the app ends the session |
| `acde dev` (desktop project) | This desktop |
| `acde dev --app ID` | Picks one app when the project has several |
| `acde dev ./a ./b` | Several projects together, in one desktop |
| `acde dev ./app --desktop ./my-desktop` | The app runs in the given desktop project |
| `acde dev ./app --desktop dopame` | The app runs in the `dopame` desktop, once it is [installed](../start/install.md#install-the-dopame-desktop) |

With several projects or `--desktop`, the desktop is chosen like this: the value of `--desktop`; otherwise the only desktop project among them; otherwise `dopame`. A `--desktop` value that looks like a path (contains `/`, or is `.` / `..`), or that names a project in the current directory, is treated as one more project.

The session is ready when `acde webs`, run from the project directory, lists the app's page. Declaring a capability grants it, so the app opens its window right away. Only a page that asks for the camera or the microphone waits for an answer, which `acde allow` or `acde deny` gives from another terminal; see [Camera and microphone](tools.md#camera-and-microphone).

`--headless` doesn't open a window (a **headless session**), which suits scripts and CI. Pages still render and screenshots still work. It still needs a GPU, so it doesn't run on Linux CI machines without one (macOS CI runners work); see [Platform support](../reference/platforms.md).

On a machine without a display, such as a Linux server over ssh, use `--headless` and look at the session with `acde shot`, `acde screen` and `acde inspect` (see [Without a display](tools.md#without-a-display)). On Linux, `acde dev` without `--headless` (and `acde test --headed`) stops at once when neither `WAYLAND_DISPLAY` nor `DISPLAY` is set, and says so. If acdert exits with an error anyway, `acde dev` adds the same `--headless` hint after acdert's own messages.

## Reloading

- Changes within 150 ms are merged into one build, and only the project that changed is rebuilt.
- Apps: the window is closed and reopened at its previous position and size (or the new `size`, if that changed in the config). Desktops: the desktop page reloads; services are not restarted.
- State survives a reload where possible: form values, scroll position, focus, and selection are restored.
- A failed build prints a single error line, and windows keep showing the last good build.
- Changes in `node_modules`, `.acde`, `.git`, framework output directories such as `dist` / `build` / `.next`, `*.e2e.*` test files, and `__screenshots__` do not trigger a build.

## Build output

By default the build goes into the project's `.acde/`. `--out DIR` changes that: an absolute path is used as is, and a relative path is resolved against **the project being built**. Dev session builds reach acdert only through `ACDE_PATH`; they are **not** installed into the local package directory.

## Stopping

`acde dev` ends on Ctrl+C, when you close the window, or when acdert exits. Its exit code is the same as acdert's. To end one running in the background, run `acde stop` from the project directory (or `acde stop --session <pid>`): it asks acdert to quit, waits for `acde dev` to exit, and prints `acde: stopped acde dev <pid>`.

## Logs

The terminal shows builds and reloads, the pages' `console.*` output and uncaught errors (`[<app>#<window>] page error: …`), and backend output (`[<app>#backend]`).

To watch them from another terminal, or to read them from a script, use `acde console` / `acde network` from the [debugging tools](tools.md).

## Runtime

`acde dev` runs the acdert named by `ACDERT` (a path, or a name on PATH), otherwise the acdert the installer put next to acde, otherwise the `acdert` on PATH. `acde --version` shows which one it finds, and `acde doctor` checks that it runs here; see [The runtime](../start/install.md#the-runtime) and [Check the setup](doctor.md).

When acdert exits before the session is ready (for example because it cannot use the GPU), `acde dev` prints its log line, then `acde: acdert exited (1) before it was ready; acde doctor checks the runtime, the GPU and this setup`, and exits with that code.
