# Capabilities

Pages only get the standard Web APIs. There is exactly one way into system capabilities: the built-in `acde:` modules, imported the same way as `node:fs`:

```js
import { fs } from 'acde:fs'
import { window } from 'acde:window'
import fs2 from 'acde:fs' // the default export is the same object
```

There is no `acde` global, and the runtime never attaches anything non-standard to `window`.

Talking to other hosts needs no capability: `fetch`, `WebSocket`, and the other standard APIs work as usual. They don't go through the system proxy, though, so on a network that reaches the internet only through a proxy, those requests fail. See [Web compatibility](../reference/web.md#network).

## Requesting capabilities

The `capabilities` in your config decide which modules an app can import. `import('acde:…')` fails outright for a module you have not requested, and calling a method you have no permission for is rejected (`forbidden`).

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
| `fs` | `acde:fs`: read and write the user's folders. `true` for all roots, or `{ "roots": [ … ] }` to limit them |
| `terminal` | `acde:terminal`: pseudo-terminals (macOS / Linux only) |
| `network` | `acde:network`: network settings, Wi-Fi (Linux only, including Dopame OS) |
| `office` | `acde:office`: office document service (Linux only) |
| `open` | Open other apps with `acde:open`. `true` for any app, or a list of app ids |
| `openFiles` | `acde:openPath` / `acde:handlers` / `acde:setDefault`: open files with their default app |
| `launch` | `launch` in `acde:windows`: start native programs |
| `slots` | Start native programs embedded in your own window |
| `session` | `acde:session`: log out, reboot, power off, switch language |
| `desktops` | `acde:desktops`: list and switch desktops |
| Any other name | The [desktop service](services.md) with that name |

Every app window can manage itself with `acde:window` without requesting anything. `acde:open` and `acde:windows` can always be imported, but opening another app requires `open`, and starting native programs requires `launch` / `slots`.

`acde:apps`, `acde:windows` (all windows), `acde:desktop` and `acde:inspect` are only available to desktop pages.

## Types

Types for every module ship in the SDK, `@dopame/acde-api`. Reference it and your editor understands `acde:*`:

```js
/// <reference types="@dopame/acde-api" />
```

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
| `acde:window` | Your own window: title, menus, closing, mode, shortcuts, events | [Windows](window.md) |
| `acde:fs` | Files | [Files and folders](files.md) |
| `acde:open` `acde:openPath` `acde:handlers` `acde:setDefault` | Between apps, default apps | [Opening apps](open.md) |
| `acde:terminal` | Pseudo-terminals | [Reference](../reference/modules.md#acdeterminal) |
| `acde:network` | Networking | [Reference](../reference/modules.md#acdenetwork) |
| `acde:session` `acde:desktops` | Session, desktops | [Reference](../reference/modules.md#acdesession) |
| `acde:apps` `acde:windows` `acde:desktop` `acde:inspect` | Desktop only | [Desktops](desktop.md) |

For full signatures, see [Reference: acde: modules](../reference/modules.md).
