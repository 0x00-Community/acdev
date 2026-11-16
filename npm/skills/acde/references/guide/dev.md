# acde dev

```sh
acde dev
```

This does three things:

1. Builds the project (into `.acde/`).
2. Starts acdebin-dbg, which opens **one** window on your computer: the **host window**, standing in for the screen of a Dopame OS machine.
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

The session is ready when `acde webs`, run from the project directory, lists the app's page. Declaring a capability grants it, so the app opens its window right away. The camera and the microphone wait for an answer, which `acde allow` or `acde deny` gives from another terminal: in 0.0.9, an app that declares one opens its window only once answered; after 0.0.9, only a page that asks for one waits. See [Camera and microphone](tools.md#camera-and-microphone).

`--headless` doesn't open a window (a **headless session**), which suits scripts and CI. Pages still render and screenshots still work. It still needs a GPU, so it doesn't run on Linux CI machines without one (macOS CI runners work); see [Platform support](../reference/platforms.md).

On a machine without a display, such as a Linux server over ssh, use `--headless` and look at the session with `acde shot`, `acde screen` and `acde inspect` (see [Without a display](tools.md#without-a-display)). On Linux, `acde dev` without `--headless` (and `acde test --headed`) stops at once when neither `WAYLAND_DISPLAY` nor `DISPLAY` is set, and says so. If acdebin-dbg exits with an error anyway, `acde dev` adds the same `--headless` hint after acdebin-dbg's own messages.

## Reloading

- Changes within 150 ms are merged into one build, and only the project that changed is rebuilt.
- Apps: the window is closed and reopened at its previous position and size (or the new `size`, if that changed in the config). Desktops: the desktop page reloads; services are not restarted.
- When a build changes only stylesheets and scripts (the HTML is the same apart from its `<style>`, `<link rel="stylesheet">` and `<script>` tags), `acde dev` asks the runtime to swap them into the open pages without reloading: styles are replaced in place, and changed function bodies of module scripts are replaced while the page keeps running. A change the runtime cannot swap (the page's HTML, a module's top-level code, a classic script, a function that is running) reloads the page as below. Scripts of backends and desktop services are never swapped.
- In a hand-written package (an `acde` field in `package.json`, built by your own scripts), the directories its manifest names, such as `dist/`, are watched even though `dist` and `build` are skipped elsewhere; a change to its other files (its sources) reloads nothing until your build writes new output.
- State survives a reload where possible: form values, scroll position, focus, and selection are restored. The page itself reloads: there is no hot module replacement, so component state (a React counter, Vue state, values in memory) starts over; see [Frameworks](frameworks.md#saving-in-acde-dev).
- A failed build prints a single error line, and windows keep showing the last good build.
- Changes in `node_modules`, `.acde`, `.git`, framework output directories such as `dist` / `build` / `.next`, `*.e2e.*` test files, and `__screenshots__` do not trigger a build.

## Build output

By default the build goes into the project's `.acde/`. `--out DIR` changes that: an absolute path is used as is, and a relative path is resolved against **the project being built**. Dev session builds reach acdebin-dbg only through `ACDE_PATH`; they are **not** installed into the local package directory.

## Stopping

`acde dev` ends on Ctrl+C, when you close the window, or when acdebin-dbg exits. Its exit code is the same as acdebin-dbg's. To end one running in the background, run `acde stop` from the project directory (or `acde stop --session <pid>`): it asks acdebin-dbg to quit, waits for `acde dev` to exit, and prints `acde: stopped acde dev <pid>`.

## Logs

The terminal shows builds and reloads, the pages' `console.*` output (lines such as `6975.356 I acde js: …`) and uncaught errors (`[<app>#<window>] page error: …`), backend output (`[<app>#backend] …`), what happens to an app (its backend started or stopped, its state restored after a reload, an `alert()`, a permission prompt waiting for an answer), and the runtime's warnings and errors (lines such as `14.383 W main …`). After 0.0.9, the runtime's own info log (startup timings, GPU and the like: `14.382 I main …`) is left out and `acde dev --verbose` shows it too; in 0.0.9 it is always shown.

To watch them from another terminal, or to read them from a script, use `acde console` / `acde network` from the [debugging tools](tools.md).

## DevTools

After 0.0.9, press **F12** in the host window (fn+F12 on a Mac keyboard) to open the DevTools of Chrome or Edge on the page in that window: Elements, Console, Network, and Sources with breakpoints. The terminal says `acde: opened DevTools for <page> in <browser>`; F12 again brings that DevTools window to the front. `acde devtools [web]` does the same from another terminal (see [DevTools](tools.md#devtools)). The page never sees that F12; F12 with Ctrl, Shift, Alt or Cmd still reaches it.

DevTools open in a browser profile of acde's own, not your everyday one. `ACDE_BROWSER` names another browser; without Chrome or Edge, or with `ACDE_BROWSER=none`, the terminal prints the address to paste into one instead.

## Runtime

`acde dev` runs the acdebin-dbg named by `ACDERT` (a path, or a name on PATH), otherwise the acdebin-dbg the installer put next to acde, otherwise the `acdebin-dbg` (or an older `acdert`) on PATH. `acde --version` shows which one it finds, and `acde doctor` checks that it runs here; see [The runtime](../start/install.md#the-runtime) and [Check the setup](doctor.md).

When acdebin-dbg exits before the session is ready (for example because it cannot use the GPU), `acde dev` prints its log line, then `acde: acdebin-dbg exited (1) before it was ready; acde doctor checks the runtime, the GPU and this setup`, and exits with that code.
