# Configuration

A project's config lives in `acde.config.jsonc` at its root (`acde.config.json` also works). JSONC allows comments and trailing commas. A `$schema` at the top gives your editor completion and validation:

```jsonc
{
  "$schema": "./node_modules/@dopame/acde-api/config.schema.json",
  "type": "app",
  "id": "notes",
  "label": "Notes",
  "icon": "editor",
  "entry": "index.html",
  "size": [960, 640],
  "capabilities": { "fs": true }
}
```

## Apps (`"type": "app"`)

| Field | Description |
| --- | --- |
| `id` | App id: lowercase letters, digits, and `-`. Defaults to one derived from `name` in `package.json` |
| `label` | Display name, shown in the title bar and on the desktop |
| `icon` | An icon name, or a `.svg` / `.png` in the project; see [Assets and icons](assets.md) |
| `entry` | Entry point: an HTML page (default `index.html`), or a module whose default export is a `WindowApp`. Omit it when building with a framework |
| `framework` | How to build; defaults to `auto`. See [Frameworks](frameworks.md) |
| `capabilities` | Capabilities the app requests; see [Capabilities](capabilities.md) |
| `size` | Default size of the window's content area, `[width, height]` in logical pixels; defaults to `[800, 600]`. The title bar is extra |
| `frame` | Whether the window has a system title bar; defaults to `true` |
| `multiple` | Whether multiple windows can be open at once |
| `mimeTypes` | File types the app can open, e.g. `["text/markdown", "image/*"]`; see [Opening apps](open.md) |
| `heapMb` | JS heap limit per window, in MB; defaults to 256, minimum 32 |
| `backend` | The backend: `false` for none, or `{ "entry": "server.ts", "port": 3000 }`. Detected automatically by default; see [Backend](backend.md) |
| `public` | Directory of static files copied as is; defaults to `public` |
| `name` / `version` | Package name and version; taken from `package.json` by default |

## Desktops (`"type": "desktop"`)

| Field | Description |
| --- | --- |
| `id` / `label` / `description` | The desktop's id, name, and description |
| `entry` | The desktop page; defaults to `index.html` |
| `heapMb` | JS heap limit for the desktop page; defaults to 1024 |
| `services` | Desktop services: name → module path; see [Services](services.md) |
| `apps` | Apps bundled with this desktop. Each entry has the same fields as an app, but `id` and `entry` are required |

See [Desktops](desktop.md).

## Check

```sh
acde check
```

This checks that the id is valid, the entry file exists, the icon is a known name or an existing image, service modules exist, and the framework is recognized. Errors make the command exit with 1; warnings (such as requesting an unknown capability) are only printed.

For the full field definitions, see [Reference: acde.config.jsonc](../reference/config.md).
