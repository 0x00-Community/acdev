# Environment variables

## acde

| Variable | Effect |
| --- | --- |
| `ACDE_INSTALL` | Install directory, default `~/.acde` |
| `ACDERT` | The acdert binary `acde dev` and `acde test` run: a path, or a name on PATH. Unset: `acdert` on PATH |
| `ACDE_BUNDLER=vite` | Bundle with Vite on Bun too |
| `ACDE_API` | The value `acde new` writes for the `@dopame/acde-api` dependency |
| `CI` | When set, `toHaveScreenshot` does not write new baselines; a missing baseline fails right away |

## Runtime (acdert)

`acde dev` and `acde test` set what is needed for you. To adjust things by hand:

| Variable | Effect |
| --- | --- |
| `ACDE_PATH` | Extra package directories (separated by `;` on Windows) |
| `ACDE_DESKTOP` | Default desktop |
| `ACDE_HEADLESS=1` | Open no windows |
| `ACDE_SIZE` | Screen size, such as `1280x800` |
| `ACDE_SCALE` | Scale factor when headless (0.5–4) |
| `ACDE_COLOR_SCHEME` | `light` / `dark` |
| `ACDE_REDUCED_MOTION` | `1` / `0` |
| `ACDE_STORAGE` | Root directory for web storage; set it to empty to keep storage in memory only |
| `ACDE_AUTOSTART` | `0` to skip autostart items |
| `ACDE_AUDIO=null` | No sound |
| `ACDE_FRAME_STYLE` | Title bar style: macOS traffic lights or Windows buttons |

## App backends

| Variable | What it is |
| --- | --- |
| `ACDE_APP_ID` | The app id |
| `ACDE_APP_DATA` | The app's data directory (also its working directory) |
| `ACDE_APP_SOCKETS` | The app's socket directory |
| `PORT` | The configured port |
| `NODE_ENV` | `production` |
