# Configuration

A project's config lives in `acde.config.jsonc` at its root (`acde.config.json` also works). JSONC allows comments and trailing commas. A `$schema` at the top gives your editor completion and validation:

```jsonc
{
  "$schema": "./acde.config.schema.json",
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
| `capabilities` | System capabilities the app requests, such as `{ "fs": true }`; see [Capabilities](capabilities.md). Declaring one grants it; the camera and the microphone also ask the user (see [Camera and microphone](capabilities.md#camera-and-microphone)) |
| `optional` | Names from `capabilities` that the app can run without; the app starts where this platform lacks them, and reaches them with `load()`. See [Optional capabilities](capabilities.md#optional-capabilities) |
| `services` | Names of the [desktop services](services.md) the app uses, e.g. `["clock"]`. The app starts only where they run |
| `size` | Default size of the window's content area, `[width, height]` in logical pixels; defaults to `[800, 600]`. The title bar is not included. A desktop opens the window at this size; a single app run by `acde dev` fills the host window, which opens at this size (see [Windows](window.md#size-and-title-bar)) |
| `frame` | Whether the window has a system title bar; defaults to `true` |
| `multiple` | Whether multiple windows can be open at once |
| `mimeTypes` | File types the app can open, e.g. `["text/markdown", "image/*"]`; see [Opening apps](open.md#files-and-links) |
| `schemes` | URL schemes of the links the app can open, lowercase and without the colon, e.g. `["mailto"]` |
| `requests` | Kinds of request the app accepts from other apps' `open()`, e.g. `["show-image"]`; see [Opening apps](open.md#apps) |
| `heapMb` | JS heap limit per window, in MB; defaults to 256, minimum 32 |
| `backend` | The backend: `false` for none, or `{ "entry": "server.ts", "port": 3000 }`. Detected automatically by default; see [Backend](backend.md) |
| `public` | Directory of static files copied as is; defaults to `public` |
| `name` / `version` | Package name and version; taken from `package.json` by default |
| `apiLevel` | The contract level the package is built for. Leave it out: `acde build` writes the level of the installed SDK |

## Desktops (`"type": "desktop"`)

| Field | Description |
| --- | --- |
| `id` / `label` / `description` | The desktop's id, name, and description |
| `entry` | The desktop page; defaults to `index.html` |
| `heapMb` | JS heap limit for the desktop page; defaults to 1024 |
| `services` | Desktop services: name → module path, or name → `{ "module": path, "modules": [shell modules] }` for a service that uses shell modules; see [Services](services.md) |
| `apps` | Apps bundled with this desktop (system apps). Each entry has the same fields as an app, but `id` and `entry` are required; its `capabilities` may also name shell modules, such as `"windows": true` |

See [Desktops](desktop.md).

## Check

```sh
acde check
```

This checks that the id is valid, the entry file exists, the icon is a known name or an existing image, service modules exist, and the framework is recognized. It also checks the declarations against the rules of the runtime: capability names, the shared places in `fs.roots`, `optional`, `services`, and every `acde:` import in the source against what the app declares. Errors make the command exit with 1; warnings and notes are only printed.

```text
error: app "notes": fs.roots "work" is not a shared place (desktop, documents, downloads, music, pictures, videos); any other folder is one the user picks (showDirectoryPicker() with "fs": true)
error: app "notes": capability "clock" is not a system capability; list desktop services under services
error: src/main.js:1: app "notes": acde:terminal needs "terminal" in the capabilities of Notes
error: src/main.js:2: app "notes": acde:windows is a shell module: only the desktop, its services and system apps may import it, and Notes is not a system app
```

A path in `fs.roots` is answered with the name to write instead: `fs.roots "~/Documents" is not a shared place: write "documents", the runtime finds that folder through the system (also when it was moved)`. An `optional` name that is not in `capabilities` is reported first, on its own: `error: app notes: optional "launch" is not in capabilities (optional lists declared capabilities that the app can run without)`. That line really names the app without quotes, unlike the ones above; match either form when you read these lines by program.

`acde check --platform windows` (or `macos`, `linux`) adds what that platform lacks: a required capability it does not have is an error, an optional one a note.

For the full field definitions, see [Reference: acde.config.jsonc](../reference/config.md).
