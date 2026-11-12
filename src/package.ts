import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AppManifest as AppEntry, WindowAppConfig } from '@dopame/acde-api'
import {
  API_LEVEL, Manifest, platformSupport, RUNNING_MODES,
  type AppManifest, type Capabilities, type Findings, type PackageManifest, type RunningMode,
} from '@dopame/acde-api/manifest'
import { Project, type BuildOptions } from './app.ts'
import { Imports, type ImportFindings, type ImportOwner } from './imports.ts'
import { Jsonc } from './runtime.ts'
import { Sdk } from './sdk.ts'
import { PackageManager } from './pm.ts'

export interface PlatformReport {
  readonly modes: readonly RunningMode[]
  readonly errors: readonly string[]
  readonly notes: readonly string[]
}

interface Declared {
  readonly id: string
  readonly capabilities: Capabilities
  readonly optional: readonly string[]
}

interface ConfigApp {
  readonly raw: AppEntry
  readonly system: boolean
  readonly entries: readonly string[]
}

export interface Checked extends Findings {
  readonly notes: readonly string[]
}

export interface Built {
  readonly dir: string
  readonly id: string
  readonly desktops: readonly string[]
  readonly apps: readonly string[]
  readonly level: number | null
}

export class AppPackage {
  static readonly PLATFORMS: Readonly<Record<string, string>> = { windows: 'win32', macos: 'darwin', linux: 'linux' }

  static here(os: string = process.platform): string | null {
    return Object.entries(AppPackage.PLATFORMS).find(([, key]) => key === os)?.[0] ?? null
  }

  readonly dir: string
  readonly name: string
  readonly manifest: PackageManifest | null
  readonly project: Project | null

  constructor(dir: string) {
    this.dir = realpathSync(resolve(dir))
    const file = join(this.dir, 'package.json')
    const json = existsSync(file)
      ? (Jsonc.parse(readFileSync(file, 'utf8'), 'package.json') as { name?: unknown; acde?: { apps?: unknown } })
      : {}
    const configured = Project.CONFIGS.some((name) => existsSync(join(this.dir, name)))
    this.manifest = !configured && Array.isArray(json.acde?.apps) ? (json.acde as PackageManifest) : null
    this.project = this.manifest ? null : new Project(this.dir)
    this.name = this.project?.name ?? (typeof json.name === 'string' ? json.name : basename(this.dir))
  }

  static packagesDir(): string {
    const set = process.env['XDG_DATA_HOME']
    return join(set && isAbsolute(set) ? set : join(homedir(), '.local', 'share'), 'acde', 'packages')
  }

  static asset(dir: string, manifest: PackageManifest, url: string): string | null {
    const [found] = Object.entries(manifest.assets ?? {})
      .filter(([prefix]) => url.startsWith(prefix))
      .sort(([a], [b]) => b.length - a.length)
    if (!found) return null
    const [prefix, dirs] = found
    const files = dirs.map((d) => join(dir, d, url.slice(prefix.length)))
    return files.find((file) => AppPackage.#isFile(file)) ?? null
  }

  static check(dir: string, manifest: PackageManifest): Findings {
    const resolveUrl = (url: string) => AppPackage.asset(dir, manifest, url) !== null
    const findings = Manifest.check(manifest, (d) => AppPackage.#isDir(join(dir, d)), resolveUrl)
    for (const desktop of manifest.desktops ?? []) {
      if (!AppPackage.#isFile(join(dir, desktop.entry)))
        findings.errors.push(`desktop ${JSON.stringify(desktop.id)}: no entry ${desktop.entry}`)
    }
    for (const service of manifest.services ?? []) {
      if (!AppPackage.#isFile(join(dir, service.module)))
        findings.errors.push(`service ${JSON.stringify(service.name)}: no module ${service.module}`)
    }
    return findings
  }

  get kind(): string {
    return this.project ? `${this.project.config.type} (${this.project.from})` : 'package'
  }

  check(): Checked {
    const findings = this.manifest ? AppPackage.check(this.dir, this.manifest) : this.#configFindings()
    const imports = this.imports()
    return {
      errors: [...new Set([...findings.errors, ...imports.errors])],
      warnings: [...new Set(findings.warnings)],
      notes: imports.notes,
    }
  }

  #configFindings(): Findings {
    const project = this.project!
    const errors = project.check()
    const apps = this.#configApps()
    if (!apps) return { errors, warnings: [] }
    const config = project.config
    const configured = config.type === 'desktop' ? Manifest.configServices(config.services) : []
    const services = typeof configured === 'string' ? [] : configured
    const manifest: PackageManifest = {
      apiLevel: API_LEVEL,
      apps: apps.map((app) => app.raw),
      ...(config.type === 'desktop' && {
        desktops: [{ id: project.id, name: project.id, entry: 'desktop/index.html', services: Project.grants(services) }],
      }),
      services: services.map(({ name }) => ({ name, module: `services/${name}.js` })),
    }
    const findings = Manifest.check(manifest, () => true, () => true)
    const sdk = this.sdkWarning()
    return { errors: [...errors, ...findings.errors], warnings: [...findings.warnings, ...(sdk ? [sdk] : [])] }
  }

  sdkWarning(): string | null {
    if (!this.project) return null
    const pm = PackageManager.of(this.dir).name
    return AppPackage.localSdk(this.project.pkg) ?? Sdk.warning(Sdk.state(this.dir, this.project.pkg), pm)
  }

  static localSdk(pkg: Readonly<Record<string, unknown>>): string | null {
    const lists = [pkg['dependencies'], pkg['devDependencies']] as (Record<string, unknown> | undefined)[]
    const spec = lists.map((list) => list?.['@dopame/acde-api']).find((value) => typeof value === 'string') as
      | string
      | undefined
    if (!spec?.startsWith('file:')) return null
    const path = spec.slice('file:'.length)
    if (!isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('~')) return null
    return `package.json: @dopame/acde-api is ${spec}, a path on this machine, so the project does not install `
      + 'anywhere else: run acde sdk update to depend on the SDK tarball this acde pairs with'
  }

  #configApps(): ConfigApp[] | null {
    const project = this.project!
    const config = project.config
    const raw = (id: string, app: WindowAppConfig): AppEntry =>
      ({ ...app, id, label: app.label ?? id, icon: 'app', entry: `/app/${id}/index.html`, backend: undefined })
    let id: string
    let framework: string | null
    try {
      id = project.id
      framework = project.framework
    } catch {
      return null
    }
    if (config.type === 'desktop') {
      return (config.apps ?? []).map((app) =>
        ({ raw: raw(app.id, app), system: true, entries: [resolve(project.dir, app.entry)] }))
    }
    const entries = framework ? Imports.sources(project.dir) : [resolve(project.dir, config.entry ?? 'index.html')]
    return [{ raw: raw(id, config), system: false, entries }]
  }

  imports(): ImportFindings {
    const errors: string[] = []
    const owners: ImportOwner[] = []
    const add = (raw: unknown, system: boolean, entries: readonly string[]) => {
      const app = Manifest.app(raw)
      if (typeof app === 'string') errors.push(app)
      else owners.push({ app, system, entries })
    }
    if (this.manifest) {
      const manifest = this.manifest
      const system = (manifest.desktops ?? []).length > 0
      for (const raw of manifest.apps ?? []) {
        const entry = typeof raw?.entry === 'string' ? AppPackage.asset(this.dir, manifest, raw.entry) : null
        add(raw, system, entry ? [entry] : [])
      }
      const found = Imports.check(this.dir, owners, (url) => AppPackage.asset(this.dir, manifest, url))
      return { errors: [...errors, ...found.errors], notes: found.notes }
    }
    const project = this.project!
    for (const app of this.#configApps() ?? []) add(app.raw, app.system, app.entries)
    const found = Imports.check(project.dir, owners, (url) => join(project.dir, url))
    return { errors: [...errors, ...found.errors], notes: found.notes }
  }

  platform(name: string): PlatformReport {
    const key = Object.hasOwn(AppPackage.PLATFORMS, name) ? AppPackage.PLATFORMS[name]! : null
    if (!key) throw new Error(`--platform ${name}: windows, macos or linux`)
    const rows = RUNNING_MODES.flatMap((mode) => {
      const row = platformSupport(key, mode)
      return row ? [{ mode, unsupported: row.unsupported }] : []
    })
    const errors: string[] = []
    const notes: string[] = []
    for (const app of this.#declarations()) {
      for (const { mode, unsupported } of rows) {
        const at = `${name} (${mode}): app ${JSON.stringify(app.id)}`
        for (const capability of unsupported.filter((c) => !!app.capabilities[c])) {
          if (app.optional.includes(capability))
            notes.push(`${at} runs without optional ${capability}, which this mode lacks`)
          else errors.push(`${at} requires ${capability}, which this mode lacks`)
        }
      }
    }
    return { modes: rows.map((row) => row.mode), errors, notes }
  }

  #declarations(): Declared[] {
    if (this.manifest) {
      return (this.manifest.apps ?? [])
        .map((raw) => Manifest.app(raw))
        .filter((app): app is AppManifest => typeof app !== 'string')
    }
    const project = this.project!
    const config = project.config
    const declared = (id: string, app: WindowAppConfig): Declared =>
      ({ id, capabilities: app.capabilities ?? {}, optional: app.optional ?? [] })
    if (config.type === 'desktop') return (config.apps ?? []).map((app) => declared(app.id, app))
    return [declared(config.id ?? Project.idOf(project.name) ?? project.name, config)]
  }

  async build(out: string, options: BuildOptions = {}): Promise<Built> {
    if (this.manifest) {
      AppPackage.#throw(this.check())
      const apps = (this.manifest.apps ?? []).map((app) => app.id)
      const desktops = (this.manifest.desktops ?? []).map((d) => d.id)
      const level = AppPackage.#level(this.manifest)
      return { dir: this.dir, id: this.name.replace(/^@[^/]*\//, ''), desktops, apps, level }
    }
    AppPackage.#throw({ ...this.imports(), warnings: [] })
    const built = await this.project!.build(out, options)
    AppPackage.#throw(AppPackage.check(out, built.acde))
    const desktops = (built.acde.desktops ?? []).map((d) => d.id)
    const apps = built.acde.apps.map((app) => app.id)
    return { dir: out, id: this.project!.id, desktops, apps, level: AppPackage.#level(built.acde) }
  }

  static #level(manifest: PackageManifest): number | null {
    const level = Manifest.apiLevel(manifest.apiLevel)
    return typeof level === 'number' ? level : null
  }

  install(built: Built): string {
    const dest = join(AppPackage.packagesDir(), built.id)
    mkdirSync(dirname(dest), { recursive: true })
    if (this.manifest) {
      if (existsSync(dest) || AppPackage.#isLink(dest)) {
        if (!AppPackage.#isLink(dest)) throw new Error(`${dest} exists and is not a link`)
        rmSync(dest)
      }
      symlinkSync(this.dir, dest, process.platform === 'win32' ? 'junction' : 'dir')
      return dest
    }
    const next = `${dest}.new-${process.pid}`
    rmSync(next, { recursive: true, force: true })
    cpSync(built.dir, next, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    renameSync(next, dest)
    return dest
  }

  static #throw(findings: Findings & Partial<Checked>): void {
    for (const warning of findings.warnings) console.error(`warning: ${warning}`)
    for (const note of findings.notes ?? []) console.error(`note: ${note}`)
    if (findings.errors.length > 0) throw new Error(findings.errors.join('\n'))
  }

  static #isFile(path: string): boolean {
    return existsSync(path) && statSync(path).isFile()
  }

  static #isDir(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory()
  }

  static #isLink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }
}
