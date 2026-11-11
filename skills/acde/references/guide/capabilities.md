# Capabilities

Pages only get the standard Web APIs. There is exactly one way into system capabilities: the built-in `acde:` modules, imported the same way as `node:fs`:

```js
import { fs } from 'acde:fs'
import { window } from 'acde:window'
import fs2 from 'acde:fs' // the default export is the same object
```

There is no `acde` global, and the runtime never attaches anything non-standard to `window`.

Talking to other hosts needs no capability: `fetch`, `WebSocket`, and the other standard APIs work as usual, through the system's proxy when one is set. See [Web compatibility](../reference/web.md#network).

## Requesting capabilities

The `capabilities` in your config decide which modules an app can import:

```jsonc
{
  "capabilities": {
    "fs": true,
    "openFiles": true,
    "open": ["notes", "viewer"]
  }
}
```

| Capability | Grants |
| --- | --- |
| `fs` | `acde:fs`. `true`: the app's private folder and the folders the user picks for it. `{ "roots": ["downloads", … ] }` adds shared places; see [Files and folders](files.md) |
| `terminal` | `acde:terminal`: pseudo-terminals |
| `network` | `acde:network`: network settings, Wi-Fi (Linux only, including Dopame OS) |
| `office` | `acde:office`: office document service (Linux only) |
| `open` | Opening other apps with `acde:open`. `true` for any app, or a list of app ids |
| `openFiles` | `acde:openPath` / `acde:handlers`, and `open(request)` without a target app: a file or a link goes to its default app |
| `launch` | `start` in `acde:launch`: start native programs |
| `slots` | `embed` in `acde:launch`: native programs embedded in your own window (Dopame OS only) |
| `camera` / `microphone` | `navigator.mediaDevices.getUserMedia()` video / audio (not on Windows); the user is asked on first use, see [below](#camera-and-microphone) |

Every app can import these without requesting anything: `acde:window` (its own window), `acde:capabilities` (what it has, see [below](#acdecapabilities)), `acde:apps` (`list()` and `open()`), and `acde:open` (opening another app still needs `open`).

A name that is not in the table is an error in `acde check`:

- **Desktop services** are listed under `services`, not under `capabilities`: `"services": ["clock"]`, then `import { clock } from 'acde:clock'`. The app then starts only in a desktop that runs the service. See [Services](services.md).
- **Shell modules** (`acde:windows`, `acde:packages`, `acde:session`, `acde:desktops`, `acde:inspect`, `acde:desktop`, `acde:setDefault`, `acde:permissions`) belong to the desktop. Only the desktop page, its services, and the apps bundled with a desktop (system apps) get them; see [Desktops](desktop.md#system-apps).

Importing a module the app has no right to fails with a `TypeError` that names the missing declaration, and `acde check` and `acde build` report the same thing for every `import` in your source before anything runs:

```text
error: app "notes": capability "clock" is not a system capability; list desktop services under services
error: src/main.js:1: app "notes": acde:terminal needs "terminal" in the capabilities of Notes
error: src/main.js:2: app "notes": acde:windows is a shell module: only the desktop, its services and system apps may import it, and Notes is not a system app
```

Calling a method the app has no right to is rejected with `status: 403` (`code: 'forbidden'`), for example `open('mail')` when `open` lists only other apps.

## Camera and microphone

Declaring a capability is what gives the app access to it: nothing is asked, also for shared places in `fs.roots`, `terminal`, `network`, `launch` and `slots`. Only the camera and the microphone ask the user, the first time a page calls `navigator.mediaDevices.getUserMedia()`; the call waits for the answer. The apps bundled with a desktop (system apps) are not asked.

- **Allowed**: the decision is stored per app (`$XDG_CONFIG_HOME/acde/permissions.json`) and the user is not asked again.
- **Denied**: `getUserMedia()` rejects with `NotAllowedError`, as in a browser; the app keeps running.
- **In a dev session**: answer with `acde allow` or `acde deny`, take a decision back with `acde revoke`; see [Debugging](tools.md#camera-and-microphone). In a desktop, the desktop shows the prompt (see [Desktops](desktop.md#camera-and-microphone-prompts)); tests answer with `acde.allow()` (see [Testing](testing.md#approvals)).

## Optional capabilities

Everything in `capabilities` is required by default: if the platform lacks one, the app does not start. List the ones the app can run without in `optional`:

```jsonc
{
  "capabilities": { "terminal": true },
  "optional": ["terminal"]
}
```

- The app also starts on a platform that lacks the capability.
- An optional module must not be imported statically (`acde check`: `acde:terminal is optional ("terminal" is in optional): reach it with load('terminal') from @dopame/acde-api instead of importing it`). Get it with `load()`, which resolves to `null` while the module is unavailable.
- `camera` and `microphone` have no module to load: the page calls `navigator.mediaDevices.getUserMedia()`, which asks the user the first time. See [Web compatibility](../reference/web.md#media).

```js
import { load } from '@dopame/acde-api'

const terminal = await load('terminal') // null where this platform lacks it
```

Making `fs` optional makes its shared places optional too.

## acde:capabilities

```js
import { capabilities } from 'acde:capabilities'

capabilities.level // 1: the contract level of the runtime
capabilities.platform // 'linux' | 'darwin' | 'win32'
capabilities.mode // 'session' (Dopame OS) | 'desktop' (a desktop in the host window) | 'standalone' (a single app in the host window)
capabilities.get('terminal') // { name, kind: 'system' | 'service', state, reason, optional }
capabilities.list() // the same for every system capability and every service the app lists
await capabilities.request('camera') // asks the user for the camera or microphone; resolves with the status
```

| `state` | Meaning |
| --- | --- |
| `available` | Declared and this platform has it (camera, microphone: and the user allowed it) |
| `not-asked` | Camera or microphone, and the user was not asked yet: `request()` asks |
| `asking` | The camera or microphone prompt waits for the user's answer |
| `not-declared` | Not in the app's `capabilities` / `services` |
| `unsupported` | This platform, or this way of running, lacks it |
| `service-not-running` | The desktop service is not running |
| `shell-only` | A shell module, and the app is not a system app |
| `denied` | Camera or microphone: the user denied it, or the decision was taken back |

`request()` of any other capability, or of one the user already answered, resolves at once with the current status.

## Types

Types for every module ship in the SDK, `@dopame/acde-api`. Reference the entry point that fits the project and your editor understands the `acde:*` modules it can import:

```js
/// <reference types="@dopame/acde-api/app" />
```

- `@dopame/acde-api/app`: the modules of an app (`acde:fs`, `acde:window`, `acde:open`, ...).
- `@dopame/acde-api/shell`: those plus the shell modules, for a desktop and its bundled apps.
- `@dopame/acde-api`: all of them.

## In a browser

To preview the same code in an ordinary browser:

- In a Vite project, add the `@dopame/acde-api/vite` plugin; the dev server then stubs `acde:*`. See [Frameworks](frameworks.md#vite-plugin).
- Or load modules on demand with `load()`, which returns `null` when the module is unavailable:

```js
import { load } from '@dopame/acde-api'

const fs = await load('fs')
```

## Modules

| Module | Purpose | Docs |
| --- | --- | --- |
| `acde:window` | Your own window: title, menus, closing, state, shortcuts, events | [Windows](window.md) |
| `acde:capabilities` | What the app has, asking for optional capabilities | [Above](#acdecapabilities) |
| `acde:fs` | Files | [Files and folders](files.md) |
| `acde:apps` `acde:open` `acde:openPath` `acde:handlers` | Other apps, opening files and links | [Opening apps](open.md) |
| `acde:launch` | Native programs | [Reference](../reference/modules.md#acdelaunch) |
| `acde:terminal` | Pseudo-terminals | [Reference](../reference/modules.md#acdeterminal) |
| `acde:network` | Networking | [Reference](../reference/modules.md#acdenetwork) |
| `acde:windows` `acde:packages` `acde:desktop` `acde:inspect` `acde:permissions` `acde:session` `acde:desktops` `acde:setDefault` | Shell modules: the desktop and system apps | [Desktops](desktop.md) |

For full signatures, see [Reference: acde: modules](../reference/modules.md).
