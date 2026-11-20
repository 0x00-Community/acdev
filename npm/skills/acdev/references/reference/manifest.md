# Manifest

The runtime only understands **packages**: a directory whose `package.json` has an `acde` field holding the manifest. `acdev build` generates it from your config; you can also write it by hand.

```json
{
  "name": "my-pkg",
  "acdev": {
    "apiLevel": 1,
    "desktops": [{ "id": "dopame", "name": "Dopame", "entry": "desktop/index.html", "services": ["assistant"] }],
    "apps": [{ "id": "term", "label": "Terminal", "icon": "term", "entry": "/app/term/index.html", "capabilities": { "terminal": true } }],
    "assets": { "/app/term/": ["apps/term/web"], "/desktop/dopame/": ["desktop"] },
    "services": [{ "name": "assistant", "module": "services/assistant.js" }]
  }
}
```

There is a single manifest validator: the runtime and `acdev check` / `acdev build` run the same code (`@acde/api/manifest`). `acdev check <dir>` checks a handwritten package.

## PackageManifest

| Field | Description |
| --- | --- |
| `apiLevel` | The contract level the package is built for, a positive integer; required. See [Contract level](#contract-level) |
| `desktops` | List of desktops |
| `apps` | List of apps. In a package that has a desktop they are system apps |
| `assets` | Same-origin URL prefix (`/…/`) → list of directories in the package |
| `services` | `{name, module}`: service name and module file. A name cannot be that of a system module or capability |

## Contract level

`apiLevel` says which version of the contract between packages and the runtime a package follows. The current level is 1 (`API_LEVEL` in `@acde/api`; `acdev --version` prints its own and the runtime's, and the runtime binary (`libexec/acdev` of the install) prints its own with `--version`). The runtime loads only packages of its own level:

| Package | What the runtime and `acdev check` say |
| --- | --- |
| No `apiLevel` (built before contract levels) | `no acde.apiLevel: a package built before contract levels; rebuild it with the current acdev (level 1)` |
| Another level | `acde.apiLevel 2: needs level 2, runtime is level 1` |

A package the runtime refuses is not in the app list or the desktop list. Rebuild it with the current `acdev`.

## DesktopManifest

| Field | Description |
| --- | --- |
| `id` / `name` / `description` | |
| `entry` | The desktop page: the path of an HTML file in the package (`desktop/index.html`), not a URL |
| `lock` | Optional. The lock screen page, written like `entry` (`desktop/lock.html`). The session shows it while the screen is locked; it gets only `acde:lock` (`user()`, `unlock(password)`) |
| `services` | The services it uses: a name, or `{name, modules}` where `modules` lists the shell modules the service may get from `ctx.import()` (see [Service API](service.md)) |
| `heapMb` | Defaults to 1024, minimum 32 |

## AppManifest

| Field | Description |
| --- | --- |
| `id` | `[\w-]+`, required. The runtime accepts this; a config only allows `[a-z0-9][a-z0-9-]*` (see [acde.config.jsonc](config.md#appconfig)), so the looser rule matters only for a handwritten package |
| `label` | Required |
| `icon` | An icon name, or a URL under assets ending in `.svg` / `.png`; required |
| `entry` | A URL starting with `/`, required. HTML or a module; a trailing `/` means the page is rendered by the backend (requires `backend`) |
| `capabilities` | System capabilities; see below |
| `optional` | Names from `capabilities` the app can run without |
| `services` | Names of the desktop services the app uses |
| `heapMb` | Defaults to 256, minimum 32 |
| `size` | `[width, height]`, defaults to 800 × 600 |
| `multiple` | Defaults to `false` |
| `frame` | Defaults to `true` |
| `mimeTypes` | File types the app can open: `type/subtype` or `type/*` |
| `schemes` | URL schemes of the links the app can open: lowercase, without the colon, not `file` |
| `requests` | Request kinds the app accepts from other apps: lowercase words, not `open-file` or `open-link` |
| `backend` | `{entry, port?}`: `entry` is a `.js` / `.mjs` URL under assets; `port` defaults to 3000 |

## Capabilities

| Key | Value | Grants | Asks the user |
| --- | --- | --- | --- |
| `fs` | `true` \| `{roots: string[]}` | `acde:fs`: the private folder and picked folders; `roots` names shared places (`desktop`, `documents`, `downloads`, `music`, `pictures`, `videos`) | |
| `terminal` | `true` | `acde:terminal` | |
| `network` | `true` | `acde:network` | |
| `system` | `true` | [`acde:system`](modules.md#acdesystem) (Linux only) | |
| `bluetooth` | `true` | [`acde:bluetooth`](modules.md#acdebluetooth) (Linux only) | |
| `audio` | `true` | [`acde:audio`](modules.md#acdeaudio) (Linux only) | |
| `devices` | `true` | [`acde:devices`](modules.md#acdedevices) (Linux only) | |
| `power` | `true` | [`acde:power`](modules.md#acdepower) (Linux only) | |
| `input` | `true` | [`acde:input`](modules.md#acdeinput) (Linux only) | |
| `display` | `true` | [`acde:display`](modules.md#acdedisplay) (Linux only) | |
| `office` | `true` | `acde:office` | |
| `launch` | `true` | `start` in `acde:launch` | |
| `slots` | `true` | `embed` in `acde:launch`: native programs embedded in the app's window | |
| `open` | `true` \| `string[]` | Opening (these) apps with `acde:open` | |
| `openFiles` | `true` | `acde:openPath`, `acde:handlers`, and `open(request)` without a target app | |
| `camera` / `microphone` | `true` | `getUserMedia()` video / audio | Yes, on first use |
| `idleDetection` | `true` | `IdleDetector` (Linux only) | Yes, when the page calls `IdleDetector.requestPermission()` |
| `windows` `packages` `session` `desktops` `inspect` `desktop` `setDefault` `permissions` | `true` | The shell module of that name. System apps only: an error in any other package | |

Any other key is an error: desktop services go in `services`. System notifications (`new Notification()`) need no key; `acde:capabilities` reports them as `notifications`. System apps are never asked for approval.

Everything in `capabilities` and `services` is required unless `optional` lists it (`optional` takes names from `capabilities` only). An app with a required item that is missing here (unsupported on the platform, service not running) is left out of the app list and refuses to start: `Notes needs "network" (not available on macOS host windows); list it in "optional" to run without it` (404 `unsupported_app`; the place is `Windows host windows`, `Linux host windows` or `Linux sessions`), or `Notes needs "clock" (service not running)` (503 `service_not_running`). Declaring a capability grants it; only the camera, the microphone and idle detection ask the user (see [Capabilities](../guide/capabilities.md#camera-and-microphone)).

## URLs

- Pages have the origin `http://acde.local`.
- An app's files are served at `/app/<id>/` and also mounted at `/`; a desktop is at `/desktop/<id>/`.
