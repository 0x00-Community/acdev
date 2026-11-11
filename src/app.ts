import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AcdeConfig, AppManifest as AppEntry, DesktopConfig, DesktopManifest, PackageManifest, ServiceManifest,
  WindowAppConfig,
} from '@dopame/acde-api'
import { API_LEVEL, Manifest, type ConfiguredService } from '@dopame/acde-api/manifest'
import { Bundler, type PublicRules } from './bundler.ts'
import { CONFIGS } from './configs.ts'
import { Frameworks, type Output } from './frameworks.ts'
import { Jsonc } from './runtime.ts'

interface BuiltApp {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly entry: string
  readonly capabilities?: Readonly<Record<string, unknown>>
  readonly optional?: readonly string[]
  readonly services?: readonly string[]
  readonly heapMb?: number
  readonly size?: readonly [number, number]
  readonly multiple?: boolean
  readonly frame?: boolean
  readonly mimeTypes?: readonly string[]
  readonly schemes?: readonly string[]
  readonly requests?: readonly string[]
  readonly backend?: { readonly entry: string; readonly port: number }
}

type AppConfig = WindowAppConfig & Pick<AppEntry, 'schemes' | 'requests'>

interface BuiltPackage {
  readonly name: string
  readonly version: string
  readonly private: true
  readonly acde: PackageManifest & {
    readonly apps: readonly BuiltApp[]
    readonly assets: Readonly<Record<string, readonly string[]>>
  }
}

const BACKENDS = [
  'server.ts', 'server.js', 'src/server.ts', 'src/server.js',
  'server/index.ts', 'server/index.js', 'backend/index.ts', 'backend/index.js',
]
const DEFAULT_PORT = 3000
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface BuildOptions {
  readonly dev?: boolean
}

export class Project {
  static readonly CONFIGS = CONFIGS
  static readonly ID = /^[a-z0-9][a-z0-9-]*$/

  readonly dir: string
  readonly name: string
  readonly version: string
  readonly from: string
  readonly config: AcdeConfig
  readonly pkg: Readonly<Record<string, unknown>>
  readonly entryGiven: boolean
  readonly #bundler: Bundler
  #dev = false

  constructor(dir: string) {
    this.dir = realpathSync(resolve(dir))
    const file = join(this.dir, 'package.json')
    const pkg = existsSync(file)
      ? (Jsonc.parse(readFileSync(file, 'utf8'), 'package.json') as Record<string, unknown>)
      : {}
    this.pkg = pkg
    const found = Project.CONFIGS.map((name) => join(this.dir, name)).find((path) => existsSync(path))
    if (!found && !existsSync(file)) throw new Error(`no ${Project.CONFIGS[0]} or package.json in ${this.dir}`)
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    if (found) {
      const config = Jsonc.parse(readFileSync(found, 'utf8'), basename(found)) as AcdeConfig
      if (typeof config !== 'object' || config === null || (config.type !== 'app' && config.type !== 'desktop')) {
        throw new Error(`${basename(found)}: "type" is "app" (a window app) or "desktop"`)
      }
      this.config = config
      this.from = basename(found)
    } else {
      const label = text(pkg['displayName']) ?? text(pkg['productName'])
      this.config = { type: 'app', ...(label !== undefined && { label }) }
      this.from = 'package.json'
    }
    this.entryGiven = this.config.entry !== undefined
    this.name = text(this.config.name) ?? text(pkg['name']) ?? basename(this.dir)
    this.version = text(this.config.version) ?? text(pkg['version']) ?? '0.0.0'
    this.#bundler = Bundler.for(this.dir)
  }

  get framework(): string | null {
    const config = this.config
    if (config.type !== 'app') return null
    return Frameworks.detect(this.#detecting, config.framework)?.name ?? null
  }

  get #detecting(): { pkg: Readonly<Record<string, unknown>>; entry: boolean } {
    return { pkg: this.pkg, entry: this.entryGiven }
  }

  static idOf(name: string): string | null {
    const id = name
      .replace(/^@[^/]*\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    return id || null
  }

  get id(): string {
    const id = this.config.id ?? Project.idOf(this.name)
    if (!id || !Project.ID.test(id)) throw new Error(`no usable id (${String(id)}): set "id" in ${this.from}`)
    return id
  }

  check(): string[] {
    const errors: string[] = []
    const need = (path: string | undefined, what: string) => {
      if (path !== undefined && !existsSync(resolve(this.dir, path)))
        errors.push(`no ${path} (${what} in ${this.from})`)
    }
    const icon = (value: string | undefined, what: string) => {
      const problem = value !== undefined && Project.isIconPath(value) ? this.#iconProblem(value) : null
      if (problem) errors.push(`${what} ${JSON.stringify(value)} in ${this.from}: ${problem}`)
    }
    try {
      this.id
    } catch (error) {
      errors.push((error as Error).message)
    }
    const config = this.config
    if (config.type === 'app') {
      icon(config.icon, 'icon')
      try {
        if (this.framework) return errors
      } catch (error) {
        return [...errors, (error as Error).message]
      }
      need(config.entry ?? 'index.html', 'entry')
      if (config.backend) need(config.backend.entry, 'backend.entry')
      return errors
    }
    need(config.entry ?? 'index.html', 'entry')
    const services = Manifest.configServices(config.services)
    if (typeof services === 'string') errors.push(`services in ${this.from}: ${services}`)
    else for (const { name, module } of services) need(module, `services.${name}`)
    for (const app of config.apps ?? []) {
      need(app.entry, `apps ${app.id}: entry`)
      icon(app.icon, `apps ${app.id}: icon`)
    }
    return errors
  }

  async build(out: string, options: BuildOptions = {}): Promise<BuiltPackage> {
    this.#dev = options.dev === true
    out = resolve(out)
    const errors = this.check()
    if (errors.length > 0) throw new Error(errors.join('\n'))
    const up = relative(out, this.dir)
    if (up === '' || (!up.startsWith('..') && !isAbsolute(up))) throw new Error(`--out ${out} holds the project`)
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    const assets: Record<string, string[]> = {}
    const config = this.config
    const manifest: { apps: BuiltApp[]; desktops?: DesktopManifest[]; services?: ServiceManifest[] } = { apps: [] }
    if (config.type === 'app') {
      manifest.apps.push(await this.#app({ ...config, id: this.id }, out, '', assets, true))
    } else {
      const services = Project.services(config)
      manifest.desktops = [await this.#desktop(config, services, out, assets)]
      for (const app of config.apps ?? [])
        manifest.apps.push(await this.#app(app, out, `apps/${app.id}/`, assets, false))
      if (services.length > 0) {
        manifest.services = []
        for (const { name, module } of services) manifest.services.push(await this.#service(name, module, out))
      }
    }
    const acde = { apiLevel: API_LEVEL, ...manifest, assets }
    const built: BuiltPackage = { name: this.name, version: this.version, private: true, acde }
    writeFileSync(join(out, 'package.json'), JSON.stringify(built, null, 2) + '\n')
    return built
  }

  async #app(
    config: WindowAppConfig, out: string, dir: string, assets: Record<string, string[]>, own: boolean,
  ): Promise<BuiltApp> {
    const id = config.id!
    const base = `/app/${id}/`
    const framework =
      own && this.config.type === 'app' ? Frameworks.detect(this.#detecting, this.config.framework) : null
    if (framework) {
      console.log(`acde: ${framework.label}: building with its own tools`)
      await Frameworks.install(this.dir)
      const scratch = mkdtempSync(join(tmpdir(), 'acde-'))
      try {
        const built = await framework.build({ dir: this.dir, pkg: this.pkg, scratch, bundler: this.#bundler })
        const placed = await this.#place(built, config, out, base, assets)
        return Project.#manifestOf(config, id, { ...placed, icon: this.#icon(config.icon, join(out, 'web'), base) })
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
    const page = await this.#web(resolve(this.dir, config.entry ?? 'index.html'), join(out, `${dir}web`), base, own)
    const backend = await this.#ownBackend(config, out, dir, base, assets)
    assets[base] = [`${dir}web`]
    const icon = this.#icon(config.icon, join(out, `${dir}web`), base)
    return Project.#manifestOf(config, id, { entry: base + page, backend, icon })
  }

  async #place(
    built: Output, config: WindowAppConfig, out: string, base: string, assets: Record<string, string[]>,
  ): Promise<{ entry: string; backend: string | null }> {
    const web = join(out, 'web')
    mkdirSync(web, { recursive: true })
    if (built.web) cpSync(built.web, web, { recursive: true, verbatimSymlinks: true })
    assets[base] = ['web']
    if (!built.server)
      return { entry: base + built.page!, backend: await this.#ownBackend(config, out, '', base, assets) }
    const backend = join(out, 'backend')
    cpSync(built.server.dir, backend, { recursive: true, verbatimSymlinks: true })
    await this.#bundler.preload(dirname(join(backend, built.server.entry)))
    assets[`${base}backend/`] = ['backend']
    return { entry: base, backend: `${base}backend/${built.server.entry}` }
  }

  async #ownBackend(
    config: WindowAppConfig, out: string, dir: string, base: string, assets: Record<string, string[]>,
  ): Promise<string | null> {
    const server = this.#server(config.backend)
    if (!server) return null
    const backend = join(out, `${dir}backend`)
    await this.#bundler.backend({ entry: server, out: backend, dir: this.dir, splitting: false, dev: this.#dev })
    await this.#bundler.preload(backend)
    assets[`${base}backend/`] = [`${dir}backend`]
    return `${base}backend/server.js`
  }

  static #manifestOf(
    config: AppConfig, id: string, placed: { entry: string; backend: string | null; icon: string },
  ): BuiltApp {
    const port = (config.backend ? config.backend.port : undefined) ?? DEFAULT_PORT
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error(`app ${id}: backend.port must be a port number, not ${String(port)}`)
    return {
      id,
      label: config.label ?? id,
      icon: placed.icon,
      entry: placed.entry,
      ...(config.capabilities && { capabilities: config.capabilities }),
      ...(config.optional && config.optional.length > 0 && { optional: config.optional }),
      ...(config.services && config.services.length > 0 && { services: config.services }),
      ...(config.heapMb !== undefined && { heapMb: config.heapMb }),
      ...(config.size && { size: config.size }),
      ...(config.multiple !== undefined && { multiple: config.multiple }),
      ...(config.frame !== undefined && { frame: config.frame }),
      ...(config.mimeTypes && { mimeTypes: config.mimeTypes }),
      ...(config.schemes && config.schemes.length > 0 && { schemes: config.schemes }),
      ...(config.requests && config.requests.length > 0 && { requests: config.requests }),
      ...(placed.backend && { backend: { entry: placed.backend, port } }),
    }
  }

  static isIconPath(icon: string): boolean {
    return /[\\/]|\.[a-z0-9]+$/i.test(icon)
  }

  #iconProblem(icon: string): string | null {
    const file = resolve(this.dir, icon)
    if (!existsSync(file) || !statSync(file).isFile()) return 'no such file'
    const ext = extname(file).toLowerCase()
    if (ext !== '.svg' && ext !== '.png') return 'an icon image is .svg or .png'
    const data = readFileSync(file)
    if (ext === '.png' && !data.subarray(0, PNG.length).equals(PNG)) return 'not a PNG image'
    if (ext === '.svg' && (data.includes(0) || !/<svg[\s>]/i.test(data.toString('utf8')))) return 'not an SVG image'
    return null
  }

  #icon(icon: string | undefined, web: string, base: string): string {
    if (icon === undefined) return 'app'
    if (!Project.isIconPath(icon)) return icon
    const data = readFileSync(resolve(this.dir, icon))
    const ext = extname(icon).toLowerCase()
    const taken = (name: string) => existsSync(join(web, name)) && !readFileSync(join(web, name)).equals(data)
    const hash = () => createHash('sha256').update(data).digest('hex').slice(0, 8)
    const name = taken(`icon${ext}`) ? `icon-${hash()}${ext}` : `icon${ext}`
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, name), data)
    return base + name
  }

  static services(config: DesktopConfig): ConfiguredService[] {
    const services = Manifest.configServices(config.services)
    if (typeof services === 'string') throw new Error(services)
    return services
  }

  static grants(services: readonly ConfiguredService[]): NonNullable<DesktopManifest['services']> {
    return services.map(({ name, modules }) => (modules.length > 0 ? { name, modules } : name))
  }

  async #desktop(
    config: DesktopConfig, services: readonly ConfiguredService[], out: string, assets: Record<string, string[]>,
  ): Promise<DesktopManifest> {
    const id = this.id
    const base = `/desktop/${id}/`
    const page = await this.#web(resolve(this.dir, config.entry ?? 'index.html'), join(out, 'desktop'), base, true)
    assets[base] = ['desktop']
    return {
      id,
      name: config.label ?? id,
      ...(config.description !== undefined && { description: config.description }),
      entry: `desktop/${page}`,
      ...(services.length > 0 && { services: Project.grants(services) }),
      ...(config.heapMb !== undefined && { heapMb: config.heapMb }),
    }
  }

  async #service(name: string, module: string, out: string): Promise<ServiceManifest> {
    await this.#bundler.service(name, resolve(this.dir, module), join(out, 'services'), this.dir)
    return { name, module: `services/${name}.js` }
  }

  #server(backend: WindowAppConfig['backend']): string | undefined {
    if (backend === false) return undefined
    if (backend?.entry !== undefined) return resolve(this.dir, backend.entry)
    return BACKENDS.map((file) => join(this.dir, file)).find((file) => existsSync(file))
  }

  async #web(entry: string, out: string, base: string, own: boolean): Promise<string> {
    const html = Bundler.isHtml(entry)
    const rules: PublicRules = {
      dir: this.dir,
      publicDir: join(this.dir, this.config.public ?? 'public'),
      own,
      rooted: own && html && this.config.type === 'app',
    }
    const page = await this.#bundler.web({ entry, out, base, rules, dev: this.#dev })
    if (own && existsSync(rules.publicDir))
      cpSync(rules.publicDir, out, { recursive: true, force: false, errorOnExist: false })
    return page
  }
}
