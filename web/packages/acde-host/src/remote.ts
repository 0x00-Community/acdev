import type { AppMenu, NativeWindow, WindowApp, WindowEdge, WindowEventName, WindowMode, WindowRect } from '@dopame/acde-api'
import type { ServiceShape, WebInit, WireMenu } from './broker'
import { Level, Log } from './log'
import { WINDOW_EVENTS, type NativeSurface, type WindowEvent } from './native'
import type { Rpc } from './rpc'

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
  readonly #windows = new Map<number, NativeWindow>()
  readonly #rpc: Rpc

  constructor(rpc: Rpc) {
    this.#rpc = rpc
  }

  track(event: WindowEvent): void {
    if (event.type === 'windowclose') return void this.#windows.delete(event.window)
    const was = this.#windows.get(event.window)
    const text = (value: unknown, fallback: string | null) => (typeof value === 'string' && value ? value : fallback)
    const web = event['web'] === true || was?.web === true
    this.#windows.set(event.window, { id: event.window, appId: text(event['appId'], was?.appId ?? null), title: text(event['title'], was?.title ?? null), ...(web ? { web } : {}) })
  }

  screenshot(path: string): Promise<{ width: number; height: number }> {
    return this.#call('screenshot', path) as Promise<{ width: number; height: number }>
  }

  #call(method: 'launch' | 'close' | 'screenshot', ...args: unknown[]): Promise<unknown> {
    const call = this.#rpc.call('windows', method, args)
    call.catch((error: Error) => Log.write(Level.Warn, 'acde_host', `windows.${method}: ${error.message}`))
    return call
  }

  readonly api = {
    on: this.notices.for('windows', WindowList.EVENTS),
    list: (): NativeWindow[] => [...this.#windows.values()].map((window) => ({ ...window })),
    launch: (argv: string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): Promise<number> => this.#call('launch', argv, options ?? {}) as Promise<number>,
    close: (id: number): void => void this.#call('close', id),
  }
}

type PageLike = { dispatchEvent(event: Event): boolean; Event: typeof Event; document: Document }

export class WindowSelf {
  static readonly #EDGES: Record<WindowEdge, number> = { top: 1, bottom: 2, left: 4, right: 8 }
  readonly #rpc: Rpc
  readonly #surface: NativeSurface
  readonly #page: PageLike
  #menus: AppMenu[] = []
  readonly #handlers = new Map<WindowEventName, Set<(value?: unknown) => unknown>>()
  #unmount: (() => void) | null = null
  #opening: Record<string, unknown> | null
  onVisible: (visible: boolean) => void = () => {}
  onTitle: (title: string) => void = () => {}

  constructor(rpc: Rpc, surface: NativeSurface, page: PageLike, opening: Record<string, unknown> | null) {
    this.#rpc = rpc
    this.#surface = surface
    this.#page = page
    this.#opening = opening
  }

  readonly host = {
    setTitle: (title: string): void => {
      this.onTitle(String(title))
      void this.#rpc.call('window', 'setTitle', [String(title)]).catch(() => undefined)
    },
    setMenus: (menus: readonly AppMenu[]): void => {
      this.#menus = Array.isArray(menus) ? [...menus] : []
      const wire: WireMenu[] = this.#menus.map((m) => ({
        id: m.id,
        label: m.label,
        items: m.items.map((it) => ('type' in it ? { type: 'separator' as const } : { id: it.id, label: it.label, shortcut: it.shortcut, checked: it.checked, disabled: it.disabled, action: !!it.onSelect })),
      }))
      void this.#rpc.call('window', 'setMenus', [wire]).catch(() => undefined)
    },
  }

  readonly api = {
    host: this.host,
    mount: (app: WindowApp) => this.#mount(app),
    setTitle: this.host.setTitle,
    setMenus: this.host.setMenus,
    close: () => this.#rpc.call('window', 'close'),
    minimize: () => this.#rpc.call('window', 'minimize'),
    requestAttention: () => this.#rpc.call('window', 'requestAttention'),
    requestMode: (mode: WindowMode) => this.#surface.requestMode(mode),
    setGrabHint: (rect: WindowRect, edges: readonly WindowEdge[] = []) =>
      this.#surface.setGrabHint(rect.x, rect.y, rect.width, rect.height, edges.reduce((bits, e) => bits | WindowSelf.#EDGES[e], 0)),
    setBackdrop: (rect: WindowRect | null, effect: { radius?: number; blur?: number; saturate?: number; brightness?: number } = {}) => {
      const r = rect ?? { x: 0, y: 0, width: 0, height: 0 }
      this.#surface.setBackdrop(r.x, r.y, r.width, r.height, effect.radius ?? 0, effect.blur ?? 0, effect.saturate ?? 1, effect.brightness ?? 1)
    },
    requestActivate: () => this.#surface.requestActivate(),
    requestGrab: (kind: 'pointer' | 'keyboard') => this.#surface.requestGrab(kind),
    shortcut: (combo: string) => this.#rpc.call('window', 'shortcut', [combo]),
    unshortcut: (combo: string) => this.#rpc.call('window', 'unshortcut', [combo]),
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
    void this.#rpc.call('window', 'ready').catch(() => undefined)
  }

  async serve(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'beforeclose': {
        for (const handler of this.#handlers.get('beforeclose') ?? []) if ((await handler()) === false) return false
        if (!WindowSelf.unload(this.#page)) return false
        this.#unmount?.()
        this.#unmount = null
        return true
      }
      case 'request':
        return this.deliver(args[0] as Record<string, unknown>)
      case 'visible':
        return this.onVisible(args[0] === true)
      case 'menu': {
        const [menu, item] = args as [string, string]
        const it = this.#menus.find((m) => m.id === menu)?.items.find((x) => 'id' in x && x.id === item) as { onSelect?(): unknown } | undefined
        return it?.onSelect?.()
      }
    }
    throw new Error(`a window web has no ${method}`)
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

export class RemoteBridge {
  readonly value: Record<string, unknown> = {}
  readonly #rpc: Rpc

  constructor(rpc: Rpc, init: WebInit, self: WindowSelf | null, windows: WindowList) {
    this.#rpc = rpc
    for (const [service, shape] of Object.entries(init.services)) this.value[service] = this.#proxy(service, shape)
    const apps = {
      list: () => rpc.call('apps', 'list'),
      launch: (app: string, request?: Record<string, unknown>) => rpc.call('apps', 'launch', [app, request ?? null]),
      open: (app: string, request?: Record<string, unknown>) => rpc.call('apps', 'open', [app, request ?? null]),
    }
    const files = {
      openPath: (path: string, options?: { app?: string; select?: boolean }) => rpc.call('apps', 'openPath', [path, options ?? {}]),
      handlers: (path: string) => rpc.call('apps', 'handlers', [path]),
      setDefault: (mime: string, handler: string) => rpc.call('apps', 'setDefault', [mime, handler]),
    }
    if (init.kind === 'desktop') {
      this.value['apps'] = {
        ...apps,
        ...files,
        on: windows.notices.for('apps', ['changed']),
        refresh: () => rpc.call('apps', 'refresh'),
        install: (dir: string) => rpc.call('apps', 'install', [dir]),
        natives: () => rpc.call('apps', 'natives'),
        runNative: (id: string) => rpc.call('apps', 'runNative', [id]),
      }
      this.value['desktop'] = { apps: async () => ({ apps: await apps.list() }), on: windows.notices.for('desktop', ['download', 'notification', 'screenshot', 'shortcut']) }
      this.value['windows'] = {
        ...windows.api,
        kill: (id: number) => rpc.call('windows', 'kill', [id]),
        focus: (id: number) => rpc.call('windows', 'focus', [id]),
        hide: (id: number) => rpc.call('windows', 'hide', [id]),
        show: (id: number) => rpc.call('windows', 'show', [id]),
        invokeMenu: (id: number, menu: string, item: string) => rpc.call('windows', 'invokeMenu', [id, menu, item]),
        stats: () => rpc.call('windows', 'stats'),
        animate: (id: number, options: Record<string, unknown>) => rpc.call('windows', 'animate', [id, options]),
        shortcut: (combo: string, scope: 'session' | 'desktop' = 'desktop') => rpc.call('windows', 'shortcut', [combo, scope]),
        unshortcut: (combo: string, scope: 'session' | 'desktop' = 'desktop') => rpc.call('windows', 'unshortcut', [combo, scope]),
      }
    } else {
      this.value['windows'] = windows.api
      this.value['open'] = apps.open
      if (init.app?.capabilities['openFiles']) Object.assign(this.value, files)
      if (self) {
        const api = self.api
        const shortcut = windows.notices.for('window', ['shortcut'])
        this.value['window'] = { ...api, on: (name: string, handler: (value?: unknown) => unknown) => (name === 'shortcut' ? shortcut(name, handler) : api.on(name as WindowEventName, handler)) }
      }
    }
  }

  define(host: { defineModule(url: string, exports: object): void }): void {
    for (const [name, value] of Object.entries(this.value)) host.defineModule(`acde:${name}`, { [name]: value, default: value })
  }

  #proxy(service: string, shape: ServiceShape): unknown {
    const methods: Record<string, unknown> = { ...shape.values }
    for (const method of shape.methods) methods[method] = method in shape.sync ? () => shape.sync[method] : (...args: unknown[]) => this.#rpc.call(service, method, args)
    if (!shape.callable) return methods
    const call = (...args: unknown[]) => this.#rpc.call(service, '', args)
    for (const [key, value] of Object.entries(methods)) Object.defineProperty(call, key, { value, enumerable: true, configurable: true, writable: true })
    return call
  }
}
