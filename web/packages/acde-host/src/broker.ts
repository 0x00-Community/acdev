import type { AppsChangedEvent, WindowCrashEvent, WindowMenusEvent, WindowOpenEvent, WindowsEvent } from '@dopame/acde-api'
import type { CapabilityStatus } from '@dopame/acde-api/manifest'
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
import type { BrokerOptions, BrokerShell, WebInfo, WebInit, WindowRecord } from './broker/types'
import { Web } from './broker/web'
import { DevRequests } from './broker/dev'
import { PageCalls, PanelCalls } from './broker/calls/page'
import { WindowCalls } from './broker/calls/windows'
import { ServiceCalls } from './broker/calls/services'
import { AppCalls } from './broker/calls/apps'
import { DesktopCalls } from './broker/calls/desktops'
import { Tiers } from './broker/access/tier'
import type { WindowFamily } from './broker/access/family'
import { Launchable } from './broker/access/launchable'
import { FileAccess } from './broker/access/files'
import { ServiceModules } from './broker/access/modules'
import { Preferences, type Emulated, type Emulation } from './broker/preferences'
import { Outputs, type Screen } from './broker/output'
import { WindowRecords } from './broker/records'
import { UserAgent } from './useragent'

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
  readonly #windows: WindowRecords = new WindowRecords({
    shell: () => this.shell,
    webs: () => this.#webs(),
    toDesktop: (event) => this.#toDesktop(event),
  })
  readonly #appCalls: AppCalls
  readonly #services: ServiceCalls
  readonly #windowCalls: WindowCalls
  readonly #panelCalls: PanelCalls
  readonly #pageCalls: PageCalls
  readonly #launchable = new Launchable({
    apps: () => this.apps,
    hosted: () => !!this.shell.hosted,
    standalone: () => !!this.#options.standalone,
    bridge: () => this.bridge,
    refresh: () => this.refreshApps(),
  })
  #opening = false
  readonly #output: Outputs
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
      apps: () => this.apps.list().filter((app) => this.#launchable.available(app)),
      associations: () => {
        const shell = this.shell
        const { fileHandlers, openWith } = shell
        if (!fileHandlers || !openWith) return null
        return { handlers: (ext) => fileHandlers.call(shell, ext), open: (handler, path) => openWith.call(shell, handler, path) }
      },
      locate: async (path) => {
        const fs = this.bridge.value['fs'] as { locate(path: string): Promise<{ root: string; path: string }> } | undefined
        return fs ? fs.locate(path).catch(() => null) : null
      },
      admit: async (path, caller) => {
        type Admit = (path: string, roots: string[] | null, owner: string | null, places: string[] | null) => Promise<string>
        const fs = this.bridge.value['fs'] as { admit: Admit } | undefined
        const places = caller?.places ? [...caller.places] : null
        return fs ? fs.admit(path, caller?.roots ? [...caller.roots] : null, caller?.owner ?? null, places).catch(() => null) : null
      },
      launch: (app, request) => this.launch(app, request).then((opened) => this.#raise(opened)),
      spawn: (argv) => void this.shell.launch(argv),
      system: () => {
        const shell = this.shell
        return shell.openDefault ? (target) => shell.openDefault!(target) : null
      },
      unsupported: (id) => this.#launchable.unsupported(id),
      view: (app) => FileAccess.view(app.capabilities, this.#launchable.tier(app)),
    })
    this.shell = native.Shell.broker()
    this.shell.onEvents(() => this.#poke())
    this.#output = new Outputs(options.width, options.height, options.scale)
    this.session.own = options.session
    this.session.attach(this.shell)
    this.session.language = this.language
    this.backends = new AppBackends({
      resources: () => this.#resources(),
      wanted: (id) => !!this.#windows.running(id),
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
    const modules = new ServiceModules({
      shell: this.shell,
      natives: this.natives,
      session: () => this.session.api,
      desktops: () => this.desktops,
      inspect: () => this.inspect.api,
      setDefault: (mime, handler) => this.opener.setDefault(mime, handler),
      apps: () => this.#appList(),
      refresh: () => this.refreshApps(),
      install: (dir) => this.installApps(dir),
      windows: () => this.windows,
      hide: (id, hidden) => this.#hide(id, hidden),
      close: (id) => (this.#windows.get(id)?.kind === 'web' ? this.closeWeb(id) : this.shell.close(id)),
      kill: (id) => this.closeWeb(id, true),
    })
    this.bridge.services.shell = (name) => modules.module(name)
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
      launch: (appId, request, family) => this.launch(appId, request, 'free', null, family),
      record: (id) => this.#windows.get(id),
      raise: (opened) => this.#raise(opened),
    })
    this.#services = new ServiceCalls({
      bridge: this.bridge,
      builtins: () => ({ inspect: this.inspect.api, session: this.session.api, desktops: this.desktops }),
    })
    this.#windowCalls = new WindowCalls({
      shell: this.shell,
      record: (id) => this.#windows.get(id),
      claim: (web, pid) => this.#windows.claim(web, pid),
      closeWeb: (id, force) => this.closeWeb(id, force),
      hide: (id, hidden) => this.#hide(id, hidden),
      toDesktop: (event) => this.#toDesktop(event),
      usable: (appId) => {
        const app = this.apps.get(appId)
        return !!app && this.#launchable.available(app)
      },
      launch: (appId, request) => void this.launch(appId, request).catch(() => undefined),
    })
    this.#panelCalls = new PanelCalls(this.shell)
    this.#pageCalls = new PageCalls({
      native,
      shell: this.shell,
      desktop: () => this.#desktop,
      shown: () => this.onDesktopShown(),
      desktopShown: () => this.#desktopShown(),
      notifications: () => this.#launchable.capabilities.supported('notifications'),
      devReload: (app) => this.devReload(app),
      toDesktop: (event) => this.#toDesktop(event),
      language: () => this.language.current.language,
    })
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

  readonly desktops = new DesktopCalls({
    packages: () => this.#options.packages,
    standalone: () => !!this.#options.standalone,
    current: () => this.#current,
    handOff: (session) => this.session.handOff(session),
    replace: (next) => this.#replaceDesktop(this.#desktop, next),
  }).api

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
    this.#windows.keepPlaces()
    this.#desktop = null
    await Promise.all([...webs.map((web) => web.terminate().catch(() => 0)), this.backends.stopAll()])
    await this.bridge.close()
  }

  startDesktop(): void {
    const { standalone } = this.#options
    if (standalone && this.shell.hosted) {
      if (this.#standaloneWindow === null && !this.#opening && !this.#stopped) {
        this.#opening = true
        this.launch(standalone, null, 'fullscreen').then(
          (opened) => (this.#standaloneWindow = opened.window),
          (error: Error) => {
            Log.write(Level.Error, 'acde_host', `acdert app ${standalone}: ${error.message}`)
            this.#end('exit')
          },
        )
      }
      return
    }
    const grant = this.shell.grant({ desktop: true })
    const init: WebInit = {
      kind: 'desktop',
      name: 'desktop',
      token: grant.token,
      window: 0,
      width: this.#output.main.width,
      height: this.#output.main.height,
      scale: this.#output.main.scale,
      screen: this.#screen(),
      reducedMotion: this.#preferences.reducedMotion,
      dark: this.#preferences.dark,
      languages: this.language.current,
      navigator: UserAgent.current,
      services: this.#services.shapes(null),
      resources: this.#resources(),
      page: this.#current.html,
      standalone: this.#current.id === Packages.BARE ? standalone : null,
      devState: this.#takeDevState(''),
      devRoutes: this.#dev.routesFor('desktop', null),
      tier: this.#launchable.tier(null),
    }
    this.#desktop = this.#spawn(init, this.#current.heapMb)
    if (standalone && ![...this.#windows.values()].some((r) => r.app?.id === standalone)) {
      this.launch(standalone, null, 'fullscreen').catch((error: Error) => Log.write(Level.Error, 'acde_host', `acdert app ${standalone}: ${error.message}`))
    }
    for (const record of this.#windows.values()) this.#announce(record)
  }

  #regrant(record: WindowRecord): bigint {
    const host = Outputs.host({ mode: record.mode, appId: record.appId }, this.#options.standalone) && { host: true }
    const size = host ? record.app!.size : Frame.windowSize(record.app!)
    return this.shell.grant({ window: record.id, mode: record.mode, ...(size && { size }), ...host }).token
  }

  #spawnWindow(record: WindowRecord, token: bigint = this.#regrant(record)): void {
    const app = record.app!
    this.#windows.placed(record.id, app.id)
    const tier = this.#launchable.tier(app)
    const init: WebInit = {
      kind: 'window',
      name: `${app.id}#${record.id}`,
      token,
      window: record.id,
      width: 800 * this.#output.main.scale,
      height: 600 * this.#output.main.scale,
      scale: this.#output.main.scale,
      screen: this.#screen(record.id),
      reducedMotion: this.#preferences.reducedMotion,
      dark: this.#preferences.dark,
      languages: this.language.current,
      navigator: UserAgent.current,
      services: this.#services.shapes(app, tier),
      resources: PageSource.isHtml(app.entry) ? PageSource.rooted(app.entry, this.#resources()) : this.#resources(),
      app,
      theme: this.#theme(),
      request: record.request ?? null,
      url: record.url ?? null,
      ...(app.backend && AppBackends.webInit(app.id)),
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
    const grants = { ...Web.grants(init.app?.id ?? null, init.app?.capabilities ?? null, init.tier), storage }
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
    this.#windows.unclaim(web)
    if (web.reloading && !web.closing && !this.#stopped) return this.#spawnWindow(record)
    if (!web.closing) {
      this.#toDesktop({ type: 'windowcrash', window: record.id, reason: reason ?? (code === 0 ? 'exit' : `exit ${code}`) } satisfies WindowCrashEvent)
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
    this.#windows.unplace(record.id, Broker.CLOSE_WAIT_MS)
    this.#toDesktop({ type: 'windowclose', window: record.id } satisfies WindowsEvent)
    if (record.app?.backend && !this.#windows.running(record.app.id)) void this.backends.stop(record.app.id)
    if (record.id === this.#standaloneWindow && !this.#stopped) this.#end(reason)
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
        this.#toDesktop({ type: 'windowresponsive', window: web.window } satisfies WindowsEvent)
      }
      if (web.hung || !busy) continue
      web.hung = true
      Log.write(Level.Warn, 'acde_host', `[${web.name}] not answering for ${Broker.HANG_MS / 1000} s`)
      if (web.kind === 'window') this.#toDesktop({ type: 'windowhang', window: web.window } satisfies WindowsEvent)
    }
  }

  #screen(window?: number): Screen {
    return this.#output.screen(window !== undefined && Outputs.host(this.#windows.get(window), this.#options.standalone))
  }

  #event(event: RawShellEvent): void {
    switch (event.type) {
      case 'output':
      case 'workarea':
      case 'hostoutput':
      case 'hostworkarea': {
        const changed = this.#output.update(event, this.#options.standalone)
        if (changed) for (const web of this.#webs()) if (changed.to(this.#windows.get(web.window))) web.thread.post({ type: 'screen', ...changed.screen })
        return
      }
      case 'milestone':
        return StartupTimeline.mark(`shell ${event.title}`)
      case 'edgeenter':
      case 'edgeleave':
        return this.#toDesktop({ type: 'screenedge', edge: event.key, entered: event.type === 'edgeenter', output: event.title ?? '' })
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
      case 'windowcloserequest': {
        const id = event.window || this.#standaloneWindow
        if (id) return void this.closeWeb(id).catch(() => undefined)
        this.#stopped = true
        this.#ended = 'close'
        return
      }
      case 'close':
      case 'exit':
        this.#stopped = true
        this.#ended = this.#signal?.aborted ? 'signal' : event.type
        return
    }
    this.#windows.shellEvent(event)
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
      const title = record.title ?? app.label
      const opened = { type: 'windowopen', window: record.id, appId: app.id, title, web: true, icon: app.icon } satisfies WindowOpenEvent
      this.#toDesktop(opened)
      if (record.menus.length) this.#toDesktop({ type: 'windowmenus', window: record.id, menus: record.menus } satisfies WindowMenusEvent)
    } else {
      this.#toDesktop({ type: 'windowopen', window: record.id, appId: record.appId, title: record.title } satisfies WindowOpenEvent)
    }
  }

  async launch(
    appId: string,
    request: Record<string, unknown> | null = null,
    mode: 'fullscreen' | 'free' = 'free',
    place: Rect | null = null,
    family: WindowFamily | null = null,
  ): Promise<{ window: number }> {
    const app = this.#launchable.app(appId)
    if (!app.multiple) {
      const running = this.#windows.running(appId)
      if (running) {
        if (request) this.#deliver(running, request)
        return { window: running.id }
      }
    }
    const rect = mode !== 'free' || family || this.#windows.running(appId) ? null : (place ?? this.#windows.place(appId, this.#screen()))
    const host = Outputs.host({ mode, appId: app.id }, this.#options.standalone) && { host: true }
    const size = host ? app.size : Frame.windowSize(app)
    const grant = this.shell.grant({ mode, ...(rect ? { rect } : size && { size }), ...family, ...host })
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
    this.#toDesktop({ type: 'windowshow', window: opened.window } satisfies WindowsEvent)
    return opened
  }

  async openFromBus(request: { kind: 'folders' | 'items' | 'properties' | 'open'; uris: string[]; app: string }): Promise<void> {
    const options: OpenOptions = request.kind === 'open' ? (request.app ? { app: request.app } : {}) : { select: request.kind !== 'folders' }
    for (const uri of request.uris) await this.opener.open(uri, options)
  }

  #appList(): { id: string; label: string; icon: string; script: string }[] {
    const shown = this.apps.list().filter((app) => this.#launchable.available(app))
    return shown.map(({ id, label, icon, entry }) => ({ id, label, icon, script: entry }))
  }

  refreshApps(): { id: string; label: string; icon: string; script: string }[] {
    this.#options.packages.rescan()
    const changed = this.apps.reload(this.#options.packages)
    const apps = this.#appList()
    if (changed) this.#toDesktop({ type: 'appschanged', apps } satisfies AppsChangedEvent)
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
        if (!after || !this.#launchable.available(after)) {
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
      if (open.length || this.#options.standalone === app) await this.launch(app, null, 'free', resized)
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
    return row?.mode === 'free' ? WindowPlaces.over(row, Frame.windowSize(app), this.#screen()) : null
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

  #capability(web: Web, method: string, args: unknown[]): CapabilityStatus {
    if (method !== 'request') throw new Error(`acde.capabilities has no ${method}`)
    const app = web.app
    return this.#launchable.capabilities.status(String(args[0]), app, app ? this.apps.origin(app.id) : { level: 1, system: true })
  }

  async #serve(web: Web, service: string, method: string, args: unknown[]): Promise<unknown> {
    if (service === 'windows') return this.#windowCalls.windows(web, method, args)
    if (service === 'apps') return this.#appCalls.call(web, method, args)
    if (service === 'packages') return this.#appCalls.packages(web, method, args)
    if (service === 'launch') return this.#windowCalls.launch(web, method, args)
    if (service === 'window') return this.#windowCalls.self(web, method, args)
    if (service === 'panel') return this.#panelCalls.call(web, method, args)
    if (service === 'capabilities') return this.#capability(web, method, args)
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
