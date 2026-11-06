import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AcdeConfig, AppConfig, DesktopConfig, DesktopManifest, PackageManifest, ServiceManifest, WindowAppConfig } from '@dopame/acde-api'
import acdeVite from '@dopame/acde-api/vite'
import { Frameworks, type Output } from './frameworks.ts'
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
const BUN_OPTIONS = { target: 'bun', format: 'esm', splitting: false, minify: { syntax: true, whitespace: false, identifiers: false }, throw: false } as const

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
  static readonly CONFIGS = ['acde.config.jsonc', 'acde.config.json']

  readonly dir: string
  readonly name: string
  readonly version: string
  readonly from: string
  readonly config: AcdeConfig
  readonly pkg: Readonly<Record<string, unknown>>

  constructor(dir: string) {
    this.dir = realpathSync(resolve(dir))
    const file = join(this.dir, 'package.json')
    const pkg = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
    this.pkg = pkg
    const found = Project.CONFIGS.map((name) => join(this.dir, name)).find((path) => existsSync(path))
    if (!found && !existsSync(file)) throw new Error(`no ${Project.CONFIGS[0]} or package.json in ${this.dir}`)
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    if (found) {
      const config = Bun.JSONC.parse(readFileSync(found, 'utf8')) as AcdeConfig
      if (typeof config !== 'object' || config === null || (config.type !== 'app' && config.type !== 'desktop')) {
        throw new Error(`${basename(found)}: "type" is "app" (a window app) or "desktop"`)
      }
      this.config = config
      this.from = basename(found)
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
    }
    this.name = text(this.config.name) ?? text(pkg['name']) ?? basename(this.dir)
    this.version = text(this.config.version) ?? text(pkg['version']) ?? '0.0.0'
  }

  get framework(): string | null {
    const config = this.config
    if (config.type !== 'app') return null
    return Frameworks.detect({ dir: this.dir, pkg: this.pkg }, config.framework)?.name ?? null
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
    try {
      this.id
    } catch (error) {
      errors.push((error as Error).message)
    }
    const config = this.config
    if (config.type === 'app') {
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
    for (const app of config.apps ?? []) need(app.entry, `apps ${app.id}: entry`)
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
      if (services.length > 0) manifest.services = await Promise.all(services.map(([name, module]) => this.#service(name, module, out)))
    }
    const built: BuiltPackage = { name: this.name, version: this.version, private: true, acde: { ...manifest, assets } }
    writeFileSync(join(out, 'package.json'), JSON.stringify(built, null, 2) + '\n')
    return built
  }

  async #app(config: WindowAppConfig, out: string, dir: string, assets: Record<string, string[]>, own: boolean): Promise<BuiltApp> {
    const id = config.id!
    const base = `/app/${id}/`
    const framework = own && this.config.type === 'app' ? Frameworks.detect({ dir: this.dir, pkg: this.pkg }, this.config.framework) : null
    if (framework) {
      console.log(`acde: ${framework.label}: building with its own tools`)
      await Frameworks.install(this.dir)
      const scratch = mkdtempSync(join(tmpdir(), 'acde-'))
      try {
        const built = await framework.build({ dir: this.dir, pkg: this.pkg, scratch, vitePlugins: [acdeVite()] })
        return Project.#manifestOf(config, id, await this.#place(built, config, out, base, assets))
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
    const page = await this.#web(resolve(this.dir, config.entry ?? 'index.html'), join(out, `${dir}web`), base, own)
    const server = this.#server(config.backend)
    if (server) {
      await Project.#backend(server, join(out, `${dir}backend`))
      assets[`${base}backend/`] = [`${dir}backend`]
    }
    assets[base] = [`${dir}web`]
    return Project.#manifestOf(config, id, { entry: base + page, backend: server ? `${base}backend/server.js` : null })
  }

  async #place(built: Output, config: WindowAppConfig, out: string, base: string, assets: Record<string, string[]>): Promise<{ entry: string; backend: string | null }> {
    const web = join(out, 'web')
    mkdirSync(web, { recursive: true })
    if (built.web) cpSync(built.web, web, { recursive: true, verbatimSymlinks: true })
    assets[base] = ['web']
    if (built.server) {
      const backend = join(out, 'backend')
      cpSync(built.server.dir, backend, { recursive: true, verbatimSymlinks: true })
      await Project.#preload(dirname(join(backend, built.server.entry)))
      assets[`${base}backend/`] = ['backend']
      return { entry: base, backend: `${base}backend/${built.server.entry}` }
    }
    const server = this.#server(config.backend)
    if (server) {
      await Project.#backend(server, join(out, 'backend'))
      assets[`${base}backend/`] = ['backend']
    }
    return { entry: base + built.page!, backend: server ? `${base}backend/server.js` : null }
  }

  static #manifestOf(config: WindowAppConfig, id: string, placed: { entry: string; backend: string | null }): BuiltApp {
    const port = (config.backend ? config.backend.port : undefined) ?? DEFAULT_PORT
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`app ${id}: backend.port must be a port number, not ${String(port)}`)
    return {
      id,
      label: config.label ?? id,
      icon: config.icon ?? 'app',
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
    const result = await Bun.build({ entrypoints: [resolve(this.dir, module)], outdir: join(out, 'services'), target: 'browser', format: 'esm', minify: { syntax: true, whitespace: true, identifiers: false }, naming: { entry: `${name}.[ext]` }, throw: false })
    Project.#check(`service ${name}`, result)
    return { name, module: `services/${name}.js` }
  }

  #server(backend: WindowAppConfig['backend']): string | undefined {
    if (backend === false) return undefined
    if (backend?.entry !== undefined) return resolve(this.dir, backend.entry)
    return BACKENDS.map((file) => join(this.dir, file)).find((file) => existsSync(file))
  }

  async #web(entry: string, out: string, base: string, own: boolean): Promise<string> {
    const html = /\.html?$/.test(entry)
    const publicDir = join(this.dir, this.config.public ?? 'public')
    const cwd = process.cwd()
    process.chdir(this.dir)
    let page = basename(entry)
    try {
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: out,
        target: 'browser',
        external: ['acde:*'],
        publicPath: base,
        minify: true,
        splitting: true,
        throw: false,
        ...(!html && { naming: { entry: '[name].[ext]' } }),
        define: { 'process.env.NODE_ENV': '"production"', ...Project.#viteEnv() },
        plugins: [
          {
            name: 'acde-public',
            setup: (build) => {
              build.onResolve({ filter: /^(?:\/|[A-Za-z]:[\\/])/ }, (args) => this.#public(args.path, args.importer, publicDir, own && html && this.config.type === 'app'))
            },
          },
        ],
      })
      Project.#check('web', result)
      if (!html) page = relative(out, result.outputs.find((o) => o.kind === 'entry-point')!.path)
    } finally {
      process.chdir(cwd)
    }
    if (own && existsSync(publicDir)) cpSync(publicDir, out, { recursive: true, force: false, errorOnExist: false })
    return page
  }

  #public(path: string, importer: string, publicDir: string, rooted: boolean): { path: string; external?: boolean } | undefined {
    const clean = path.replace(/[?#].*$/s, '')
    if (existsSync(clean)) return undefined
    const inProject = clean.startsWith(this.dir + sep)
    const css = /\.css$/i.test(importer)
    if (!inProject && !css) return undefined
    const rel = inProject ? relative(this.dir, clean) : clean.slice(1)
    const file = join(publicDir, rel)
    if (existsSync(file) && statSync(file).isFile()) return css && !inProject && rooted ? { path, external: true } : { path: file }
    const shown = relative(this.dir, publicDir) || '.'
    throw new Error(`/${rel.split(sep).join('/')} in ${relative(this.dir, importer) || importer}: there is no ${join(shown, rel)} (a URL starting with / is a file in ${shown}/)`)
  }

  static async #backend(entry: string, out: string): Promise<void> {
    Project.#check('backend', await Bun.build({ ...BUN_OPTIONS, outdir: out, entrypoints: [entry], naming: { entry: 'server.[ext]' } }))
    await Project.#preload(out)
  }

  static async #preload(out: string): Promise<void> {
    Project.#check('preload', await Bun.build({ ...BUN_OPTIONS, outdir: out, entrypoints: [join(import.meta.dir, 'listen.ts')], naming: { entry: 'acde-listen.[ext]' } }))
  }

  static #check(what: string, result: Bun.BuildOutput): void {
    if (result.success) return
    throw new AggregateError(result.logs, `${what}: ${result.logs.map((log) => String(log.message ?? log)).join('; ')}`)
  }

  static #viteEnv(): Record<string, string> {
    const env: Record<string, unknown> = { MODE: 'production', DEV: false, PROD: true, SSR: false, BASE_URL: '/' }
    for (const [key, value] of Object.entries(process.env)) if (key.startsWith('VITE_')) env[key] = value
    const define: Record<string, string> = { 'import.meta.env': JSON.stringify(env) }
    for (const [key, value] of Object.entries(env)) define[`import.meta.env.${key}`] = JSON.stringify(value)
    return define
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
