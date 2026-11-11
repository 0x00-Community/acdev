import type { WireMenu } from './broker'

/** A window's or the desktop's `natives.desk` (crates/acde `desk/js.rs`): what it may do is checked in Rust against the caller. */
export interface IsolateDesk {
  readonly place: 'desktop' | 'window'
  readonly window: number
  onMessage(fn: (message: DeskMessage) => void): void
  onAsk(fn: (kind: AskKind, payload: unknown) => unknown): void
  launch(argv: readonly string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): number
  close(window: number): Promise<boolean>
  kill(window: number): Promise<boolean>
  focus(window: number): Promise<void>
  hide(window: number): Promise<void>
  show(window: number): Promise<void>
  setMode(window: number, mode: 'fullscreen' | 'free' | 'fixed' | 'pinned'): Promise<void>
  placeWindow(window: number, rect: readonly number[]): Promise<void>
  geometry(): Promise<DeskGeometry>
  invokeMenu(window: number, menu: string, item: string): Promise<unknown>
  stats(): Promise<unknown>
  screenshot(path?: string): Promise<{ path: string; width: number; height: number }>
  animate(window: number, options: Record<string, unknown>): Promise<void>
  shortcut(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  unshortcut(combo: string, scope?: 'session' | 'desktop'): Promise<void>
  panelOpen(rect: readonly number[]): { window: number; token: bigint }
  panelPlace(window: number, rect: readonly number[]): void
  panelClose(window: number): void
  setTitle(title: string): void
  setMenus(menus: readonly WireMenu[]): void
  closeSelf(): Promise<boolean>
  minimize(): Promise<void>
  requestAttention(): Promise<void>
  ready(): Promise<void>
  reload(url?: string | null): boolean
  openUrl(url: string): boolean
  shown(): void
  download(name: string, type: string, bytes: Uint8Array): Promise<string>
  notify(notification: Record<string, unknown>): void
  apps(): Promise<{ id: string; label: string; icon: string; script: string }[]>
  openApp(app: string, request?: Record<string, unknown> | null): Promise<{ window: number }>
  sessionOwn(): boolean
  endSession(kind: 'logout' | 'reboot' | 'poweroff'): Promise<void>
  setLanguage(tag: string): Promise<void>
  desktops(): Promise<{ desktops: DesktopEntry[]; current: string }>
  displays(): Promise<unknown>
  setScale(output: string, scale: number): Promise<void>
  setBrightness(output: string, value: number): Promise<void>
  chooseDesktop(id: string, remember: boolean): Promise<void>
  openPath(path: string, options: { app?: string; select?: boolean }): Promise<{ app: string; window: number }>
  handlers(path: string): Promise<{ mime: string; handlers: { id: string; label: string; icon: string; default: boolean }[] }>
  setDefault(mime: string, app: string): Promise<string>
  inspectSnapshot(options: Record<string, unknown>): Promise<unknown>
  inspectRun(steps: readonly { ref: string; action: string; text?: unknown }[]): Promise<{ ok: boolean; text: string }>
  inspectOpen(name: string): Promise<{ ok: boolean; text: string }>
}

/** One of `desktops.list()`: a package's desktop, or another Wayland session. */
export interface DesktopEntry {
  readonly kind: 'acde' | 'session'
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly package: string | null
}

export type AskKind = 'beforeclose' | 'request' | 'menu' | 'inspect' | 'debug.eval' | 'debug.stats'

export type DeskMessage =
  | { type: 'events'; events: Record<string, unknown>[] }
  | { type: 'screen'; width: number; height: number }
  | { type: 'languages'; language?: string; languages?: string[] }
  | { type: 'colorscheme'; dark: boolean }
  | { type: 'visible'; visible: boolean }
  | { type: 'display'; state: unknown }

/** The services channel of a desktop or window isolate (`natives.services`). */
export interface IsolateServices {
  post(message: unknown): void
  onMessage(fn: (message: unknown) => void): void
}

export interface ServiceSpec {
  readonly name: string
  readonly capability: string
  readonly desktopOnly?: boolean
  readonly shape: unknown
}

export interface LookChange {
  width?: number
  height?: number
  scale?: number
  reducedMotion?: boolean | null
  dark?: boolean
  languages?: unknown
  resources?: { prefix: string; dirs: string[] }[]
  services?: ServiceSpec[]
  theme?: string
  env?: [string, string][]
  storage?: boolean
  frame?: string | null
  own?: boolean
  standalone?: boolean
  desktops?: { desktops: DesktopEntry[]; current: string }
}

export type BrokerNotice =
  | { type: 'exit' }
  | { type: 'milestone'; title: string; time: number }
  | { type: 'desktopexit'; code: number; reason: string | null; closing: boolean }
  | { type: 'desktopshown' }
  | { type: 'isolateexit'; window: number }
  | { type: 'appstart' | 'appstop'; app: string }
  | { type: 'end'; kind: 'logout' | 'reboot' | 'poweroff' }
  | { type: 'language'; locale: string }
  | { type: 'choose'; id: string }

export interface ShellWindow {
  readonly id: number
  readonly window?: number | null
  readonly canvas: number
  readonly mode: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly z: number
  readonly focus: boolean
  readonly hidden?: boolean
  readonly pid?: number | null
}

/** A window of the desk's table: its app (the manifest's id, or the client's app id), its title, and whether its isolate runs (`page`). */
export interface DeskRecord {
  readonly id: number
  readonly app: string | null
  readonly title: string | null
  readonly page: boolean
}

export interface InjectEvent {
  type: 'move' | 'motion' | 'down' | 'up' | 'wheel' | 'keydown' | 'keyup'
  x?: number
  y?: number
  button?: number
  dx?: number
  dy?: number
  source?: 'wheel' | 'finger' | 'continuous'
  code?: number
}

/** The Broker's `sys.desk(look)` (crates/acde `desk/js.rs`): the desk is the runtime's window table; the Broker starts the desktop and serves the services. */
export interface BrokerDesk {
  readonly socketName: string
  onNotice(fn: (notice: BrokerNotice) => void): void
  onService(fn: (window: number, message: unknown) => void): void
  servicePost(window: number, message: unknown): void
  caller(window: number): { place: 'desktop' | 'window'; name: string; app: Record<string, unknown> | null } | null
  look(change: LookChange): void
  setApps(apps: { app: unknown; available: boolean }[]): void
  openDesktop(options: { html?: string | null; standalone?: string | null; storage?: string | null; heapMb: number }): void
  launch(app: string, request?: Record<string, unknown> | null, mode?: 'fullscreen' | 'free'): number
  raise(window: number): void
  running(app: string): boolean
  records(): DeskRecord[]
  isPanel(window: number): boolean
  closeWindow(window: number, force?: boolean): Promise<boolean>
  hide(window: number, hidden: boolean): void
  focus(window: number): void
  close(window: number): void
  windows(): ShellWindow[]
  stats(reset?: boolean): Record<string, unknown>
  inject(event: InjectEvent): void
  screenshot(path?: string): Promise<{ path: string; width: number; height: number }>
  startProgram(argv: readonly string[], options?: { cwd?: string; env?: Record<string, string> }): number
  children(): number[]
  ask(window: number, kind: 'inspect' | 'debug.eval' | 'debug.stats', payload: unknown): Promise<unknown>
  named(name: string): number | null
  isolates(): { window: number; name: string; cpuMs: number; externalMb: number }[]
  openOffice(): string | null
  closeOffice(): void
  closeAll(): Promise<void>
  closeDesktop(): Promise<void>
  toDesktop(event: Record<string, unknown>): void
  openPath(path: string, options?: { app?: string; select?: boolean }): Promise<{ app: string; window: number }>
  inspectSnapshot(options: Record<string, unknown>): Promise<unknown>
  inspectRun(steps: readonly { ref: string; action: string; text?: unknown }[]): Promise<{ ok: boolean; text: string }>
  inspectOpen(name: string): Promise<{ ok: boolean; text: string }>
  warmAccessibility(): void
  startPower(): void
  quit(): void
}

export interface DeskGeometry {
  readonly windows: readonly { readonly window: number; readonly mode: string; readonly rect: readonly [number, number, number, number]; readonly z: number; readonly focus: boolean; readonly hidden: boolean }[]
  readonly canvases: readonly { readonly id: number; readonly rect: readonly [number, number, number, number]; readonly scale: number }[]
}
