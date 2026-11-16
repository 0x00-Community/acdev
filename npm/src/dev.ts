import { readFileSync, rmSync, statSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import type { PackageManifest } from '@dopame/acde-api/manifest'
import type { StdioOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Devtools } from './devtools.ts'
import * as Changes from './changes.ts'
import type { Reload, Snapshot } from './changes.ts'
import { DevClient, type Message } from './ipc.ts'
import { AppPackage, type Built } from './package.ts'
import { Project } from './app.ts'
import { contains, E2E_FILE, SKIPPED } from './paths.ts'
import { Runtime, type Child, type RuntimeProbe } from './runtime.ts'
import { Claims, Sessions, type Reloaded } from './sessions.ts'
import { TreeWatch, type Watching } from './watch.ts'

const SETTLE_MS = 150
const MARK_MS = 2_000

export interface Target {
  readonly kind: 'app' | 'desktop'
  readonly id: string
}

export interface DevOptions {
  readonly dirs: readonly string[]
  readonly out?: string
  readonly app?: string
  readonly desktop?: string
  readonly headless?: boolean
  readonly verbose?: boolean
  readonly force?: boolean
  readonly test?: boolean
  readonly acdert: string
}

interface Unit {
  pkg: AppPackage
  readonly out: string
  built: Built | null
  served?: Served
  timer?: ReturnType<typeof setTimeout>
  watcher?: Watching
}

interface Running {
  child: Child | null
  running: boolean
  stopping: boolean
}

interface Served {
  readonly snapshot: Snapshot
  readonly fixed: readonly string[]
}

export type { RuntimeProbe }

export class DevSession {
  static readonly DEFAULT_DESKTOP = 'dopame'
  static readonly INTERRUPT_MS = 2_000
  static readonly SAME_INTERRUPT_MS = 500
  static readonly REVIVE_MS = 1_000
  static readonly CRASHES = 3
  static readonly CRASH_WINDOW_MS = 60_000
  static readonly RECORD = /^\d+\.\d{3} ([EWIDT]) \S+ (\S+): (.*)$/
  static readonly PAGE = 'js'
  static readonly HOST = 'acde_host'
  static readonly PROCESSES: ReadonlySet<string> = new Set(['acdert::child', 'acdert::backends'])
  static readonly LIFECYCLE = /^(?:startup: |broker started \(|(?:ended \(.*\)|session \S+), exit -?\d+$)/

  static keeps(line: string): boolean {
    const [, level, target = '', message = ''] = DevSession.RECORD.exec(line) ?? []
    if (level === undefined || level === 'E' || level === 'W' || target === DevSession.PAGE) return true
    if (level !== 'I') return false
    if (target === DevSession.HOST) return !DevSession.LIFECYCLE.test(message)
    return DevSession.PROCESSES.has(target) && message.startsWith('[')
  }

  static quiet(from: Readable, to: Writable): void {
    createInterface({ input: from, crlfDelay: Infinity }).on('line', (line) => {
      if (DevSession.keeps(line)) to.write(`${line}\n`)
    })
  }

  readonly #units: Unit[]
  readonly #desktop: Unit | string | null
  readonly #app: string | undefined
  readonly #acdert: string
  readonly #headless: boolean
  readonly #verbose: boolean
  readonly #force: boolean
  readonly #test: boolean
  readonly #endpoint = DevClient.endpoint()
  #link: DevClient | null = null
  readonly #dirty = new Set<Unit>()
  readonly #started = Date.now()
  #building = false
  #shown: string | null = null
  #level: number | null = null
  #reloaded: Reloaded | null = null
  #presses: Promise<void> = Promise.resolve()

  constructor(options: DevOptions) {
    const packages = (options.dirs.length ? options.dirs : ['.']).map((dir) => new AppPackage(dir))
    if (options.out !== undefined && packages.length > 1)
      throw new Error('--out is for one project; with several, each builds into its own .acde')
    this.#units = []
    for (const pkg of packages) {
      if (this.#units.some((u) => u.pkg.dir === pkg.dir)) continue
      this.#units.push({ pkg, out: resolve(pkg.dir, options.out ?? '.acde'), built: null })
    }
    this.#desktop = options.desktop === undefined ? null : this.#desktopOf(options.desktop)
    if (options.app !== undefined && this.multiple) {
      throw new Error(
        '--app picks the window of one project; with several projects or --desktop, every app runs in the desktop',
      )
    }
    this.#app = options.app
    this.#acdert = options.acdert
    this.#headless = options.headless === true
    this.#verbose = options.verbose === true
    this.#force = options.force === true
    this.#test = options.test === true
  }

  get multiple(): boolean {
    return this.#units.length > 1 || this.#desktop !== null
  }

  static target(built: Built, app: string | undefined): Target {
    if (app !== undefined) {
      if (!built.apps.includes(app)) throw new Error(DevSession.#notApp(app, built.apps))
      return { kind: 'app', id: app }
    }
    const desktop = built.desktops[0]
    if (desktop !== undefined) return { kind: 'desktop', id: desktop }
    const first = built.apps[0]
    if (first === undefined) throw new Error('nothing to run: no desktop and no app')
    return { kind: 'app', id: first }
  }

  static #notApp(app: string, apps: readonly string[]): string {
    const listed = apps.length ? `its apps: ${apps.join(', ')}` : 'it has no apps'
    const pathy = /[\\/]/.test(app) || app === '.' || app === '..' || DevSession.#isDirectory(resolve(app))
    const hint = pathy ? `; give a directory as the first argument: acde dev ${app}` : ''
    return `--app ${app}: not an app id of this project (${listed}); --app takes an app id${hint}`
  }

  static #isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  #desktopOf(value: string): Unit | string {
    const dir = Sessions.desktopProject(value)
    if (dir === null && Sessions.pathy(value))
      throw new Error(`--desktop ${value}: no project or package there (no package.json or ${Project.CONFIGS[0]})`)
    if (dir === null) {
      if (!/^[\w-]+$/.test(value)) throw new Error(`--desktop ${value}: not a desktop id or a directory`)
      return value
    }
    const pkg = new AppPackage(dir)
    const known = this.#units.find((u) => u.pkg.dir === pkg.dir)
    if (known) return known
    const unit: Unit = { pkg, out: resolve(pkg.dir, '.acde'), built: null }
    this.#units.push(unit)
    return unit
  }

  #plan(): Target {
    const built = this.#units.map((u) => u.built!)
    if (!this.multiple) return DevSession.target(built[0]!, this.#app)
    const owners = new Map<string, string>()
    for (const unit of this.#units) {
      const ids = [...unit.built!.apps.map((a) => `app ${a}`), ...unit.built!.desktops.map((d) => `desktop ${d}`)]
      for (const id of ids) {
        const other = owners.get(id)
        if (other !== undefined) throw new Error(`${id} is in both ${other} and ${unit.pkg.dir}`)
        owners.set(id, unit.pkg.dir)
      }
    }
    if (typeof this.#desktop === 'string') return { kind: 'desktop', id: this.#desktop }
    if (this.#desktop) {
      const ids = this.#desktop.built!.desktops
      if (ids.length === 1) return { kind: 'desktop', id: ids[0]! }
      const dir = this.#desktop.pkg.dir
      if (ids.length === 0)
        throw new Error(`--desktop ${dir}: it has no desktop (apps ${this.#desktop.built!.apps.join(', ')})`)
      throw new Error(
        `--desktop ${dir} has several desktops (${ids.join(', ')}): pass the directory as a project and --desktop <id>`,
      )
    }
    const desktops = built.flatMap((b) => b.desktops)
    if (desktops.length > 1) throw new Error(`several desktops (${desktops.join(', ')}): pick one with --desktop <id>`)
    return { kind: 'desktop', id: desktops[0] ?? DevSession.DEFAULT_DESKTOP }
  }

  static readonly WINDOW_HINT =
    'if acdebin-dbg could not open a window here (no display, e.g. over ssh), run acde dev --headless'

  static runtimeLevel(acdert: string): Promise<RuntimeProbe> {
    return Runtime.level(acdert)
  }

  static refusal(unit: { readonly pkg: AppPackage; readonly built: Built | null }, runtime: number): string | null {
    const level = unit.built?.level ?? null
    if (level === null || level === runtime) return null
    return `${unit.pkg.name}: needs level ${level}, runtime is level ${runtime}`
  }

  async #checkLevels(): Promise<void> {
    if (this.#units.every((u) => u.built?.level === null)) return
    const { level, said, failed } = await DevSession.runtimeLevel(this.#acdert)
    this.#level = level
    const refused = this.#units.map((u) => DevSession.refusal(u, level)).filter((r) => r !== null)
    if (refused.length === 0) return
    const told = said ? `says ${JSON.stringify(said)}` : 'printed nothing'
    const why = failed ? `\n${this.#acdert} --version: ${failed} (acde doctor checks the whole setup)`
      : level === 0 ? `\n${this.#acdert} --version ${told}, no contract level: ` +
        'it is older than contract levels; use an acdebin-dbg that has them' : ''
    throw new Error(`${refused.join('\n')}${why}`)
  }

  static #refusal(pid: number, dir: string): Error {
    return new Error(`acde dev ${pid} already runs ${dir}; stop it first (acde stop --session ${pid}), `
      + 'or pass --force to start another')
  }

  async #claim(): Promise<Claims | null> {
    if (this.#force) return null
    const dirs = this.#units.map((u) => u.pkg.dir)
    const claims = this.#test ? null : await Claims.take(dirs, this.#started)
    if (claims !== null && !(claims instanceof Claims)) throw DevSession.#refusal(claims.pid, claims.dir)
    try {
      const [other] = await Sessions.live(Sessions.running(Sessions.list(), dirs))
      if (!other) return claims
      const dir = other.dirs.find((d) => dirs.some((mine) => Sessions.sameDir(d, mine)))!
      throw DevSession.#refusal(other.pid, dir)
    } catch (error) {
      claims?.release()
      throw error
    }
  }

  async run(): Promise<number> {
    const display = this.#headless ? null : Runtime.noDisplay()
    if (display) throw new Error(`${display}: run acde dev --headless`)
    const claims = await this.#claim()
    try {
      return await this.#run()
    } finally {
      claims?.release()
    }
  }

  get #resilient(): boolean {
    return !this.#headless && !this.#test
  }

  async #run(): Promise<number> {
    for (const unit of this.#units) {
      const sdk = unit.pkg.sdkWarning()
      if (sdk) console.error(`acde: warning: ${sdk}`)
    }
    await this.#firstBuild()
    const target = this.#plan()
    await this.#checkLevels()
    this.#shown = target.kind === 'desktop' ? target.id : null
    DevClient.prepare(this.#endpoint)
    const watchers: Watching[] = []
    const signals: [NodeJS.Signals, () => void][] = []
    const runtime: Running = { child: null, running: false, stopping: false }
    try {
      const paths = [...new Set(this.#units.map((u) => u.built!.dir)), process.env['ACDE_PATH']]
        .filter(Boolean)
        .join(delimiter)
      const what = this.#units.map((u) => `${u.pkg.name} (${u.built!.dir})`).join(', ')
      const headless = this.#headless ? ' (headless)' : ''
      console.log(`acde: dev ${target.kind} ${target.id}${headless}: ${what}; rebuilding and reloading on change`)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ACDE_DEV: this.#endpoint,
        ACDE_PATH: paths,
        ACDE_RUNTIME: Runtime.bun ? 'bun' : 'node',
        ...(this.#headless && { ACDE_HEADLESS: '1' }),
      }
      delete env[Sessions.TEST_ENV]
      let interrupted = 0
      let counted = -Infinity
      signals.push(['SIGINT', () => {
        const now = performance.now()
        if (process.platform !== 'win32' && now - counted < DevSession.SAME_INTERRUPT_MS) return
        counted = now
        interrupted++
        runtime.stopping = true
        if (process.platform !== 'win32') runtime.child?.kill(interrupted > 1 ? 'SIGKILL' : 'SIGTERM')
        else if (interrupted > 1) runtime.child?.kill()
        else setTimeout(() => runtime.child?.kill(), DevSession.INTERRUPT_MS).unref()
      }])
      if (process.platform !== 'win32') {
        for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
          signals.push([signal, () => {
            runtime.stopping = true
            runtime.child?.kill(signal)
          }])
        }
      }
      for (const [signal, handler] of signals) process.on(signal, handler)
      const crashes: number[] = []
      for (let first = true; ; first = false) {
        const started = this.#spawn(target, env, runtime)
        this.#link = await DevClient.reach(
          this.#endpoint,
          () => runtime.running,
          () =>
            console.error(
              `acde: acdebin-dbg has not opened ${this.#endpoint} after 10 s; ` +
                'an acdebin-dbg older than acde dev never does (no reload, no acde webs / eval …): use a newer one',
            ),
        )
        if (!this.#link && first) {
          const code = await started.exited
          if (code !== 0)
            console.error(`acde: acdebin-dbg exited (${code}) before it was ready; ` +
              'acde doctor checks the runtime, the GPU and this setup')
          this.#hint(code)
          return code
        }
        if (this.#link) {
          this.#link.onEvent = (message) => this.#event(message)
          this.#link.send({ type: 'hello', role: 'dev' })
          this.#publish()
        }
        if (first) {
          for (const unit of this.#units) {
            const skip = (dir: string) => DevSession.#skipped(unit, basename(dir), dir) || contains(unit.out, dir)
            unit.watcher = TreeWatch.start(unit.pkg.dir, skip, (file) => this.#changed(unit, file))
          }
          watchers.push(...this.#units.map((u) => u.watcher!))
        }
        const code = await started.exited
        this.#link?.close()
        this.#link = null
        if (!this.#revives(code, runtime.stopping, crashes)) {
          this.#hint(code)
          return code
        }
        console.error(`acde: acdebin-dbg exited (${code}); starting it again (acde dev keeps a window session running)`)
        await new Promise((done) => setTimeout(done, DevSession.REVIVE_MS))
        DevClient.prepare(this.#endpoint)
      }
    } finally {
      if (runtime.running) runtime.child?.kill('SIGTERM')
      for (const [signal, handler] of signals) process.off(signal, handler)
      for (const watcher of watchers) watcher.close()
      for (const unit of this.#units) clearTimeout(unit.timer)
      Sessions.remove(process.pid)
      this.#link?.close()
      this.#link = null
      if (process.platform !== 'win32') rmSync(this.#endpoint, { force: true })
    }
  }

  #spawn(target: Target, env: NodeJS.ProcessEnv, runtime: Running): Child {
    const stdio: StdioOptions = this.#verbose ? 'inherit' : ['inherit', 'inherit', 'pipe']
    const started = Runtime.spawn([this.#acdert, target.kind, target.id], { env, stdio })
    if (!this.#verbose) DevSession.quiet(started.process.stderr!, process.stderr)
    runtime.child = started
    runtime.running = true
    void started.exited.finally(() => {
      if (runtime.child === started) runtime.running = false
    })
    return started
  }

  #revives(code: number, stopping: boolean, crashes: number[]): boolean {
    if (!this.#resilient || stopping || code === 0) return false
    const now = performance.now()
    crashes.push(now)
    while (crashes.length && now - crashes[0]! > DevSession.CRASH_WINDOW_MS) crashes.shift()
    if (crashes.length <= DevSession.CRASHES) return true
    const within = DevSession.CRASH_WINDOW_MS / 1000
    console.error(`acde: acdebin-dbg exited ${crashes.length} times within ${within} s; giving up`)
    return false
  }

  async #firstBuild(): Promise<void> {
    for (;;) {
      try {
        for (const unit of this.#units) {
          unit.built = await unit.pkg.build(unit.out, { dev: true })
          unit.served = DevSession.#served(unit.pkg, unit.built)
        }
        return
      } catch (error) {
        if (!this.#resilient) throw error
        const message = error instanceof Error ? error.message : String(error)
        console.error(`acde: build failed: ${message}\nacde: waiting for a change to build again`)
        await this.#nextChange()
      }
    }
  }

  async #nextChange(): Promise<void> {
    const watchers: Watching[] = []
    try {
      await new Promise<void>((done) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        for (const unit of this.#units) {
          const skip = (dir: string) => DevSession.#skipped(unit, basename(dir), dir) || contains(unit.out, dir)
          watchers.push(TreeWatch.start(unit.pkg.dir, skip, (file) => {
            const path = resolve(unit.pkg.dir, file)
            const skipped = file.split(/[\\/]/).some((part) => DevSession.#skipped(unit, part, path))
            if (skipped || contains(unit.out, path)) return
            clearTimeout(timer)
            timer = setTimeout(done, SETTLE_MS)
          }))
        }
      })
    } finally {
      for (const watcher of watchers) watcher.close()
    }
  }

  #event(message: Message): void {
    if (message['event'] === 'devtools') this.#presses = this.#presses.then(() => this.#devtools(message))
  }

  /**
   * F12 in a host window: open DevTools on the page acdert names, as acde devtools <page> does. Presses run one after
   * another, so a second press finds the window the first opened and brings it to the front.
   */
  async #devtools(message: Message): Promise<void> {
    const link = this.#link
    const web = message['web']
    if (!link || typeof web !== 'string') return
    try {
      const endpoint = Devtools.endpoint(await link.request('devtools'))
      const wanted = [web, ...(Number.isInteger(message['window']) ? [String(message['window'])] : [])]
      const target = Devtools.pick(await Devtools.targets(endpoint), wanted, web)
      await Devtools.present(target, endpoint, { address: 'fallback' })
    } catch (error) {
      console.error(`acde: F12: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #hint(code: number): void {
    if (!this.#headless && code !== 0 && code < 128) console.error(`acde: ${DevSession.WINDOW_HINT}`)
  }

  #publish(): void {
    try {
      Sessions.write({
        pid: process.pid,
        endpoint: this.#endpoint,
        dirs: this.#units.map((u) => u.pkg.dir),
        apps: [...new Set(this.#units.flatMap((u) => u.built?.apps ?? []))],
        desktop: this.#shown,
        headless: this.#headless,
        ...(this.#test && { test: true }),
        options: {
          desktop: this.#desktop === null || typeof this.#desktop === 'string' ? this.#desktop : this.#desktop.pkg.dir,
          app: this.#app ?? null,
        },
        started: this.#started,
        ...(this.#reloaded && { reloaded: this.#reloaded }),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`acde: acde webs / eval / shot / inspect / act will not find this session: ${reason}`)
    }
  }

  #changed(unit: Unit, file: string | null): void {
    if (file === null) return
    const path = resolve(unit.pkg.dir, file)
    if (file.split(/[\\/]/).some((part) => DevSession.#skipped(unit, part, path)) || E2E_FILE.test(file)) return
    if (DevSession.#directory(path)) return
    if (contains(unit.out, path)) return
    const nested = (other: Unit) =>
      other !== unit && contains(unit.pkg.dir, other.pkg.dir) && contains(other.pkg.dir, path)
    if (this.#units.some(nested)) return
    clearTimeout(unit.timer)
    unit.timer = setTimeout(() => {
      this.#dirty.add(unit)
      void this.#drain()
    }, SETTLE_MS)
  }

  static reload(pkg: AppPackage, before: Served | undefined, after: Served | undefined): Reload {
    if (!before || !after) return 'full'
    const reload = Changes.reload(before.snapshot, after.snapshot, after.fixed)
    return reload === 'none' && !pkg.manifest ? 'full' : reload
  }

  static #served(pkg: AppPackage, built: Built): Served | undefined {
    try {
      const manifest = pkg.manifest
        ?? (JSON.parse(readFileSync(join(built.dir, 'package.json'), 'utf8')) as { acde: PackageManifest }).acde
      const { roots, fixed } = Changes.served(built.dir, manifest, !pkg.manifest)
      return { snapshot: Changes.snapshot(built.dir, roots), fixed }
    } catch {
      return undefined
    }
  }

  static #skipped(unit: Unit, name: string, path: string): boolean {
    if (Changes.IGNORED.has(name)) return true
    if (!SKIPPED.has(name)) return false
    const manifest = unit.pkg.manifest
    if (!manifest) return true
    const { roots } = Changes.served(unit.pkg.dir, manifest, false)
    return !roots.some((root) => contains(join(unit.pkg.dir, root), path))
  }

  async #marks(): Promise<Reloaded | null> {
    const link = this.#link
    if (!link) return null
    const next = async (op: string) => {
      const page = (await link.request(op, { limit: 1 })) as { next?: unknown } | null
      return typeof page?.next === 'number' ? page.next : 0
    }
    const asked = Promise.all([next('console'), next('network')])
      .then(([logs, requests]) => ({ console: logs, network: requests }), () => null)
    return await Promise.race([asked, new Promise<null>((done) => setTimeout(() => done(null), MARK_MS).unref())])
  }

  static #directory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  async #drain(): Promise<void> {
    if (this.#building) return
    this.#building = true
    try {
      for (let unit = this.#next(); unit; unit = this.#next()) await this.#rebuild(unit)
    } finally {
      this.#building = false
    }
  }

  #next(): Unit | undefined {
    const unit = this.#dirty.values().next().value
    if (unit) this.#dirty.delete(unit)
    return unit
  }

  async #rebuild(unit: Unit): Promise<void> {
    const started = performance.now()
    const who = this.#units.length > 1 ? `${unit.pkg.name}: ` : ''
    try {
      unit.pkg = new AppPackage(unit.pkg.dir)
      const built = await unit.pkg.build(unit.out, { dev: true })
      const refused = this.#level === null ? null : DevSession.refusal({ pkg: unit.pkg, built }, this.#level)
      if (refused) throw new Error(refused)
      unit.built = built
      const served = DevSession.#served(unit.pkg, built)
      const reload = DevSession.reload(unit.pkg, unit.served, served)
      unit.served = served
      const took = `${who}rebuilt (${Math.round(performance.now() - started)} ms)`
      if (reload === 'none') {
        console.log(`acde: ${took}; nothing the runtime loads changed, so no reload`)
        return
      }
      console.log(`acde: ${took}, ${reload === 'hot' ? 'swapping its styles and scripts in place' : 'reloading'}`)
      this.#reloaded = (await this.#marks()) ?? this.#reloaded
      const hot = reload === 'hot' ? { hot: true } : {}
      for (const app of built.apps) this.#link?.send({ type: 'reload', app, ...hot })
      if (this.#shown !== null && built.desktops.includes(this.#shown)) this.#link?.send({ type: 'reload', ...hot })
      if (this.#link) this.#publish()
    } catch (error) {
      console.error(`acde: ${who}build failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
