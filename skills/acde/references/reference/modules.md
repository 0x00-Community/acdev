# acde: modules

Every module has both named exports and a default export:

```js
import { fs } from 'acde:fs'
import fs from 'acde:fs'
```

Types are in `@dopame/acde-api`. For who can import what, see [Capabilities](../guide/capabilities.md).

| Module | App | Desktop |
| --- | --- | --- |
| `acde:window` | ✓ | |
| `acde:fs` | `fs` | ✓ |
| `acde:terminal` | `terminal` | ✓ |
| `acde:network` | `network` | ✓ |
| `acde:office` | `office` | ✓ |
| `acde:open` | ✓ (opening needs `open`) | ✓ |
| `acde:openPath` `acde:handlers` `acde:setDefault` | `openFiles` | On `acde:apps` |
| `acde:windows` | Only native programs it launched itself (`launch` / `slots`) | All windows |
| `acde:session` | `session` | ✓ |
| `acde:desktops` | `desktops` | ✓ |
| `acde:apps` | | ✓ |
| `acde:desktop` | | ✓ |
| `acde:inspect` | | ✓ (and services) |
| `acde:<service>` | Service name | ✓ |

All callbacks and events are subscribed with `on(type, handler)`, which returns an unsubscribe function; unknown event types throw `TypeError`.

## acde:window

```ts
interface AcdeWindow {
  readonly host: WindowHost
  mount(app: WindowApp): void
  setTitle(title: string): void
  setMenus(menus: readonly AppMenu[]): void
  close(): Promise<unknown>
  minimize(): Promise<unknown>
  requestAttention(): Promise<unknown>
  requestMode(mode: 'fullscreen' | 'free' | 'fixed' | 'pinned'): void
  setGrabHint(rect: WindowRect, edges?: readonly ('top' | 'bottom' | 'left' | 'right')[]): void
  setBackdrop(rect: WindowRect | null, effect?: { radius?: number; blur?: number; saturate?: number; brightness?: number }): void
  requestActivate(): void
  requestGrab(kind: 'pointer' | 'keyboard'): void
  releaseGrab(kind: 'pointer' | 'keyboard'): void
  shortcut(combo: string): Promise<void>
  unshortcut(combo: string): Promise<void>
  on(name: 'beforeclose', handler: () => boolean | void | Promise<boolean | void>): () => boolean
  on(name: 'request', handler: (request: Record<string, unknown>) => void): () => boolean
  on(name: 'suspend', handler: () => unknown): () => boolean
  on(name: 'resume', handler: (state: unknown) => void): () => boolean
  on(name: 'activate' | 'deactivate', handler: () => void): () => boolean
  on(name: 'shortcut', handler: (event: { readonly key: string }) => void): () => boolean
  on(name: 'grab' | 'grablost', handler: (value?: unknown) => unknown): () => boolean
}

interface WindowRect { x: number; y: number; width: number; height: number }

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

Coordinates are logical pixels of the page (the content area). Shortcut combos are written like `ctrl+alt+t`: keys are xkb keysym names, and Shift is part of the combo.

## acde:fs

```ts
interface AcdeFs {
  roots(): Promise<FinderRoot[]>
  list(root: string, path?: string, hidden?: boolean): Promise<{ root: FinderRoot; path: string; entries: FinderEntry[]; truncated: boolean }>
  stat(root: string, path: string): Promise<FinderEntry & { path: string }>
  readText(root: string, path: string): Promise<{ text: string; modifiedMs: number; size: number }>
  readBytes(root: string, path: string): Promise<{ data: Uint8Array; modifiedMs: number; size: number }>
  writeFile(root: string, path: string, data: string | Uint8Array, options?: {
    create?: 'always' | 'new' | 'never'
    ifModifiedMs?: number
    mkdirs?: boolean
  }): Promise<FinderEntry>
  mkdir(root: string, path: string, options?: { recursive?: boolean }): Promise<FinderEntry>
  rename(root: string, from: string, to: string): Promise<FinderEntry>
  delete(root: string, path: string): Promise<{ status: 'deleted'; path: string }>
  copyIn?(root: string, dir: string, source: string): Promise<FinderEntry>
  preview(root: string, path: string): Promise<FinderPreview>
  download(root: string, path: string): Promise<{ name: string; contentType: string; data: Uint8Array }>
  locate(path: string): Promise<{ root: string; path: string }>
  openPath(root: string, path: string): Promise<{ root: string; path: string; file: string }>
  revoke(rootPath: string): Promise<void>
}

interface FinderRoot {
  path: string
  label: string
  source: 'desktop' | 'downloads' | 'default' | 'task' | 'granted'
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

Limits: `readText` / `readBytes` 64 MiB; `preview` text 256 KiB. For error codes, see [Files and folders](../guide/files.md#errors).

## acde:open

```ts
function open(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
```

## acde:openPath / acde:handlers / acde:setDefault

```ts
function openPath(path: string, options?: { app?: string; select?: boolean }): Promise<{ kind: 'acde' | 'native'; id: string; window?: number }>
function handlers(path: string): Promise<{ mime: string; handlers: OpenHandler[] }>
function setDefault(mime: string, handler: string): Promise<string>

interface OpenHandler {
  kind: 'acde' | 'native'
  id: string
  label: string
  icon: string
  default: boolean
}
```

`path` can be a path or a URI.

## acde:terminal

macOS / Linux only.

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

Dopame OS only (Linux, NetworkManager).

```ts
interface AcdeNetwork {
  state(): Promise<NetworkState>
  networks(scan?: boolean): Promise<WifiNetwork[]>
  connect(ssid: string, password?: string): Promise<void>
  activate(iface: string): Promise<void>
  disconnect(iface: string): Promise<void>
  setWifiEnabled(on: boolean): Promise<void>
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

## acde:session

```ts
interface AcdeSession {
  own(): boolean
  logout(): Promise<void>
  reboot(): Promise<void>
  poweroff(): Promise<void>
  setLanguage(tag: string): Promise<void>
}
```

`own()`: whether this is a real Dopame OS session (`false` in the host window of `acde dev`). After `setLanguage`, pages receive `languagechange`.

## acde:desktops

```ts
interface AcdeDesktops {
  list(): Promise<{ desktops: DesktopInfo[]; current: string }>
  choose(id: string, remember?: boolean): Promise<void>
}

interface DesktopInfo {
  kind: 'acde' | 'session'
  id: string
  name: string
  description: string | null
  package: string | null
}
```

`kind: 'session'` is another Wayland session on the system (GNOME, KDE, ...).

## acde:apps

Desktop only.

```ts
interface AcdeApps {
  list(): Promise<DesktopApp[]>
  launch(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  open(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  refresh(): Promise<DesktopApp[]>
  install(dir: string): Promise<{ id: string; dir: string; apps: DesktopApp[] }>
  natives(): Promise<NativeApp[]>
  runNative(id: string): Promise<number>
  openPath(...): ...   // same as acde:openPath
  handlers(...): ...
  setDefault(...): ...
  on(type: 'changed', handler: (event: { apps?: DesktopApp[] }) => void): () => boolean
}

interface DesktopApp { id: string; label: string; icon: string; script: string }

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

Desktops get everything; apps can only use `list` / `launch` / `close` to manage native programs they launched themselves.

```ts
interface AcdeWindows {
  on(type: WindowsEventType, handler: (event: { type: string; window: number; [field: string]: unknown }) => void): () => boolean
  list(): NativeWindow[]
  launch(argv: string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): number | Promise<number>
  close(id: number): void
  // desktop only:
  kill(id: number): Promise<boolean>
  focus(id: number): Promise<void>
  hide(id: number): Promise<void>
  show(id: number): Promise<void>
  invokeMenu(id: number, menu: string, item: string): Promise<unknown>
  stats(): Promise<unknown>
  animate(id: number, options: {
    opacity?: number; scale?: number; dx?: number; dy?: number
    duration?: number; delay?: number
    easing?: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
  }): Promise<void>
  shortcut(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  unshortcut(combo: string, scope?: 'session' | 'desktop'): Promise<void>
}

interface NativeWindow { id: number; appId: string | null; title: string | null; web?: boolean }
```

`WindowsEventType`: `open` `close` `title` `fullscreen` `unfullscreen` `minimize` `activate` `minsize` `parent` `menus` `crash` `hang` `responsive` `attention` `ready` `show` `animated`.

## acde:desktop

Desktop only.

```ts
interface AcdeDesktop {
  apps(): Promise<{ apps: DesktopApp[] }>
  pin(element: Element, options?: { margin?: number }): { update(): void; unpin(): void }
  on(type: 'notification', handler: (e: NotificationEvent) => void): () => boolean
  on(type: 'download', handler: (e: DownloadEvent) => void): () => boolean
  on(type: 'screenshot', handler: (e: { path: string; width?: number; height?: number; error?: string }) => void): () => boolean
  on(type: 'shortcut', handler: (e: { key: string; title?: string; window?: number }) => void): () => boolean
}

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

## acde:inspect

Desktops and desktop services only. Turns the screen into a text semantic tree and acts on it by ref; meant for AI agents. `acde inspect` / `acde act` and MCP are built on it.

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

type InspectAction = 'click' | 'double' | 'right' | 'hover' | 'drag' | 'type' | 'settext' | 'select' | 'key' | 'scroll' | 'focus' | 'close' | 'minimize' | 'restore'
```

Window refs are `w0` (the desktop), `w1`, ...; element refs look like `w3.12`. The text form has one node per line:

```text
- button "New Folder" [pressed] [w1.52]
```

## acde:office

Linux only. An editing service for office documents (text, spreadsheets, presentations), used by Dopame's bundled office apps; the API will change.
