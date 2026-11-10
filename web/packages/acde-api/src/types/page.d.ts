import type { AppsChangedEvent, DesktopEventMap, ShortcutEvent, TerminalEvent, WindowGrabEvent, WindowGrabLostEvent, WindowsEvents } from './events'
import type { AcdeOffice } from './office'
import type { AcdePermissions } from './permissions'
import type { SharedPlace } from '../runtime/places'

export type * from './events'
export type * from './office'
export type * from './permissions'

export interface FinderRoot {
  id: string
  path?: string
  label: string
  source: 'desktop' | 'downloads' | 'default' | 'task' | 'granted' | 'private' | 'place'
  place?: SharedPlace
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

export type AcdeFsErrorCode =
  | 'EINVAL'
  | 'EACCES'
  | 'ENOENT'
  | 'EEXIST'
  | 'ECONFLICT'
  | 'ENOTEMPTY'
  | 'EFBIG'
  | 'EILSEQ'
  | 'ENOSPC'
  | 'EIO'

export interface AcdeFsError extends Error {
  readonly status: number
  readonly code: AcdeFsErrorCode
}

export interface FinderStat extends FinderEntry {
  path: string
}

export interface FileText {
  readonly text: string
  readonly modifiedMs: number
  readonly size: number
}

export interface FileData {
  readonly data: Uint8Array
  readonly modifiedMs: number
  readonly size: number
}

export interface WriteFileOptions {
  ifModifiedMs?: number
  create?: 'new' | 'always' | 'never'
  mkdirs?: boolean
}

export interface MkdirOptions {
  recursive?: boolean
}

export interface AcdeFs {
  roots(): Promise<FinderRoot[]>
  list(
    root: string,
    path?: string,
    hidden?: boolean,
  ): Promise<{ root: FinderRoot; path: string; entries: FinderEntry[]; truncated: boolean }>
  preview(root: string, path: string): Promise<FinderPreview>
  download(root: string, path: string): Promise<FileBytes>
  mkdir(root: string, path: string, options?: MkdirOptions): Promise<FinderEntry>
  stat(root: string, path: string): Promise<FinderStat>
  readText(root: string, path: string): Promise<FileText>
  readBytes(root: string, path: string): Promise<FileData>
  writeFile(root: string, path: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<FinderEntry>
  copy(fromRoot: string, fromPath: string, toRoot: string, toDir: string): Promise<FinderEntry & { path: string }>
  rename(root: string, from: string, to: string): Promise<FinderEntry>
  delete(root: string, path: string): Promise<{ status: 'deleted'; path: string }>
  locate(path: string): Promise<{ root: string; path: string }>
  openPath(root: string, path: string): Promise<{ root: string; path: string; file: string }>
  revoke(rootPath: string): Promise<void>
}

export interface NativeWindow {
  readonly id: number
  readonly appId: string | null
  readonly title: string | null
  readonly web?: boolean
  readonly state?: WindowState
}

export interface AcdeWindows extends WindowsEvents {
  list(): NativeWindow[]
  launch(
    argv: string[],
    options?: { cwd?: string; env?: Record<string, string>; slot?: boolean },
  ): number | Promise<number>
  close(id: number): void
  requestState?(id: number, state: WindowState): Promise<void>
  kill?(id: number): Promise<boolean>
  focus?(id: number): Promise<void>
  hide?(id: number): Promise<void>
  show?(id: number): Promise<void>
  invokeMenu?(id: number, menu: string, item: string): Promise<void>
  stats?(): Promise<Readonly<Record<string, number>>>
  /**
   * Plays a short animation on a window. Where the runtime cannot animate, the
   * animation may complete at once; its completion event `windowanimated`
   * (`on('animated')`) still fires.
   */
  animate?(
    id: number,
    options: {
      opacity?: number
      scale?: number
      dx?: number
      dy?: number
      duration?: number
      delay?: number
      easing?: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
    },
  ): Promise<void>
  shortcut?(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  unshortcut?(combo: string, scope?: 'session' | 'desktop'): Promise<void>
}

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
  /** An acde app id; a native program's desktop entry (`x.desktop`), or on Windows its registered name (a path or a packaged app id). */
  readonly id: string
  readonly label: string
  /** An icon name or URL; Windows programs give a `data:image/png` URL, or `''`. */
  readonly icon: string
  /** The app `openPath` uses for this file when none is named (the user's remembered choice, else the first that fits). */
  readonly default: boolean
  /** Windows: this program is the system's own default for the file's extension (read, never changed by acde). */
  readonly system?: boolean
}

export interface AcdeOpenFiles {
  openPath(
    path: string,
    options?: { app?: string; select?: boolean },
  ): Promise<{ kind: 'acde' | 'native'; id: string; window?: number }>
  /**
   * The apps that can open a file. `mime` is `''` when the system knows no type for it (Windows); `association` is the key
   * `setDefault` remembers a choice for this file under: the MIME type, or on Windows the file's extension (`.md`).
   */
  handlers(path: string): Promise<{ mime: string; association: string | null; handlers: OpenHandler[] }>
  /** Remembers `handler` for a MIME type, or on Windows for a file extension (`.md`); the system's own default is untouched. */
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

export interface OpenWindowOptions {
  readonly parent?: number
  readonly modal?: boolean
}

export interface OpenFileRequest {
  readonly kind: 'open-file'
  readonly handle?: FileSystemFileHandle | FileSystemDirectoryHandle
  readonly url?: string
  readonly root?: string
  readonly path?: string
  readonly file?: string | null
}

export interface OpenLinkRequest {
  readonly kind: 'open-link'
  readonly url: string
}

export type SystemRequest = OpenFileRequest | OpenLinkRequest

export type AppRequest<K extends string = string, Fields extends object = Record<never, never>> = { readonly kind: K } & {
  readonly [P in keyof Fields]: Fields[P]
}

export type WindowRequest = SystemRequest | AppRequest

export interface Opened {
  readonly kind: 'acde' | 'native'
  readonly id: string
  readonly window?: number
}

export interface AcdeOpen {
  (request: SystemRequest): Promise<Opened>
  (app: string, request: SystemRequest): Promise<Opened>
  <R extends AppRequest>(app: string, request: R, options?: OpenWindowOptions): Promise<{ window: number }>
  (app: string, request?: null, options?: OpenWindowOptions): Promise<{ window: number }>
  /** @deprecated Level 0 request without a kind; removed with level 0. */
  (app: string, request?: Record<string, unknown> | null, options?: OpenWindowOptions): Promise<{ window: number }>
}

export interface AcdeAppList {
  on?(type: 'changed', handler: (event: AppsChangedEvent) => void): () => boolean
  list(): Promise<DesktopApp[]>
  open: AcdeOpen
}

export interface AcdeApps extends AcdeAppList, AcdeOpenFiles {
  launch(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  refresh(): Promise<DesktopApp[]>
  install(dir: string): Promise<{ id: string; dir: string; apps: DesktopApp[] }>
  natives(): Promise<NativeApp[]>
  runNative(id: string): Promise<number>
}

export interface AcdePackages {
  on(type: 'changed', handler: (event: AppsChangedEvent) => void): () => boolean
  refresh(): Promise<DesktopApp[]>
  install(dir: string): Promise<{ id: string; dir: string; apps: DesktopApp[] }>
  natives(): Promise<NativeApp[]>
  runNative(id: string): Promise<number>
}

export interface LaunchOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

export interface AcdeLaunch extends WindowsEvents {
  start(argv: readonly string[], options?: LaunchOptions): Promise<number>
  embed(argv: readonly string[], options?: LaunchOptions): Promise<number>
  close(window: number): Promise<boolean>
  list(): NativeWindow[]
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
  readonly state?: WindowState
  readonly rect: readonly [number, number, number, number]
  readonly z: number
  readonly focus: boolean
  readonly hidden: boolean
  readonly pid: number | null
  readonly parent?: number | null
  readonly modal?: boolean
}

export interface InspectMatch extends InspectNode {
  readonly tag: string
  readonly visible: boolean
  readonly attributes?: Readonly<Record<string, string | null>>
}

export type InspectAction =
  | 'click'
  | 'double'
  | 'right'
  | 'hover'
  | 'drag'
  | 'type'
  | 'settext'
  | 'select'
  | 'key'
  | 'scroll'
  | 'focus'
  | 'close'
  | 'minimize'
  | 'restore'

export type InspectArg = string | number | readonly string[] | null

export interface AcdeInspect {
  snapshot(options?: {
    window?: string
    ref?: string
    all?: boolean
    diff?: boolean
    limit?: number
    find?: string
    tree?: boolean
    offscreen?: boolean
  }): Promise<{ text: string; windows: InspectWindow[]; trees: Record<string, InspectNode[]> }>
  act(ref: string, action: InspectAction, arg?: InspectArg): Promise<{ ok: boolean; text: string }>
  run(
    steps: readonly { ref: string; action: InspectAction; text?: InspectArg }[],
  ): Promise<{ ok: boolean; text: string }>
  open(name: string): Promise<{ ok: boolean; text: string }>
  query(options: {
    selector: string
    window?: string
    ref?: string
    limit?: number
    attributes?: readonly string[]
  }): Promise<{ window: string; count: number; nodes: InspectMatch[] }>
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

export interface WindowApp {
  mount(element: Element, host: WindowHost): () => void
}

export type WindowEventName =
  | 'activate'
  | 'deactivate'
  | 'beforeclose'
  | 'request'
  | 'suspend'
  | 'resume'
  | 'grab'
  | 'grablost'
  | 'state'
  | 'output'
  | 'hostcontrols'
  | 'minimizable'

export type WindowMode = 'free' | 'fixed' | 'pinned'
export type WindowState = 'normal' | 'minimized' | 'filled' | 'fullscreen'
export interface WindowStateEvent {
  readonly state: WindowState
  readonly previous: WindowState
}
export type WindowEdge = 'top' | 'bottom' | 'left' | 'right'
export interface WindowRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowOutput {
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly workArea: WindowRect
}

export interface AcdeWindowError extends Error {
  readonly code: 'unavailable'
  readonly status: 409
}

export interface AcdeWindow {
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
  requestMode(mode: WindowMode | 'fullscreen'): void
  setGrabHint(rect: WindowRect, edges?: readonly WindowEdge[]): void
  /**
   * Blurs what lies behind a part of the window. Where the platform cannot
   * draw the effect exactly, it may be approximated (see
   * `acde:capabilities` `window.backdrop`).
   */
  setBackdrop(
    rect: WindowRect | null,
    effect?: { radius?: number; blur?: number; saturate?: number; brightness?: number },
  ): void
  requestActivate(): void
  requestGrab(kind: 'pointer' | 'keyboard'): void
  releaseGrab(kind: 'pointer' | 'keyboard'): void
  shortcut(combo: string): Promise<void>
  unshortcut(combo: string): Promise<void>
  on(name: 'beforeclose', handler: () => boolean | void | Promise<boolean | void>): () => boolean
  on<R extends AppRequest = AppRequest>(name: 'request', handler: (request: SystemRequest | R) => void): () => boolean
  on(name: 'suspend' | 'resume', handler: () => void): () => boolean
  on(name: 'activate' | 'deactivate', handler: () => void): () => boolean
  on(name: 'grab', handler: (event: WindowGrabEvent) => void): () => boolean
  on(name: 'grablost', handler: (event: WindowGrabLostEvent) => void): () => boolean
  on(name: 'state', handler: (event: WindowStateEvent) => void): () => boolean
  on(name: 'output', handler: (output: WindowOutput) => void): () => boolean
  on(name: 'hostcontrols', handler: (hostControls: boolean) => void): () => boolean
  on(name: 'minimizable', handler: (minimizable: boolean) => void): () => boolean
  on(name: 'shortcut', handler: (event: ShortcutEvent) => void): () => boolean
  /** @deprecated Level 0 untyped request; removed with level 0. */
  on(name: 'request', handler: (request: Record<string, unknown>) => void): () => boolean
  /** @deprecated Level 0 untyped form; removed with level 0. */
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

export interface PanelReserve {
  readonly edge: WindowEdge
  readonly thickness?: number
}

export interface PinOptions {
  readonly margin?: number
  readonly reserve?: PanelReserve
}

export interface PinnedPanel {
  update(): void
  unpin(): void
  reserve(reserve: PanelReserve | null): void
}

export type DoubleClickAction = 'fill' | 'minimize' | 'none'

export interface FrameColors {
  readonly background?: string
  readonly title?: string
  readonly line?: string
  readonly buttons?: string
}

export interface FrameTheme {
  readonly active?: FrameColors
  readonly inactive?: FrameColors
  readonly buttonStyle?: 'dots' | 'glyphs'
  readonly buttonSide?: 'left' | 'right'
  readonly titleAlign?: 'center' | 'start'
}

export interface AcdeDesktop {
  apps(): Promise<{ apps: DesktopApp[] }>
  pin?(element: Element, options?: PinOptions): PinnedPanel
  setDoubleClick?(action: DoubleClickAction): void
  setFrameTheme?(theme: FrameTheme | null): void
  on<K extends keyof DesktopEventMap>(type: K, handler: (event: DesktopEventMap[K]) => void): () => boolean
}

export interface ShellModuleTypes {
  readonly windows: AcdeWindows
  readonly packages: AcdePackages
  readonly session: AcdeSession
  readonly desktops: AcdeDesktops
  readonly inspect: AcdeInspect
  readonly desktop: AcdeDesktop
  readonly setDefault: AcdeOpenFiles['setDefault']
  readonly permissions: AcdePermissions
}

export interface AcdePage {
  readonly fs?: AcdeFs
  readonly office?: AcdeOffice
  readonly terminal?: AcdeTerminals
  readonly network?: AcdeNetwork
  readonly windows?: AcdeWindows
  readonly apps?: AcdeApps
  readonly launch?: AcdeLaunch
  readonly packages?: AcdePackages
  readonly desktop?: AcdeDesktop
  readonly desktops?: AcdeDesktops
  readonly session?: AcdeSession
  readonly inspect?: AcdeInspect
  readonly open?: AcdeOpen
  readonly openPath?: AcdeOpenFiles['openPath']
  readonly handlers?: AcdeOpenFiles['handlers']
  readonly setDefault?: AcdeOpenFiles['setDefault']
  readonly permissions?: AcdePermissions
  readonly window?: AcdeWindow
  readonly capabilities?: import('./capabilities').AcdeCapabilities
  readonly [service: string]: unknown
}
