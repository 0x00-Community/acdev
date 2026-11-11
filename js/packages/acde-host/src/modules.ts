import type { AppMenu, DeskWindow, WindowApp, WindowEdge, WindowEventName, WindowMode, WindowRect } from '@dopame/acde-api'
// The `acde:` modules of a desktop or window isolate. Windows, apps, the compositor and the window itself are
// `natives.desk` (crates/acde `desk/`), called on this isolate's own thread; only the desktop package's services (and
// the builtins the Broker still serves) are calls to the Broker, over the services binding.
import type { ServiceShape, IsolateInit, WireMenu } from './broker'
import type { ServiceBinding } from './binding'
import type { DeskGeometry, IsolateDesk } from './desk'
import { Level, Log } from './log'
import { WINDOW_EVENTS, type NativeSurface, type WindowEvent } from './native'

class Notices {
  readonly #handlers = new Map<string, Set<(detail: unknown) => void>>()

  on(type: string, handler: (detail: unknown) => void): () => boolean {
    const set = this.#handlers.get(type) ?? new Set()
    set.add(handler)
    this.#handlers.set(type, set)
    return () => set.delete(handler)
  }

  emit(type: string, detail: unknown): void {
    for (const handler of this.#handlers.get(type) ?? []) {
      try {
        handler(detail)
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `${type} handler: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  for(scope: string, types: readonly string[]): (type: string, handler: (detail: unknown) => void) => () => boolean {
    return (type, handler) => {
      if (!types.includes(type)) throw new TypeError(`acde:${scope} has no ${String(type)} event (${types.join(', ')})`)
      return this.on(`${scope}:${type}`, handler)
    }
  }
}

export type WindowState = 'normal' | 'minimized' | 'filled' | 'fullscreen'
type Rect = readonly [number, number, number, number]
type Reserve = { readonly edge: WindowEdge; readonly thickness: number }

export class WindowList {
  static readonly STATES: readonly WindowState[] = ['normal', 'minimized', 'filled', 'fullscreen']
  static readonly EVENTS = [...WINDOW_EVENTS.map((type) => type.slice('window'.length)), 'state']
  readonly notices = new Notices()
  readonly #windows = new Map<number, DeskWindow>()
  readonly #states = new Map<number, WindowState>()
  readonly #beforeMinimized = new Map<number, WindowState>()
  readonly #beforeFullscreen = new Map<number, WindowState>()
  readonly #restore = new Map<number, Rect>()
  readonly #reserves = new Map<object, Reserve>()
  readonly #desk: IsolateDesk

  constructor(desk: IsolateDesk) {
    this.#desk = desk
  }

  stateOf(window: number): WindowState {
    return this.#states.get(window) ?? 'normal'
  }

  track(event: WindowEvent): void {
    const id = event.window
    switch (event.type) {
      case 'windowclose':
        this.#windows.delete(id)
        for (const map of [this.#states, this.#beforeMinimized, this.#beforeFullscreen, this.#restore]) map.delete(id)
        return
      case 'windowopen':
      case 'windowtitle': {
        const was = this.#windows.get(id)
        const text = (value: unknown, fallback: string | null) => (typeof value === 'string' && value ? value : fallback)
        this.#windows.set(id, { id, appId: text(event['appId'], was?.appId ?? null), title: text(event['title'], was?.title ?? null) })
        return
      }
      case 'windowfullscreen':
        if (this.stateOf(id) !== 'fullscreen') this.#beforeFullscreen.set(id, this.stateOf(id))
        return this.#set(id, 'fullscreen')
      case 'windowunfullscreen': {
        const back = this.#beforeFullscreen.get(id) === 'filled' ? 'filled' : 'normal'
        this.#beforeFullscreen.delete(id)
        return this.#set(id, back)
      }
      case 'windowminimize':
        return void this.requestState(id, 'minimized').catch((error: Error) => Log.write(Level.Warn, 'acde_host', `minimize ${id}: ${error.message}`))
      case 'windowshow':
        if (this.stateOf(id) === 'minimized') this.#set(id, this.#beforeMinimized.get(id) ?? 'normal')
        return
    }
  }

  #set(window: number, state: WindowState): void {
    const previous = this.stateOf(window)
    if (previous === state) return
    this.#states.set(window, state)
    this.notices.emit('windows:state', { window, state, previous })
  }

  /** The runtime's window states: minimized hides, filled covers the work area (the canvas less the pinned panels' reserves), fullscreen is the compositor's mode. */
  async requestState(window: number, state: WindowState): Promise<void> {
    if (!WindowList.STATES.includes(state)) throw new TypeError(`requestState: no state ${String(state)} (${WindowList.STATES.join(', ')})`)
    if (state === this.stateOf(window)) return
    if (state === 'minimized') {
      this.#beforeMinimized.set(window, this.stateOf(window))
      await this.#desk.hide(window)
      return this.#set(window, 'minimized')
    }
    if (this.stateOf(window) === 'minimized') {
      await this.#desk.show(window)
      this.#set(window, this.#beforeMinimized.get(window) ?? 'normal')
      this.#beforeMinimized.delete(window)
      if (state === this.stateOf(window)) return
    }
    if (state === 'fullscreen') return this.#desk.setMode(window, 'fullscreen')
    if (this.stateOf(window) === 'fullscreen') {
      this.#beforeFullscreen.set(window, state)
      await this.#desk.setMode(window, 'free')
      if (state === 'filled') return
    }
    if (state === 'filled') {
      const geometry = await this.#desk.geometry()
      const rect = geometry.windows.find((w) => w.window === window)?.rect
      if (rect) this.#restore.set(window, rect)
      const area = this.#workArea(geometry)
      if (area) await this.#desk.placeWindow(window, area)
      return this.#set(window, 'filled')
    }
    const back = this.#restore.get(window)
    this.#restore.delete(window)
    if (back) await this.#desk.placeWindow(window, back)
    this.#set(window, 'normal')
  }

  async unminimize(window: number): Promise<void> {
    if (this.stateOf(window) === 'minimized') await this.requestState(window, this.#beforeMinimized.get(window) ?? 'normal')
  }

  /** A pinned panel's claim on a screen edge (output pixels); filled windows keep clear of it. */
  reserve(owner: object, reserve: Reserve | null): void {
    if (reserve && reserve.thickness > 0 && ['top', 'bottom', 'left', 'right'].includes(reserve.edge)) this.#reserves.set(owner, { edge: reserve.edge, thickness: reserve.thickness })
    else this.#reserves.delete(owner)
    void this.#refill()
  }

  async #refill(): Promise<void> {
    const filled = [...this.#states].filter(([, state]) => state === 'filled').map(([id]) => id)
    if (!filled.length) return
    const area = this.#workArea(await this.#desk.geometry())
    if (area) for (const id of filled) await this.#desk.placeWindow(id, area).catch(() => undefined)
  }

  #workArea(geometry: DeskGeometry): Rect | null {
    const canvas = geometry.canvases[0]
    if (!canvas) return null
    let [x, y, width, height] = canvas.rect
    const scale = canvas.scale || 1
    for (const { edge, thickness } of this.#reserves.values()) {
      const t = Math.ceil(thickness / scale)
      if (edge === 'top') [y, height] = [y + t, height - t]
      else if (edge === 'bottom') height -= t
      else if (edge === 'left') [x, width] = [x + t, width - t]
      else width -= t
    }
    return [x, y, Math.max(1, width), Math.max(1, height)]
  }

  /** Saves the screen as a PNG; the Broker picks the path (the user's pictures folder) unless one is given. */
  screenshot(path?: string): Promise<{ path: string; width: number; height: number }> {
    return this.#desk.screenshot(path)
  }

  readonly api = {
    on: this.notices.for('windows', WindowList.EVENTS),
    list: (): DeskWindow[] => [...this.#windows.values()].map((window) => ({ ...window, state: this.stateOf(window.id) })),
    launch: (argv: string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): number => this.#desk.launch(argv, options ?? {}),
    close: (id: number): void =>
      void this.#desk.close(id).catch((error: Error) => Log.write(Level.Warn, 'acde_host', `windows.close: ${error.message}`)),
  }
}

type PageLike = { dispatchEvent(event: Event): boolean; Event: typeof Event; document: Document }

export class WindowSelf {
  static readonly #EDGES: Record<WindowEdge, number> = { top: 1, bottom: 2, left: 4, right: 8 }
  readonly #desk: IsolateDesk
  readonly #surface: NativeSurface
  readonly #page: PageLike
  #menus: AppMenu[] = []
  readonly #handlers = new Map<WindowEventName, Set<(value?: unknown) => unknown>>()
  #unmount: (() => void) | null = null
  #opening: Record<string, unknown> | null
  onVisible: (visible: boolean) => void = () => {}
  onTitle: (title: string) => void = () => {}
  #state: WindowState = 'normal'
  #beforeFullscreen: WindowState = 'normal'
  #beforeHidden: WindowState = 'normal'

  constructor(desk: IsolateDesk, surface: NativeSurface, page: PageLike, opening: Record<string, unknown> | null) {
    this.#desk = desk
    this.#surface = surface
    this.#page = page
    this.#opening = opening
  }

  readonly host = {
    setTitle: (title: string): void => {
      this.onTitle(String(title))
      this.#desk.setTitle(String(title))
    },
    setMenus: (menus: readonly AppMenu[]): void => {
      this.#menus = Array.isArray(menus) ? [...menus] : []
      const wire: WireMenu[] = this.#menus.map((m) => ({
        id: m.id,
        label: m.label,
        items: m.items.map((it) => ('type' in it ? { type: 'separator' as const } : { id: it.id, label: it.label, shortcut: it.shortcut, checked: it.checked, disabled: it.disabled, action: !!it.onSelect })),
      }))
      this.#desk.setMenus(wire)
    },
  }

  get state(): WindowState {
    return this.#state
  }

  #setState(state: WindowState): void {
    if (state === this.#state) return
    const previous = this.#state
    this.#state = state
    for (const handler of this.#handlers.get('state' as WindowEventName) ?? []) handler({ state, previous })
  }

  /** The compositor's mode for this window (acde_window `mode`). */
  mode(mode: string): void {
    if (mode === 'fullscreen' && this.#state !== 'fullscreen') {
      this.#beforeFullscreen = this.#state
      this.#setState('fullscreen')
    } else if (mode !== 'fullscreen' && this.#state === 'fullscreen') this.#setState(this.#beforeFullscreen === 'filled' ? 'filled' : 'normal')
  }

  visible(visible: boolean): void {
    if (!visible && this.#state !== 'minimized') {
      this.#beforeHidden = this.#state
      this.#setState('minimized')
    } else if (visible && this.#state === 'minimized') this.#setState(this.#beforeHidden)
  }

  async requestState(state: WindowState): Promise<void> {
    if (!WindowList.STATES.includes(state)) throw new TypeError(`requestState: no state ${String(state)} (${WindowList.STATES.join(', ')})`)
    if (state === this.#state) return
    if (state === 'minimized') return this.#desk.minimize()
    if (state === 'fullscreen') return this.#surface.requestMode('fullscreen')
    if (this.#state === 'fullscreen') this.#surface.requestMode('free')
    if (state === 'filled') Log.write(Level.Warn, 'acde_host', 'requestState(filled) from a window is not supported yet; the desktop fills windows')
  }

  readonly api = {
    host: this.host,
    mount: (app: WindowApp) => this.#mount(app),
    setTitle: this.host.setTitle,
    setMenus: this.host.setMenus,
    close: () => this.#desk.closeSelf(),
    minimize: () => this.#desk.minimize(),
    requestAttention: () => this.#desk.requestAttention(),
    requestMode: (mode: WindowMode) => this.#surface.requestMode(mode),
    setGrabHint: (rect: WindowRect, edges: readonly WindowEdge[] = []) =>
      this.#surface.setGrabHint(rect.x, rect.y, rect.width, rect.height, edges.reduce((bits, e) => bits | WindowSelf.#EDGES[e], 0)),
    setBackdrop: (rect: WindowRect | null, effect: { radius?: number; blur?: number; saturate?: number; brightness?: number } = {}) => {
      const r = rect ?? { x: 0, y: 0, width: 0, height: 0 }
      this.#surface.setBackdrop(r.x, r.y, r.width, r.height, effect.radius ?? 0, effect.blur ?? 0, effect.saturate ?? 1, effect.brightness ?? 1)
    },
    requestState: (state: WindowState) => this.requestState(state),
    requestActivate: () => this.#surface.requestActivate(),
    requestGrab: (kind: 'pointer' | 'keyboard') => this.#surface.requestGrab(kind),
    shortcut: (combo: string) => this.#desk.shortcut(String(combo)),
    unshortcut: (combo: string) => this.#desk.unshortcut(String(combo)),
    releaseGrab: (kind: 'pointer' | 'keyboard') => this.#surface.releaseGrab(kind),
    on: (name: WindowEventName, handler: (value?: unknown) => unknown) => {
      const set = this.#handlers.get(name) ?? new Set()
      set.add(handler)
      this.#handlers.set(name, set)
      const opening = name === 'request' ? this.#opening : null
      if (opening) {
        this.#opening = null
        queueMicrotask(() => handler(opening))
      }
      return () => set.delete(handler)
    },
  }

  #mount(app: WindowApp): void {
    const root = this.#page.document.getElementById('app')
    if (!root) throw new Error('acde.window.mount: the window document has no #app')
    this.#unmount = app.mount(root, this.host)
    void this.#desk.ready().catch(() => undefined)
  }

  /** Asked by the desk: may the window close (`beforeclose`), a request from another app, a menu item chosen on the desktop. */
  async beforeClose(): Promise<boolean> {
    for (const handler of this.#handlers.get('beforeclose') ?? []) if ((await handler()) === false) return false
    if (!WindowSelf.unload(this.#page)) return false
    this.#unmount?.()
    this.#unmount = null
    return true
  }

  menu(menu: string, item: string): unknown {
    const it = this.#menus.find((m) => m.id === menu)?.items.find((x) => 'id' in x && x.id === item) as { onSelect?(): unknown } | undefined
    return it?.onSelect?.()
  }

  static unload(page: PageLike): boolean {
    const window = page as unknown as { BeforeUnloadEvent?: typeof Event; PageTransitionEvent?: new (type: string, init?: { persisted?: boolean }) => Event }
    const BeforeUnload = window.BeforeUnloadEvent ?? page.Event
    if (!page.dispatchEvent(new BeforeUnload('beforeunload', { cancelable: true }))) return false
    if (window.PageTransitionEvent) page.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }))
    page.dispatchEvent(new page.Event('unload'))
    return true
  }

  deliver(request: Record<string, unknown>): void {
    const handlers = this.#handlers.get('request')
    if (!handlers?.size) return void (this.#opening = request)
    for (const handler of handlers) handler(request)
  }

  emit(name: 'activate' | 'deactivate' | 'grab' | 'grablost', value?: unknown): void {
    for (const handler of this.#handlers.get(name) ?? []) handler(value)
  }
}

/** The `acde:` modules this isolate defines: the desk's, and a proxy per service its init names. */
export class Modules {
  /** A builtin the Broker still serves, not a module of its own: folded into `acde:apps`. */
  static readonly STORE = '#apps'
  readonly value: Record<string, unknown> = {}
  readonly #binding: ServiceBinding

  constructor(binding: ServiceBinding, desk: IsolateDesk, init: IsolateInit, self: WindowSelf | null, windows: WindowList) {
    this.#binding = binding
    const proxies: Record<string, unknown> = {}
    for (const [service, shape] of Object.entries(init.services)) proxies[service] = this.#proxy(service, shape)
    for (const [name, proxy] of Object.entries(proxies)) if (!name.startsWith('#')) this.value[name] = proxy
    const apps = {
      list: () => desk.apps(),
      launch: (app: string, request?: Record<string, unknown>) => desk.openApp(String(app), request ?? null),
      open: (app: string, request?: Record<string, unknown>) => desk.openApp(String(app), request ?? null),
    }
    const modules = new Set(init.modules ?? [])
    const files = modules.has('files')
      ? {
          openPath: (path: string, options?: { app?: string; select?: boolean }) => desk.openPath(String(path), options ?? {}),
          handlers: (path: string) => desk.handlers(String(path)),
          setDefault: (mime: string, app: string) => desk.setDefault(String(mime), String(app)),
        }
      : {}
    if (modules.has('session')) {
      this.value['session'] = {
        own: () => desk.sessionOwn(),
        logout: () => desk.endSession('logout'),
        reboot: () => desk.endSession('reboot'),
        poweroff: () => desk.endSession('poweroff'),
        setLanguage: (tag: string) => desk.setLanguage(String(tag)),
      }
    }
    if (modules.has('inspect')) this.value['inspect'] = Modules.inspect(desk)
    if (modules.has('display')) this.value['display'] = this.#display(desk)
    if (modules.has('desktops')) this.value['desktops'] = { list: () => desk.desktops(), choose: (id: string, remember = false) => desk.chooseDesktop(String(id), remember === true) }
    if (init.place === 'desktop') {
      this.value['apps'] = { ...apps, ...files, ...((proxies[Modules.STORE] ?? {}) as object), on: windows.notices.for('apps', ['changed']) }
      this.value['desktop'] = { apps: async () => ({ apps: await apps.list() }), on: windows.notices.for('desktop', ['download', 'notification', 'screenshot', 'shortcut']) }
      this.value['windows'] = {
        ...windows.api,
        kill: (id: number) => desk.kill(Number(id)),
        focus: async (id: number) => {
          await windows.unminimize(Number(id))
          return desk.focus(Number(id))
        },
        hide: (id: number) => desk.hide(Number(id)),
        show: async (id: number) => {
          if (windows.stateOf(Number(id)) === 'minimized') return windows.unminimize(Number(id))
          return desk.show(Number(id))
        },
        requestState: (id: number, state: WindowState) => windows.requestState(Number(id), state),
        invokeMenu: (id: number, menu: string, item: string) => desk.invokeMenu(Number(id), String(menu), String(item)),
        stats: () => desk.stats(),
        animate: (id: number, options: Record<string, unknown>) => desk.animate(Number(id), options ?? {}),
        shortcut: (combo: string, scope: 'session' | 'desktop' = 'desktop') => desk.shortcut(String(combo), scope),
        unshortcut: (combo: string, scope: 'session' | 'desktop' = 'desktop') => desk.unshortcut(String(combo), scope),
      }
    } else {
      this.value['windows'] = windows.api
      this.value['open'] = apps.open
      Object.assign(this.value, files)
      if (self) {
        const api = self.api
        const shortcut = windows.notices.for('window', ['shortcut'])
        const value = { ...api, on: (name: string, handler: (value?: unknown) => unknown) => (name === 'shortcut' ? shortcut(name, handler) : api.on(name as WindowEventName, handler)) }
        Object.defineProperty(value, 'state', { get: () => self.state, enumerable: true })
        this.value['window'] = value
      }
    }
  }

  readonly #displayListeners = new Set<(state: unknown) => void>()

  displayChanged(state: unknown): void {
    for (const listener of [...this.#displayListeners]) {
      try {
        listener(state)
      } catch (error) {
        Log.write(Level.Error, 'acde_host', `acde:display changed: ${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  #display(desk: Pick<IsolateDesk, 'displays' | 'setScale' | 'setBrightness'>): Record<string, unknown> {
    const unsupported = (what: string) => Promise.reject(Object.assign(new Error(`acde:display: ${what} is not supported here`), { code: 'unsupported', status: 501 }))
    return {
      state: () => desk.displays(),
      configure: (id: string, patch: Record<string, unknown>) => {
        const keys = Object.keys(patch ?? {}).filter((k) => patch[k] !== undefined)
        const other = keys.filter((k) => k !== 'scale')
        if (other.length) return unsupported(`changing ${other.join(', ')}`)
        if (!keys.length) return Promise.resolve()
        return desk.setScale(String(id), Number(patch['scale']))
      },
      setBrightness: (id: string, value: number) => desk.setBrightness(String(id), Number(value)),
      setNightLight: () => unsupported('night light'),
      on: (type: string, handler: (state: unknown) => void) => {
        if (type !== 'changed') throw new TypeError(`acde:display has no ${String(type)} event`)
        if (typeof handler !== 'function') throw new TypeError('acde:display on: the handler is not a function')
        this.#displayListeners.add(handler)
        return () => this.#displayListeners.delete(handler)
      },
    }
  }

  /** `acde:inspect` on the desk (crates/acde `desk/inspect.rs`); the Broker gives the package's services the same. */
  static inspect(desk: Pick<IsolateDesk, 'inspectSnapshot' | 'inspectRun' | 'inspectOpen'>): Record<string, unknown> {
    return {
      snapshot: (options?: Record<string, unknown>) => desk.inspectSnapshot(options ?? {}),
      act: (ref: string, action: string, arg?: string | number | null) => desk.inspectRun([{ ref: String(ref), action: String(action), text: arg ?? null }]),
      run: (steps: readonly { ref: string; action: string; text?: unknown }[]) => desk.inspectRun(Array.isArray(steps) ? steps.map((s) => ({ ref: String(s?.ref ?? ''), action: String(s?.action ?? ''), text: s?.text ?? null })) : []),
      open: (name: string) => desk.inspectOpen(String(name)),
    }
  }

  define(host: { defineModule(url: string, exports: object): void }): void {
    for (const [name, value] of Object.entries(this.value)) host.defineModule(`acde:${name}`, { [name]: value, default: value })
  }

  #proxy(service: string, shape: ServiceShape): unknown {
    const methods: Record<string, unknown> = { ...shape.values }
    for (const method of shape.methods) methods[method] = method in shape.sync ? () => shape.sync[method] : (...args: unknown[]) => this.#binding.call(service, method, args)
    if (!shape.callable) return methods
    const call = (...args: unknown[]) => this.#binding.call(service, '', args)
    for (const [key, value] of Object.entries(methods)) Object.defineProperty(call, key, { value, enumerable: true, configurable: true, writable: true })
    return call
  }
}
