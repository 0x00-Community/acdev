import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AcdeConfig, AppConfig, DesktopConfig, DesktopManifest, PackageManifest, ServiceManifest, WindowAppConfig } from '@dopame/acde-api'
import acdeVite from '@dopame/acde-api/vite'
import { Bundler, type PublicRules } from './bundler.ts'
import { CONFIGS } from './configs.ts'
import { Frameworks, type Output } from './frameworks.ts'
import { Jsonc } from './runtime.ts'
import { appId } from './sockets.ts'

interface BuiltApp {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly entry: string
  readonly capabilities?: Readonly<Record<string, unknown>>
  readonly heapMb?: number
  readonly size?: readonly [number, number]
  readonly multiple?: boolean
  readonly frame?: boolean
  readonly mimeTypes?: readonly string[]
  readonly backend?: { readonly entry: string; readonly port: number }
}

interface BuiltPackage {
  readonly name: string
  readonly version: string
  readonly private: true
  readonly acde: PackageManifest & { readonly apps: readonly BuiltApp[]; readonly assets: Readonly<Record<string, readonly string[]>> }
}

const BACKENDS = ['server.ts', 'server.js', 'src/server.ts', 'src/server.js', 'server/index.ts', 'server/index.js', 'backend/index.ts', 'backend/index.js']
const DEFAULT_PORT = 3000
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface Legacy {
  readonly id?: string
  readonly label?: string
  readonly icon?: string
  readonly capabilities?: AppConfig['capabilities']
  readonly heapMb?: number
  readonly multiple?: boolean
  readonly web?: string
  readonly server?: string
  readonly backend?: false | { readonly port?: number }
}

export class Project {
  static readonly CONFIGS = CONFIGS

  readonly dir: string
  readonly name: string
  readonly version: string
  readonly from: string
  readonly config: AcdeConfig
  readonly pkg: Readonly<Record<string, unknown>>
  readonly entryGiven: boolean
  readonly #bundler: Bundler

  constructor(dir: string) {
    this.dir = realpathSync(resolve(dir))
    const file = join(this.dir, 'package.json')
    const pkg = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
    this.pkg = pkg
    const found = Project.CONFIGS.map((name) => join(this.dir, name)).find((path) => existsSync(path))
    if (!found && !existsSync(file)) throw new Error(`no ${Project.CONFIGS[0]} or package.json in ${this.dir}`)
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    if (found) {
      const config = Jsonc.parse(readFileSync(found, 'utf8')) as AcdeConfig
      if (typeof config !== 'object' || config === null || (config.type !== 'app' && config.type !== 'desktop')) {
        throw new Error(`${basename(found)}: "type" is "app" (a window app) or "desktop"`)
      }
      this.config = config
      this.from = basename(found)
      this.entryGiven = config.entry !== undefined
    } else {
      const legacy = (pkg['acde'] ?? {}) as Legacy
      if (typeof legacy !== 'object' || legacy === null) throw new Error(`${file}: "acde" is not an object`)
      const { web, server, backend, ...app } = legacy
      this.config = {
        type: 'app',
        ...app,
        label: legacy.label ?? text(pkg['displayName']) ?? text(pkg['productName']),
        entry: web ?? 'index.html',
        backend: backend === false ? false : { ...(server !== undefined && { entry: server }), ...(backend?.port !== undefined && { port: backend.port }) },
      }
      this.from = 'package.json'
      this.entryGiven = web !== undefined
    }
    this.name = text(this.config.name) ?? text(pkg['name']) ?? basename(this.dir)
    this.version = text(this.config.version) ?? text(pkg['version']) ?? '0.0.0'
    this.#bundler = Bundler.for(this.dir)
  }

  get framework(): string | null {
    const config = this.config
    if (config.type !== 'app') return null
    return Frameworks.detect(this.#detecting, config.framework)?.name ?? null
  }

  get #detecting(): { dir: string; pkg: Readonly<Record<string, unknown>>; entry: boolean } {
    return { dir: this.dir, pkg: this.pkg, entry: this.entryGiven }
  }

  get id(): string {
    const id = this.config.id ?? appId(this.name)
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`no usable id (${String(id)}): set "id" in ${this.from}`)
    return id
  }

  check(): string[] {
    const errors: string[] = []
    const need = (path: string | undefined, what: string) => {
      if (path !== undefined && !existsSync(resolve(this.dir, path))) errors.push(`no ${path} (${what} in ${this.from})`)
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
    for (const [name, module] of Object.entries(config.services ?? {})) need(module, `services.${name}`)
    for (const app of config.apps ?? []) {
      need(app.entry, `apps ${app.id}: entry`)
      icon(app.icon, `apps ${app.id}: icon`)
    }
    return errors
  }

  async build(out: string): Promise<BuiltPackage> {
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
      manifest.desktops = [await this.#desktop(config, out, assets)]
      for (const app of config.apps ?? []) manifest.apps.push(await this.#app(app, out, `apps/${app.id}/`, assets, false))
      const services = Object.entries(config.services ?? {})
      if (services.length > 0) {
        manifest.services = []
        for (const [name, module] of services) manifest.services.push(await this.#service(name, module, out))
      }
    }
    const built: BuiltPackage = { name: this.name, version: this.version, private: true, acde: { ...manifest, assets } }
    writeFileSync(join(out, 'package.json'), JSON.stringify(built, null, 2) + '\n')
    return built
  }

  async #app(config: WindowAppConfig, out: string, dir: string, assets: Record<string, string[]>, own: boolean): Promise<BuiltApp> {
    const id = config.id!
    const base = `/app/${id}/`
    const framework = own && this.config.type === 'app' ? Frameworks.detect(this.#detecting, this.config.framework) : null
    if (framework) {
      console.log(`acde: ${framework.label}: building with its own tools`)
      await Frameworks.install(this.dir)
      const scratch = mkdtempSync(join(tmpdir(), 'acde-'))
      try {
        const built = await framework.build({ dir: this.dir, pkg: this.pkg, scratch, vitePlugins: [acdeVite()], bundler: this.#bundler })
        const placed = await this.#place(built, config, out, base, assets)
        return Project.#manifestOf(config, id, { ...placed, icon: this.#icon(config.icon, join(out, 'web'), base) })
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
    const page = await this.#web(resolve(this.dir, config.entry ?? 'index.html'), join(out, `${dir}web`), base, own)
    const server = this.#server(config.backend)
    if (server) {
      await this.#backend(server, join(out, `${dir}backend`))
      assets[`${base}backend/`] = [`${dir}backend`]
    }
    assets[base] = [`${dir}web`]
    return Project.#manifestOf(config, id, { entry: base + page, backend: server ? `${base}backend/server.js` : null, icon: this.#icon(config.icon, join(out, `${dir}web`), base) })
  }

  async #place(built: Output, config: WindowAppConfig, out: string, base: string, assets: Record<string, string[]>): Promise<{ entry: string; backend: string | null }> {
    const web = join(out, 'web')
    mkdirSync(web, { recursive: true })
    if (built.web) cpSync(built.web, web, { recursive: true, verbatimSymlinks: true })
    assets[base] = ['web']
    if (built.server) {
      const backend = join(out, 'backend')
      cpSync(built.server.dir, backend, { recursive: true, verbatimSymlinks: true })
      await this.#bundler.preload(dirname(join(backend, built.server.entry)))
      assets[`${base}backend/`] = ['backend']
      return { entry: base, backend: `${base}backend/${built.server.entry}` }
    }
    const server = this.#server(config.backend)
    if (server) {
      await this.#backend(server, join(out, 'backend'))
      assets[`${base}backend/`] = ['backend']
    }
    return { entry: base + built.page!, backend: server ? `${base}backend/server.js` : null }
  }

  static #manifestOf(config: WindowAppConfig, id: string, placed: { entry: string; backend: string | null; icon: string }): BuiltApp {
    const port = (config.backend ? config.backend.port : undefined) ?? DEFAULT_PORT
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`app ${id}: backend.port must be a port number, not ${String(port)}`)
    return {
      id,
      label: config.label ?? id,
      icon: placed.icon,
      entry: placed.entry,
      ...(config.capabilities && { capabilities: config.capabilities }),
      ...(config.heapMb !== undefined && { heapMb: config.heapMb }),
      ...(config.size && { size: config.size }),
      ...(config.multiple !== undefined && { multiple: config.multiple }),
      ...(config.frame !== undefined && { frame: config.frame }),
      ...(config.mimeTypes && { mimeTypes: config.mimeTypes }),
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
    const problem = this.#iconProblem(icon)
    if (problem) throw new Error(`icon ${JSON.stringify(icon)} in ${this.from}: ${problem}`)
    const data = readFileSync(resolve(this.dir, icon))
    const ext = extname(icon).toLowerCase()
    const taken = (name: string) => existsSync(join(web, name)) && !readFileSync(join(web, name)).equals(data)
    const name = taken(`icon${ext}`) ? `icon-${createHash('sha256').update(data).digest('hex').slice(0, 8)}${ext}` : `icon${ext}`
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, name), data)
    return base + name
  }

  async #desktop(config: DesktopConfig, out: string, assets: Record<string, string[]>): Promise<DesktopManifest> {
    const id = this.id
    const base = `/desktop/${id}/`
    const page = await this.#web(resolve(this.dir, config.entry ?? 'index.html'), join(out, 'desktop'), base, true)
    assets[base] = ['desktop']
    return {
      id,
      name: config.label ?? id,
      ...(config.description !== undefined && { description: config.description }),
      entry: `desktop/${page}`,
      ...(config.services && Object.keys(config.services).length > 0 && { services: Object.keys(config.services) }),
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
    const rules: PublicRules = { dir: this.dir, publicDir: join(this.dir, this.config.public ?? 'public'), own, rooted: own && html && this.config.type === 'app' }
    const page = await this.#bundler.web({ entry, out, base, rules })
    if (own && existsSync(rules.publicDir)) cpSync(rules.publicDir, out, { recursive: true, force: false, errorOnExist: false })
    return page
  }

  async #backend(entry: string, out: string): Promise<void> {
    await this.#bundler.backend({ entry, out, dir: this.dir, splitting: false })
    await this.#bundler.preload(out)
  }
}

export function packagesDir(): string {
  const set = process.env['XDG_DATA_HOME']
  return join(set && isAbsolute(set) ? set : join(homedir(), '.local', 'share'), 'acde', 'packages')
}

export function install(out: string, id: string): string {
  const dest = join(packagesDir(), id)
  const next = `${dest}.new-${process.pid}`
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(next, { recursive: true, force: true })
  cpSync(out, next, { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  renameSync(next, dest)
  return dest
}
