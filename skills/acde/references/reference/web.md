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
- Requests to other hosts use the system's DNS and network, with normal certificate validation, and go through a proxy the way the system says: with `http_proxy`, `https_proxy` or `all_proxy` set in the session, only those variables (and `no_proxy`) count; otherwise the system's proxy settings (Windows: the user's Internet settings, including a configuration script and automatic detection; macOS: the network settings; Linux has no other source). `localhost`, loopback addresses and the app's own backend are always reached directly. Proxy authentication and `https://` proxies are not supported. Responses are not decompressed automatically (no `Accept-Encoding` is sent).
- Cross-origin requests follow browser rules: `Origin` header, CORS preflight, response header filtering, opaque responses for `no-cors`.
- Forbidden request headers (`Host`, `Cookie`, `Origin`, `Referer`, `Sec-*`, ...) are not sent even if you set them.
- Synchronous XHR can only read the app's own files.

## External resources

Images (`<img>` and images in CSS), stylesheets (`<link rel="stylesheet">`) and fonts load from other hosts as they do in a browser: images and stylesheets without CORS, fonts only with an `Access-Control-Allow-Origin` that allows the page, a stylesheet only from a 2xx `text/css` response. They show up in `acde network` with the kinds `image`, `stylesheet` and `font`, and a failed one is a console error `Failed to load resource: <url>: <reason>`. A `<link rel="stylesheet">` fires `load` once its sheet is fetched and applied and `error` when it cannot be had (also when a sheet it `@import`s cannot); `link.sheet` and `document.styleSheets` have the sheet from then on. The rules of a sheet from another host (`sheet.cssRules`) throw `SecurityError` unless the link has `crossorigin` and the host allows the page with `Access-Control-Allow-Origin`. **ES modules can't be `import`ed from other hosts** (`module … is not a local file`): bundle the code you depend on into the app. (Classic `<script src>` can load from other hosts.) An app that should work without a network bundles its images, styles and fonts too.

## Scripts

Classic `<script>`, `type="module"`, and `type="importmap"` are supported.

## File pickers

`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, and `<input type="file">` open the system dialog; see [Files and folders](../guide/files.md).

Files and folders dropped into a window arrive the standard way: `dataTransfer.files`, and a read-only handle from `dataTransfer.items[i].getAsFileSystemHandle()`. Folders and files over 64 MiB are not in `files`; use the handle. See [Dropped files](../guide/files.md#dropped-files).

## Media

`Audio` / `AudioContext` are supported. WebGPU is currently available only on Linux.

`<video>` plays what the system's own decoders can open, so formats differ by platform: on macOS, MP4 / QuickTime plays and WebM does not. Ask `canPlayType()` before choosing a source.

`navigator.mediaDevices.getUserMedia()` needs the `camera` / `microphone` capability in the config and the user's answer the first time (see [Capabilities](../guide/capabilities.md#camera-and-microphone)). Not available on Windows.

- A required capability is approved before the app starts. An [optional](../guide/capabilities.md#optional-capabilities) one that was not asked for yet is asked for by `getUserMedia()` itself, with the prompt `request('camera')` raises; a call that wants both asks for the microphone first, then the camera. The call resolves once the user allows and rejects with `NotAllowedError` (`Permission denied`) when the user denies; later calls do not ask again.
- `navigator.permissions.query({ name: 'camera' })` (or `'microphone'`) answers `prompt` until the user has answered and `denied` after a denial or after the approval was taken back; its `change` event fires on the answer. Once the user has allowed it, the answer is the host system's own permission for the device (`granted` when the system allows it too).
- In an app that does not declare the capability, the query answers `denied` and `getUserMedia()` rejects with `NotAllowedError`, without a prompt.
- Constraints are judged first: a request that no device can meet rejects with `OverconstrainedError` and asks nobody.
- `enumerateDevices()` lists one entry without a label for a kind that is not allowed yet.
- To try a page without a real camera or microphone, start the session with `ACDE_CAPTURE=fake`: the devices are then `Fake camera` and `Fake microphone`.

## Not yet supported

`<datalist>`, `appearance: base-select` on `<select>`, Web Workers, `crypto.subtle`, WebGL (`getContext('webgl')` and `getContext('webgl2')` return `null`; use 2D canvas, or WebGPU on Linux), OffscreenCanvas / `createImageBitmap`, the Fullscreen API (`requestFullscreen()` rejects with `NotSupportedError`; an app window goes full screen with `requestState('fullscreen')` from [`acde:window`](../guide/window.md#window-state)) and pointer lock, `:target`, Storage Buckets, and Service Workers.

## Differences from browsers

- `alert()` is drawn inside the window; `confirm()` returns `false` and `prompt()` returns `null`.
- `navigator.userAgent` and `navigator.platform` say Linux on every system (`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) acdert/<version>` and `Linux x86_64`), and editing shortcuts use Ctrl everywhere, so an app behaves the same on every host. To know the real system, read `platform` from [`acde:capabilities`](../guide/capabilities.md#acdecapabilities).
- There are no developer tools: use the [debugging tools](../guide/tools.md) and [MCP](../guide/mcp.md).
- Pages have no security sandbox (there is no syscall-level isolation yet): don't run code you don't trust.
