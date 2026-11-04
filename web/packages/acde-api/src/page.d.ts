export interface FinderRoot {
  path: string
  label: string
  source: 'desktop' | 'downloads' | 'default' | 'task'
  mode: RootMode
  reason: string | null
  exists: boolean
}

export type RootMode = 'writable' | 'read_only' | 'unavailable'

export type EntryKind = 'directory' | 'file' | 'symlink' | 'other'

export interface FinderEntry {
  name: string
  kind: EntryKind
  size: number
  modifiedMs: number
  target?: string
}

export interface FinderPreview {
  path: string
  name: string
  size: number
  modifiedMs: number
  kind: 'text' | 'image' | 'binary' | 'too_large'
  content?: string
  truncated?: boolean
}

export interface FileBytes {
  readonly name: string
  readonly contentType: string
  readonly data: Uint8Array
}

export interface AcdeFs {
  state(): Promise<{ roots: FinderRoot[]; root: string | null; path: string; entries: FinderEntry[]; truncated: boolean; preview: FinderPreview | null; error: string | null }>
  roots(): Promise<FinderRoot[]>
  desktop(): Promise<{ root: string; entries: FinderEntry[]; truncated: boolean }>
  list(root: string, path?: string, hidden?: boolean): Promise<{ root: FinderRoot; path: string; entries: FinderEntry[]; truncated: boolean }>
  preview(root: string, path: string): Promise<FinderPreview>
  download(root: string, path: string): Promise<FileBytes>
  place(root: string, path?: string, file?: string): Promise<unknown>
  mkdir(root: string, path: string): Promise<FinderEntry>
  write(root: string, path: string, content: string, expectedModifiedMs: string): Promise<FinderEntry>
  copyIn?(root: string, dir: string, source: string): Promise<FinderEntry>
  rename(root: string, from: string, to: string): Promise<FinderEntry>
  delete(root: string, path: string): Promise<{ status: 'deleted'; path: string }>
  locate(path: string): Promise<{ root: string; path: string }>
  openPath(root: string, path: string): Promise<{ root: string; path: string; file: string }>
}

export interface AcdeOffice {
  server(): Promise<unknown>
  state(root?: string, dir?: string, path?: string): Promise<unknown>
  status(key: string): Promise<unknown>
  save(body: { key: string }): Promise<{ result: 'requested' | 'no_changes' }>
  'new'(body: { root: string; kind: string; dir?: string; name?: string }): Promise<{ path: string }>
  editorPage(setup: { api: string; config: unknown }, theme: 'light' | 'dark'): Promise<string>
}

export interface NativeWindow {
  readonly id: number
  readonly appId: string | null
  readonly title: string | null
  readonly web?: boolean
}

export type WindowsEventType = 'open' | 'close' | 'title' | 'fullscreen' | 'unfullscreen' | 'minimize' | 'activate' | 'minsize' | 'parent' | 'menus' | 'crash' | 'hang' | 'responsive' | 'attention' | 'ready' | 'show' | 'animated'

export interface WindowsEvent {
  readonly type: string
  readonly window: number
  readonly [field: string]: unknown
}

export interface AcdeWindows {
  on(type: WindowsEventType, handler: (event: WindowsEvent) => void): () => boolean
  list(): NativeWindow[]
  launch(argv: string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): number | Promise<number>
  close(id: number): void
  kill?(id: number): Promise<boolean>
  focus?(id: number): Promise<void>
  hide?(id: number): Promise<void>
  show?(id: number): Promise<void>
  invokeMenu?(id: number, menu: string, item: string): Promise<unknown>
  stats?(): Promise<unknown>
  animate?(id: number, options: { opacity?: number; scale?: number; dx?: number; dy?: number; duration?: number; delay?: number; easing?: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' }): Promise<void>
  shortcut?(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  unshortcut?(combo: string, scope?: 'session' | 'desktop'): Promise<void>
}

export type TerminalEvent = { type: 'output'; data: string } | { type: 'cwd'; path: string } | { type: 'exit'; code: number | null; signal: number | null }

export interface AcdeTerminals {
  open(cols: number, rows: number): Promise<{ id: string }>
  subscribe(id: string, callback: (events: TerminalEvent[]) => void): Promise<void>
  input(id: string, data: string): Promise<{ ok: true }>
  resize(id: string, cols: number, rows: number): Promise<{ cols: number; rows: number }>
  close(id: string): Promise<{ closed: string }>
}

export interface DesktopApp {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly script: string
}

export interface OpenHandler {
  readonly kind: 'acde' | 'native'
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly default: boolean
}

export interface AcdeOpenFiles {
  openPath(path: string, options?: { app?: string; select?: boolean }): Promise<{ kind: 'acde' | 'native'; id: string; window?: number }>
  handlers(path: string): Promise<{ mime: string; handlers: OpenHandler[] }>
  setDefault(mime: string, handler: string): Promise<string>
}

export interface NativeApp {
  readonly id: string
  readonly name: string
  readonly comment: string | null
  readonly icon: string
  readonly keywords: readonly string[]
  readonly wmClass: string | null
}

export interface AcdeApps extends AcdeOpenFiles {
  on?(type: 'changed', handler: (event: { readonly apps?: readonly DesktopApp[] }) => void): () => boolean
  list(): Promise<DesktopApp[]>
  launch(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  open(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  refresh(): Promise<DesktopApp[]>
  install(dir: string): Promise<{ id: string; dir: string; apps: DesktopApp[] }>
  natives(): Promise<NativeApp[]>
  runNative(id: string): Promise<number>
}

export interface DesktopInfo {
  readonly kind: 'acde' | 'session'
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly package: string | null
}

export interface AcdeDesktops {
  list(): Promise<{ desktops: DesktopInfo[]; current: string }>
  choose(id: string, remember?: boolean): Promise<void>
}

export interface AcdeSession {
  own(): boolean
  logout(): Promise<void>
  reboot(): Promise<void>
  poweroff(): Promise<void>
  setLanguage(tag: string): Promise<void>
}

export interface InspectNode {
  readonly ref: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly states?: readonly string[]
  readonly level?: number
  readonly rect?: readonly [number, number, number, number]
  readonly more?: number
  readonly children?: readonly InspectNode[]
}

export interface InspectWindow {
  readonly ref: string
  readonly id: number
  readonly kind: 'desktop' | 'web' | 'native'
  readonly app: string | null
  readonly title: string | null
  readonly mode: string
  readonly rect: readonly [number, number, number, number]
  readonly z: number
  readonly focus: boolean
  readonly hidden: boolean
  readonly pid: number | null
}

export type InspectAction = 'click' | 'double' | 'right' | 'hover' | 'type' | 'settext' | 'key' | 'scroll' | 'focus' | 'close' | 'minimize' | 'restore'

export interface AcdeInspect {
  snapshot(options?: { window?: string; ref?: string; all?: boolean; diff?: boolean; limit?: number; find?: string; tree?: boolean }): Promise<{ text: string; windows: InspectWindow[]; trees: Record<string, InspectNode[]> }>
  act(ref: string, action: InspectAction, arg?: string | number | null): Promise<{ ok: boolean; text: string }>
  run(steps: readonly { ref: string; action: InspectAction; text?: string | number | null }[]): Promise<{ ok: boolean; text: string }>
  open(name: string): Promise<{ ok: boolean; text: string }>
}

export interface AppMenuItem {
  readonly id: string
  readonly label: string
  readonly shortcut?: string
  readonly checked?: boolean
  readonly disabled?: boolean
  onSelect?(): void | Promise<void>
}

export interface AppMenu {
  readonly id: string
  readonly label: string
  readonly items: readonly ({ readonly type: 'separator' } | AppMenuItem)[]
}

export interface WindowHost {
  setTitle(title: string): void
  setMenus(menus: readonly AppMenu[]): void
}

export interface NotificationEvent {
  readonly type: 'notification'
  readonly window: number
  readonly app: string | null
  readonly label: string | null
  readonly title: string
  readonly body: string
  readonly icon: string
  readonly tag: string
}

export interface DownloadEvent {
  readonly type: 'download'
  readonly window: number
  readonly app: string | null
  readonly path: string
  readonly name: string
  readonly size: number
}

export interface WindowApp {
  mount(element: Element, host: WindowHost): () => void
}

export type WindowEventName = 'activate' | 'deactivate' | 'beforeclose' | 'request' | 'suspend' | 'resume' | 'grab' | 'grablost'

export type WindowMode = 'fullscreen' | 'free' | 'fixed' | 'pinned'
export type WindowEdge = 'top' | 'bottom' | 'left' | 'right'
export interface WindowRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface AcdeWindow {
  readonly host: WindowHost
  mount(app: WindowApp): void
  setTitle(title: string): void
  setMenus(menus: readonly AppMenu[]): void
  close(): Promise<unknown>
  minimize(): Promise<unknown>
  requestAttention(): Promise<unknown>
  requestMode(mode: WindowMode): void
  setGrabHint(rect: WindowRect, edges?: readonly WindowEdge[]): void
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
  on(name: WindowEventName, handler: (value?: unknown) => unknown): () => boolean
}

export interface NetworkDevice {
  readonly iface: string
  readonly type: 'wifi' | 'ethernet'
  readonly state: 'connected' | 'connecting' | 'disconnecting' | 'disconnected' | 'unavailable' | 'unmanaged' | 'failed'
  readonly connection: string | null
  readonly ip4: string | null
  readonly ssid?: string
  readonly strength?: number
  readonly carrier?: boolean
  readonly speed?: number
}
export interface NetworkState {
  readonly wifiEnabled: boolean
  readonly connectivity: 'full' | 'limited' | 'portal' | 'none' | 'unknown'
  readonly primary: 'wifi' | 'ethernet' | string | null
  readonly devices: NetworkDevice[]
}
export interface WifiNetwork {
  readonly ssid: string
  readonly strength: number
  readonly secure: boolean
  readonly band: '2.4GHz' | '5GHz'
  readonly active: boolean
  readonly saved: boolean
}
export interface AcdeNetwork {
  state(): Promise<NetworkState>
  networks(scan?: boolean): Promise<WifiNetwork[]>
  connect(ssid: string, password?: string): Promise<void>
  activate(iface: string): Promise<void>
  disconnect(iface: string): Promise<void>
  setWifiEnabled(on: boolean): Promise<void>
  watch(callback: (state: NetworkState) => void): void
}

export interface PinnedPanel {
  update(): void
  unpin(): void
}

export interface AcdeDesktop {
  apps(): Promise<{ apps: DesktopApp[] }>
  pin?(element: Element, options?: { margin?: number }): PinnedPanel
  on(type: 'download', handler: (event: DownloadEvent) => void): () => boolean
  on(type: 'notification', handler: (event: NotificationEvent) => void): () => boolean
  on(type: 'screenshot', handler: (event: { readonly path: string; readonly width?: number; readonly height?: number; readonly error?: string }) => void): () => boolean
  on(type: 'shortcut', handler: (event: { readonly key: string; readonly title?: string; readonly window?: number }) => void): () => boolean
}

export interface AcdePage {
  readonly fs?: AcdeFs
  readonly office?: AcdeOffice
  readonly terminal?: AcdeTerminals
  readonly network?: AcdeNetwork
  readonly windows?: AcdeWindows
  readonly apps?: AcdeApps
  readonly desktop?: AcdeDesktop
  readonly desktops?: AcdeDesktops
  readonly session?: AcdeSession
  readonly inspect?: AcdeInspect
  readonly open?: (app: string, request?: Record<string, unknown> | null) => Promise<{ window: number }>
  readonly openPath?: AcdeOpenFiles['openPath']
  readonly handlers?: AcdeOpenFiles['handlers']
  readonly setDefault?: AcdeOpenFiles['setDefault']
  readonly window?: AcdeWindow
  readonly [service: string]: unknown
}
