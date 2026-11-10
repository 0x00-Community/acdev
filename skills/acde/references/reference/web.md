# Web compatibility

acdert has its own renderer (it is not Chromium), and page JS runs in its embedded V8. The rule is that **standard APIs are fully browser-compatible**: behavior, signatures, events, and errors all follow the spec. Anything that can't be done that way is a gap; it is not filled with a look-alike proprietary version. Below are the things worth knowing.

## Origin

Every app page has the origin `http://acde.local`. Each app's storage is a separate partition, invisible to other apps.

## Storage

| API | Notes |
| --- | --- |
| `localStorage` | Shared by all windows of the same app; 5 MiB quota; other windows get a `storage` event on changes |
| `sessionStorage` | Per window, in memory only; **not** kept across `location.reload()` (unlike browsers) |
| IndexedDB | Fully implemented, stored in SQLite; promise-wrapper libraries (idb and others) behave as in browsers |
| Cache API | `caches` is supported |
| cookie | Stored and sent as usual for same-origin requests (your own backend); cross-origin requests neither send nor store cookies |
| `navigator.storage` | `estimate()`; `persist()` is always `true`; `getDirectory()` is the origin private file system (OPFS) |

Data lives in `$XDG_DATA_HOME/acde/storage/app-<id>/`.

## Network

- `fetch`, `XMLHttpRequest`, `WebSocket`, and `EventSource` are all supported.
- Same-origin paths and `localhost` go to the app's own backend; see [Backend](../guide/backend.md).
- Requests to other hosts use the system's DNS and network, with normal certificate validation. They do **not** go through the system proxy, and responses are not decompressed automatically (no `Accept-Encoding` is sent).
- Cross-origin requests follow browser rules: `Origin` header, CORS preflight, response header filtering, opaque responses for `no-cors`.
- Forbidden request headers (`Host`, `Cookie`, `Origin`, `Referer`, `Sec-*`, ...) are not sent even if you set them.
- Synchronous XHR can only read the app's own files.

## External resources

`<img>` and images and fonts in CSS are **read only from the app's own files**; they are never fetched from other hosts. ES modules can't be `import`ed from other hosts either. Bundle the resources you need into the app. (Classic `<script src>` can load from other hosts.)

## Scripts

Classic `<script>`, `type="module"`, and `type="importmap"` are supported.

## File pickers

`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, and `<input type="file">` open the system dialog; see [Files and folders](../guide/files.md).

## Media

`Audio` / `AudioContext` are supported. WebGPU is currently available only on Linux.

## Not yet supported

`<datalist>`, `appearance: base-select` on `<select>`, Web Workers, `crypto.subtle`, WebGL (`getContext('webgl')` and `getContext('webgl2')` return `null`; use 2D canvas, or WebGPU on Linux), OffscreenCanvas / `createImageBitmap`, fullscreen and pointer lock, `:target`, Storage Buckets, and Service Workers.

## Differences from browsers

- `alert()` is drawn inside the window; `confirm()` returns `false` and `prompt()` returns `null`.
- There are no developer tools: use the [debugging tools](../guide/tools.md) and [MCP](../guide/mcp.md).
- Pages have no security sandbox (there is no syscall-level isolation yet): don't run code you don't trust.
