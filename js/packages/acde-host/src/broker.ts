// The Broker: the runtime's main isolate. It scans the packages, runs the desktop package's services, starts the
// desktop, and answers what is not yet the desk's own (the app store: rescanning and installing packages). The windows, apps and the compositor are the desk's (crates/acde `desk/`): every
// desktop and window isolate calls it directly, on its own thread; the Broker does not stand in for them.
import { readFileSync } from './sys/fs'
import { sys } from './sys/natives'
import { AppRegistry, type AppManifest, type Capabilities } from './apps'
import { AppBackends } from './backend'
import { ServiceBinding } from './binding'
import { Crashes } from './crashes'
import { PageBridge } from './bridge'
import type { BrokerDesk, BrokerNotice, DeskRecord, DesktopEntry, InjectEvent, ServiceSpec, ShellWindow } from './desk'
import { StartupTimeline } from './timeline'
import type { Native } from './native'
import { Packages, type InstalledDesktop } from './packages'
import { DesktopSession, type RunEnd } from './session'
import { SessionLanguage, type Languages } from './language'
import { Level, Log } from './log'
import { process } from './sys/process'
import { Modules } from './modules'

/** The compositor as the Broker's helpers (session, main, debug) use it: the desk's link. */
export interface BrokerShell {
  launch(argv: string[], options?: { cwd?: string; env?: Record<string, string> }): number
  focus(window: number): void
  hide(window: number, hidden: boolean): void
  close(window: number): void
  stats(reset?: boolean): Record<string, unknown>
  windows(): ShellWindow[]
  inject(event: InjectEvent): void
  screenshot(path?: string): Promise<{ path: string; width: number; height: number }>
  quit(): void
  readonly socketName: string
}

export type { ShellWindow }

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

/** What a desktop or window isolate starts with (built by the desk, crates/acde `desk/mod.rs`). */
export interface IsolateInit {
  readonly place: 'desktop' | 'window'
  readonly name: string
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
  /** The desktop's page, read by the Broker (the isolate reads no files of its own choosing). */
  readonly html?: string | null
  readonly standalone?: string | null
  readonly app?: AppManifest
  readonly theme?: string
  /** The desktop's window frame module, when this window gets a frame. */
  readonly frame?: string | null
  readonly frameStyle?: 'mac' | 'windows' | null
  readonly frameTheme?: unknown
  readonly doubleClick?: string | null
  readonly request?: Record<string, unknown> | null
  readonly url?: string | null
  readonly sockets?: string
  /** The `acde:` modules of the desk this isolate gets beyond windows and apps (`session`, `desktops`). */
  readonly modules?: readonly string[]
}

export interface ServiceShape {
  readonly methods: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
  readonly sync: Readonly<Record<string, unknown>>
  readonly callable: boolean
}

/** Who called a service: the desk tells (`caller`). */
interface Caller {
  readonly place: 'desktop' | 'window'
  readonly name: string
  readonly app: AppManifest | null
}

export class Broker {
  static readonly RESTARTS = 3
  static readonly SYNC = ['session.own'] as const

  readonly native: Native
  readonly desk: BrokerDesk
  readonly shell: BrokerShell
  readonly apps: AppRegistry
  readonly bridge: PageBridge
  readonly session = new DesktopSession()
  readonly language = new SessionLanguage()
  readonly backends: AppBackends
  readonly #options: BrokerOptions
  #current: InstalledDesktop
  readonly #bindings = new Map<number, ServiceBinding>()
  readonly #inbound = new Map<number, (message: unknown) => void>()
  readonly #desktopCrashes = new Crashes(Broker.RESTARTS)
  readonly #themes = new Map<string, string>()
  #stopped = false
  #dark: boolean
  #ended: RunEnd = 'signal'
  #wake: (() => void) | null = null
  onDesktopShown: () => void = () => {}

  constructor(native: Native, options: BrokerOptions) {
    this.native = native
    this.#options = options
    this.#dark = options.dark
    this.#current = options.desktop
    this.apps = new AppRegistry(options.packages)
    this.bridge = new PageBridge()
    const open = sys().desk
    if (!open) throw new Error('acde: this runtime has no desk (not Linux)')
    this.desk = open({
      width: options.width * options.scale,
      height: options.height * options.scale,
      scale: options.scale,
      reducedMotion: options.reducedMotion,
      dark: options.dark,
      languages: this.language.current,
      resources: options.packages.resources(),
      env: Broker.#env(),
      storage: process.env['ACDE_STORAGE'] !== '',
      theme: this.#theme(),
      frame: options.desktop.frame,
      own: options.session,
      standalone: !!options.standalone,
    }) as BrokerDesk
    const desk = this.desk
    this.shell = {
      launch: (argv, o) => desk.startProgram(argv, o ?? {}),
      focus: (w) => desk.focus(w),
      hide: (w, hidden) => desk.hide(w, hidden),
      close: (w) => desk.close(w),
      stats: (reset) => desk.stats(reset),
      windows: () => desk.windows(),
      inject: (event) => desk.inject(event),
      screenshot: (path) => desk.screenshot(path),
      quit: () => desk.quit(),
      socketName: desk.socketName,
    }
    desk.onNotice((notice) => this.#notice(notice))
    desk.onService((window, message) => {
      this.#binding(window)
      this.#inbound.get(window)?.(message)
    })
    this.session.own = options.session
    this.session.attach(this.shell, () => desk.children())
    this.backends = new AppBackends({
      resources: () => options.packages.resources(),
      wanted: (id) => desk.running(id),
    })
    this.bridge.services.inspect = Modules.inspect(desk)
    this.#publishApps()
    this.desk.look({ desktops: this.#desktops() })
    StartupTimeline.mark('shell created')
  }

  setDark(dark: boolean): void {
    if (this.#dark === dark) return
    this.#dark = dark
    Log.write(Level.Info, 'acde_host', `color scheme: ${dark ? 'dark' : 'light'}`)
    this.desk.look({ dark })
  }

  async startServices(): Promise<void> {
    StartupTimeline.mark('services starting')
    if (this.#options.session) this.desk.warmAccessibility()
    await this.bridge.start(this.native, this.#current, this.desk)
    this.#publishServices()
    StartupTimeline.mark('services started')
  }

  /** What `desktops.list()` answers (the desk keeps it): the installed desktops and the other Wayland sessions. */
  #desktops(): { desktops: DesktopEntry[]; current: string } {
    const { packages } = this.#options
    return {
      desktops: [
        ...packages.desktops().map((d) => ({ kind: d.kind, id: d.id, name: d.name, description: d.description, package: d.package.name })),
        ...packages.sessions().map((s) => ({ kind: s.kind, id: s.id, name: s.name, description: s.description, package: null })),
      ],
      current: this.#current.id,
    }
  }

  /** `desktops.choose`, once the desk has checked it: switch to that desktop, or hand the session to another one. */
  async #choose(id: string): Promise<void> {
    const next = this.#options.packages.find(String(id))
    if (!next) return
    if (next.kind === 'session') return this.session.handOff(next)
    if (next.id === this.#current.id) return
    Log.write(Level.Info, 'acde_host', `switching to desktop ${next.id}`)
    await this.desk.closeDesktop()
    this.#current = next
    await this.bridge.startDesktop(next, this.native)
    this.#publishServices()
    this.desk.look({ theme: this.#theme(), frame: next.frame, desktops: this.#desktops() })
    this.startDesktop()
  }

  get desktopId(): string {
    return this.#current.id
  }

  async run(signal?: AbortSignal): Promise<RunEnd> {
    const abort = (): void => this.#poke()
    signal?.addEventListener('abort', abort)
    try {
      while (!this.#stopped && !signal?.aborted) await new Promise<void>((resolve) => (this.#wake = resolve))
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    if (signal?.aborted && !this.#stopped) this.#ended = 'signal'
    return this.#ended
  }

  #poke(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  async close(): Promise<void> {
    this.#stopped = true
    this.#poke()
    await this.desk.closeAll()
    await this.backends.stopAll()
    await this.bridge.close()
  }

  startDesktop(): void {
    const { storageFile, standalone } = this.#options
    this.desk.openDesktop({ html: standalone ? null : readFileSync(this.#current.html, 'utf8'), standalone, storage: storageFile(this.#current.id), heapMb: this.#current.heapMb })
    if (standalone && !this.desk.records().some((r) => r.app === standalone)) {
      try {
        this.launch(standalone, null, 'fullscreen')
      } catch (error) {
        Log.write(Level.Error, 'acde_host', `acde window ${standalone}: ${(error as Error).message}`)
      }
    }
  }

  #notice(notice: BrokerNotice): void {
    switch (notice.type) {
      case 'exit':
        this.#stopped = true
        this.#ended = 'exit'
        return this.#poke()
      case 'milestone':
        return StartupTimeline.mark(`shell ${notice.title}`)
      case 'desktopshown':
        return this.onDesktopShown()
      case 'isolateexit':
        this.#bindings.get(notice.window)?.fail('acde: the isolate stopped')
        this.#bindings.delete(notice.window)
        this.#inbound.delete(notice.window)
        return
      case 'appstart': {
        const app = this.apps.get(notice.app)
        if (app) this.backends.start(app)
        return
      }
      case 'appstop':
        return void this.backends.stop(notice.app)
      case 'end':
        return this.session.finish(notice.kind)
      case 'language':
        return this.language.adopt(notice.locale)
      case 'choose':
        return void this.#choose(notice.id).catch((error: Error) => Log.write(Level.Error, 'acde_host', `switching to ${notice.id}: ${error.message}`))
      case 'desktopexit': {
        if (notice.closing || this.#stopped) return
        const why = `exit ${notice.code}${notice.reason ? `, ${notice.reason}` : ''}`
        const crashes = this.#desktopCrashes.note()
        if (crashes.tooMany) {
          Log.write(Level.Error, 'acde_host', `the desktop stopped ${crashes.count} times in a minute (${why}); the session ends`)
          this.#stopped = true
          this.#ended = 'exit'
          return this.#poke()
        }
        Log.write(Level.Warn, 'acde_host', `the desktop stopped (${why}); starting it again`)
        setTimeout(() => !this.#stopped && this.startDesktop(), 500)
        return
      }
    }
  }

  launch(appId: string, request: Record<string, unknown> | null = null, mode: 'fullscreen' | 'free' = 'free'): { window: number } {
    if (!this.apps.get(appId)) this.refreshApps()
    return { window: this.desk.launch(appId, request, mode) }
  }

  async openFromBus(request: { kind: 'folders' | 'items' | 'properties' | 'open'; uris: string[]; app: string }): Promise<void> {
    const options = request.kind === 'open' ? (request.app ? { app: request.app } : {}) : { select: request.kind !== 'folders' }
    for (const uri of request.uris) await this.desk.openPath(uri, options)
  }

  #appList(): { id: string; label: string; icon: string; script: string }[] {
    return this.apps.list().filter((app) => this.#available(app)).map(({ id, label, icon, entry }) => ({ id, label, icon, script: entry }))
  }

  #publishApps(): void {
    this.desk.setApps(this.apps.list().map((app) => ({ app, available: this.#available(app) })))
  }

  refreshApps(): { id: string; label: string; icon: string; script: string }[] {
    this.#options.packages.rescan()
    const changed = this.apps.reload(this.#options.packages)
    this.desk.look({ resources: this.#options.packages.resources(), desktops: this.#desktops() })
    this.#publishApps()
    const apps = this.#appList()
    if (changed) this.desk.toDesktop({ type: 'appschanged', apps })
    return apps
  }

  installApps(dir: string): { id: string; dir: string; apps: { id: string; label: string; icon: string; script: string }[] } {
    const installed = Packages.install(String(dir))
    Log.write(Level.Info, 'acde_host', `installed package ${installed.id} from ${dir} into ${installed.dir}`)
    return { ...installed, apps: this.refreshApps() }
  }

  #available(app: AppManifest): boolean {
    return this.bridge.available(app.capabilities)
  }

  // ---- services (step 6) ----

  #binding(window: number): ServiceBinding {
    let binding = this.#bindings.get(window)
    if (binding) return binding
    binding = new ServiceBinding({ postMessage: (message) => this.desk.servicePost(window, message), on: (_event, listener) => this.#inbound.set(window, listener) })
    binding.serve((service, method, args) => this.#serve(window, service, method, args))
    this.#bindings.set(window, binding)
    return binding
  }

  /** The builtins the Broker still serves, and the package's services: what a caller's place and manifest allow. */
  #builtins(): Record<string, Record<string, (...args: never[]) => unknown>> {
    return {
      [Modules.STORE]: {
        refresh: () => this.refreshApps(),
        install: (dir: string) => this.installApps(String(dir)),
      },
    }
  }

  static readonly #BUILTIN_CAPS: Readonly<Record<string, { capability: string; desktopOnly?: boolean }>> = {
    [Modules.STORE]: { capability: 'store', desktopOnly: true },
  }

  static readonly #LOCAL = new Set(['fs', 'terminal', 'network', 'office', 'devices'])

  addService(name: string, target: unknown): void {
    this.bridge.value[name] = target
    this.#publishServices()
  }

  #publishServices(): void {
    const services: ServiceSpec[] = []
    for (const [name, target] of Object.entries(this.bridge.value)) {
      if (Broker.#LOCAL.has(name)) continue
      services.push({ name, capability: this.bridge.services.capability.get(name) ?? name, shape: this.#shape(name, target) })
    }
    for (const [name, api] of Object.entries(this.#builtins())) services.push({ name, ...Broker.#BUILTIN_CAPS[name]!, shape: this.#shape(name, api) })
    this.desk.look({ services })
    this.#publishApps()
  }

  async #serve(window: number, service: string, method: string, args: unknown[]): Promise<unknown> {
    const caller = this.desk.caller(window) as Caller | null
    if (!caller) throw new Error('acde: the caller has stopped')
    const desktop = caller.place === 'desktop'
    const caps: Capabilities | null = caller.app?.capabilities ?? null
    const builtin = this.#builtins()[service]
    const target = (builtin ?? this.bridge.value[service]) as Record<string, (...a: unknown[]) => unknown> | ((...a: unknown[]) => unknown) | undefined
    if (Broker.#LOCAL.has(service)) throw new Error(`acde.${service} is bound in the isolate itself, not served by the Broker`)
    if (!desktop) {
      const rule = Broker.#BUILTIN_CAPS[service]
      const key = rule?.capability ?? this.bridge.services.capability.get(service) ?? service
      if (rule?.desktopOnly || !caps?.[key]) throw Broker.#refused(caller, `acde.${service.replace(/^#/, '')}`)
    }
    if (!target) throw Object.assign(new Error(`acde.${service} is not running`), { status: 503 })
    if (method === '' && typeof target === 'function') return target(...args)
    const fn = (target as Record<string, (...a: unknown[]) => unknown>)[method]
    if (typeof fn !== 'function') throw new Error(`acde.${service} has no ${method}`)
    return fn.apply(target, args)
  }

  static #refused(caller: Caller, what: string): Error {
    return Object.assign(new Error(`${caller.app?.label ?? caller.place} may not use ${what} (not in its manifest's capabilities)`), { status: 403, code: 'forbidden' })
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

  static #env(): [string, string][] {
    const keep = /^(ACDE_|XDG_|LANG$|LC_|LANGUAGE$|HOME$|USER$|DBUS_SESSION_BUS_ADDRESS$|RUST_LOG$|TZ$|PATH$|RUST_BACKTRACE$)/
    return Object.entries(process.env).filter((entry): entry is [string, string] => keep.test(entry[0]) && entry[1] !== undefined)
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

  // ---- debug (ACDE_DEBUG_DIR) ----

  debugEval(name: string, code: string): Promise<unknown> {
    const window = this.desk.named(name)
    if (window === null) return Promise.reject(new Error(`no isolate ${name} (${this.desk.isolates().map((i) => i.name).join(', ')})`))
    return this.desk.ask(window, 'debug.eval', code)
  }

  async debugStats(reset = false): Promise<Record<string, unknown>> {
    const isolates = this.desk.isolates()
    const stats = await Promise.all(isolates.map((i) => this.desk.ask(i.window, 'debug.stats', reset).catch((e: Error) => ({ error: e.message }))))
    return Object.fromEntries(isolates.map((i, n) => [i.name, { ...(stats[n] as object), cpuMs: i.cpuMs, externalMb: i.externalMb }]))
  }

  get windows(): DeskRecord[] {
    return this.desk.records()
  }
}
