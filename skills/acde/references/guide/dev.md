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

`--headless` doesn't open a window (a **headless session**), which suits scripts and CI. Pages still render and screenshots still work. It still needs a GPU, so it doesn't run on Linux CI machines without one (macOS CI runners work); see [Platform support](../reference/platforms.md).

## Reloading

- Changes within 150 ms are merged into one build, and only the project that changed is rebuilt.
- Apps: the window is closed and reopened at its previous position and size (or the new `size`, if that changed in the config). Desktops: the desktop page reloads; services are not restarted.
- State survives a reload where possible: form values, scroll position, focus, and selection are restored.
- A failed build prints a single error line, and windows keep showing the last good build.
- Changes in `node_modules`, `.acde`, `.git`, framework output directories such as `dist` / `build` / `.next`, `*.e2e.*` test files, and `__screenshots__` do not trigger a build.

## Build output

By default the build goes into the project's `.acde/`. `--out DIR` changes that: an absolute path is used as is, and a relative path is resolved against **the project being built**. Dev session builds reach acdert only through `ACDE_PATH`; they are **not** installed into the local package directory.

## Stopping

`acde dev` ends on Ctrl+C, when you close the window, or when acdert exits. Its exit code is the same as acdert's.

## Logs

The terminal shows builds and reloads, the pages' `console.*` output and uncaught errors (`[<app>#<window>] page error: …`), and backend output (`[<app>#backend]`).

To watch them from another terminal, or to read them from a script, use `acde console` / `acde network` from the [debugging tools](tools.md).

## Runtime

`acde dev` runs the acdert named by `ACDERT` (a path, or a name on PATH), otherwise the `acdert` on PATH. acdert is not part of acde; see [Install the runtime](../start/install.md#install-the-runtime-on-your-own-computer).
