import { existsSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { DevClient } from './ipc.ts'
import { AppPackage, type Built } from './package.ts'
import { Project } from './app.ts'
import { contains, E2E_FILE, SKIPPED } from './paths.ts'
import { Runtime, type Child } from './runtime.ts'
import { Sessions } from './sessions.ts'

const SETTLE_MS = 150
const VERSION_MS = 10_000

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
  readonly acdert: string
}

interface Unit {
  pkg: AppPackage
  readonly out: string
  built: Built | null
  timer?: ReturnType<typeof setTimeout>
  watcher?: FSWatcher
}

export class DevSession {
  static readonly DEFAULT_DESKTOP = 'dopame'

  readonly #units: Unit[]
  readonly #desktop: Unit | string | null
  readonly #app: string | undefined
  readonly #acdert: string
  readonly #headless: boolean
  readonly #endpoint = DevClient.endpoint()
  #link: DevClient | null = null
  readonly #dirty = new Set<Unit>()
  readonly #started = Date.now()
  #building = false
  #shown: string | null = null
  #level: number | null = null

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
  }

  get multiple(): boolean {
    return this.#units.length > 1 || this.#desktop !== null
  }

  static target(built: Built, app: string | undefined): Target {
    if (app !== undefined) {
      if (!built.apps.includes(app)) throw new Error(`no app ${JSON.stringify(app)} here (${built.apps.join(', ')})`)
      return { kind: 'app', id: app }
    }
    const desktop = built.desktops[0]
    if (desktop !== undefined) return { kind: 'desktop', id: desktop }
    const first = built.apps[0]
    if (first === undefined) throw new Error('nothing to run: no desktop and no app')
    return { kind: 'app', id: first }
  }

  #desktopOf(value: string): Unit | string {
    const dir = resolve(value)
    const pathy = /[\\/]/.test(value) || value === '.' || value === '..'
    const project =
      existsSync(dir) &&
      statSync(dir).isDirectory() &&
      ['package.json', ...Project.CONFIGS].some((name) => existsSync(resolve(dir, name)))
    if (pathy && !project)
      throw new Error(`--desktop ${value}: no project or package there (no package.json or ${Project.CONFIGS[0]})`)
    if (!project) {
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

  static async runtimeLevel(acdert: string): Promise<{ level: number; said: string }> {
    const child = Runtime.spawn([acdert, '--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let said = ''
    child.process.stdout!.setEncoding('utf8').on('data', (chunk: string) => (said += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), VERSION_MS)
    try {
      await child.exited
    } finally {
      clearTimeout(timer)
    }
    const level = /\(contract level (\d+)\)/.exec(said)
    return { level: level ? Number(level[1]) : 0, said: said.trim() }
  }

  static refusal(unit: { readonly pkg: AppPackage; readonly built: Built | null }, runtime: number): string | null {
    const level = unit.built?.level ?? null
    if (level === null || level === runtime) return null
    return `${unit.pkg.name}: needs level ${level}, runtime is level ${runtime}`
  }

  async #checkLevels(): Promise<void> {
    if (this.#units.every((u) => u.built?.level === null)) return
    const { level, said } = await DevSession.runtimeLevel(this.#acdert)
    this.#level = level
    const refused = this.#units.map((u) => DevSession.refusal(u, level)).filter((r) => r !== null)
    if (refused.length === 0) return
    const why = level === 0 ? `\n${this.#acdert} --version says ${JSON.stringify(said)}, no contract level: ` +
      'it is older than contract levels; use an acdert that has them' : ''
    throw new Error(`${refused.join('\n')}${why}`)
  }

  async run(): Promise<number> {
    for (const unit of this.#units) unit.built = await unit.pkg.build(unit.out)
    const target = this.#plan()
    await this.#checkLevels()
    this.#shown = target.kind === 'desktop' ? target.id : null
    DevClient.prepare(this.#endpoint)
    const watchers: FSWatcher[] = []
    const signals: [NodeJS.Signals, () => void][] = []
    let child: Child | null = null
    let running = false
    try {
      const paths = [...new Set(this.#units.map((u) => u.built!.dir)), process.env['ACDE_PATH']]
        .filter(Boolean)
        .join(delimiter)
      const what = this.#units.map((u) => `${u.pkg.name} (${u.built!.dir})`).join(', ')
      const headless = this.#headless ? ' (headless)' : ''
      console.log(`acde: dev ${target.kind} ${target.id}${headless}: ${what}; rebuilding and reloading on change`)
      const env = {
        ...process.env,
        ACDE_DEV: this.#endpoint,
        ACDE_PATH: paths,
        ACDE_RUNTIME: Runtime.bun ? 'bun' : 'node',
        ...(this.#headless && { ACDE_HEADLESS: '1' }),
      }
      const started = Runtime.spawn([this.#acdert, target.kind, target.id], { env, stdio: 'inherit' })
      child = started
      running = true
      void started.exited.finally(() => {
        running = false
      })
      signals.push(['SIGINT', () => undefined])
      if (process.platform !== 'win32')
        for (const signal of ['SIGTERM', 'SIGHUP'] as const) signals.push([signal, () => started.kill(signal)])
      for (const [signal, handler] of signals) process.on(signal, handler)
      this.#link = await DevClient.reach(
        this.#endpoint,
        () => running,
        () =>
          console.error(
            `acde: acdert has not opened ${this.#endpoint} after 10 s; an acdert older than acde dev never does ` +
              '(no reload, no acde webs / eval …): use a newer one',
          ),
      )
      if (!this.#link) return await started.exited
      this.#link.send({ type: 'hello', role: 'dev' })
      this.#publish()
      for (const unit of this.#units) {
        unit.watcher = watch(unit.pkg.dir, { recursive: true }, (_, file) =>
          this.#changed(unit, file === null ? null : String(file)))
      }
      watchers.push(...this.#units.map((u) => u.watcher!))
      return await started.exited
    } finally {
      if (running) child?.kill('SIGTERM')
      for (const [signal, handler] of signals) process.off(signal, handler)
      for (const watcher of watchers) watcher.close()
      for (const unit of this.#units) clearTimeout(unit.timer)
      Sessions.remove(process.pid)
      this.#link?.close()
      this.#link = null
      if (process.platform !== 'win32') rmSync(this.#endpoint, { force: true })
    }
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
        started: this.#started,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`acde: acde webs / eval / shot / inspect / act will not find this session: ${reason}`)
    }
  }

  #changed(unit: Unit, file: string | null): void {
    if (file === null) return
    const path = resolve(unit.pkg.dir, file)
    if (file.split(/[\\/]/).some((part) => SKIPPED.has(part)) || E2E_FILE.test(file)) return
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
      const built = await unit.pkg.build(unit.out)
      const refused = this.#level === null ? null : DevSession.refusal({ pkg: unit.pkg, built }, this.#level)
      if (refused) throw new Error(refused)
      unit.built = built
      console.log(`acde: ${who}rebuilt (${Math.round(performance.now() - started)} ms), reloading`)
      for (const app of built.apps) this.#link?.send({ type: 'reload', app })
      if (this.#shown !== null && built.desktops.includes(this.#shown)) this.#link?.send({ type: 'reload' })
      if (this.#link) this.#publish()
    } catch (error) {
      console.error(`acde: ${who}build failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
