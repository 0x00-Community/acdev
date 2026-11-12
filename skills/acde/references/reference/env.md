# Environment variables

## acde

| Variable | Effect |
| --- | --- |
| `ACDE_INSTALL` | Install directory, default `~/.acde` |
| `ACDE_DIST` | Where the installers download acde from, and where `acde doctor --online` looks for a newer one; default `https://calbin-1318886512.cos.ap-beijing.myqcloud.com/pkgs/acde` |
| `ACDERT_DIST` | Where the installers download the runtime from, and where `acde new` and `acde sdk update` point the SDK dependency; default `https://calbin-1318886512.cos.ap-beijing.myqcloud.com/pkgs/acdert` |
| `ACDERT` | The acdert binary `acde dev` and `acde test` run: a path, or a name on PATH. Unset: the acdert the installer put next to acde, then `acdert` on PATH |
| `ACDE_BUNDLER=vite` | Bundle with Vite on Bun too |
| `ACDE_DEBUG=1` | An error also prints its stack trace (normally only the one-line message) (after 0.0.9) |
| `ACDE_BROWSER` | The browser `acde devtools` and F12 in `acde dev` open DevTools in: a path, or `none` to open nothing and only print the address. Unset: Edge, then Chrome on Windows; Chrome, then Edge on macOS; Chrome, Chromium or Edge on `PATH` on Linux (after 0.0.9) |
| `CI` | When set, `toHaveScreenshot` does not write new baselines; a missing baseline fails right away |
| `NO_COLOR` | Set and not empty: no color in acde's output |
| `FORCE_COLOR` | Set and not `0`: color even when the output is not a terminal |

## Runtime (acdert)

`acde dev` and `acde test` set what is needed for you. To adjust things by hand:

| Variable | Effect |
| --- | --- |
| `ACDE_PATH` | Extra package directories (separated by `;` on Windows) |
| `ACDE_DESKTOP` | Default desktop |
| `ACDE_HEADLESS=1` | Don't open a window |
| `ACDE_SIZE` | Screen size, such as `1280x800` |
| `ACDE_SCALE` | Scale factor when headless (0.5–4) |
| `ACDE_COLOR_SCHEME` | `light` / `dark` |
| `ACDE_REDUCED_MOTION` | `1` / `0` |
| `ACDE_STORAGE` | Root directory for web storage; set it to empty to keep storage in memory only |
| `ACDE_AUTOSTART` | Autostart items run by default only in a Dopame OS session: `1` runs them in the host window too, `0` skips them |
| `ACDE_AUDIO=null` | No sound |
| `ACDE_CAPTURE=fake` | A fake camera and microphone (`Fake camera`, `Fake microphone`) in place of the system's devices, for `getUserMedia()` |
| `ACDE_FRAME_STYLE` | Title bar style: `mac` (traffic lights) or `windows` (Windows buttons). Unset: `windows` in the host window on Windows, else `mac` |

## App backends

| Variable | What it is |
| --- | --- |
| `ACDE_APP_ID` | The app id |
| `ACDE_APP_DATA` | The app's data directory (also its working directory) |
| `ACDE_APP_SOCKETS` | The app's socket directory. Not set for a Node.js backend on Windows, which gets `ACDE_APP_CHANNEL=fd` instead; see [Backend](../guide/backend.md#on-windows) |
| `PORT` | The configured port |
| `NODE_ENV` | `production` |
| `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy` | The session's proxy variables, or else the system's manual proxy (Windows, macOS) with its exceptions plus `localhost,127.0.0.1,::1` in `no_proxy`; upper-case names on Windows, both cases elsewhere. See [Backends](../guide/backend.md#running) |
