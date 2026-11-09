import type { AppMenu, NativeWindow, WindowApp, WindowEdge, WindowEventName, WindowMode, WindowOutput, WindowRect, WindowState } from '@dopame/acde-api'
import type { ServiceShape, WebInit, WireMenu } from './broker'
import { Level, Log } from './log'
import { WINDOW_EVENTS, type NativeSurface, type WindowEvent } from './native'
import { Rpc } from './rpc'
import { CapabilityCheck } from './broker/access/capabilities'

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
    if (event.type === 'windowstate') {
      if (was) this.#windows.set(event.window, { ...was, state: event['state'] as WindowState })
      return
    }
    const text = (value: unknown, fallback: string | null) => (typeof value === 'string' && value ? value : fallback)
    const web = event['web'] === true || was?.web === true
    const appId = text(event['appId'], was?.appId ?? null)
    this.#windows.set(event.window, { id: event.window, appId, title: text(event['title'], was?.title ?? null), ...(web ? { web } : {}) })
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
    launch: (argv: string[], options?: { cwd?: string; env?: Record<string, string>; slot?: boolean }): Promise<number> =>
      this.#call('launch', argv, options ?? {}) as Promise<number>,
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
  #state: WindowState = 'normal'
  #output: WindowOutput
  onVisible: (visible: boolean) => void = () => {}
  onTitle: (title: string) => void = () => {}

  constructor(rpc: Rpc, surface: NativeSurface, page: PageLike, opening: Record<string, unknown> | null, output: WindowOutput) {
    this.#rpc = rpc
    this.#surface = surface
    this.#page = page
    this.#opening = opening
    this.#output = output
  }

  get state(): WindowState {
    return this.#state
  }

  get output(): WindowOutput {
    return this.#output
  }

  get hostControls(): boolean {
    return this.#surface.hostControls === true
  }

  changed(state: string, previous: string): void {
    this.#state = state as WindowState
    this.emit('state', { state, previous })
  }

  moved(output: WindowOutput): void {
    const was = this.#output
    this.#output = output
    if (JSON.stringify(was) !== JSON.stringify(output)) this.emit('output', output)
  }

  static output(width: number, height: number, scale: number, workArea?: WindowRect | null): WindowOutput {
    return Object.freeze({ width, height, scale, workArea: Object.freeze({ ...(workArea ?? { x: 0, y: 0, width, height }) }) })
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
        items: m.items.map((it) =>
          'type' in it
            ? { type: 'separator' as const }
            : { id: it.id, label: it.label, shortcut: it.shortcut, checked: it.checked, disabled: it.disabled, action: !!it.onSelect },
        ),
      }))
      void this.#rpc.call('window', 'setMenus', [wire]).catch(() => undefined)
    },
  }

  get id(): number {
    return this.#surface.window
  }

  readonly api = {
    host: this.host,
    mount: (app: WindowApp) => this.#mount(app),
    setTitle: this.host.setTitle,
    setMenus: this.host.setMenus,
    ...Rpc.calls(() => this.#rpc, 'window', 'close', 'minimize', 'requestAttention', 'shortcut', 'unshortcut'),
    requestMode: (mode: WindowMode | 'fullscreen') => this.#surface.requestMode(mode),
    requestState: (state: WindowState) => this.#surface.requestState(state),
    setGrabHint: (rect: WindowRect, edges: readonly WindowEdge[] = []) =>
      this.#surface.setGrabHint(rect.x, rect.y, rect.width, rect.height, edges.reduce((bits, e) => bits | WindowSelf.#EDGES[e], 0)),
    setBackdrop: (rect: WindowRect | null, effect: { radius?: number; blur?: number; saturate?: number; brightness?: number } = {}) => {
      const r = rect ?? { x: 0, y: 0, width: 0, height: 0 }
      this.#surface.setBackdrop(r.x, r.y, r.width, r.height, effect.radius ?? 0, effect.blur ?? 0, effect.saturate ?? 1, effect.brightness ?? 1)
    },
    requestActivate: () => this.#surface.requestActivate(),
    requestGrab: (kind: 'pointer' | 'keyboard') => this.#surface.requestGrab(kind),
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

  emit(name: 'activate' | 'deactivate' | 'grab' | 'grablost' | 'state' | 'output' | 'hostcontrols', value?: unknown): void {
    for (const handler of this.#handlers.get(name) ?? []) handler(value)
  }
}

export class RemoteBridge {
  readonly value: Record<string, unknown> = {}
  readonly #rpc: Rpc

  constructor(rpc: Rpc, init: WebInit, self: WindowSelf | null, windows: WindowList) {
    this.#rpc = rpc
    for (const [service, shape] of Object.entries(init.services)) this.value[service] = this.#proxy(service, shape)
    const apps = Rpc.calls(() => rpc, 'apps', 'list', 'launch', 'open')
    const files = Rpc.calls(() => rpc, 'apps', 'openPath', 'handlers', 'setDefault')
    const shell = new Set<string>(init.tier?.shell ?? [])
    const globalWindows = () => ({
      ...windows.api,
      ...Rpc.calls(() => rpc, 'windows', 'kill', 'focus', 'hide', 'show', 'requestState', 'invokeMenu', 'stats', 'animate', 'shortcut', 'unshortcut'),
    })
    const tier = {
      packages: () => ({ ...Rpc.calls(() => rpc, 'packages', 'refresh', 'install', 'natives', 'runNative'), on: windows.notices.for('apps', ['changed']) }),
      launch: () => ({ ...Rpc.calls(() => rpc, 'launch', 'start', 'embed', 'close'), list: windows.api.list, on: windows.api.on }),
    }
    if (init.kind === 'desktop') {
      const shell = Rpc.calls(() => rpc, 'apps', 'refresh', 'install', 'natives', 'runNative')
      this.value['apps'] = { ...apps, ...files, ...shell, on: windows.notices.for('apps', ['changed']) }
      const events = ['download', 'notification', 'screenshot', 'shortcut']
      this.value['desktop'] = { apps: async () => ({ apps: await apps.list() }), on: windows.notices.for('desktop', events) }
      this.value['windows'] = globalWindows()
      Object.assign(this.value, { packages: tier.packages(), launch: tier.launch(), open: apps.open, ...files })
    } else if (init.tier && init.tier.level >= 1) {
      const caps = init.app?.capabilities ?? {}
      this.value['apps'] = { list: apps.list, open: apps.open, on: windows.notices.for('apps', ['changed']) }
      this.value['open'] = apps.open
      if (caps['openFiles']) Object.assign(this.value, { openPath: files.openPath, handlers: files.handlers })
      if (caps['launch'] || caps['slots']) this.value['launch'] = tier.launch()
      if (shell.has('windows')) this.value['windows'] = globalWindows()
      if (shell.has('packages')) this.value['packages'] = tier.packages()
      if (shell.has('setDefault')) this.value['setDefault'] = files.setDefault
      if (shell.has('desktop')) {
        this.value['desktop'] = { apps: async () => ({ apps: await apps.list() }), on: windows.notices.for('desktop', ['download', 'notification']) }
      }
      if (self) this.value['window'] = this.#window(self, windows)
    } else {
      this.value['windows'] = windows.api
      this.value['open'] = apps.open
      if (init.app?.capabilities['openFiles']) Object.assign(this.value, files)
      if (self) this.value['window'] = this.#window(self, windows)
    }
    if (init.tier?.capabilities) this.value['capabilities'] = CapabilityCheck.module(init.tier.capabilities)
    this.#refused = init.tier?.refused ?? {}
  }

  readonly #refused: Readonly<Record<string, string>>

  #window(self: WindowSelf, windows: WindowList): unknown {
    const api = self.api
    const shortcut = windows.notices.for('window', ['shortcut'])
    const on = (name: string, handler: (value?: unknown) => unknown) =>
      name === 'shortcut' ? shortcut(name, handler) : api.on(name as WindowEventName, handler)
    const value = { ...api, id: self.id, on }
    Object.defineProperty(value, 'state', { get: () => self.state, enumerable: true })
    Object.defineProperty(value, 'output', { get: () => self.output, enumerable: true })
    Object.defineProperty(value, 'hostControls', { get: () => self.hostControls, enumerable: true })
    return value
  }

  define(host: { defineModule(url: string, exports: object): void; refuseModule?(url: string, reason: string): void }): void {
    for (const [name, value] of Object.entries(this.value)) host.defineModule(`acde:${name}`, { [name]: value, default: value })
    for (const [url, reason] of Object.entries(this.#refused)) if (!(url.slice('acde:'.length) in this.value)) host.refuseModule?.(url, reason)
  }

  #proxy(service: string, shape: ServiceShape): unknown {
    const methods: Record<string, unknown> = { ...shape.values }
    for (const method of shape.methods) {
      methods[method] = method in shape.sync ? () => shape.sync[method] : (...args: unknown[]) => this.#rpc.call(service, method, args)
    }
    if (!shape.callable) return methods
    const call = (...args: unknown[]) => this.#rpc.call(service, '', args)
    for (const [key, value] of Object.entries(methods)) Object.defineProperty(call, key, { value, enumerable: true, configurable: true, writable: true })
    return call
  }
}
