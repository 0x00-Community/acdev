# Manifest

The runtime only understands **packages**: a directory whose `package.json` has an `acde` field holding the manifest. `acde build` generates it from your config; you can also write it by hand.

```json
{
  "name": "my-pkg",
  "acde": {
    "desktops": [{ "id": "dopame", "name": "Dopame", "entry": "/desktop/dopame/index.html", "services": ["assistant"] }],
    "apps": [{ "id": "term", "label": "Terminal", "icon": "term", "entry": "/app/term/index.html", "capabilities": { "terminal": true } }],
    "assets": { "/app/term/": ["apps/term/web"], "/desktop/dopame/": ["desktop"] },
    "services": [{ "name": "assistant", "module": "services/assistant.js" }]
  }
}
```

There is a single manifest validator: the runtime and `acde check` / `acde build` run the same code (`@dopame/acde-api/manifest`).

## PackageManifest

| Field | Description |
| --- | --- |
| `desktops` | List of desktops |
| `apps` | List of apps |
| `assets` | Same-origin URL prefix (`/…/`) → list of directories in the package |
| `services` | `{name, module}`: service name and module file |

## DesktopManifest

| Field | Description |
| --- | --- |
| `id` / `name` / `description` | |
| `entry` | URL of the desktop page; must fall under one of the `assets` prefixes |
| `services` | Names of the services it uses |
| `heapMb` | Defaults to 1024, minimum 32 |

## AppManifest

| Field | Description |
| --- | --- |
| `id` | `[\w-]+`, required. The runtime accepts this; a config only allows `[a-z0-9][a-z0-9-]*` (see [acde.config.jsonc](config.md#appconfig)), so the looser rule matters only for a handwritten package |
| `label` | Required |
| `icon` | An icon name, or a URL under assets ending in `.svg` / `.png`; required |
| `entry` | A URL starting with `/`, required. HTML or a module; a trailing `/` means the page is rendered by the backend (requires `backend`) |
| `capabilities` | See below |
| `heapMb` | Defaults to 256, minimum 32 |
| `size` | `[width, height]`, defaults to 800 × 600 |
| `multiple` | Defaults to `false` |
| `frame` | Defaults to `true` |
| `mimeTypes` | Types the app can open |
| `backend` | `{entry, port?}`: `entry` is a `.js` / `.mjs` URL under assets; `port` defaults to 3000 |

## Capabilities

| Key | Value | Grants |
| --- | --- | --- |
| `fs` | `true` \| `{roots: string[]}` | `acde:fs` |
| `terminal` | `true` | `acde:terminal` |
| `network` | `true` | `acde:network` |
| `office` | `true` | `acde:office` |
| `launch` | `true` | `launch` in `acde:windows` |
| `slots` | `true` | `launch({slot: true})`: native programs embedded in the app's window |
| `open` | `true` \| `string[]` | Opening (these) apps with `acde:open` |
| `openFiles` | `true` | `acde:openPath`, `acde:handlers`, `acde:setDefault` |
| `session` | `true` | `acde:session` |
| `desktops` | `true` | `acde:desktops` |
| Anything else | `true` | The desktop service of the same name |

## URLs

- Pages have the origin `http://acde.local`.
- An app's files are served at `/app/<id>/` and also mounted at `/`; a desktop is at `/desktop/<id>/`.
