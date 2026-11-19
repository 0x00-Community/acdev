# acde: modules

Every module has both named exports and a default export:

```js
import { fs } from 'acde:fs'
import fs from 'acde:fs'
```

Types are in `@dopame/acde-api`: `@dopame/acde-api/app` declares the modules an app can import, `@dopame/acde-api/shell` adds the shell modules, and the package root declares all of them. For how capabilities are requested and approved, see [Capabilities](../guide/capabilities.md).

Who can import what. "App" is an app of its own package; a "system app" ships in a desktop's package (the `apps` of a desktop config). A name in a cell is the capability the app must declare:

| Module | App | System app | Desktop page |
| --- | --- | --- | --- |
| `acde:window` | ✓ | ✓ | |
| `acde:capabilities` | ✓ | ✓ | ✓ |
| `acde:apps` | ✓ | ✓ | ✓ |
| `acde:open` | ✓ (opening an app needs `open`) | ✓ (same) | ✓ |
| `acde:fs` | `fs` | `fs` | ✓ |
| `acde:terminal` | `terminal` | `terminal` | ✓ |
| `acde:network` | `network` | `network` | ✓ |
| `acde:system` | `system` | `system` | ✓ |
| `acde:bluetooth` | `bluetooth` | `bluetooth` | ✓ |
| `acde:audio` | `audio` | `audio` | ✓ |
| `acde:devices` | `devices` | `devices` | ✓ |
| `acde:power` | `power` | `power` | ✓ |
| `acde:input` | `input` | `input` | ✓ |
| `acde:display` | `display` | `display` | ✓ |
| `acde:office` | `office` | `office` | ✓ |
| `acde:openPath` `acde:handlers` | `openFiles` | `openFiles` | ✓ |
| `acde:launch` | `launch` or `slots` | `launch` or `slots` | ✓ |
| `acde:windows` `acde:packages` `acde:session` `acde:desktops` `acde:inspect` `acde:desktop` `acde:setDefault` `acde:permissions` (shell modules) | | The module's name: `"windows": true` | ✓ |
| `acde:<service>` | The service's name in `services` | The same | ✓ |

A module the platform lacks is missing for everyone there (see [Platform support](platforms.md)). An import that is not allowed fails with an `AcdeError` (`code: 'forbidden'`, `status: 403`, `module` without `acde:`) whose message names the missing declaration, such as `acde:terminal needs "terminal" in the capabilities of Notes`; when the service that provided the module stopped, the code is `service_not_running` and the status 503. See [Errors](#errors). Desktop services cannot import `acde:` modules; a service that the desktop grants shell modules gets them from `ctx.import()`; see [Service API](service.md).

Events are subscribed with `on(type, handler)`, which returns an unsubscribe function. `on()` throws a `TypeError` for an event type the module does not have, such as `acde:window has no nosuch event (activate, deactivate, …)`. `acde:terminal` takes a callback instead (`subscribe`); `acde:network` has `on('changed')` and also takes a callback with `watch`.

## Errors

The system modules (`acde:network`, `acde:system`, `acde:bluetooth`, `acde:audio`, `acde:devices`, `acde:power`, `acde:input`, `acde:display`) fail with one kind of error, whether a method throws or its promise rejects: an `Error` with `name === 'AcdeError'` and `status`, `code` and `module` (the module's name without `acde:`). The cause is in `cause`, and a code of its own, when it has one, in the optional `reason`. The types are `AcdeError` and `AcdeErrorCode` in `@dopame/acde-api`; tell the error by `error.name === 'AcdeError'`. The codes:

| `code` | `status` | When |
| --- | --- | --- |
| `bad_request` | 400 | A wrong argument, such as a host name, a time zone, a power setting, a brightness or a device id |
| `forbidden` | 403 | The app was not given the module or the call (not in its capabilities) |
| `unsupported` | 501 | This runtime or platform cannot do it |
| `service_not_running` | 503 | The system service or bus it needs is not there (NetworkManager, BlueZ, UPower, fcitx5 and the like) |
| `failed` | 500 | Anything else |

```js
try {
  await network.connect('Home', 'secret')
} catch (error) {
  if (error.name === 'AcdeError' && error.code === 'service_not_running') showOffline()
  else throw error
}
```

An `import` of a module the app was not given fails with the same error, `code: 'forbidden'` (see above).

## acde:window

```ts
interface AcdeWindow {
  readonly id: number
  readonly state: WindowState
  readonly output: WindowOutput
  readonly hostControls: boolean
  readonly minimizable: boolean
  readonly host: WindowHost
  mount(app: WindowApp): void
  setTitle(title: string): void
  setMenus(menus: readonly AppMenu[]): void
  close(): Promise<boolean>
  minimize(): Promise<void>
  requestAttention(): Promise<void>
  requestState(state: WindowState): void
  requestMode(mode: WindowMode): void
  setGrabHint(rect: WindowRect, edges?: readonly ('top' | 'bottom' | 'left' | 'right')[]): void
  setBackdrop(rect: WindowRect | null, effect?: { radius?: number; blur?: number; saturate?: number; brightness?: number }): void
  requestActivate(): void
  requestGrab(kind: 'pointer' | 'keyboard'): void
  releaseGrab(kind: 'pointer' | 'keyboard'): void
  shortcut(combo: string): Promise<void>
  unshortcut(combo: string): Promise<void>
  on(name: 'beforeclose', handler: () => boolean | void | Promise<boolean | void>): () => boolean
  on<R extends AppRequest = AppRequest>(name: 'request', handler: (request: SystemRequest | R) => void): () => boolean
  on(name: 'activate' | 'deactivate', handler: () => void): () => boolean
  on(name: 'state', handler: (event: { readonly state: WindowState; readonly previous: WindowState }) => void): () => boolean
  on(name: 'output', handler: (output: WindowOutput) => void): () => boolean
  on(name: 'hostcontrols', handler: (hostControls: boolean) => void): () => boolean
  on(name: 'minimizable', handler: (minimizable: boolean) => void): () => boolean
  on(name: 'shortcut', handler: (event: ShortcutEvent) => void): () => boolean
  on(name: 'grab', handler: (event: { readonly kind: 'pointer' | 'keyboard'; readonly granted: boolean }) => void): () => boolean
  on(name: 'grablost', handler: (event: { readonly kind: 'lost'; readonly reason: 'esc' | 'other_window' | 'focus_lost' | 'denied' }) => void): () => boolean
  on(name: 'suspend' | 'resume', handler: () => void): () => boolean
}

type WindowState = 'normal' | 'minimized' | 'filled' | 'fullscreen'
type WindowMode = 'free' | 'fixed' | 'pinned'

interface WindowRect { x: number; y: number; width: number; height: number }
interface WindowOutput { width: number; height: number; scale: number; workArea: WindowRect }

interface ShortcutEvent { type: 'shortcut'; window: number; key: string; title: 'session' | 'desktop' | 'app' }

interface AppMenu {
  id: string
  label: string
  items: ({ type: 'separator' } | AppMenuItem)[]
}
interface AppMenuItem {
  id: string
  label: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  onSelect?(): void | Promise<void>
}

interface WindowApp {
  mount(element: Element, host: WindowHost): () => void
}
interface WindowHost {
  setTitle(title: string): void
  setMenus(menus: readonly AppMenu[]): void
}
```

- Full screen is a state: `requestState('fullscreen')`. `requestMode('fullscreen')` throws a `TypeError`, and so does an unknown state. `requestState` has no result; follow the `state` event. See [Window state](../guide/window.md#window-state).
- `close()` closes the window without asking `beforeclose`.
- `minimize()` rejects with `status: 409`, `code: 'unavailable'` for a window that cannot be minimized (`minimizable` is `false`): `window 1048576 cannot be minimized: it fills the host window, which only the host window's own controls minimize here` for the app's window in a session that runs a single app, on macOS and headless. `requestState('minimized')` changes nothing there.
- `suspend` and `resume` are declared, but the runtime does not send them yet.
- Coordinates are logical pixels of the page (the content area). Shortcut combos are written like `ctrl+alt+t`: keys are xkb keysym names, the key names X11 and Wayland use (`t`, `return`, `escape`, `f5`, `space`; case doesn't matter), and Shift is part of the combo.

## acde:capabilities

```ts
interface AcdeCapabilities {
  readonly level: number
  readonly platform: 'linux' | 'win32' | 'darwin'
  readonly mode: 'session' | 'desktop' | 'standalone'
  readonly window: { readonly backdrop: 'full' | 'approximated' | 'unsupported' }
  get(name: string): CapabilityStatus
  list(): CapabilityStatus[]
  request(name: string): Promise<CapabilityStatus>
}

interface CapabilityStatus {
  name: string
  kind: 'system' | 'service'
  state: 'available' | 'not-asked' | 'asking' | 'not-declared' | 'unsupported' | 'service-not-running' | 'shell-only' | 'denied'
  reason: string
  optional: boolean
}
```

`level` is the contract level (1). `request(name)` asks the user for a capability that needs approval and resolves with its status after the answer; for anything else it resolves at once. A capability that needs approval is `available` only once the user allowed it: `not-asked` before the prompt, `asking` while it waits, `denied` after a denial or after the approval was taken back. A call that the approval stops fails with `status: 403`, the `capability`, and one of the codes `not_asked`, `asking`, `denied`. Names are capability names, `fs.<place>` for a shared place (`fs.downloads`), service names, and `notifications` (the standard `Notification` API: `available`, or `unsupported` where this way of running has no notifications). See [Capabilities](../guide/capabilities.md#acdecapabilities).

## acde:fs

```ts
interface AcdeFs {
  roots(): Promise<FinderRoot[]>
  list(root: string, path?: string, hidden?: boolean): Promise<{ root: FinderRoot; path: string; entries: FinderEntry[]; truncated: boolean; skipped?: number }>
  stat(root: string, path: string): Promise<FinderEntry & { path: string }>
  readText(root: string, path: string): Promise<{ text: string; modifiedMs: number; size: number; version: string }>
  readBytes(root: string, path: string): Promise<{ data: Uint8Array; modifiedMs: number; size: number; version: string }>
  readRange(root: string, path: string, offset: number, length: number, options?: { ifVersion?: string }): Promise<{
    data: Uint8Array; offset: number; size: number; modifiedMs: number; version: string
  }>
  writeFile(root: string, path: string, data: string | Uint8Array, options?: {
    create?: 'always' | 'new' | 'never'
    ifVersion?: string
    ifModifiedMs?: number
    mkdirs?: boolean
  }): Promise<FinderEntry>
  openWrite(root: string, path: string, options?: {
    keepExistingData?: boolean
    create?: 'always' | 'new' | 'never'
    ifVersion?: string
    mkdirs?: boolean
  }): Promise<{ id: string; size: number }>
  writeChunk(id: string, offset: number, data: string | Uint8Array): Promise<void>
  truncateWrite(id: string, size: number): Promise<void>
  commitWrite(id: string): Promise<FinderEntry>
  abortWrite(id: string): Promise<void>
  mkdir(root: string, path: string, options?: { recursive?: boolean }): Promise<FinderEntry>
  rename(root: string, from: string, to: string): Promise<FinderEntry>
  delete(root: string, path: string): Promise<{ status: 'deleted'; path: string }>
  copy(fromRoot: string, fromPath: string, toRoot: string, toDir: string): Promise<FinderEntry & { path: string }>
  preview(root: string, path: string): Promise<FinderPreview>
  download(root: string, path: string): Promise<{ name: string; contentType: string; data: Uint8Array }>
  revoke(root: string): Promise<void>
  locate(path: string): Promise<{ root: string; path: string }>
  openPath(root: string, path: string): Promise<{ root: string; path: string; file: string }>
}

interface FinderRoot {
  id: string
  label: string
  source: 'private' | 'place' | 'granted' | 'desktop' | 'downloads' | 'default'
  place?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  path?: string
  mode: 'writable' | 'read_only' | 'unavailable'
  reason: string | null
  exists: boolean
}

interface FinderEntry {
  name: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  modifiedMs: number
  target?: string
  version?: string
  inPlace?: true
}

interface FinderPreview {
  path: string
  name: string
  size: number
  modifiedMs: number
  kind: 'text' | 'image' | 'binary' | 'too_large'
  content?: string
  truncated?: boolean
}
```

- `root` is the `id` of an item of `roots()`: `private`, a shared place's name, or `folder-…` for a picked folder; never a path. An app's roots have `source` `private`, `place` (with `place`), or `granted`, and no `path`.
- `path` is there only for system apps that name shared places, and for the desktop page. `locate` and `openPath` work only for them; in other apps they reject with `EACCES`.
- The desktop page's roots are folders by path (`source` `desktop`, `downloads`, `default`, or `granted`), and their `id` is the path.
- `list` leaves hidden entries out unless `hidden` is `true`; `skipped` counts entries whose names are not valid Unicode.
- `copy` copies a file or a folder from one root into the folder `toDir` of another; a taken name gets a number (`todo 2.md`), and `path` is where the copy is in `toRoot`.
- `revoke` gives back a folder the user picked.
- `version` is an opaque string for one state of a file; pass it as `ifVersion` and a write (or a `readRange`) of a file that changed since fails with `ECONFLICT`. `inPlace` marks a write that could not go through a temporary file. See [Safe writes](../guide/files.md#safe-writes).
- `openWrite` starts a write in parts: `writeChunk` at any offset, `truncateWrite`, then `commitWrite` puts the file in place (or `abortWrite`). A write left alone for 10 minutes is given up. See [Large files](../guide/files.md#large-files).
- Limits: `readText` / `readBytes` / `writeFile` 64 MiB; `readRange` / `writeChunk` 16 MiB a call; `list` 5000 entries (`truncated`); `preview` text 256 KiB.
- `download` answers the type the system knows for the file's name as `contentType`: `text/markdown` for `note.md`, `image/png` for `shot.png`, and `application/octet-stream` for a name it knows no type for (`data.xyz`). The types come from the system, as described under [Files and links](../guide/open.md#files-and-links).
- Errors have `code` and `status`; see [Files and folders](../guide/files.md#errors).

## acde:open

```ts
interface AcdeOpen {
  (app: string, request?: null, options?: OpenWindowOptions): Promise<{ window: number }>
  <R extends AppRequest>(app: string, request: R, options?: OpenWindowOptions): Promise<{ window: number }>
  (app: string, request: SystemRequest): Promise<Opened>
  (request: SystemRequest): Promise<Opened>
}

type AppRequest<K extends string = string, Fields extends object = Record<never, never>> = { readonly kind: K } & { readonly [P in keyof Fields]: Fields[P] }

type SystemRequest =
  | { kind: 'open-file'; handle?: FileSystemFileHandle | FileSystemDirectoryHandle; url?: string; root?: string; path?: string; file?: string | null }
  | { kind: 'open-link'; url: string }

interface OpenWindowOptions { parent?: number; modal?: boolean }
interface Opened { kind: 'acdev' | 'native'; id: string; window?: number }
```

- `open(app)` and `open(app, request)` need the `open` capability to allow `app`. A request to an app must have a `kind` that the target lists in its `requests` (400 `untyped_request`, 409 `not_accepted`).
- `open(request)` with a system request and no app needs `openFiles`: the system picks the app. With an app, the target must declare the file's type (`mimeTypes`) or the link's scheme (`schemes`).
- A receiving app gets a file as `{ kind: 'open-file', handle }`; a system app that names shared places also gets `url`. Send a file with `handle` (one this page got from a picker, a drop, or a request) or, where the caller knows paths, with `url`.
- A receiver types its own requests with `AppRequest<K, Fields>`: `type ShowImage = AppRequest<'show-image', { image: string }>`, then `self.on<ShowImage>('request', …)` narrows by `kind`. `SystemRequest` and `AppRequest` are also in `acde:window`'s `request` event (above).

See [Opening apps](../guide/open.md).

## acde:apps

```ts
interface AcdeAppList {
  list(): Promise<DesktopApp[]>
  open: AcdeOpen
  on(type: 'changed', handler: (event: { type: 'appschanged'; apps: readonly DesktopApp[] }) => void): () => boolean
}

interface DesktopApp { id: string; label: string; icon: string; script: string }
```

`list()` gives the apps that can run here; `open` is the function of `acde:open`. `changed` fires with the new list when it changes. A denied camera or microphone keeps the app in the list. Installing packages and native programs are in [`acde:packages`](#acdepackages).

## acde:openPath / acde:handlers / acde:setDefault

```ts
function openPath(path: string, options?: { app?: string; select?: boolean }): Promise<{ kind: 'acdev' | 'native'; id: string; window?: number }>
function handlers(path: string): Promise<{ mime: string; association: string | null; handlers: OpenHandler[] }>
function setDefault(association: string, handler: string): Promise<string>

interface OpenHandler {
  kind: 'acdev' | 'native'
  id: string
  label: string
  icon: string
  default: boolean
  system?: boolean
}
```

`path` can be a path or a URI. `openPath` and `handlers` need `openFiles`; for an app the file must be inside one of its roots (404 `outside_roots`). `setDefault` is a shell module. `association` is the key a choice is remembered under: the MIME type, or on Windows the file's extension (`.md`); `mime` is `''` when the system knows no type for the file. `system` marks the program that is the system's own default (Windows).

## acde:launch

Needs `launch` (for `start`) or `slots` (for `embed`).

```ts
interface AcdeLaunch {
  start(argv: readonly string[], options?: LaunchOptions): Promise<number>
  embed(argv: readonly string[], options?: LaunchOptions): Promise<number>
  close(window: number): Promise<boolean>
  list(): NativeWindow[]
  on<K extends WindowsEventType>(type: K, handler: (event: WindowsEventMap[K]) => void): () => boolean
}

interface LaunchOptions { cwd?: string; env?: Record<string, string> }
```

`start` runs a native program and `embed` runs one embedded in the app's own window (Dopame OS only). `close` closes a window the app started; any other window is rejected with 403 `forbidden`. The events are those of [`acde:windows`](#acdewindows).

## acde:terminal

Needs `terminal`.

```ts
interface AcdeTerminals {
  open(cols: number, rows: number): Promise<{ id: string }>
  subscribe(id: string, callback: (events: TerminalEvent[]) => void): Promise<void>
  input(id: string, data: string): Promise<{ ok: true }>
  resize(id: string, cols: number, rows: number): Promise<{ cols: number; rows: number }>
  close(id: string): Promise<{ closed: string }>
}

type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'cwd'; path: string }
  | { type: 'exit'; code: number | null; signal: number | null }
```

## acde:network

Linux only (Dopame OS, or any Linux with NetworkManager). Needs `network`.

```ts
interface AcdeNetwork {
  state(): Promise<NetworkState>
  networks(scan?: boolean): Promise<WifiNetwork[]>
  connect(ssid: string, password?: string): Promise<void>
  activate(iface: string): Promise<void>
  disconnect(iface: string): Promise<void>
  setWifiEnabled(on: boolean): Promise<void>
  on(type: 'changed', handler: (state: NetworkState) => void): () => boolean
  watch(callback: (state: NetworkState) => void): void
}

interface NetworkState {
  wifiEnabled: boolean
  connectivity: 'full' | 'limited' | 'portal' | 'none' | 'unknown'
  primary: 'wifi' | 'ethernet' | string | null
  devices: NetworkDevice[]
}

interface NetworkDevice {
  iface: string
  type: 'wifi' | 'ethernet'
  state: 'connected' | 'connecting' | 'disconnecting' | 'disconnected' | 'unavailable' | 'unmanaged' | 'failed'
  connection: string | null
  ip4: string | null
  ssid?: string
  strength?: number
  carrier?: boolean
  speed?: number
}

interface WifiNetwork {
  ssid: string
  strength: number
  secure: boolean
  band: '2.4GHz' | '5GHz'
  active: boolean
  saved: boolean
}
```

## acde:system

Linux only. Needs `system`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdeSystem {
  info(): Promise<SystemInfo>
  storage(): Promise<SystemVolume[]>
  time(): Promise<SystemTime>
  timezones(): Promise<string[]>
  setTimezone(zone: string): Promise<void>
  setNtp(on: boolean): Promise<void>
  setHostname(name: string): Promise<void>
  user(): Promise<SystemUser>
  on(type: 'changed', handler: (change: SystemChange) => void): () => boolean
}
```

The computer: `info()` (the host name and other facts), `storage()` (its volumes), `time()` (with `timezone` and `ntp`), `timezones()`, the settings `setTimezone`, `setNtp` and `setHostname`, and `user()`. `changed` gives `{storage, hostname, timezone, ntp}`, the whole set each time, when one of these changes; it is checked every 30 seconds while someone listens, and right after this page sets one of them. The state types are in `@dopame/acde-api`.

## acde:bluetooth

Linux only. Needs `bluetooth`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdeBluetooth {
  state(): Promise<BluetoothState>
  setPowered(on: boolean): Promise<void>
  setDiscoverable(on: boolean, timeout?: number): Promise<void>
  setName(name: string): Promise<void>
  scan(on: boolean): Promise<void>
  pair(id: string): Promise<void>
  answer(id: string, accept: boolean, pin?: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  forget(id: string): Promise<void>
  setTrusted(id: string, on: boolean): Promise<void>
  setBlocked(id: string, on: boolean): Promise<void>
  rename(id: string, name: string): Promise<void>
  setOnLogin(mode: 'remember' | 'on' | 'off'): Promise<void>
  on(type: 'changed', handler: (state: BluetoothState) => void): () => boolean
  on(type: 'pairing', handler: (request: BluetoothPairing) => void): () => boolean
}
```

The Bluetooth adapter and its devices (BlueZ). `changed` gives the whole `BluetoothState`; `pairing` asks the page to confirm a pairing, show or enter a PIN or passkey, or authorize a service, and the page answers with `answer(id, accept, pin?)`. The state types are in `@dopame/acde-api`.

## acde:audio

Linux only. Needs `audio`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdeAudio {
  state(): Promise<AudioState>
  setDefault(id: string): Promise<void>
  setVolume(id: string, volume: number): Promise<void>
  setMuted(id: string, muted: boolean): Promise<void>
  setBalance(id: string, balance: number): Promise<void>
  setPort(id: string, port: string): Promise<void>
  setProfile(card: string, profile: string): Promise<void>
  moveStream(id: string, device: string | null): Promise<void>
  on(type: 'changed', handler: (state: AudioState) => void): () => boolean
}
```

The sound cards, outputs, inputs and playing streams: the default device, volume, mute, balance, port and card profile, and which device a stream plays on. `changed` gives the whole `AudioState`. The state types are in `@dopame/acde-api`.

## acde:devices

Linux only. Needs `devices`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdeDevices {
  state(): Promise<DevicesState>
  mount(id: string): Promise<string>
  unmount(id: string): Promise<void>
  eject(id: string): Promise<void>
  setAutomount(patch: Partial<Pick<Automount, 'onLogin' | 'onAttach' | 'unknown'>>): Promise<void>
  setDeviceAutomount(id: string, patch: Partial<Pick<AutomountDevice, 'login' | 'attach'>>): Promise<void>
  forgetDevice(id: string): Promise<void>
  setDefaultPrinter(id: string): Promise<void>
  pausePrinter(id: string): Promise<void>
  resumePrinter(id: string): Promise<void>
  jobs(printer: string): Promise<PrintJob[]>
  cancelJob(printer: string, job: number): Promise<void>
  on(type: 'changed', handler: (state: DevicesState) => void): () => boolean
  on(type: 'added', handler: (drive: Drive) => void): () => boolean
}
```

Drives (USB sticks, cards, discs, phones, disks: mount, unmount, eject, and the automount settings) and printers (the default one, pause, resume, jobs). `changed` gives the whole `DevicesState`; `added` gives a drive when one is plugged in. The state types are in `@dopame/acde-api`.

## acde:power

Linux only. Needs `power`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdePower {
  state(): Promise<PowerState>
  setProfile(profile: PowerProfile): Promise<void>
  configure(patch: PowerSettingsPatch): Promise<void>
  setScreenOff(seconds: number | null): Promise<void>
  setSleep(seconds: number | null): Promise<void>
  suspend(): Promise<void>
  hibernate(): Promise<void>
  setBrightness(value: number): Promise<void>
  setChargeLimit(percent: number | null): Promise<void>
  on(type: 'changed', handler: (state: PowerState) => void): () => boolean
  on(type: 'prompt', handler: (event: PowerPromptEvent) => void): () => boolean
  on(type: 'critical', handler: (event: PowerCriticalEvent) => void): () => boolean
}
```

Batteries, the power profile, what the lid, the power button and being idle do (on AC, on battery and on low battery), screen-off and sleep timers, suspend and hibernate, the backlight, and the charge limit. `changed` gives the whole `PowerState`; `prompt` (`{type: 'prompt'}`) asks the page to offer the power choices, and `critical` (`{type: 'critical', action, seconds}`) says the battery is critically low and what happens in how many seconds. The state types are in `@dopame/acde-api`.

## acde:input

Linux only. Needs `input`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdeInput {
  state(): Promise<InputState>
  set(patch: InputPatch): Promise<void>
  catalog(): Promise<InputCatalog>
  on(type: 'changed', handler: (state: InputState) => void): () => boolean
}
```

Keyboard (model, layouts, options, Num Lock), mouse and touchpad settings, and the input methods. `set()` takes the parts to change; `catalog()` lists the models, layouts, options and input methods to choose from. `changed` gives the whole `InputState`. The state types are in `@dopame/acde-api`.

## acde:display

Linux only. Needs `display`. Its errors are [`AcdeError`s](#errors).

```ts
interface AcdeDisplay {
  state(): Promise<DisplayState>
  configure(id: string, patch: DisplayPatch): Promise<void>
  setBrightness(id: string, value: number): Promise<void>
  setNightLight(patch: Partial<NightLight>): Promise<void>
  on(type: 'changed', handler: (state: DisplayState) => void): () => boolean
}
```

The displays (mode, scale, rotation and the rest, set with `configure`), their brightness, and the night light. `changed` gives the whole `DisplayState`. The state types are in `@dopame/acde-api`.

## acde:session

Shell module: only the desktop page and the system apps of its package (with `"session": true` in their capabilities) can import it; an ordinary app cannot, even if it declares `session`.

```ts
interface AcdeSession {
  own(): boolean
  logout(): Promise<void>
  reboot(): Promise<void>
  poweroff(): Promise<void>
  setLanguage(tag: string): Promise<void>
}
```

`own()`: whether this is a real Dopame OS session (`false` in the host window of `acdev dev`). After `setLanguage`, pages receive `languagechange`.

## acde:desktops

Shell module.

```ts
interface AcdeDesktops {
  list(): Promise<{ desktops: DesktopInfo[]; current: string }>
  choose(id: string, remember?: boolean): Promise<void>
}

interface DesktopInfo {
  kind: 'acdev' | 'session'
  id: string
  name: string
  description: string | null
  package: string | null
}
```

`kind: 'session'` is another Wayland session on the system (GNOME, KDE, ...).

## acde:packages

Shell module.

```ts
interface AcdePackages {
  refresh(): Promise<DesktopApp[]>
  install(dir: string): Promise<{ id: string; dir: string; apps: DesktopApp[] }>
  natives(): Promise<NativeApp[]>
  runNative(id: string): Promise<number>
  on(type: 'changed', handler: (event: { type: 'appschanged'; apps: readonly DesktopApp[] }) => void): () => boolean
}

interface NativeApp {
  id: string
  name: string
  comment: string | null
  icon: string
  keywords: string[]
  wmClass: string | null
}
```

`natives()` lists the system's native programs (`.desktop` files, Linux only).

## acde:windows

Shell module: every window of the session.

```ts
interface AcdeWindows {
  on<K extends WindowsEventType>(type: K, handler: (event: WindowsEventMap[K]) => void): () => boolean
  list(): NativeWindow[]
  close(id: number): void
  requestState(id: number, state: WindowState): Promise<void>
  kill(id: number): Promise<boolean>
  focus(id: number): Promise<void>
  hide(id: number): Promise<void>
  show(id: number): Promise<void>
  invokeMenu(id: number, menu: string, item: string): Promise<void>
  stats(): Promise<Record<string, number>>
  animate(id: number, options: {
    opacity?: number; scale?: number; dx?: number; dy?: number
    duration?: number; delay?: number
    easing?: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
  }): Promise<void>
  shortcut(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  unshortcut(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  launch(argv: string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): number | Promise<number>
}

interface NativeWindow { id: number; appId: string | null; title: string | null; web?: boolean; state: WindowState }
```

`WindowsEventType`: `open` `close` `title` `state` `activate` `minsize` `parent` `menus` `crash` `hang` `responsive` `attention` `ready` `show` `animated`. Every event is `{ type: 'window<name>', window: number, … }`:

| Event | Extra fields |
| --- | --- |
| `open` | `appId`, `title`, `web`, `icon` |
| `title` | `appId`, `title` |
| `state` | `state`, `previous` |
| `minsize` | `width`, `height` |
| `parent` | `parent` |
| `menus` | `menus`: the app's menus, each item with `action: boolean` instead of `onSelect` |
| `crash` | `reason` |

- A window's state changes are reported by `state`; full screen and minimizing have no events of their own. `requestState` rejects an unknown state with a `TypeError`.
- `close(id)` asks the app (`beforeclose`); `kill(id)` ends the window without asking.
- `animate` may finish at once where the runtime cannot animate; `animated` still fires.
- Every row of `list()` has the window's current `state`, and `list()` has every window, also in a system app that started after a window opened.
- An app starts native programs with [`acde:launch`](#acdelaunch), not with `launch` here.

## acde:desktop

Shell module.

```ts
interface AcdeDesktop {
  apps(): Promise<{ apps: DesktopApp[] }>
  pin(element: Element, options?: { margin?: number; reserve?: PanelReserve }): PinnedPanel
  setDoubleClick(action: 'fill' | 'minimize' | 'none'): void
  setFrameTheme(theme: FrameTheme | null): void
  on(type: 'notification', handler: (e: NotificationEvent) => void): () => boolean
  on(type: 'download', handler: (e: DownloadEvent) => void): () => boolean
  on(type: 'screenshot', handler: (e: { type: 'screenshot'; path: string; width: number; height: number } | { type: 'screenshot'; path: string; error: string }) => void): () => boolean
  on(type: 'shortcut', handler: (e: ShortcutEvent) => void): () => boolean
  on(type: 'edge', handler: (e: { type: 'screenedge'; edge: 'top' | 'right' | 'bottom' | 'left'; entered: boolean; output: string }) => void): () => boolean
}

interface PanelReserve { edge: 'top' | 'bottom' | 'left' | 'right'; thickness?: number }
interface PinnedPanel {
  update(): void
  unpin(): void
  reserve(reserve: PanelReserve | null): void
}

interface FrameTheme {
  active?: FrameColors
  inactive?: FrameColors
  light?: { active?: FrameColors; inactive?: FrameColors }
  buttonStyle?: 'dots' | 'glyphs'
  buttonSide?: 'left' | 'right'
  titleAlign?: 'center' | 'start'
}
interface FrameColors { background?: string; title?: string; line?: string; buttons?: string }

interface NotificationEvent {
  type: 'notification'
  window: number
  app: string | null
  label: string | null
  title: string
  body: string
  icon: string
  tag: string
}

interface DownloadEvent {
  type: 'download'
  window: number
  app: string | null
  path: string
  name: string
  size: number
}
```

- `edge` fires when the pointer reaches (`entered: true`) or leaves an edge of the screen, once per edge (twice in a corner); `output` is the screen's name, `host` in a host window. It takes no focus, for a desktop that shows its hidden menu bar or Dock.
- `light`: the title bar colors for windows whose page does not declare dark support (`color-scheme` without `dark`); `active` / `inactive` are then for pages that do. Every `setFrameTheme` call gives the whole theme; a bad value throws a `TypeError`, and an unknown key is ignored with a warning in the log.
- A system app that declares `"desktop": true` gets `apps()`, `setDoubleClick`, `setFrameTheme`, and the `notification`, `download` and `edge` events; `pin`, `screenshot` and `shortcut` are the desktop page's only.

See [Desktops](../guide/desktop.md#panels).

## acde:permissions

Shell module: the approval prompts and the decisions about them.

```ts
interface AcdePermissions {
  pending(): Promise<PermissionPrompt[]>
  answer(id: number, allow: boolean): Promise<void>
  list(app?: string): Promise<PermissionDecision[]>
  revoke(app: string, capability: string): Promise<boolean>
  on(type: 'prompt', handler: (event: PermissionPrompt & { type: 'permissionprompt' }) => void): () => boolean
  on(type: 'answered', handler: (event: { type: 'permissionanswered'; id: number; app: string; capability: string; allowed: boolean }) => void): () => boolean
}

interface PermissionPrompt {
  id: number
  app: string
  label: string
  capability: string
  reason: 'request'
}

interface PermissionDecision {
  app: string
  label: string | null
  capability: string
  decision: 'granted' | 'denied'
  folder?: { label: string; exists: boolean }
}
```

A prompt's `capability` is `camera`, `microphone` or `idleDetection`, the only capabilities that ask; in a decision it can also be `fs.folder-…`, a folder the user picked for the app (with `folder`). `revoke` resolves to `false` when there was no decision. Every prompt comes on first use, with `reason: 'request'`. See [Desktops](../guide/desktop.md#camera-and-microphone-prompts).

## acde:inspect

Shell module, also given to desktop services as `ctx.inspect`. Turns the screen into a text semantic tree and acts on it by ref; meant for AI agents. `acdev inspect` / `acdev act` and MCP are built on it.

```ts
interface AcdeInspect {
  snapshot(options?: {
    window?: string; ref?: string; all?: boolean; diff?: boolean
    limit?: number; find?: string; tree?: boolean; offscreen?: boolean
  }): Promise<{ text: string; windows: InspectWindow[]; trees: Record<string, InspectNode[]> }>
  act(ref: string, action: InspectAction, arg?: string | number | readonly string[] | null): Promise<{ ok: boolean; text: string }>
  run(steps: readonly { ref: string; action: InspectAction; text?: InspectArg }[]): Promise<{ ok: boolean; text: string }>
  open(name: string): Promise<{ ok: boolean; text: string }>
  query(options: { selector: string; window?: string; ref?: string; limit?: number; attributes?: readonly string[] }): Promise<{ window: string; count: number; nodes: InspectMatch[] }>
}

type InspectAction = 'click' | 'double' | 'right' | 'hover' | 'drag' | 'type' | 'settext' | 'select' | 'key' | 'scroll' | 'focus' | 'close' | 'minimize' | 'restore' | 'fill' | 'fullscreen'
```

Window refs are `w0` (the desktop), `w1`, ...; element refs look like `w3.12`. The text form has one node per line:

```text
- button "New Folder" [pressed] [w1.52]
```

## acde:office

Linux only. An editing service for office documents (text, spreadsheets, presentations), used by Dopame's bundled office apps; the API is still subject to change.
