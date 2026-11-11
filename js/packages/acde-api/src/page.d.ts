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

/** A window of the desk: an acde app's or any other client's, all alike. `appId`: the app's id (an acde app's manifest id, or the client's own). */
export interface DeskWindow {
  readonly id: number
  readonly appId: string | null
  readonly title: string | null
}

export type WindowsEventType = 'open' | 'close' | 'title' | 'fullscreen' | 'unfullscreen' | 'minimize' | 'activate' | 'minsize' | 'parent' | 'menus' | 'crash' | 'hang' | 'responsive' | 'attention' | 'ready' | 'show' | 'animated'

export interface WindowsEvent {
  readonly type: string
  readonly window: number
  readonly [field: string]: unknown
}

export interface AcdeWindows {
  on(type: WindowsEventType, handler: (event: WindowsEvent) => void): () => boolean
  list(): DeskWindow[]
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

/** An app that opens a file: an app of the installed packages. */
export interface OpenHandler {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly default: boolean
}

export interface AcdeOpenFiles {
  openPath(path: string, options?: { app?: string; select?: boolean }): Promise<{ app: string; window: number }>
  handlers(path: string): Promise<{ mime: string; handlers: OpenHandler[] }>
  setDefault(mime: string, app: string): Promise<string>
}

export interface AcdeApps extends AcdeOpenFiles {
  on?(type: 'changed', handler: (event: { readonly apps?: readonly DesktopApp[] }) => void): () => boolean
  list(): Promise<DesktopApp[]>
  launch(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  open(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  refresh(): Promise<DesktopApp[]>
  install(dir: string): Promise<{ id: string; dir: string; apps: DesktopApp[] }>
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
  readonly kind: 'desktop' | 'window'
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

export interface SystemInfo {
  readonly hostname: string
  readonly os: string
  readonly kernel: string
  readonly cpu: string
  readonly cores: number
  readonly memory: number
  readonly gpu: readonly string[]
  readonly npu: string | null
  readonly uptimeSeconds: number
  readonly serial: string | null
}
export interface SystemVolume {
  readonly path: string
  readonly label: string
  readonly size: number
  readonly free: number
}
export interface SystemTime {
  readonly timezone: string
  readonly ntp: boolean
  readonly canSetTime: boolean
}
export interface SystemUser {
  readonly name: string
  readonly fullName: string
  readonly avatar: string | null
}
export interface AcdeSystem {
  info(): Promise<SystemInfo>
  storage(): Promise<SystemVolume[]>
  time(): Promise<SystemTime>
  timezones(): Promise<string[]>
  setTimezone(zone: string): Promise<void>
  setNtp(on: boolean): Promise<void>
  setHostname(name: string): Promise<void>
  user(): Promise<SystemUser>
  on(type: 'changed', handler: (what: 'time' | 'storage' | 'user' | 'info') => void): () => void
}

export interface DisplayMode {
  readonly width: number
  readonly height: number
  readonly refresh: number
  readonly preferred?: boolean
}
export interface Display {
  readonly id: string
  readonly name: string
  readonly builtin: boolean
  readonly primary: boolean
  readonly enabled: boolean
  readonly mode: DisplayMode
  readonly modes: readonly DisplayMode[]
  readonly scale: number
  readonly scales: readonly number[]
  readonly brightness: number | null
  readonly rotation: 0 | 90 | 180 | 270
}
export interface NightLight {
  readonly on: boolean
  readonly warmth: number
  readonly schedule: 'manual' | 'sunset'
}
export interface DisplayState {
  readonly displays: readonly Display[]
  readonly nightLight: NightLight | null
}
export interface DisplayPatch {
  readonly mode?: DisplayMode
  readonly scale?: number
  readonly rotation?: Display['rotation']
  readonly primary?: boolean
  readonly enabled?: boolean
}
export interface AcdeDisplay {
  state(): Promise<DisplayState>
  configure(id: string, patch: DisplayPatch): Promise<void>
  setBrightness(id: string, value: number): Promise<void>
  setNightLight(patch: Partial<NightLight>): Promise<void>
  on(type: 'changed', handler: (state: DisplayState) => void): () => boolean
}
export interface AudioPort {
  readonly id: string
  readonly name: string
  readonly available: boolean | null
}
export interface AudioDevice {
  readonly id: string
  readonly name: string
  readonly port: 'speaker' | 'headphones' | 'hdmi' | 'bluetooth' | 'usb' | 'mic' | 'other'
  readonly isDefault: boolean
  readonly volume: number
  readonly muted: boolean
  readonly balance: number | null
  readonly ports: readonly AudioPort[]
  readonly activePort: string | null
  readonly card: string | null
  readonly virtual: boolean
}
export interface AudioStream {
  readonly id: string
  readonly kind: 'playback' | 'capture'
  readonly app: string
  readonly title: string
  readonly icon: string
  readonly volume: number
  readonly muted: boolean
  readonly balance: number | null
  readonly device: string | null
}
export interface AudioCard {
  readonly id: string
  readonly name: string
  readonly icon: string
  readonly bus: string
  readonly profile: string | null
  readonly profiles: readonly { readonly id: string; readonly name: string; readonly available: boolean | null }[]
}
export interface AudioState {
  readonly outputs: readonly AudioDevice[]
  readonly inputs: readonly AudioDevice[]
  readonly streams: readonly AudioStream[]
  readonly cards: readonly AudioCard[]
  readonly maxVolume: number
}
export interface AcdeAudio {
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

export interface KeyboardLayout {
  readonly layout: string
  readonly variant: string
}
export interface InputKeyboard {
  readonly layouts: readonly KeyboardLayout[]
  readonly model: string
  readonly options: readonly string[]
  readonly repeat: boolean
  readonly repeatDelay: number
  readonly repeatRate: number
  readonly numlock: 'on' | 'off' | 'unchanged'
  readonly active: readonly string[]
  readonly current: number
}
export interface InputPointer {
  readonly present: boolean
  readonly speed: number
  readonly acceleration: 'adaptive' | 'flat'
  readonly leftHanded: boolean
  readonly naturalScroll: boolean
  readonly scrollSpeed: number
  readonly middleEmulation: boolean
}
export type TouchpadScroll = 'two-finger' | 'edge' | 'button' | 'none'
export type TouchpadClick = 'areas' | 'fingers'
export interface InputTouchpad extends InputPointer {
  readonly tapToClick: boolean
  readonly tapAndDrag: boolean
  readonly dragLock: boolean
  readonly tapButtons: 'lrm' | 'lmr'
  readonly disableWhileTyping: boolean
  readonly scroll: TouchpadScroll
  readonly click: TouchpadClick
  readonly scrollMethods: readonly TouchpadScroll[]
  readonly clickMethods: readonly TouchpadClick[]
}
export interface InputState {
  readonly keyboard: InputKeyboard
  readonly mouse: InputPointer
  readonly touchpad: InputTouchpad
  readonly devices: readonly { readonly name: string; readonly kind: 'mouse' | 'touchpad' }[]
}
type Settable<T> = { readonly [K in keyof T]?: T[K] | null }
export interface InputPatch {
  readonly keyboard?: Settable<Omit<InputKeyboard, 'active' | 'current'>>
  readonly mouse?: Settable<Omit<InputPointer, 'present'>>
  readonly touchpad?: Settable<Omit<InputTouchpad, 'present' | 'scrollMethods' | 'clickMethods'>>
}
export interface InputCatalog {
  readonly models: readonly { readonly id: string; readonly name: string; readonly vendor: string }[]
  readonly layouts: readonly {
    readonly id: string
    readonly name: string
    readonly short: string
    readonly languages: readonly string[]
    readonly variants: readonly { readonly id: string; readonly name: string }[]
  }[]
  readonly options: readonly {
    readonly id: string
    readonly name: string
    readonly multiple: boolean
    readonly options: readonly { readonly id: string; readonly name: string }[]
  }[]
}
export interface AcdeInput {
  state(): Promise<InputState | null>
  catalog(): Promise<InputCatalog>
  set(patch: InputPatch): Promise<void>
  on(type: 'changed', handler: (state: InputState) => void): () => boolean
}

export type PowerProfile = 'power-saver' | 'balanced' | 'performance'
export type PowerAction = 'none' | 'sleep' | 'hibernate' | 'shutdown' | 'prompt' | 'lock' | 'screen-off'
export type PowerIdleAction = 'none' | 'sleep' | 'hibernate' | 'shutdown'
export interface ChargeLimit {
  readonly start: number | null
  readonly end: number | null
  readonly writable: boolean
  readonly upower: boolean
}
export interface PowerBattery {
  readonly id: string
  readonly name: string
  readonly percent: number
  readonly state: 'charging' | 'discharging' | 'full' | 'empty' | 'unknown'
  readonly secondsLeft: number | null
  readonly health: number | null
  readonly rate: number | null
  readonly chargeLimit: ChargeLimit | null
}
export interface PowerPolicy {
  readonly dim: number | null
  readonly screenOff: number | null
  readonly idleAction: PowerIdleAction
  readonly idleAfter: number
  readonly lidAction: PowerAction
  readonly lidExternal: boolean
  readonly powerButton: PowerAction
  readonly sleepMode: 'suspend' | 'hybrid' | 'suspend-then-hibernate'
  readonly profile: PowerProfile | null
  readonly brightness: number | null
}
export type PowerGroup = 'ac' | 'battery' | 'lowBattery'
export interface PowerSettings {
  readonly ac: PowerPolicy
  readonly battery: PowerPolicy
  readonly lowBattery: PowerPolicy
  readonly lowLevel: number
  readonly criticalLevel: number
  readonly criticalAction: PowerIdleAction
}
export type PowerSettingsPatch = { readonly [G in PowerGroup]?: Partial<PowerPolicy> } & Partial<Pick<PowerSettings, 'lowLevel' | 'criticalLevel' | 'criticalAction'>>
export interface PowerState {
  readonly onBattery: boolean
  readonly battery: PowerBattery | null
  readonly batteries: readonly PowerBattery[]
  readonly lid: boolean
  readonly profile: PowerProfile | null
  readonly profiles: readonly PowerProfile[]
  readonly degraded: string | null
  readonly screenOffSeconds: number | null
  readonly sleepSeconds: number | null
  readonly current: PowerGroup
  readonly settings: PowerSettings
  readonly can: { readonly suspend: boolean; readonly hibernate: boolean; readonly hybrid: boolean; readonly suspendThenHibernate: boolean }
  readonly brightness: number | null
  readonly inhibitors: readonly { readonly who: string; readonly why: string; readonly what: readonly ('sleep' | 'idle')[] }[]
  readonly policy: boolean
}
export interface AcdePower {
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
  on(type: 'prompt', handler: (event: { readonly type: 'prompt' }) => void): () => boolean
  on(type: 'critical', handler: (event: { readonly type: 'critical'; readonly action: PowerIdleAction; readonly seconds: number }) => void): () => boolean
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
  readonly system?: AcdeSystem
  readonly display?: AcdeDisplay
  readonly audio?: AcdeAudio
  readonly input?: AcdeInput
  readonly power?: AcdePower
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
