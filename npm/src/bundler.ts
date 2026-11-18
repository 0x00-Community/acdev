import { existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import acdeVite from './vite-plugin.ts'
import { InlineStyles } from './inline-styles.ts'
import { PackageManager } from './pm.ts'
import { Runtime } from './runtime.ts'

interface Position {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly lineText: string
}

export interface PublicRules {
  readonly dir: string
  readonly publicDir: string
  readonly own: boolean
  readonly rooted: boolean
}

export interface WebJob {
  readonly entry: string
  readonly out: string
  readonly base: string
  readonly rules: PublicRules
  readonly dev?: boolean
}

export interface BackendJob {
  readonly entry: string
  readonly out: string
  readonly dir: string
  readonly splitting: boolean
  readonly dev?: boolean
}

export class PublicError extends Error {
  static of(rules: PublicRules, rel: string, importer: string): PublicError {
    const shown = relative(rules.dir, rules.publicDir) || '.'
    const where = relative(rules.dir, importer) || importer
    return new PublicError(`/${rel.split(sep).join('/')} in ${where}: there is no ${join(shown, rel)} ` +
      `(a URL starting with / is a file in ${shown}/)`)
  }
}

export class ServiceImports {
  readonly #found = new Set<string>()

  readonly name: string
  readonly dir: string
  readonly out: string

  constructor(name: string, dir: string, out: string) {
    this.name = name
    this.dir = dir
    this.out = out
  }

  static readonly FILTER = /^acde:/

  see(spec: string, importer: string | undefined): void {
    const file = importer ? relative(this.dir, importer.replace(/[?#].*$/s, '')).split(sep).join('/') : '?'
    this.#found.add(`${file} imports ${spec}`)
  }

  check(): void {
    if (this.#found.size === 0) return
    rmSync(join(this.out, `${this.name}.js`), { force: true })
    throw new Error(`service ${this.name}: ${[...this.#found].sort().join(', ')}: a service gets shell modules ` +
      "from ctx.import('acde:<name>'), listed in its modules in acde.config.jsonc " +
      `("services": { ${JSON.stringify(this.name)}: { "module": "<file>", "modules": ["<name>"] } })`)
  }
}

type Built = {
  readonly success: boolean
  readonly logs: readonly unknown[]
  readonly outputs: readonly { readonly kind: string; readonly path: string }[]
}

export abstract class Bundler {
  static readonly SERVE = 'acde.serve'

  static for(dir: string, env: Readonly<Record<string, string | undefined>> = process.env): Bundler {
    const wanted = env['ACDEV_BUNDLER'] || (Runtime.bun ? 'bun' : 'vite')
    if (wanted === 'vite') return new ViteBundler(dir)
    if (wanted === 'bun' && Runtime.bun) return new BunBundler()
    throw new Error(`ACDEV_BUNDLER=${wanted}: vite, or bun when acdev runs on bun`)
  }

  static isHtml(entry: string): boolean {
    return /\.html?$/.test(entry)
  }

  abstract web(job: WebJob): Promise<string>
  abstract service(name: string, entry: string, out: string, dir: string): Promise<void>
  protected abstract server(job: BackendJob, wrapper: string): Promise<void>

  async preload(out: string): Promise<void> {
    const fromSource = import.meta.url.endsWith('.ts')
    const text = fromSource ? await Bundler.buildPreload() : (await import('./listen-bundle.ts')).LISTEN_JS
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'acde-listen.js'), text)
  }

  static async buildPreload(): Promise<string> {
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'listen.ts')
    const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm', minify: { syntax: true } })
    const [output] = built.outputs
    if (!built.success || !output) throw new Error(`bundling src/listen.ts failed: ${built.logs.join('\n')}`)
    return output.text()
  }

  async backend(job: BackendJob): Promise<void> {
    const scratch = mkdtempSync(join(tmpdir(), 'acde-backend-'))
    try {
      const wrapper = join(scratch, 'acde-server.mjs')
      writeFileSync(wrapper, Bundler.wrapper(job.entry))
      mkdirSync(job.out, { recursive: true })
      await this.server(job, wrapper)
      writeFileSync(join(job.out, 'package.json'), '{ "type": "module" }\n')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  static wrapper(entry: string): string {
    return `const app = await import(${JSON.stringify(entry)})
const main = app.default
export default main
const serve = globalThis[Symbol.for(${JSON.stringify(Bundler.SERVE)})]
if (typeof serve === "function" && main && typeof main.fetch === "function") serve(main)
`
  }

  static check(what: string, result: { readonly success: boolean; readonly logs: readonly unknown[] }): void {
    if (result.success) return
    const said = result.logs.map((log) => Bundler.describe(log))
    throw new AggregateError(result.logs, `${what}: ${said.join('\n')}`)
  }

  static describe(log: unknown): string {
    const { message, position } = log as { message?: unknown; position?: Position | null }
    const text = String(message ?? log)
    if (!position?.file) return text
    const file = relative(process.cwd(), position.file) || position.file
    const caret = `${' '.repeat(Math.max(0, position.column - 1))}^`
    return `${file}:${position.line}:${position.column}: ${text}\n  ${position.lineText}\n  ${caret}`
  }

  static publicFile(rules: PublicRules, rel: string): string | null {
    const file = join(rules.publicDir, rel)
    return existsSync(file) && statSync(file).isFile() ? file : null
  }
}

export class AssetUrls {
  static readonly FILTER = /\.[cm]?[jt]sx?$/
  static readonly PATTERN = /new\s+URL\(\s*(['"])(\.{1,2}\/[^'"\n?#]+)\1\s*,\s*import\.meta\.url\s*\)/g

  static rewrite(source: string, file: string): string | null {
    if (!source.includes('import.meta.url')) return null
    const imports: string[] = []
    const out = source.replace(AssetUrls.PATTERN, (all: string, _quote: string, path: string) => {
      const target = resolve(dirname(file), path)
      if (AssetUrls.FILTER.test(path) || !existsSync(target) || !statSync(target).isFile()) return all
      const name = `__acdeAssetUrl${imports.length}`
      imports.push(`import ${name} from ${JSON.stringify(path)} with { type: 'file' };`)
      return `new URL(${name}, import.meta.url)`
    })
    return imports.length ? `${imports.join(' ')} ${out}` : null
  }

  static loader(file: string): 'js' | 'jsx' | 'ts' | 'tsx' {
    const ext = /\.([cm]?)([jt]sx?)$/.exec(file)?.[2] ?? 'js'
    return ext as 'js' | 'jsx' | 'ts' | 'tsx'
  }
}

export class BunBundler extends Bundler {
  static readonly OPTIONS = {
    format: 'esm', minify: { syntax: true, whitespace: false, identifiers: false }, throw: false,
  } as const

  async web(job: WebJob): Promise<string> {
    const html = Bundler.isHtml(job.entry)
    const cwd = process.cwd()
    process.chdir(job.rules.dir)
    try {
      const result = (await Bun.build({
        entrypoints: [job.entry],
        outdir: job.out,
        target: 'browser',
        external: ['acde:*'],
        publicPath: job.base,
        minify: !job.dev,
        sourcemap: job.dev ? 'linked' : 'none',
        splitting: true,
        throw: false,
        ...(!html && { naming: { entry: '[name].[ext]' } }),
        define: { 'process.env.NODE_ENV': '"production"', ...BunBundler.#viteEnv() },
        plugins: [
          {
            name: 'acde-public',
            setup: (build) => {
              build.onResolve({ filter: /^(?:\/|[A-Za-z]:[\\/])/ }, (args) =>
                BunBundler.#public(job.rules, args.path, args.importer))
            },
          },
          {
            name: 'acde-asset-urls',
            setup: (build) => {
              build.onLoad({ filter: AssetUrls.FILTER }, async (args) => {
                const contents = AssetUrls.rewrite(await Bun.file(args.path).text(), args.path)
                return contents === null ? undefined : { contents, loader: AssetUrls.loader(args.path) }
              })
            },
          },
        ],
      })) as Built
      Bundler.check('web', result)
      if (html) InlineStyles.bundle(job.entry, join(job.out, basename(job.entry)), job.out, job.base, job.rules.dir)
      return html ? basename(job.entry) : relative(job.out, result.outputs.find((o) => o.kind === 'entry-point')!.path)
    } finally {
      process.chdir(cwd)
    }
  }

  async service(name: string, entry: string, out: string, dir: string): Promise<void> {
    const imports = new ServiceImports(name, dir, out)
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: out,
      target: 'browser',
      format: 'esm',
      minify: { syntax: true, whitespace: true, identifiers: false },
      naming: { entry: `${name}.[ext]` },
      throw: false,
      plugins: [{
        name: 'acde-service',
        setup: (build) => {
          build.onResolve({ filter: ServiceImports.FILTER }, (args) => {
            imports.see(args.path, args.importer)
            return { path: args.path, external: true }
          })
        },
      }],
    })
    Bundler.check(`service ${name}`, result)
    imports.check()
  }

  protected async server(job: BackendJob, wrapper: string): Promise<void> {
    const onBun = (process.env['ACDEV_HOST_RUNTIME'] || (process.versions['bun'] ? 'bun' : 'node')) === 'bun'
    const result = await Bun.build({
      ...BunBundler.OPTIONS,
      target: job.dev && onBun ? 'bun' : 'node',
      external: ['bun', 'bun:*'],
      entrypoints: [wrapper],
      outdir: job.out,
      splitting: job.splitting,
      sourcemap: job.dev ? 'inline' : 'none',
      naming: { entry: 'server.[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
    })
    Bundler.check('backend', result)
  }

  static #public(
    rules: PublicRules, path: string, importer: string,
  ): { path: string; external?: boolean } | undefined {
    const clean = path.replace(/[?#].*$/s, '')
    if (existsSync(clean)) return undefined
    const inProject = clean.startsWith(rules.dir + sep)
    const css = /\.css$/i.test(importer)
    if (!inProject && !css) return undefined
    const rel = inProject ? relative(rules.dir, clean) : clean.slice(1)
    const file = Bundler.publicFile(rules, rel)
    const html = /\.html?$/i.test(importer)
    if (file) return rules.rooted && ((css && !inProject) || html) ? { path, external: true } : { path: file }
    throw PublicError.of(rules, rel, importer)
  }

  static #viteEnv(): Record<string, string> {
    const env: Record<string, unknown> = { MODE: 'production', DEV: false, PROD: true, SSR: false, BASE_URL: '/' }
    for (const [key, value] of Object.entries(process.env)) if (key.startsWith('VITE_')) env[key] = value
    const define: Record<string, string> = { 'import.meta.env': JSON.stringify(env) }
    for (const [key, value] of Object.entries(env)) define[`import.meta.env.${key}`] = JSON.stringify(value)
    return define
  }
}

interface Vite {
  readonly version: string
  build(config: object): Promise<unknown>
}

interface Chunk {
  readonly type: string
  readonly fileName: string
  readonly isEntry?: boolean
}

interface Loaded {
  readonly vite: Vite
  readonly options: 'rolldownOptions' | 'rollupOptions'
  readonly single: Record<string, boolean>
}

export class ViteBundler extends Bundler {
  static readonly CSS = new RegExp(
    String.raw`\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)` +
      String.raw`|[?&]lang\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|&)`,
  )
  static readonly HTML_REF = /(\s(?:src|href)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi
  static readonly CSS_URL = /url\(\s*(["']?)(\/(?!\/)[^"')\s]*)\1\s*\)/g

  readonly #dir: string
  #vite: Promise<Vite> | null = null

  constructor(dir: string) {
    super()
    this.#dir = dir
  }

  static async load(dir: string): Promise<Vite> {
    let file: string
    try {
      file = Runtime.resolve('vite', dir)
    } catch {
      const pm = PackageManager.of(dir).name
      throw new Error(`this project builds with Vite on Node.js: add it with ${pm} add -D vite`)
    }
    return (await import(pathToFileURL(file).href)) as Vite
  }

  async #load(): Promise<Loaded> {
    this.#vite ??= ViteBundler.load(this.#dir)
    const vite = await this.#vite
    const rolldown = Number.parseInt(vite.version, 10) >= 8
    const single: Record<string, boolean> = rolldown ? { codeSplitting: false } : { inlineDynamicImports: true }
    return { vite, options: rolldown ? 'rolldownOptions' : 'rollupOptions', single }
  }

  static #common(root: string): Record<string, unknown> {
    return { configFile: false, root, envDir: root, mode: 'production', logLevel: 'warn', clearScreen: false }
  }

  static #chunks(result: unknown): Chunk[] {
    const outputs = Array.isArray(result) ? result : [result]
    return outputs.flatMap((o) => ((o as { output?: Chunk[] } | null)?.output ?? []))
  }

  async web(job: WebJob): Promise<string> {
    const { vite, options } = await this.#load()
    const html = Bundler.isHtml(job.entry)
    const hasPublic = existsSync(job.rules.publicDir) && statSync(job.rules.publicDir).isDirectory()
    const result = await vite.build({
      ...ViteBundler.#common(job.rules.dir),
      base: job.base,
      publicDir: hasPublic ? job.rules.publicDir : false,
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [acdeVite(), ViteBundler.#public(job.rules)],
      ...(job.rules.rooted && {
        experimental: {
          renderBuiltUrl: (file: string, info: { type: string; hostType: string }) =>
            (info.type === 'public' && info.hostType === 'css' ? `/${file}` : undefined),
        },
      }),
      build: {
        outDir: job.out,
        emptyOutDir: false,
        copyPublicDir: false,
        modulePreload: false,
        ...(job.dev && { minify: false, sourcemap: true }),
        [options]: {
          input: job.entry,
          ...(!html && { preserveEntrySignatures: 'exports-only', output: { entryFileNames: '[name].js' } }),
        },
      },
    })
    if (!html) {
      const entry = ViteBundler.#chunks(result).find((c) => c.type === 'chunk' && c.isEntry)
      if (!entry) throw new Error(`web: vite build made no entry for ${relative(job.rules.dir, job.entry)}`)
      return entry.fileName
    }
    const made = relative(job.rules.dir, job.entry)
    const page = basename(job.entry)
    if (made !== page) {
      renameSync(join(job.out, made), join(job.out, page))
      ViteBundler.#prune(job.out, dirname(join(job.out, made)))
    }
    return page
  }

  static #prune(root: string, dir: string): void {
    for (let at = dir; at !== root && at.startsWith(root + sep); at = dirname(at)) {
      try {
        rmdirSync(at)
      } catch {
        return
      }
    }
  }

  static #public(rules: PublicRules): object {
    const html = (url: string, importer: string): string => {
      const clean = url.replace(/[?#].*$/s, '')
      const rel = clean.slice(1)
      if (existsSync(join(rules.dir, rel))) return url
      const file = Bundler.publicFile(rules, rel)
      if (!file) throw PublicError.of(rules, rel, importer)
      return rules.own ? url : ViteBundler.#relative(importer, file) + url.slice(clean.length)
    }
    const css = (url: string, importer: string): string => {
      const clean = url.replace(/[?#].*$/s, '')
      if (existsSync(clean)) return url
      const rel = clean.slice(1)
      const file = Bundler.publicFile(rules, rel)
      if (!file) throw PublicError.of(rules, rel, importer)
      return rules.rooted ? url : ViteBundler.#relative(importer, file) + url.slice(clean.length)
    }
    return {
      name: 'acde-public',
      enforce: 'pre',
      transformIndexHtml: {
        order: 'pre',
        handler: (source: string, ctx: { filename: string }) => source.replace(ViteBundler.HTML_REF,
          (_, before: string, quote: string, url: string) => before + quote + html(url, ctx.filename) + quote),
      },
      transform: (code: string, id: string) => {
        if (!ViteBundler.CSS.test(id)) return null
        const file = id.replace(/[?#].*$/s, '')
        const out = code.replace(ViteBundler.CSS_URL,
          (_, quote: string, url: string) => `url(${quote}${css(url, file)}${quote})`)
        return out === code ? null : { code: out, map: null }
      },
    }
  }

  static #relative(importer: string, file: string): string {
    const rel = relative(dirname(importer), file).split(sep).join('/')
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  async service(name: string, entry: string, out: string, dir: string): Promise<void> {
    const { vite, options, single } = await this.#load()
    const imports = new ServiceImports(name, dir, out)
    await vite.build({
      ...ViteBundler.#common(dir),
      publicDir: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{
        name: 'acde-service',
        enforce: 'pre',
        resolveId: (id: string, importer?: string) => {
          if (!ServiceImports.FILTER.test(id)) return null
          imports.see(id, importer)
          return { id, external: true }
        },
      }],
      build: {
        outDir: out,
        emptyOutDir: false,
        copyPublicDir: false,
        modulePreload: false,
        minify: false,
        [options]: {
          input: entry,
          preserveEntrySignatures: 'strict',
          output: { format: 'es', entryFileNames: `${name}.js`, ...single },
        },
      },
    })
    imports.check()
  }

  protected async server(job: BackendJob, wrapper: string): Promise<void> {
    const { vite, options, single } = await this.#load()
    await vite.build({
      ...ViteBundler.#common(job.dir),
      publicDir: false,
      ssr: { noExternal: true, target: 'node' },
      build: {
        ssr: wrapper,
        outDir: job.out,
        emptyOutDir: false,
        copyPublicDir: false,
        minify: false,
        sourcemap: job.dev ? 'inline' : false,
        target: 'node22',
        [options]: {
          external: [/^bun(?::|$)/],
          output: {
            format: 'es',
            entryFileNames: 'server.js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            ...(!job.splitting && single),
          },
        },
      },
    })
  }
}
