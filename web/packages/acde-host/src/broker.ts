import { readTextOr } from './sys/fs'
import { unref, within } from './sys/timers'
import { sys } from './sys/natives'
import { AppRegistry, type AppManifest } from './apps'
import { AppBackends } from './backend'
import { Crashes } from './crashes'
import { PageBridge } from './bridge'
import { Frame } from './frame'
import { Opener, type OpenOptions } from './open'
import { NativeApps } from './launcher'
import { PageSource } from './page'
import { StartupTimeline } from './timeline'
import type { Native, RawShellEvent } from './native'
import { Packages, type InstalledDesktop } from './packages'
import { DesktopSession, type RunEnd } from './session'
import { DevLog } from './devlog'
import { Inspect, type NativeAccessibility } from './inspect'
import { SessionLanguage } from './language'
import { StoragePlaces } from './storage'
import { WindowPlaces, type Rect } from './places'
import { Level, Log } from './log'
import { process } from './sys/process'
import type { AnimateOptions, BrokerOptions, BrokerShell, WebInfo, WebInit, WindowRecord } from './broker/types'
import type { ShellModule } from '@dopame/acde-api/manifest'
import { Web } from './broker/web'
import { DevRequests } from './broker/dev'
import { PageCalls, PanelCalls } from './broker/page'
import { WindowCalls } from './broker/windows'
import { ServiceCalls } from './broker/services'
import { AppCalls } from './broker/apps'
import { Tiers } from './broker/tier'
import { Preferences, type Emulated, type Emulation } from './broker/preferences'

export type { BrokerShell, ServiceShape, WebInfo, WebInit, WireMenu } from './broker/types'

export class Broker {
  static readonly HANG_MS = 5000
  static readonly CLOSE_WAIT_MS = 3000
  static readonly DEV_STATE_MS = 500
  static readonly RESTARTS = 3

  readonly native: Native
  readonly shell: BrokerShell
  readonly apps: AppRegistry
  readonly bridge: PageBridge
  readonly opener: Opener
  readonly natives = new NativeApps()
  readonly session = new DesktopSession()
  readonly language = new SessionLanguage((languages) => {
    for (const web of this.#webs()) web.thread.post({ type: 'languages', ...languages })
  })
  readonly backends: AppBackends
  readonly inspect: Inspect
  #accessibility: Promise<NativeAccessibility | null> | null = null
  readonly #options: BrokerOptions
  #current: InstalledDesktop
  #desktop: Web | null = null
  #standaloneWindow: number | null = null
  readonly #windows = new Map<number, WindowRecord>()
  readonly #appCalls: AppCalls
  readonly #services: ServiceCalls
  readonly #windowCalls: WindowCalls
  readonly #panelCalls: PanelCalls
  readonly #pageCalls: PageCalls
  readonly #places = new WindowPlaces()
  readonly #placed = new Map<number, string>()
  readonly #claims: { web: Web; pid: number }[] = []
  #output: { width: number; height: number; scale: number }
  readonly #desktopCrashes = new Crashes(Broker.RESTARTS)
  readonly #themes = new Map<string, string>()
  #stopped = false
  readonly #preferences: Preferences
  readonly devlog = new DevLog()
  readonly #dev: DevRequests
  #ended: RunEnd = 'signal'
  #devStates = new Map<string, unknown>()
  #wake: (() => void) | null = null
  #signal: AbortSignal | null = null
  onDesktopShown: () => void = () => {}

  constructor(native: Native, options: BrokerOptions) {
    this.native = native
    this.#options = options
    this.#preferences = new Preferences(options.dark, options.reducedMotion, (message) => {
      for (const web of this.#webs()) web.thread.post(message)
    })
    this.#current = options.desktop
    this.apps = new AppRegistry(options.packages)
    this.bridge = new PageBridge()
    this.opener = new Opener({
      apps: () => this.apps.list().filter((app) => this.#available(app) && this.#runsHere(app)),
      locate: async (path) => {
        const fs = this.bridge.value['fs'] as { locate(path: string): Promise<{ root: string; path: string }> } | undefined
        return fs ? fs.locate(path).catch(() => null) : null
      },
      admit: async (path, caller) => {
        const fs = this.bridge.value['fs'] as { admit(path: string, roots: string[] | null, owner: string | null): Promise<string> } | undefined
        return fs ? fs.admit(path, caller?.roots ? [...caller.roots] : null, caller?.owner ?? null).catch(() => null) : null
      },
      launch: (app, request) => this.#raise(this.launch(app, request)),
      spawn: (argv) => void this.shell.launch(argv),
      system: () => {
        const shell = this.shell
        return shell.openDefault ? (target) => shell.openDefault!(target) : null
      },
      unsupported: (id) => {
        const app = this.apps.get(id)
        return app && this.#available(app) && !this.#runsHere(app) ? Broker.#unsupported(app) : null
      },
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
      panel: (id) => this.#panelCalls.has(id),
      close: async (id) => (this.#windows.get(id)?.kind === 'web' ? this.closeWeb(id) : this.shell.close(id)),
      hide: (id, hidden) => this.#hide(id, hidden),
      open: (name) => this.#appCalls.openByName(name),
      accessibility: () => this.accessibility(),
      records: () => [...this.#windows.keys()],
    })
    this.bridge.services.inspect = this.inspect.api
    this.bridge.services.shell = (name) => this.#serviceModule(name)
    this.#dev = new DevRequests({
      shell: this.shell,
      inspect: this.inspect,
      devlog: this.devlog,
      webs: () => this.#webs(),
      desktop: () => this.#desktop,
      title: (web) => (web.kind === 'desktop' ? this.#current.name : (this.#windows.get(web.window)?.title ?? web.app?.label ?? web.name)),
      emulate: (options) => this.emulate(options),
    })
    this.#appCalls = new AppCalls({
      shell: this.shell,
      natives: this.natives,
      opener: this.opener,
      list: () => this.#appList(),
      refresh: () => this.refreshApps(),
      install: (dir) => this.installApps(dir),
      launch: (appId, request) => this.launch(appId, request),
      raise: (opened) => this.#raise(opened),
    })
    this.#services = new ServiceCalls({
      bridge: this.bridge,
      builtins: () => ({ inspect: this.inspect.api, session: this.session.api, desktops: this.desktops }),
    })
    this.#windowCalls = new WindowCalls({
      shell: this.shell,
      record: (id) => this.#windows.get(id),
      claim: (web, pid) => void this.#claims.push({ web, pid }),
      closeWeb: (id, force) => this.closeWeb(id, force),
      hide: (id, hidden) => this.#hide(id, hidden),
      toDesktop: (event) => this.#toDesktop(event),
      usable: (appId) => {
        const app = this.apps.get(appId)
        return !!app && this.#available(app) && this.#runsHere(app)
      },
      launch: (appId, request) => void this.launch(appId, request),
    })
    this.#panelCalls = new PanelCalls(this.shell)
    this.#pageCalls = new PageCalls({
      native,
      shell: this.shell,
      desktop: () => this.#desktop,
      shown: () => this.onDesktopShown(),
      desktopShown: () => this.#desktopShown(),
      devReload: (app) => this.devReload(app),
      toDesktop: (event) => this.#toDesktop(event),
    })
    StartupTimeline.mark('shell created')
  }

  #serviceModule(name: ShellModule): object | null {
    switch (name) {
      case 'session':
        return this.session.api
      case 'desktops':
        return this.desktops
      case 'inspect':
        return this.inspect.api
      case 'setDefault':
        return (mime: string, handler: string) => this.opener.setDefault(String(mime), String(handler))
      case 'desktop':
        return { apps: async () => ({ apps: this.#appList() }) }
      case 'packages':
        return {
          refresh: () => this.refreshApps(),
          install: (dir: string) => this.installApps(String(dir)),
          natives: () => this.natives.list(),
          runNative: (id: string) => {
            const file = this.natives.file(String(id))
            if (!file) throw Object.assign(new Error(`no native app ${String(id)}`), { status: 404 })
            return this.shell.launch(['gio', 'launch', file])
          },
        }
      case 'windows':
        return {
          list: () => this.windows,
          focus: (id: number) => this.shell.focus(Number(id)),
          hide: (id: number) => this.#hide(Number(id), true),
          show: (id: number) => this.#hide(Number(id), false),
          close: (id: number) => (this.#windows.get(Number(id))?.kind === 'web' ? this.closeWeb(Number(id)) : this.shell.close(Number(id))),
          kill: (id: number) => this.closeWeb(Number(id), true),
          stats: () => this.shell.stats(),
          animate: (id: number, options: AnimateOptions) => this.shell.animate(Number(id), options ?? {}),
        }
    }
    return null
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

  setDark(dark: boolean): void {
    this.#preferences.setDark(dark)
  }

  emulate(options: Emulation): Emulated {
    return this.#preferences.emulate(options)
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
      await this.#replaceDesktop(this.#desktop, next)
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
    await Promise.all([...webs.map((web) => web.terminate().catch(() => 0)), this.backends.stopAll()])
    await this.bridge.close()
  }

  startDesktop(): void {
    const { standalone } = this.#options
    if (standalone && this.shell.hosted) {
      if (this.#standaloneWindow === null && !this.#stopped) {
        try {
          this.#standaloneWindow = this.launch(standalone, null, 'fullscreen').window
        } catch (error) {
          Log.write(Level.Error, 'acde_host', `acdert app ${standalone}: ${(error as Error).message}`)
          this.#end('exit')
        }
      }
      return
    }
    const grant = this.shell.grant({ desktop: true })
    const init: WebInit = {
      kind: 'desktop',
      name: 'desktop',
      token: grant.token,
      window: 0,
      width: this.#output.width,
      height: this.#output.height,
      scale: this.#output.scale,
      screen: this.#screen(),
      reducedMotion: this.#preferences.reducedMotion,
      dark: this.#preferences.dark,
      languages: this.language.current,
      services: this.#services.shapes(null),
      resources: this.#resources(),
      page: this.#current.html,
      standalone: this.#current.id === Packages.BARE ? standalone : null,
      devState: this.#takeDevState(''),
      devRoutes: this.#dev.routesFor('desktop', null),
      tier: Tiers.DESKTOP,
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

  #spawnWindow(
    record: WindowRecord,
    token: bigint = this.shell.grant({ window: record.id, mode: record.mode, size: Frame.windowSize(record.app!) }).token,
  ): void {
    const app = record.app!
    this.#placed.set(record.id, app.id)
    const tier = Tiers.app(app, this.apps.origin(app.id))
    const init: WebInit = {
      kind: 'window',
      name: `${app.id}#${record.id}`,
      token,
      window: record.id,
      width: 800 * this.#output.scale,
      height: 600 * this.#output.scale,
      scale: this.#output.scale,
      screen: this.#screen(),
      reducedMotion: this.#preferences.reducedMotion,
      dark: this.#preferences.dark,
      languages: this.language.current,
      services: this.#services.shapes(app.capabilities, tier),
      resources: PageSource.isHtml(app.entry) ? PageSource.rooted(app.entry, this.#resources()) : this.#resources(),
      app,
      theme: this.#theme(),
      request: record.request ?? null,
      url: record.url ?? null,
      ...(app.backend && { sockets: AppBackends.socketDir(app.id) }),
      devState: this.#takeDevState(app.id),
      devRoutes: this.#dev.routesFor(`${app.id}#${record.id}`, app.id),
      tier,
    }
    record.request = null
    record.web = this.#spawn(init, app.heapMb)
    if (record.hidden) this.#tellVisible(record)
  }

  #spawn(init: WebInit, heapMb: number): Web {
    const env = { ...Web.env(), WAYLAND_DISPLAY: this.shell.socketName }
    const storage = init.app ? StoragePlaces.app(init.app.id) : this.#options.storage(this.#current.id)
    const grants = { ...Web.grants(init.app?.id ?? null, init.app?.capabilities ?? null), storage }
    const web: Web = new Web(init.kind, init.name, init.window, init.app ?? null, (onMessage, exit) =>
      sys().spawnWeb(init.name, init, heapMb, env, onMessage, (code, reason) => {
        this.#exited(web, code, reason)
        exit(code)
      }, grants), init.tier)
    web.rpc.serve((service, method, args) => this.#serve(web, service, method, args))
    web.onPost = (message) => {
      if (DevLog.isPost(message)) this.devlog.take({ name: web.name, app: web.app?.id ?? null }, message)
      else if (typeof (message as { devroute?: unknown })?.devroute === 'number') this.#dev.used((message as { devroute: number }).devroute)
    }
    return web
  }

  #theme(): string {
    const id = this.#current.id
    let theme = this.#themes.get(id)
    if (theme === undefined) {
      theme = /:root\s*\{[^}]*\}/.exec(readTextOr(this.#current.html, ''))?.[0] ?? ''
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
    this.devlog.gone(web.name)
    if (this.#stopped && web.closing) return
    if (web.kind === 'desktop') {
      if (this.#desktop !== web) return
      this.#desktop = null
      if (this.#stopped) return
      const crashes = this.#desktopCrashes.note()
      if (crashes.tooMany) {
        Log.write(
          Level.Error,
          'acde_host',
          `the desktop stopped ${crashes.count} times in a minute (exit ${code}${reason ? `, ${reason}` : ''}); the session ends`,
        )
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
    this.#forget(record, web.closing ? 'close' : 'exit')
  }

  #end(reason: RunEnd): void {
    this.#stopped = true
    this.#ended = reason
    this.#poke()
  }

  #forget(record: WindowRecord, reason: RunEnd = 'close'): void {
    this.#windows.delete(record.id)
    this.shell.release(record.id)
    unref(setTimeout(() => !this.#windows.has(record.id) && this.#placed.delete(record.id), Broker.CLOSE_WAIT_MS))
    this.#toDesktop({ type: 'windowclose', window: record.id })
    if (record.app?.backend && !this.#running(record.app.id)) void this.backends.stop(record.app.id)
    if (record.id === this.#standaloneWindow && !this.#stopped) this.#end(reason)
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
      const busy = web.thread.busyMs() >= Broker.HANG_MS
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
          if (screen.width !== was.width || screen.height !== was.height) for (const web of this.#webs()) web.thread.post({ type: 'screen', ...screen })
        }
        return
      case 'milestone':
        return StartupTimeline.mark(`shell ${event.title}`)
      case 'shortcut': {
        const owner = event.window === undefined ? undefined : this.#windows.get(event.window)
        const to = event.title === 'app' && owner?.web ? owner.web : this.#desktop
        return to?.thread.post(event)
      }
      case 'devreload':
        return void this.devReload(event.key ?? null, event.title === 'hot').catch((error: Error) =>
          Log.write(Level.Error, 'acde_host', `acde dev: reload: ${error.message}`),
        )
      case 'devrequest':
        return void this.#dev.request(event.key ?? '')
      case 'windowcloserequest':
        if (event.window === 0 || event.window === undefined) {
          this.#stopped = true
          this.#ended = 'close'
          return
        }
        return void this.closeWeb(event.window).catch(() => undefined)
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
      const opened: WindowRecord = {
        id: event.window,
        kind: 'native',
        appId: event.appId ?? null,
        title: event.title ?? null,
        owner: claim?.web ?? null,
        web: null,
        app: null,
        menus: [],
      }
      this.#windows.set(event.window, opened)
      if (claim) {
        claim.web.owns.set(event.window, claim.pid)
        return claim.web.thread.post(event)
      }
      const pid = this.shell.windows().find((row) => (row.window ?? row.id) === event.window)?.pid
      const starter = pid ? this.#webs().find((web) => web.startedPids.has(pid)) : undefined
      if (starter) {
        opened.starter = starter
        starter.started.add(event.window)
        starter.thread.post(event)
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
      record.starter?.started.delete(event.window)
    }
    if (record.owner) return record.owner.thread.post(event)
    record.starter?.thread.post(event)
    this.#toDesktop(event)
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

  #desktopShown(): boolean {
    if (!this.#desktop) return false
    const row = this.shell.windows().find((w) => (w.window ?? w.id) === 0)
    return !!row && !row.hidden
  }

  #toDesktop(event: Record<string, unknown> | RawShellEvent): void {
    this.#desktop?.thread.post(event)
    const type = String(event.type)
    for (const record of this.#windows.values()) if (record.web && Tiers.listens(record.web.tier, type)) record.web.thread.post(event)
  }

  #announce(record: WindowRecord): void {
    if (record.owner) return
    if (record.kind === 'web') {
      const app = record.app!
      this.#toDesktop({ type: 'windowopen', window: record.id, appId: app.id, title: record.title ?? app.label, web: true, icon: app.icon })
      if (record.menus.length) this.#toDesktop({ type: 'windowmenus', window: record.id, menus: record.menus })
    } else {
      this.#toDesktop({ type: 'windowopen', window: record.id, appId: record.appId, title: record.title })
    }
  }

  launch(appId: string, request: Record<string, unknown> | null = null, mode: 'fullscreen' | 'free' = 'free', place: Rect | null = null): { window: number } {
    const app = this.apps.get(appId) ?? (this.refreshApps(), this.apps.get(appId))
    if (!app) throw this.#missing(appId)
    if (!this.#available(app)) throw Object.assign(new Error(`${app.label}: the system service it needs is not running`), { status: 503 })
    if (!this.#runsHere(app)) throw Broker.#unsupported(app)
    const shellRefusal = Tiers.refusal(app, this.apps.origin(app.id))
    if (shellRefusal) throw Object.assign(new Error(shellRefusal), { status: 403, code: 'shell_module' })
    if (!app.multiple) {
      const running = this.#running(appId)
      if (running) {
        if (request) this.#deliver(running, request)
        return { window: running.id }
      }
    }
    const rect = mode !== 'free' || this.#running(appId) ? null : (place ?? this.#places.get(appId, this.#screen()))
    const grant = this.shell.grant({ mode, ...(rect ? { rect } : { size: Frame.windowSize(app) }) })
    const record: WindowRecord = { id: grant.window, kind: 'web', appId: app.id, title: app.label, owner: null, web: null, app, menus: [], request, mode }
    this.#windows.set(record.id, record)
    this.#spawnWindow(record, grant.token)
    this.#announce(record)
    if (app.backend) this.backends.start(app)
    return { window: record.id }
  }

  #missing(appId: string): Error {
    const refusal = this.apps.refusal(appId)
    if (refusal) return Object.assign(new Error(`${appId}: ${refusal}`), { status: 409, code: 'api_level' })
    return Object.assign(new Error(`no app ${appId}`), { status: 404 })
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
    const shown = this.apps.list().filter((app) => this.#available(app) && this.#runsHere(app))
    return shown.map(({ id, label, icon, entry }) => ({ id, label, icon, script: entry }))
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

  static #unsupported(app: AppManifest): Error {
    return Object.assign(new Error(`${app.label} cannot run in a host window (it needs slots)`), { status: 404, code: 'unsupported_app' })
  }

  #runsHere(app: AppManifest): boolean {
    return !(app.capabilities.slots && this.shell.hosted)
  }

  async devReload(app: string | null, hot = false): Promise<void> {
    if (hot) {
      const webs = app ? [...this.#windows.values()].filter((r) => r.kind === 'web' && r.app?.id === app).map((r) => r.web) : [this.#desktop]
      for (const web of webs) web?.thread.post({ type: 'devhot' })
      return
    }
    if (app) {
      const before = this.apps.get(app)
      this.refreshApps()
      const after = this.apps.get(app)
      const open = [...this.#windows.values()].filter((r) => r.kind === 'web' && r.app?.id === app)
      const primary = open.find((record) => record.id === this.#standaloneWindow)
      const web = (primary ?? open[0])?.web ?? null
      const state = await Broker.#snapshot(web)
      if (primary) {
        if (this.#stopped || !web || primary.web !== web || web.closing || web.reloading) return
        if (!after || !this.#available(after)) {
          Log.write(
            Level.Error, 'acde_host', `acdert app ${app}: the app or a required system service is no longer available`,
          )
          this.#end('exit')
          return
        }
        if (state) this.#devStates.set(app, state)
        const backend = primary.app?.backend ? this.backends.stop(app) : undefined
        primary.app = after
        web.reloading = true
        await web.terminate()
        await backend
        if (!this.#stopped && primary.app === after) this.backends.start(after)
        return
      }
      if (state) this.#devStates.set(app, state)
      const resized = before && after && String(Frame.windowSize(before)) !== String(Frame.windowSize(after)) ? this.#resizedPlace(open[0]?.id, after) : null
      for (const record of open) await this.closeWeb(record.id, true)
      if (open.length || this.#options.standalone === app) this.launch(app, null, 'free', resized)
      return
    }
    const old = this.#desktop
    const state = await Broker.#snapshot(old)
    if (state) this.#devStates.set('', state)
    await this.#replaceDesktop(old)
  }

  async #replaceDesktop(old: Web | null, next?: InstalledDesktop): Promise<void> {
    if (old) old.closing = true
    this.#desktop = null
    await old?.terminate().catch(() => 0)
    if (next) await this.bridge.startDesktop((this.#current = next), this.native)
    this.startDesktop()
  }

  #resizedPlace(window: number | undefined, app: AppManifest): Rect | null {
    const row = window === undefined ? undefined : this.shell.windows().find((w) => (w.window ?? w.id) === window)
    if (!row || row.mode !== 'free') return null
    const screen = this.#screen()
    const [w, h] = Frame.windowSize(app)
    const width = Math.min(w, screen.width)
    const height = Math.min(h, screen.height)
    const x = Math.round(Math.min(Math.max(0, row.x + (row.width - width) / 2), screen.width - width))
    const y = Math.round(Math.min(Math.max(0, row.y + (row.height - height) / 2), screen.height - height))
    return [x, y, width, height]
  }

  static async #snapshot(web: Web | null): Promise<unknown> {
    return !web || web.closing ? null : within(web.rpc.call('dev', 'state', []).catch(() => null), Broker.DEV_STATE_MS, null)
  }

  #takeDevState(key: string): unknown {
    const state = this.#devStates.get(key)
    this.#devStates.delete(key)
    return state
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
      await web.terminate()
    } else {
      this.#forget(record)
    }
    return true
  }

  async #serve(web: Web, service: string, method: string, args: unknown[]): Promise<unknown> {
    if (service === 'windows') return this.#windowCalls.windows(web, method, args)
    if (service === 'apps') return this.#appCalls.call(web, method, args)
    if (service === 'packages') return this.#appCalls.packages(web, method, args)
    if (service === 'launch') return this.#windowCalls.launch(web, method, args)
    if (service === 'window') return this.#windowCalls.self(web, method, args)
    if (service === 'panel') return this.#panelCalls.call(web, method, args)
    if (service === 'page') return this.#pageCalls.call(web, method, args)
    return this.#services.call(web, service, method, args)
  }

  async debugEval(name: string, code: string): Promise<unknown> {
    return this.#dev.web(name).rpc.call('debug', 'eval', [code])
  }

  webs(): WebInfo[] {
    return this.#dev.infos()
  }

  async debugStats(reset = false): Promise<Record<string, unknown>> {
    return this.#dev.stats(reset)
  }

  get windows(): { id: number; kind: string; app: string | null; title: string | null; running: boolean }[] {
    return [...this.#windows.values()].map((r) => ({ id: r.id, kind: r.kind, app: r.app?.id ?? r.appId, title: r.title, running: !!r.web }))
  }
}
