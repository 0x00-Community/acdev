import type { AppMenu, DeskWindow, WindowApp, WindowEdge, WindowEventName, WindowMode, WindowRect } from '@dopame/acde-api'
// The `acde:` modules of a desktop or window isolate. Windows, apps, the compositor and the window itself are
// `natives.desk` (crates/acde `desk/`), called on this isolate's own thread; only the desktop package's services (and
// the builtins the Broker still serves) are calls to the Broker, over the services binding.
import type { ServiceShape, IsolateInit, WireMenu } from './broker'
import type { ServiceBinding } from './binding'
import type { IsolateDesk } from './desk'
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

export class WindowList {
  static readonly EVENTS = WINDOW_EVENTS.map((type) => type.slice('window'.length))
  readonly notices = new Notices()
  readonly #windows = new Map<number, DeskWindow>()
  readonly #desk: IsolateDesk

  constructor(desk: IsolateDesk) {
    this.#desk = desk
  }

  track(event: WindowEvent): void {
    if (event.type === 'windowclose') return void this.#windows.delete(event.window)
    const was = this.#windows.get(event.window)
    const text = (value: unknown, fallback: string | null) => (typeof value === 'string' && value ? value : fallback)
    this.#windows.set(event.window, { id: event.window, appId: text(event['appId'], was?.appId ?? null), title: text(event['title'], was?.title ?? null) })
  }

  /** Saves the screen as a PNG; the Broker picks the path (the user's pictures folder) unless one is given. */
  screenshot(path?: string): Promise<{ path: string; width: number; height: number }> {
    return this.#desk.screenshot(path)
  }

  readonly api = {
    on: this.notices.for('windows', WindowList.EVENTS),
    list: (): DeskWindow[] => [...this.#windows.values()].map((window) => ({ ...window })),
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
    if (modules.has('desktops')) this.value['desktops'] = { list: () => desk.desktops(), choose: (id: string, remember = false) => desk.chooseDesktop(String(id), remember === true) }
    if (init.place === 'desktop') {
      this.value['apps'] = { ...apps, ...files, ...((proxies[Modules.STORE] ?? {}) as object), on: windows.notices.for('apps', ['changed']) }
      this.value['desktop'] = { apps: async () => ({ apps: await apps.list() }), on: windows.notices.for('desktop', ['download', 'notification', 'screenshot', 'shortcut']) }
      this.value['windows'] = {
        ...windows.api,
        kill: (id: number) => desk.kill(Number(id)),
        focus: (id: number) => desk.focus(Number(id)),
        hide: (id: number) => desk.hide(Number(id)),
        show: (id: number) => desk.show(Number(id)),
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
        this.value['window'] = { ...api, on: (name: string, handler: (value?: unknown) => unknown) => (name === 'shortcut' ? shortcut(name, handler) : api.on(name as WindowEventName, handler)) }
      }
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
