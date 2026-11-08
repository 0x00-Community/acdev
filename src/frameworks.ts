import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Bundler } from './bundler.ts'
import { PackageManager } from './pm.ts'
import { Runtime } from './runtime.ts'

export interface Output {
  readonly web: string | null
  readonly page: string | null
  readonly server: { readonly dir: string; readonly entry: string } | null
}

export interface Build {
  readonly dir: string
  readonly pkg: Readonly<Record<string, unknown>>
  readonly scratch: string
  readonly vitePlugins: readonly unknown[]
  readonly bundler: Bundler
}

export interface Detecting {
  readonly dir: string
  readonly pkg: Readonly<Record<string, unknown>>
  readonly entry?: boolean
}

interface Framework {
  readonly name: string
  readonly label: string
  detect(deps: ReadonlySet<string>, build: Build): boolean
  build(build: Build): Promise<Output>
}

export class Frameworks {
  static readonly OUT_DIRS = ['dist', 'build', 'out', 'www', '.output/public']
  static readonly ENV = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', CI: '1' }

  static readonly LIST: readonly Framework[] = [
    { name: 'next', label: 'Next.js', detect: (deps) => deps.has('next'), build: (b) => Frameworks.#next(b) },
    { name: 'nuxt', label: 'Nuxt', detect: (deps) => deps.has('nuxt') || deps.has('nuxt3'), build: (b) => Frameworks.#nuxt(b) },
    { name: 'sveltekit', label: 'SvelteKit', detect: (deps) => deps.has('@sveltejs/kit'), build: (b) => Frameworks.#sveltekit(b) },
    { name: 'astro', label: 'Astro', detect: (deps) => deps.has('astro'), build: (b) => Frameworks.#astro(b) },
    { name: 'react-router', label: 'React Router', detect: (deps) => deps.has('@react-router/dev'), build: (b) => Frameworks.#reactRouter(b, 'react-router', ['build']) },
    { name: 'remix', label: 'Remix', detect: (deps) => deps.has('@remix-run/dev'), build: (b) => Frameworks.#reactRouter(b, 'remix', ['vite:build']) },
    { name: 'angular', label: 'Angular', detect: (deps) => deps.has('@angular/core') && deps.has('@angular/cli'), build: (b) => Frameworks.#angular(b) },
    { name: 'vite', label: 'Vite', detect: (deps) => deps.has('vite'), build: (b) => Frameworks.#vite(b) },
    { name: 'cra', label: 'Create React App', detect: (deps) => deps.has('react-scripts'), build: (b) => Frameworks.#script(b, ['react-scripts', 'build'], ['build']) },
    { name: 'script', label: 'build script', detect: (_, b) => Frameworks.#ownBuild(b), build: (b) => Frameworks.#script(b, null, Frameworks.OUT_DIRS) },
  ]

  static detect(build: Detecting, wanted?: string): Framework | null {
    if (wanted === 'none') return null
    if (wanted && wanted !== 'auto') {
      const found = Frameworks.LIST.find((f) => f.name === wanted)
      if (!found) throw new Error(`framework ${JSON.stringify(wanted)}: one of auto, none, ${Frameworks.LIST.map((f) => f.name).join(', ')}`)
      return found
    }
    const deps = Frameworks.#deps(build.pkg)
    return Frameworks.LIST.find((f) => !(f.name === 'vite' && build.entry) && f.detect(deps, build as Build)) ?? null
  }

  static async install(dir: string): Promise<void> {
    if (Frameworks.#up(dir, 'node_modules')) return
    const pm = PackageManager.of(dir)
    console.log(`acde: no node_modules: ${pm.name} install`)
    const code = await Runtime.spawn(pm.install, { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] }).exited
    if (code !== 0) throw new Error(`${pm.name} install failed (exit ${code})`)
  }

  static #ownBuild(b: Pick<Build, 'pkg'>): boolean {
    const build = Frameworks.#scripts(b)['build']
    return typeof build === 'string' && !/(^|[\s;&|(/])(acde|acde\.mjs|bunx acde|npx acde)\s/.test(`${build} `)
  }

  static #deps(pkg: Readonly<Record<string, unknown>>): Set<string> {
    const names = new Set<string>()
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const group = pkg[key]
      if (group && typeof group === 'object') for (const name of Object.keys(group)) names.add(name)
    }
    return names
  }

  static #scripts(b: Pick<Build, 'pkg'>): Record<string, unknown> {
    const scripts = b.pkg['scripts']
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>) : {}
  }

  static #up(dir: string, name: string): string | null {
    for (let at = dir; ; at = dirname(at)) {
      const path = join(at, name)
      if (existsSync(path)) return path
      if (dirname(at) === at) return null
    }
  }

  static async #spawn(cwd: string, argv: readonly string[], env: Record<string, string> = {}): Promise<void> {
    const code = await Runtime.spawn(argv, { cwd, env: { ...process.env, ...Frameworks.ENV, ...env }, stdio: ['ignore', 'inherit', 'inherit'] }).exited
    if (code !== 0) throw new Error(`${argv.slice(1).join(' ')} failed (exit ${code})`)
  }

  static #tool(b: Build, name: string, args: readonly string[], env?: Record<string, string>): Promise<void> {
    const bin = PackageManager.bin(b.dir, name, Frameworks.#deps(b.pkg))
    if (!bin) throw new Error(`no ${name} in node_modules: run ${PackageManager.of(b.dir).name} install first`)
    return Frameworks.#spawn(b.dir, [process.execPath, ...(Runtime.bun ? ['--bun'] : []), bin, ...args], env)
  }

  static #page(dir: string): string | null {
    if (existsSync(join(dir, 'index.html'))) return 'index.html'
    for (const name of ['200.html', '404.html']) if (existsSync(join(dir, name))) return name
    const html = Frameworks.#walk(dir).find((file) => file.endsWith('.html'))
    return html ? relative(dir, html) : null
  }

  static #walk(dir: string, depth = 3): string[] {
    if (!existsSync(dir)) return []
    const out: string[] = []
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (depth > 0 && name !== 'node_modules') out.push(...Frameworks.#walk(path, depth - 1))
      } else out.push(path)
    }
    return out
  }

  static #static(dir: string, what: string): Output {
    const page = Frameworks.#page(dir)
    if (!page) throw new Error(`${what}: no .html page in ${dir}`)
    return { web: dir, page, server: null }
  }

  static #isDir(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory()
  }

  static async #vite(b: Build): Promise<Output> {
    const out = join(b.scratch, 'vite')
    const vite = (await import(pathToFileURL(Runtime.resolve('vite', b.dir)).href)) as { build(config: object): Promise<unknown> }
    const cwd = process.cwd()
    process.chdir(b.dir)
    try {
      await vite.build({ root: b.dir, base: '/', mode: 'production', logLevel: 'warn', plugins: [...b.vitePlugins], build: { outDir: out, emptyOutDir: true } })
    } finally {
      process.chdir(cwd)
    }
    return Frameworks.#static(out, 'vite build')
  }

  static async #script(b: Build, tool: readonly string[] | null, dirs: readonly string[]): Promise<Output> {
    if (tool) await Frameworks.#tool(b, tool[0]!, tool.slice(1), { PUBLIC_URL: '/' })
    else await Frameworks.#spawn(b.dir, Runtime.bun ? [process.execPath, '--bun', 'run', 'build'] : PackageManager.of(b.dir).run('build'))
    for (const dir of dirs) {
      const path = join(b.dir, dir)
      if (Frameworks.#isDir(path) && Frameworks.#page(path)) return { web: path, page: Frameworks.#page(path), server: null }
    }
    throw new Error(`the build made no page: no .html in ${dirs.join(', ')}`)
  }

  static async #next(b: Build): Promise<Output> {
    const dist = join(b.dir, '.next')
    rmSync(join(dist, 'standalone'), { recursive: true, force: true })
    await Frameworks.#tool(b, 'next', ['build'], { NEXT_PRIVATE_STANDALONE: '1' })
    const exported = join(b.dir, 'out')
    const standalone = join(dist, 'standalone')
    if (!Frameworks.#isDir(standalone)) {
      if (Frameworks.#isDir(exported)) return Frameworks.#static(exported, 'next build (output: export)')
      throw new Error('next build made neither .next/standalone nor out/')
    }
    const server = Frameworks.#walk(standalone, 4).find((file) => basename(file) === 'server.js' && !/(^|\/)(node_modules|\.next)\//.test(relative(standalone, file)))
    if (!server) throw new Error('next build: no server.js in .next/standalone')
    const app = dirname(server)
    const web = join(b.scratch, 'next-web')
    mkdirSync(web, { recursive: true })
    if (Frameworks.#isDir(join(b.dir, 'public'))) {
      cpSync(join(b.dir, 'public'), join(app, 'public'), { recursive: true })
      cpSync(join(b.dir, 'public'), web, { recursive: true })
    }
    if (Frameworks.#isDir(join(dist, 'static'))) {
      cpSync(join(dist, 'static'), join(app, '.next', 'static'), { recursive: true })
      cpSync(join(dist, 'static'), join(web, '_next', 'static'), { recursive: true })
    }
    return { web, page: null, server: { dir: standalone, entry: relative(standalone, server) } }
  }

  static async #nuxt(b: Build): Promise<Output> {
    const output = join(b.dir, '.output')
    rmSync(output, { recursive: true, force: true })
    await Frameworks.#tool(b, existsSync(join(b.dir, 'node_modules', '.bin', 'nuxt')) ? 'nuxt' : 'nuxi', ['build'], { NITRO_PRESET: 'node-server' })
    const entry = join(output, 'server', 'index.mjs')
    if (!existsSync(entry)) throw new Error('nuxt build: no .output/server/index.mjs')
    const web = join(output, 'public')
    return { web: Frameworks.#isDir(web) ? web : null, page: null, server: { dir: output, entry: 'server/index.mjs' } }
  }

  static async #sveltekit(b: Build): Promise<Output> {
    await Frameworks.#tool(b, 'vite', ['build'])
    const output = join(b.dir, '.svelte-kit', 'output')
    const server = join(output, 'server')
    if (!existsSync(join(server, 'index.js'))) throw new Error('vite build (SvelteKit): no .svelte-kit/output/server/index.js')
    const manifest = existsSync(join(server, 'manifest-full.js')) ? 'manifest-full.js' : 'manifest.js'
    const web = join(b.scratch, 'sveltekit-web')
    mkdirSync(web, { recursive: true })
    if (Frameworks.#isDir(join(output, 'client'))) cpSync(join(output, 'client'), web, { recursive: true })
    const launcher = `import { Server } from ${JSON.stringify(pathToFileURL(join(server, 'index.js')).href)}
import { manifest } from ${JSON.stringify(pathToFileURL(join(server, manifest)).href)}
const server = new Server(manifest)
await server.init({ env: process.env })
export default {
  port: Number(process.env.PORT) || 3000,
  fetch: (request) => server.respond(request, { getClientAddress: () => '127.0.0.1' }),
}
`
    return { web, page: null, server: await Frameworks.#launch(b, 'sveltekit', launcher) }
  }

  static async #astro(b: Build): Promise<Output> {
    const dist = join(b.dir, 'dist')
    rmSync(dist, { recursive: true, force: true })
    await Frameworks.#tool(b, 'astro', ['build'])
    const entry = join(dist, 'server', 'entry.mjs')
    if (!existsSync(entry)) return Frameworks.#static(dist, 'astro build')
    const client = join(dist, 'client')
    const launcher = `process.env.HOST ??= 'localhost'
await import(${JSON.stringify(pathToFileURL(entry).href)})
`
    return { web: Frameworks.#isDir(client) ? client : null, page: null, server: await Frameworks.#launch(b, 'astro', launcher) }
  }

  static async #reactRouter(b: Build, tool: string, args: readonly string[]): Promise<Output> {
    const build = join(b.dir, 'build')
    rmSync(build, { recursive: true, force: true })
    await Frameworks.#tool(b, tool, args)
    const client = join(build, 'client')
    const server = join(build, 'server', 'index.js')
    if (!existsSync(server)) return Frameworks.#static(Frameworks.#isDir(client) ? client : build, `${tool} build`)
    const runtime = tool === 'remix' ? '@remix-run/node' : 'react-router'
    const launcher = `import { createRequestHandler } from ${JSON.stringify(pathToFileURL(Runtime.resolve(runtime, b.dir)).href)}
import * as build from ${JSON.stringify(pathToFileURL(server).href)}
const handle = createRequestHandler(build, 'production')
export default { port: Number(process.env.PORT) || 3000, fetch: (request) => handle(request) }
`
    return { web: Frameworks.#isDir(client) ? client : null, page: null, server: await Frameworks.#launch(b, tool, launcher) }
  }

  static async #angular(b: Build): Promise<Output> {
    const dist = join(b.dir, 'dist')
    rmSync(dist, { recursive: true, force: true })
    await Frameworks.#tool(b, 'ng', ['build', '--configuration', 'production', '--base-href', '/'])
    const files = Frameworks.#walk(dist, 3)
    const ssr = files.find((file) => /\/server\/server\.mjs$/.test(file))
    const browser = files.map((file) => dirname(file)).find((dir) => existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'index.csr.html')))
    if (!ssr) {
      if (!browser) throw new Error('ng build: no index.html in dist')
      return Frameworks.#static(browser, 'ng build')
    }
    const root = dirname(dirname(ssr))
    return { web: browser ?? null, page: null, server: { dir: root, entry: relative(root, ssr) } }
  }

  static async #launch(b: Build, name: string, source: string): Promise<{ dir: string; entry: string }> {
    const dir = join(b.scratch, `${name}-server`)
    const file = join(b.scratch, `${name}-launcher.mjs`)
    writeFileSync(file, source)
    await b.bundler.backend({ entry: file, out: dir, dir: b.dir, splitting: true })
    return { dir, entry: 'server.js' }
  }
}
