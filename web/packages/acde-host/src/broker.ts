import { readFileSync } from './sys/fs'
import { unref, within } from './sys/timers'
import { WebThread } from './sys/worker'
import type { WebGrants } from './sys/natives'
import { AppRegistry, type AppManifest, type Capabilities } from './apps'
import { AppBackends } from './backend'
import { Crashes } from './crashes'
import { PageBridge } from './bridge'
import { Downloads } from './downloads'
import { Opener, type OpenOptions } from './open'
import { NativeApps } from './launcher'
import { PageSource } from './page'
import { StartupTimeline } from './timeline'
import type { Native, NativeFileChooser, RawShellEvent } from './native'
import { Packages, type InstalledDesktop } from './packages'
import { Rpc } from './rpc'
import { DesktopSession, type RunEnd } from './session'
import { Inspect, type NativeAccessibility } from './inspect'
import { SessionLanguage, type Languages } from './language'
import { StorageFile } from './storage'
import { WindowPlaces } from './places'
import { Level, Log } from './log'
import { basename } from './sys/path'
import { process } from './sys/process'

export interface BrokerShell {
  pump(): RawShellEvent[]
  onEvents(callback: () => void): void
  grant(options?: { desktop?: boolean; window?: number; mode?: 'fullscreen' | 'free' | 'fixed' | 'pinned'; rect?: number[]; size?: readonly number[] }): { window: number; token: bigint }
  place(window: number, x: number, y: number, width: number, height: number): void
  release(window: number): void
  focus(window: number): void
  hide(window: number, hidden: boolean): void
  close(window: number): void
  launch(argv: string[], options?: { cwd?: string; env?: Record<string, string> }): number
  screenshot(path: string): Promise<{ width: number; height: number }>
  stats(reset?: boolean): Record<string, unknown>
  windows(): ShellWindow[]
  animate(window: number, options: AnimateOptions): void
  shortcut(combo: string, scope: 'session' | 'desktop' | 'app', owner: number): void
  unshortcut(combo: string, scope: 'session' | 'desktop' | 'app', owner: number): void
  inject(event: { type: 'move' | 'motion' | 'down' | 'up' | 'wheel' | 'keydown' | 'keyup'; x?: number; y?: number; button?: number; dx?: number; dy?: number; source?: 'wheel' | 'finger' | 'continuous'; code?: number }): void
  quit(): void
  readonly socketName: string
}

export interface ShellWindow {
  readonly id: number
  readonly window?: number
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

interface AnimateOptions {
  opacity?: number
  scale?: number
  dx?: number
  dy?: number
  duration?: number
  delay?: number
  easing?: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
}

interface BrokerOptions {
  readonly packages: Packages
  readonly desktop: InstalledDesktop
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly reducedMotion: boolean | null
  readonly dark: boolean
  readonly session: boolean
  readonly storageFile: (desktop: string) => string | null
  readonly standalone: string | null
}

export interface WireMenu {
  readonly id: string
  readonly label: string
  readonly items: readonly ({ readonly type: 'separator' } | { readonly id: string; readonly label: string; readonly shortcut?: string; readonly checked?: boolean; readonly disabled?: boolean; readonly action: boolean })[]
}

export interface WebInit {
  readonly kind: 'desktop' | 'window'
  readonly name: string
  readonly token: bigint
  readonly window: number
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly screen?: { width: number; height: number }
  readonly reducedMotion: boolean | null
  readonly dark: boolean
  readonly languages: Languages
  readonly services: Readonly<Record<string, ServiceShape>>
  readonly resources: { prefix: string; dirs: string[] }[]
  readonly page?: string
  readonly storageFile?: string | null
  readonly standalone?: string | null
  readonly app?: AppManifest
  readonly theme?: string
  readonly request?: Record<string, unknown> | null
  readonly url?: string | null
  readonly sockets?: string
}

export interface ServiceShape {
  readonly methods: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
  readonly sync: Readonly<Record<string, unknown>>
  readonly callable: boolean
}

class Web {
  readonly rpc: Rpc
  hung = false
  closing = false
  reloading = false
  readonly owns = new Map<number, number>()

  constructor(readonly kind: 'desktop' | 'window', readonly name: string, readonly window: number, readonly worker: WebThread, readonly app: AppManifest | null) {
    this.rpc = new Rpc(worker)
  }

  post(message: unknown): void {
    this.worker.postMessage(message)
  }
}

interface WindowRecord {
  readonly id: number
  readonly kind: 'native' | 'web'
  appId: string | null
  title: string | null
  owner: Web | null
  web: Web | null
  app: AppManifest | null
  menus: WireMenu[]
  request?: Record<string, unknown> | null
  url?: string | null
  mode?: 'fullscreen' | 'free'
  hidden?: boolean
}

export class Broker {
  static readonly HANG_MS = 5000
  static readonly CLOSE_WAIT_MS = 3000
  static readonly RESTARTS = 3
  static readonly SYNC = ['session.own'] as const
  static readonly BROWSER = 'browser'

  readonly native: Native
  readonly shell: BrokerShell
  readonly apps: AppRegistry
  readonly bridge: PageBridge
  readonly opener: Opener
  readonly natives = new NativeApps()
  readonly session = new DesktopSession()
  readonly language = new SessionLanguage((languages) => {
    for (const web of this.#webs()) web.post({ type: 'languages', ...languages })
  })
  readonly backends: AppBackends
  readonly inspect: Inspect
  #accessibility: Promise<NativeAccessibility | null> | null = null
  readonly #options: BrokerOptions
  #current: InstalledDesktop
  #desktop: Web | null = null
  readonly #windows = new Map<number, WindowRecord>()
  readonly #panels = new Set<number>()
  readonly #places = new WindowPlaces()
  readonly #placed = new Map<number, string>()
  readonly #claims: { web: Web; pid: number }[] = []
  #output: { width: number; height: number; scale: number }
  readonly #desktopCrashes = new Crashes(Broker.RESTARTS)
  readonly #themes = new Map<string, string>()
  #stopped = false
  #dark: boolean
  #ended: RunEnd = 'signal'
  #wake: (() => void) | null = null
  #signal: AbortSignal | null = null
  onDesktopShown: () => void = () => {}

  constructor(native: Native, options: BrokerOptions) {
    this.native = native
    this.#options = options
    this.#dark = options.dark
    this.#current = options.desktop
    this.apps = new AppRegistry(options.packages)
    this.bridge = new PageBridge()
    this.opener = new Opener({
      apps: () => this.apps.list().filter((app) => this.#available(app)),
      locate: async (path) => {
        const fs = this.bridge.value['fs'] as { locate(path: string): Promise<{ root: string; path: string }> } | undefined
        return fs ? fs.locate(path).catch(() => null) : null
      },
      launch: (app, request) => this.#raise(this.launch(app, request)),
      spawn: (argv) => void this.shell.launch(argv),
    })
    this.shell = native.Shell.broker()
    this.shell.onEvents(() => this.#poke())
    this.#output = { width: options.width * options.scale, height: options.height * options.scale, scale: options.scale }
    this.session.own = options.session
    this.session.attach(this.shell)
    this.session.language = this.language
    this.backends = new AppBackends({
      resources: () => this.#resources(),
      wanted: (id) => !!this.#running(id),
    })
    this.inspect = new Inspect({
      shell: this.shell,
      web: (id) => (id === 0 ? this.#desktop : (this.#windows.get(id)?.web ?? null))?.rpc ?? null,
      record: (id) => {
        const r = this.#windows.get(id)
        return r ? { kind: r.kind, app: r.app?.id ?? r.appId, title: r.title } : null
      },
      panel: (id) => this.#panels.has(id),
      close: async (id) => (this.#windows.get(id)?.kind === 'web' ? this.closeWeb(id) : this.shell.close(id)),
      hide: (id, hidden) => this.#hide(id, hidden),
      open: (name) => this.#openByName(name),
      accessibility: () => this.accessibility(),
      records: () => [...this.#windows.keys()],
    })
    this.bridge.services.inspect = this.inspect.api
    StartupTimeline.mark('shell created')
  }

  accessibility(): Promise<NativeAccessibility | null> {
    if (this.#accessibility) return this.#accessibility
    const native = this.native.Accessibility
    this.#accessibility = native
      ? native.open().catch((error: Error) => {
          Log.write(Level.Warn, 'acde_host', `AT-SPI: ${error.message}; native windows have no semantics`)
          return null
        })
      : Promise.resolve(null)
    return this.#accessibility
  }

  async #openByName(name: string): Promise<string> {
    const wanted = name.trim().toLowerCase()
    const apps = this.#appList()
    const app = apps.find((a) => a.id.toLowerCase() === wanted) ?? apps.find((a) => a.label.toLowerCase() === wanted) ?? apps.find((a) => a.label.toLowerCase().includes(wanted))
    if (app) {
      this.#raise(this.launch(app.id))
      return `打开了应用 ${app.label} (${app.id})`
    }
    const natives = this.natives.list()
    const native = natives.find((n) => n.id.toLowerCase() === wanted || n.id.toLowerCase() === `${wanted}.desktop`) ?? natives.find((n) => n.name.toLowerCase() === wanted) ?? natives.find((n) => n.name.toLowerCase().includes(wanted))
    const file = native && this.natives.file(native.id)
    if (!native || !file) throw Object.assign(new Error(`没有叫 ${name} 的应用 (acde 应用: ${apps.map((a) => a.label).join(', ')})`), { status: 404 })
    this.shell.launch(['gio', 'launch', file])
    return `起了原生程序 ${native.name} (${native.id})`
  }

  setDark(dark: boolean): void {
    if (this.#dark === dark) return
    this.#dark = dark
    Log.write(Level.Info, 'acde_host', `color scheme: ${dark ? 'dark' : 'light'}`)
    for (const web of this.#webs()) web.post({ type: 'colorscheme', dark })
  }

  #events(): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        if (this.#wake === wake) this.#wake = null
        resolve()
      }
      this.#wake = wake
    })
  }

  #poke(): void {
    this.#wake?.()
  }

  async startServices(): Promise<void> {
    StartupTimeline.mark('services starting')
    if (this.#options.session) void this.accessibility()
    await this.bridge.start(this.native, this.#current)
    StartupTimeline.mark('services started')
  }

  readonly desktops = {
    list: () => {
      const { packages } = this.#options
      return {
        desktops: [
          ...packages.desktops().map((d) => ({ kind: d.kind, id: d.id, name: d.name, description: d.description, package: d.package.name })),
          ...packages.sessions().map((s) => ({ kind: s.kind, id: s.id, name: s.name, description: s.description, package: null })),
        ],
        current: this.#current.id,
      }
    },
    choose: async (id: string, remember = false): Promise<void> => {
      const next = this.#options.packages.find(String(id))
      if (!next) throw Object.assign(new Error(`no desktop ${id}`), { status: 404 })
      if (next.kind === 'session' && this.#options.standalone) throw Object.assign(new Error(`acdert app: ${id} is not an acde desktop`), { status: 409 })
      if (remember) Packages.remember(next.id)
      if (next.kind === 'session') return this.session.handOff(next)
      if (next.id === this.#current.id) return
      Log.write(Level.Info, 'acde_host', `switching to desktop ${next.id}`)
      const old = this.#desktop
      if (old) old.closing = true
      this.#desktop = null
      await old?.worker.terminate().catch(() => 0)
      this.#current = next
      await this.bridge.startDesktop(next, this.native)
      this.startDesktop()
    },
  }

  get desktopId(): string {
    return this.#current.id
  }

  async run(signal?: AbortSignal): Promise<RunEnd> {
    const watchdog = setInterval(() => this.#watch(), 1000)
    const abort = (): void => this.#poke()
    this.#signal = signal ?? null
    signal?.addEventListener('abort', abort)
    try {
      while (!this.#stopped && !signal?.aborted) {
        for (const event of this.shell.pump()) this.#event(event)
        if (this.#stopped || signal?.aborted) break
        await this.#events()
      }
    } finally {
      clearInterval(watchdog)
      signal?.removeEventListener('abort', abort)
    }
    return this.#ended
  }

  async close(): Promise<void> {
    this.#stopped = true
    this.#poke()
    const webs = this.#webs()
    for (const web of webs) web.closing = true
    this.#keepPlaces()
    this.#desktop = null
    await Promise.all([...webs.map((web) => web.worker.terminate().catch(() => 0)), this.backends.stopAll()])
    await this.bridge.close()
  }

  startDesktop(): void {
    const grant = this.shell.grant({ desktop: true })
    const { storageFile, standalone } = this.#options
    const init: WebInit = {
      kind: 'desktop',
      name: 'desktop',
      token: grant.token,
      window: 0,
      width: this.#output.width,
      height: this.#output.height,
      scale: this.#output.scale,
      screen: this.#screen(),
      reducedMotion: this.#options.reducedMotion,
      dark: this.#dark,
      languages: this.language.current,
      services: this.#shapes(null),
      resources: this.#resources(),
      page: this.#current.html,
      storageFile: storageFile(this.#current.id),
      standalone,
    }
    this.#desktop = this.#spawn(init, this.#current.heapMb)
    if (standalone && ![...this.#windows.values()].some((r) => r.app?.id === standalone)) {
      try {
        this.launch(standalone, null, 'fullscreen')
      } catch (error) {
        Log.write(Level.Error, 'acde_host', `acdert app ${standalone}: ${(error as Error).message}`)
      }
    }
    for (const record of this.#windows.values()) this.#announce(record)
  }

  #spawnWindow(record: WindowRecord, token: bigint = this.shell.grant({ window: record.id, mode: record.mode, ...(record.app?.size && { size: record.app.size }) }).token): void {
    const app = record.app!
    this.#placed.set(record.id, app.id)
    const init: WebInit = {
      kind: 'window',
      name: `${app.id}#${record.id}`,
      token,
      window: record.id,
      width: 800 * this.#output.scale,
      height: 600 * this.#output.scale,
      scale: this.#output.scale,
      screen: this.#screen(),
      reducedMotion: this.#options.reducedMotion,
      dark: this.#dark,
      languages: this.language.current,
      services: this.#shapes(app.capabilities),
      resources: PageSource.isHtml(app.entry) ? PageSource.rooted(app.entry, this.#resources()) : this.#resources(),
      app,
      theme: this.#theme(),
      storageFile: StorageFile.forApp(app.id),
      request: record.request ?? null,
      url: record.url ?? null,
      ...(app.backend && { sockets: AppBackends.socketDir(app.id) }),
    }
    record.request = null
    record.web = this.#spawn(init, app.heapMb)
    if (record.hidden) this.#tellVisible(record)
  }

  #spawn(init: WebInit, heapMb: number): Web {
    const worker = new WebThread({ name: init.name, init, env: { ...Broker.#env(), WAYLAND_DISPLAY: this.shell.socketName }, heapMb, grants: Broker.#grants(init.app?.capabilities ?? null), onExit: (code, reason) => this.#exited(web, code, reason) })
    const web = new Web(init.kind, init.name, init.window, worker, init.app ?? null)
    web.rpc.serve((service, method, args) => this.#serve(web, service, method, args))
    return web
  }

  static readonly #LOCAL = new Set(['fs', 'terminal', 'network', 'office'])

  static #grants(caps: Capabilities | null): WebGrants {
    if (!caps) return { fs: true, terminal: true, network: true, office: true }
    const fs = caps.fs
    return { fs: typeof fs === 'object' && fs ? [...fs.roots] : fs ? true : null, terminal: !!caps.terminal, network: !!caps.network, office: !!caps.office }
  }

  static #env(): Record<string, string> {
    const keep = /^(ACDE_|XDG_|LANG$|LC_|LANGUAGE$|HOME$|USER$|DBUS_SESSION_BUS_ADDRESS$|RUST_LOG$|TZ$|PATH$|RUST_BACKTRACE$)/
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => keep.test(entry[0]) && entry[1] !== undefined))
  }

  #theme(): string {
    const id = this.#current.id
    let theme = this.#themes.get(id)
    if (theme === undefined) {
      try {
        theme = /:root\s*\{[^}]*\}/.exec(readFileSync(this.#current.html, 'utf8'))?.[0] ?? ''
      } catch {
        theme = ''
      }
      this.#themes.set(id, theme)
    }
    return theme
  }

  #webs(): Web[] {
    return [this.#desktop, ...[...this.#windows.values()].map((r) => r.web)].filter((w): w is Web => !!w)
  }

  #resources(): { prefix: string; dirs: string[] }[] {
    return this.#options.packages.resources()
  }

  #exited(web: Web, code: number, reason: string | null): void {
    web.rpc.fail('acde: the web stopped')
    if (this.#stopped && web.closing) return
    if (web.kind === 'desktop') {
      if (this.#desktop !== web) return
      this.#desktop = null
      if (this.#stopped) return
      const crashes = this.#desktopCrashes.note()
      if (crashes.tooMany) {
        Log.write(Level.Error, 'acde_host', `the desktop stopped ${crashes.count} times in a minute (exit ${code}${reason ? `, ${reason}` : ''}); the session ends`)
        this.#stopped = true
        this.#ended = 'exit'
        this.#poke()
        return
      }
      Log.write(Level.Warn, 'acde_host', `the desktop stopped (exit ${code}${reason ? `, ${reason}` : ''}); starting it again`)
      setTimeout(() => !this.#stopped && this.startDesktop(), 500)
      return
    }
    const record = this.#windows.get(web.window)
    if (!record || record.web !== web) return
    record.web = null
    this.#closePrograms(web)
    this.#claims.splice(0, this.#claims.length, ...this.#claims.filter((c) => c.web !== web))
    if (web.reloading && !web.closing && !this.#stopped) return this.#spawnWindow(record)
    if (!web.closing) {
      this.#toDesktop({ type: 'windowcrash', window: record.id, reason: reason ?? (code === 0 ? 'exit' : `exit ${code}`) })
      Log.write(Level.Warn, 'acde_host', `[${web.name}] stopped (${reason ?? `exit ${code}`})`)
    }
    this.#forget(record)
  }

  #forget(record: WindowRecord): void {
    this.#windows.delete(record.id)
    this.shell.release(record.id)
    unref(setTimeout(() => !this.#windows.has(record.id) && this.#placed.delete(record.id), Broker.CLOSE_WAIT_MS))
    this.#toDesktop({ type: 'windowclose', window: record.id })
    if (record.app?.backend && !this.#running(record.app.id)) void this.backends.stop(record.app.id)
  }

  #running(appId: string): WindowRecord | undefined {
    for (const record of this.#windows.values()) if (record.kind === 'web' && record.app?.id === appId) return record
    return undefined
  }

  #hide(id: number, hidden: boolean): void {
    this.shell.hide(id, hidden)
    const record = this.#windows.get(id)
    if (!record || !!record.hidden === hidden) return
    record.hidden = hidden
    this.#tellVisible(record)
  }

  #tellVisible(record: WindowRecord): void {
    void record.web?.rpc.call('window', 'visible', [!record.hidden]).catch(() => undefined)
  }

  #closePrograms(web: Web): void {
    const owned = [...web.owns]
    for (const [id] of owned) this.shell.close(id)
    unref(setTimeout(() => {
      for (const [id, pid] of owned) {
        if (!this.#windows.has(id) || !(pid > 0)) continue
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
        }
      }
    }, Broker.CLOSE_WAIT_MS))
  }

  #watch(): void {
    for (const web of this.#webs()) {
      if (web.closing) continue
      const busy = web.worker.busyMs() >= Broker.HANG_MS
      if (web.hung && !busy) {
        web.hung = false
        this.#toDesktop({ type: 'windowresponsive', window: web.window })
      }
      if (web.hung || !busy) continue
      web.hung = true
      Log.write(Level.Warn, 'acde_host', `[${web.name}] not answering for ${Broker.HANG_MS / 1000} s`)
      if (web.kind === 'window') this.#toDesktop({ type: 'windowhang', window: web.window })
    }
  }

  #screen(): { width: number; height: number } {
    const scale = this.#output.scale || 1
    return { width: Math.round(this.#output.width / scale), height: Math.round(this.#output.height / scale) }
  }

  #event(event: RawShellEvent): void {
    switch (event.type) {
      case 'output':
        if (event.width && event.height) {
          const was = this.#screen()
          this.#output = { width: event.width, height: event.height, scale: event.scale ?? this.#output.scale }
          const screen = this.#screen()
          if (screen.width !== was.width || screen.height !== was.height) for (const web of this.#webs()) web.post({ type: 'screen', ...screen })
        }
        return
      case 'milestone':
        return StartupTimeline.mark(`shell ${event.title}`)
      case 'shortcut': {
        const owner = event.window === undefined ? undefined : this.#windows.get(event.window)
        const to = event.title === 'app' && owner?.web ? owner.web : this.#desktop
        return to?.post({ type: 'events', events: [event] })
      }
      case 'close':
      case 'exit':
        this.#stopped = true
        this.#ended = this.#signal?.aborted ? 'signal' : event.type
        return
    }
    if (!event.type.startsWith('window') || event.window === undefined) return
    if (event.type === 'windowgone') return this.#gone(event)
    const record = this.#windows.get(event.window)
    if (record?.kind === 'web') return this.#toDesktop(event)
    if (event.type === 'windowopen') {
      const claim = this.#claims.shift() ?? null
      const opened: WindowRecord = { id: event.window, kind: 'native', appId: event.appId ?? null, title: event.title ?? null, owner: claim?.web ?? null, web: null, app: null, menus: [] }
      this.#windows.set(event.window, opened)
      if (claim) {
        claim.web.owns.set(event.window, claim.pid)
        return claim.web.post({ type: 'events', events: [event] })
      }
      return this.#toDesktop(event)
    }
    if (!record) return this.#toDesktop(event)
    if (event.type === 'windowtitle') {
      record.title = event.title ?? record.title
      record.appId = event.appId ?? record.appId
    }
    if (event.type === 'windowclose') {
      this.#windows.delete(event.window)
      record.owner?.owns.delete(event.window)
    }
    if (record.owner) record.owner.post({ type: 'events', events: [event] })
    else this.#toDesktop(event)
  }

  #gone(event: RawShellEvent): void {
    const app = this.#placed.get(event.window!)
    if (!app) return
    if (!this.#windows.has(event.window!)) this.#placed.delete(event.window!)
    this.#places.set(app, [event.x ?? NaN, event.y ?? NaN, event.width ?? NaN, event.height ?? NaN])
  }

  #keepPlaces(): void {
    for (const row of this.shell.windows()) {
      const app = row.window === undefined ? undefined : this.#placed.get(row.window)
      if (app && (row.mode === 'free' || row.mode === 'fixed')) this.#places.set(app, [row.x, row.y, row.width, row.height])
    }
    this.#places.flush()
  }

  #toDesktop(event: Record<string, unknown> | RawShellEvent): void {
    this.#desktop?.post({ type: 'events', events: [event] })
  }

  #announce(record: WindowRecord): void {
    if (record.owner) return
    if (record.kind === 'web') {
      this.#toDesktop({ type: 'windowopen', window: record.id, appId: record.app!.id, title: record.title ?? record.app!.label, web: true, icon: record.app!.icon })
      if (record.menus.length) this.#toDesktop({ type: 'windowmenus', window: record.id, menus: record.menus })
    } else {
      this.#toDesktop({ type: 'windowopen', window: record.id, appId: record.appId, title: record.title })
    }
  }

  launch(appId: string, request: Record<string, unknown> | null = null, mode: 'fullscreen' | 'free' = 'free'): { window: number } {
    const app = this.apps.get(appId) ?? (this.refreshApps(), this.apps.get(appId))
    if (!app) throw Object.assign(new Error(`no app ${appId}`), { status: 404 })
    if (!this.#available(app)) throw Object.assign(new Error(`${app.label}: the system service it needs is not running`), { status: 503 })
    if (!app.multiple) {
      const running = this.#running(appId)
      if (running) {
        if (request) this.#deliver(running, request)
        return { window: running.id }
      }
    }
    const rect = mode === 'free' && !this.#running(appId) ? this.#places.get(appId, this.#screen()) : null
    const grant = this.shell.grant({ mode, ...(rect ? { rect } : app.size && { size: app.size }) })
    const record: WindowRecord = { id: grant.window, kind: 'web', appId: app.id, title: app.label, owner: null, web: null, app, menus: [], request, mode }
    this.#windows.set(record.id, record)
    this.#spawnWindow(record, grant.token)
    this.#announce(record)
    if (app.backend) this.backends.start(app)
    return { window: record.id }
  }

  #raise(opened: { window: number }): { window: number } {
    this.#hide(opened.window, false)
    this.shell.focus(opened.window)
    this.#toDesktop({ type: 'windowshow', window: opened.window })
    return opened
  }

  async openFromBus(request: { kind: 'folders' | 'items' | 'properties' | 'open'; uris: string[]; app: string }): Promise<void> {
    const options: OpenOptions = request.kind === 'open' ? (request.app ? { app: request.app } : {}) : { select: request.kind !== 'folders' }
    for (const uri of request.uris) await this.opener.open(uri, options)
  }

  #appList(): { id: string; label: string; icon: string; script: string }[] {
    return this.apps.list().filter((app) => this.#available(app)).map(({ id, label, icon, entry }) => ({ id, label, icon, script: entry }))
  }

  refreshApps(): { id: string; label: string; icon: string; script: string }[] {
    this.#options.packages.rescan()
    const changed = this.apps.reload(this.#options.packages)
    const apps = this.#appList()
    if (changed) this.#toDesktop({ type: 'appschanged', apps })
    return apps
  }

  installApps(dir: string): { id: string; dir: string; apps: { id: string; label: string; icon: string; script: string }[] } {
    const installed = Packages.install(String(dir))
    Log.write(Level.Info, 'acde_host', `installed package ${installed.id} from ${dir} into ${installed.dir}`)
    return { ...installed, apps: this.refreshApps() }
  }

  #deliver(record: WindowRecord, request: Record<string, unknown>): void {
    if (record.web) void record.web.rpc.call('window', 'request', [request]).catch(() => undefined)
    else record.request = request
  }

  #available(app: AppManifest): boolean {
    return this.bridge.available(app.capabilities)
  }

  async closeWeb(id: number, force = false): Promise<boolean> {
    const record = this.#windows.get(id)
    if (!record || record.kind !== 'web') return false
    const web = record.web
    if (web && !force) {
      const close = await within(web.rpc.call('window', 'beforeclose'), Broker.CLOSE_WAIT_MS, true as unknown).catch(() => true)
      if (close === false) return false
    }
    if (web) {
      web.closing = true
      await web.worker.terminate()
    } else {
      this.#forget(record)
    }
    return true
  }

  #shapes(caps: Capabilities | null): Record<string, ServiceShape> {
    const shapes: Record<string, ServiceShape> = {}
    for (const [service, target] of Object.entries(this.bridge.value)) {
      if (Broker.#LOCAL.has(service) || (caps && !this.#allowed(caps, service))) continue
      shapes[service] = this.#shape(service, target)
    }
    for (const [service, api] of Object.entries(this.#builtins())) if (!caps || (service !== 'inspect' && caps[service])) shapes[service] = this.#shape(service, api)
    return shapes
  }

  #builtins(): Record<'inspect' | 'session' | 'desktops', Record<string, (...args: never[]) => unknown>> {
    return { inspect: this.inspect.api, session: this.session.api, desktops: this.desktops }
  }

  #shape(service: string, target: unknown): ServiceShape {
    const methods = new Set<string>()
    const values: Record<string, unknown> = {}
    for (let o = target as object | null; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Object.getOwnPropertyNames(o)) {
        if (key === 'constructor' || methods.has(key) || key in values || (o === target && typeof target === 'function' && ['length', 'name', 'prototype', 'caller', 'arguments'].includes(key))) continue
        let value: unknown
        try {
          value = (target as Record<string, unknown>)[key]
        } catch {
          continue
        }
        if (typeof value === 'function') methods.add(key)
        else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) values[key] = value
      }
    }
    const sync: Record<string, unknown> = {}
    for (const name of [...Broker.SYNC, ...this.bridge.services.sync]) {
      const [owner, method] = name.split('.') as [string, string]
      if (owner !== service || !methods.has(method)) continue
      try {
        sync[method] = (target as Record<string, () => unknown>)[method]!()
      } catch {
        sync[method] = null
      }
    }
    return { methods: [...methods], values, sync, callable: typeof target === 'function' }
  }

  #allowed(caps: Capabilities, namespace: string): boolean {
    return !!caps[this.bridge.services.capability.get(namespace) ?? namespace]
  }

  async #serve(web: Web, service: string, method: string, args: unknown[]): Promise<unknown> {
    const desktop = web.kind === 'desktop'
    const caps = web.app?.capabilities ?? null
    if (service === 'windows') return this.#windowsCall(web, method, args)
    if (service === 'apps') {
      if (method === 'list') return this.#appList()
      if (method === 'refresh' || method === 'install') {
        if (!desktop) throw Broker.#refused(web, `acde.apps.${method}`)
        return method === 'refresh' ? this.refreshApps() : this.installApps(String(args[0]))
      }
      if (method === 'natives' || method === 'runNative') {
        if (!desktop) throw Broker.#refused(web, `acde.apps.${method}`)
        if (method === 'natives') return this.natives.list()
        const file = this.natives.file(String(args[0]))
        if (!file) throw Object.assign(new Error(`no native app ${String(args[0])}`), { status: 404 })
        return this.shell.launch(['gio', 'launch', file])
      }
      if (method === 'openPath' || method === 'handlers' || method === 'setDefault') {
        if (!desktop && !caps?.['openFiles']) throw Broker.#refused(web, 'opening files with their apps')
        if (method === 'openPath') return this.opener.open(String(args[0]), (args[1] ?? {}) as OpenOptions)
        if (method === 'handlers') return this.opener.handlers(String(args[0]))
        return this.opener.setDefault(String(args[0]), String(args[1]))
      }
      if (method === 'launch' || method === 'open') {
        const [appId, request] = args as [string, Record<string, unknown> | undefined]
        const open = caps?.open
        if (!desktop && !(open === true || (Array.isArray(open) && open.includes(appId)))) throw Broker.#refused(web, `open ${appId}`)
        return this.launch(appId, request ?? null)
      }
      throw new Error(`acde.apps has no ${method}`)
    }
    if (service === 'window') return this.#selfCall(web, method, args)
    if (service === 'panel') return this.#panelCall(web, method, args)
    if (service === 'page') return this.#pageCall(web, method, args)
    if (service === 'inspect' || service === 'session' || service === 'desktops') {
      if (!desktop && (service === 'inspect' || !caps?.[service])) throw Broker.#refused(web, `acde.${service}`)
      const call = (this.#builtins()[service] as Record<string, (...a: unknown[]) => unknown>)[method]
      if (!call) throw new Error(`acde.${service} has no ${method}`)
      return call(...args)
    }
    if (caps && !this.#allowed(caps, service)) throw Broker.#refused(web, `acde.${service}`)
    if (Broker.#LOCAL.has(service)) throw new Error(`acde.${service} is bound in the web itself, not served by the Broker`)
    const target = this.bridge.value[service] as Record<string, (...a: unknown[]) => unknown> | ((...a: unknown[]) => unknown) | undefined
    if (!target) throw Object.assign(new Error(`acde.${service} is not running`), { status: 503 })
    if (method === '' && typeof target === 'function') return target(...args)
    const fn = (target as Record<string, (...a: unknown[]) => unknown>)[method]
    if (typeof fn !== 'function') throw new Error(`acde.${service} has no ${method}`)
    return fn.apply(target, args)
  }

  static #refused(web: Web, what: string): Error {
    return Object.assign(new Error(`${web.app?.label ?? web.kind} may not use ${what} (not in its manifest's capabilities)`), { status: 403, code: 'forbidden' })
  }

  async #windowsCall(web: Web, method: string, args: unknown[]): Promise<unknown> {
    const desktop = web.kind === 'desktop'
    const caps = web.app?.capabilities ?? {}
    const id = Number(args[0])
    const mine = (window: number) => desktop || web.owns.has(window)
    switch (method) {
      case 'launch': {
        const [argv, options] = args as [string[], { cwd?: string; env?: Record<string, string>; slot?: boolean } | undefined]
        const slot = !!options?.slot && !desktop
        if (!desktop && !(slot ? caps.slots : caps.launch)) throw Broker.#refused(web, slot ? 'native programs in its slots' : 'starting programs')
        const pid = this.shell.launch(argv, { cwd: options?.cwd, env: options?.env })
        if (slot) this.#claims.push({ web, pid })
        return pid
      }
      case 'close': {
        if (!mine(id)) throw Broker.#refused(web, `window ${id}`)
        if (this.#windows.get(id)?.kind === 'web') return this.closeWeb(id)
        this.shell.close(id)
        return true
      }
      case 'kill':
        if (!desktop) throw Broker.#refused(web, `window ${id}`)
        return this.closeWeb(id, true)
      case 'invokeMenu': {
        if (!desktop) throw Broker.#refused(web, `the menus of window ${id}`)
        const record = this.#windows.get(id)
        return record?.web?.rpc.call('window', 'menu', [args[1], args[2]])
      }
      case 'focus':
      case 'hide':
      case 'show':
        if (!desktop) throw Broker.#refused(web, `window ${id}`)
        if (method === 'focus') return this.shell.focus(id)
        return this.#hide(id, method === 'hide')
      case 'stats':
        if (!desktop) throw Broker.#refused(web, 'compositor stats')
        return this.shell.stats()
      case 'screenshot':
        if (!desktop) throw Broker.#refused(web, 'screenshots')
        return this.shell.screenshot(String(args[0]))
      case 'animate':
        if (!desktop) throw Broker.#refused(web, `animating window ${id}`)
        return this.shell.animate(id, (args[1] ?? {}) as AnimateOptions)
      case 'shortcut':
      case 'unshortcut': {
        const [combo, scope] = [String(args[0]), String(args[1] ?? 'desktop')]
        if (!desktop || (scope !== 'session' && scope !== 'desktop')) throw Broker.#refused(web, `${scope} shortcuts`)
        return method === 'shortcut' ? this.shell.shortcut(combo, scope, 0) : this.shell.unshortcut(combo, scope, 0)
      }
    }
    throw new Error(`acde.windows has no ${method}`)
  }

  #panelCall(web: Web, method: string, args: unknown[]): unknown {
    if (web.kind !== 'desktop') throw Broker.#refused(web, 'pinned panels')
    const rect = (value: unknown): [number, number, number, number] => {
      const v = Array.isArray(value) ? value.map((n) => Math.round(Number(n) || 0)) : []
      return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]
    }
    const id = Number(args[0])
    switch (method) {
      case 'open': {
        const grant = this.shell.grant({ mode: 'pinned', rect: rect(args[0]) })
        this.#panels.add(grant.window)
        return grant
      }
      case 'place': {
        if (!this.#panels.has(id)) throw Broker.#refused(web, `window ${id}`)
        const [x, y, width, height] = rect(args[1])
        if (width <= 0 || height <= 0) return this.shell.hide(id, true)
        this.shell.place(id, x, y, width, height)
        return this.shell.hide(id, false)
      }
      case 'close':
        if (this.#panels.delete(id)) this.shell.release(id)
        return
    }
    throw new Error(`acde.panel has no ${method}`)
  }

  #selfCall(web: Web, method: string, args: unknown[]): unknown {
    const record = this.#windows.get(web.window)
    if (web.kind !== 'window' || !record) throw new Error('acde.window: only a window web has a window')
    switch (method) {
      case 'setTitle':
        record.title = String(args[0])
        return this.#toDesktop({ type: 'windowtitle', window: record.id, appId: record.app!.id, title: record.title })
      case 'setMenus':
        record.menus = (args[0] as WireMenu[]) ?? []
        return this.#toDesktop({ type: 'windowmenus', window: record.id, menus: record.menus })
      case 'close':
        return this.closeWeb(record.id, true)
      case 'minimize':
        return this.#toDesktop({ type: 'windowminimize', window: record.id })
      case 'requestAttention':
        return this.#toDesktop({ type: 'windowattention', window: record.id })
      case 'shortcut':
        return this.shell.shortcut(String(args[0]), 'app', record.id)
      case 'unshortcut':
        return this.shell.unshortcut(String(args[0]), 'app', record.id)
      case 'ready':
        return this.#toDesktop({ type: 'windowready', window: record.id })
      case 'reload': {
        if (record.web !== web || web.closing) return false
        const url = args[0] === undefined || args[0] === null ? null : String(args[0])
        if (url !== null && !url.startsWith(`${PageSource.ORIGIN}/`)) return false
        if (url !== null) record.url = url
        web.reloading = true
        void web.worker.terminate().catch(() => 0)
        return true
      }
      case 'openUrl': {
        const url = String(args[0])
        if (!/^https?:\/\//i.test(url)) return false
        const browser = this.apps.get(Broker.BROWSER)
        if (!browser || !this.#available(browser)) {
          Log.write(Level.Warn, 'acde_host', `[${web.name}] opens ${url}: no ${Broker.BROWSER} app installed`)
          return false
        }
        this.launch(Broker.BROWSER, { url })
        return true
      }
    }
    throw new Error(`acde.window has no ${method}`)
  }

  async #pageCall(web: Web, method: string, args: unknown[]): Promise<unknown> {
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).slice(0, max)
    const filters = (value: unknown) =>
      (Array.isArray(value) ? value : []).slice(0, 32).map((f: { name?: unknown; globs?: unknown; mimes?: unknown }) => ({
        name: text(f?.name, 200),
        globs: (Array.isArray(f?.globs) ? f.globs : []).map((g: unknown) => text(g, 100)).filter(Boolean),
        mimes: (Array.isArray(f?.mimes) ? f.mimes : []).map((m: unknown) => text(m, 100)).filter(Boolean),
      })).filter((f) => f.globs.length || f.mimes.length)
    switch (method) {
      case 'shown':
        if (web === this.#desktop) this.onDesktopShown()
        return
      case 'open':
      case 'save': {
        const options = (args[0] ?? {}) as Record<string, unknown>
        const chooser = await this.#fileChooser()
        if (!chooser) return null
        const label = web.app?.label ?? '桌面'
        if (method === 'open') return chooser.openFile({ title: `${label}: 打开`, multiple: options['multiple'] === true, directory: options['directory'] === true, filters: filters(options['filters']) })
        return chooser.saveFile({ title: `${label}: 保存`, name: text(options['name'], 255), filters: filters(options['filters']) })
      }
      case 'download': {
        const [name, type, bytes] = args as [unknown, unknown, unknown]
        if (!(bytes instanceof Uint8Array)) throw new TypeError('acde: a download is bytes')
        const path = Downloads.save(text(name, 1000), text(type, 200), bytes)
        Log.write(Level.Info, 'acde_host', `[${web.name}] saved ${path} (${bytes.length} bytes)`)
        this.#toDesktop({ type: 'download', window: web.window, app: web.app?.id ?? null, path, name: basename(path), size: bytes.length })
        return path
      }
      case 'notify': {
        const n = (args[0] ?? {}) as Record<string, unknown>
        const icon = text(n['icon'], 256 * 1024)
        this.#toDesktop({ type: 'notification', window: web.window, app: web.app?.id ?? null, label: web.app?.label ?? null, title: text(n['title'], 200), body: text(n['body'], 2000), icon: /^(data:image\/|http:\/\/acde\.local\/)/.test(icon) ? icon : '', tag: text(n['tag'], 200) })
        return true
      }
    }
    throw new Error(`acde: no page call ${method}`)
  }

  #fileChooser(): Promise<NativeFileChooser | null> {
    this.#chooser ??= (async () => {
      const FileChooser = this.native.FileChooser
      if (!FileChooser) return null
      try {
        return await FileChooser.open()
      } catch (error) {
        if (!this.#chooserWarned) Log.write(Level.Warn, 'acde_host', `no file chooser: ${(error as Error).message}`)
        this.#chooserWarned = true
        this.#chooser = null
        return null
      }
    })()
    return this.#chooser
  }
  #chooser: Promise<NativeFileChooser | null> | null = null
  #chooserWarned = false

  debugEval(name: string, code: string): Promise<unknown> {
    const webs = this.#webs()
    const web = webs.find((w) => w.name === name)
    if (!web) return Promise.reject(new Error(`no web ${name} (${webs.map((w) => w.name).join(', ')})`))
    return web.rpc.call('debug', 'eval', [code])
  }

  async debugStats(reset = false): Promise<Record<string, unknown>> {
    const webs = this.#webs()
    const stats = await Promise.all(webs.map((w) => w.rpc.call('debug', 'stats', [reset]).catch((e: Error) => ({ error: e.message }))))
    return Object.fromEntries(webs.map((w, i) => [w.name, { ...(stats[i] as object), cpuMs: w.worker.cpuMs() }]))
  }

  get windows(): { id: number; kind: string; app: string | null; title: string | null; running: boolean }[] {
    return [...this.#windows.values()].map((r) => ({ id: r.id, kind: r.kind, app: r.app?.id ?? r.appId, title: r.title, running: !!r.web }))
  }
}
