import * as p from '@clack/prompts'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { installed, runtimes, which } from 'acde/launcher'
import { Project } from './app.ts'
import { AppPackage } from './package.ts'
import { up } from './paths.ts'
import { PackageManager, type PmName } from './pm.ts'
import { Runtime } from './runtime.ts'
import { Sdk } from './sdk.ts'

export type Kind = 'app' | 'desktop'

export interface Starter {
  readonly name: string
  readonly label: string
  readonly hint: string
  readonly kind: Kind
  readonly scaffold?: (dir: string, pm: PackageManager) => readonly string[]
  readonly server?: string
}

export interface CreateOptions {
  readonly dir?: string
  readonly template?: string
  readonly id?: string
  readonly label?: string
  readonly backend?: boolean
  readonly install?: boolean
  readonly git?: boolean
  readonly pm?: string
}

export interface Created {
  readonly pkg: AppPackage
  readonly dir: string
  readonly starter: Starter
  readonly installed: boolean
  readonly pm: PackageManager
}

const vite = (template: string) => (dir: string, pm: PackageManager) =>
  pm.exec('create-vite@latest', [dir, '--template', template, '--no-interactive', '--no-immediate'])

export const STARTERS: readonly Starter[] = [
  { name: 'html', label: 'HTML', hint: 'index.html + JS, an optional server.ts backend; no framework', kind: 'app' },
  { name: 'react', label: 'React', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('react-ts') },
  { name: 'vue', label: 'Vue', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('vue-ts') },
  { name: 'svelte', label: 'Svelte', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('svelte-ts') },
  { name: 'solid', label: 'Solid', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('solid-ts') },
  { name: 'preact', label: 'Preact', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('preact-ts') },
  { name: 'vanilla', label: 'Vanilla', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('vanilla-ts') },
  {
    name: 'next',
    label: 'Next.js',
    hint: 'server rendering, App Router',
    kind: 'app',
    server: 'its own server: API routes in app/api',
    scaffold: (dir, pm) =>
      pm.exec('create-next-app@latest', [
        dir,
        '--yes',
        '--ts',
        '--app',
        `--use-${pm.name}`,
        '--skip-install',
        '--disable-git',
        '--no-agent-feedback',
      ]),
  },
  {
    name: 'nuxt',
    label: 'Nuxt',
    hint: 'server rendering',
    kind: 'app',
    server: 'its own server: API routes in server/api',
    scaffold: (dir, pm) =>
      pm.exec('create-nuxt@latest', [
        dir,
        '--template',
        'minimal',
        '--no-install',
        '--no-gitInit',
        '--packageManager',
        pm.name,
      ]),
  },
  {
    name: 'sveltekit',
    label: 'SvelteKit',
    hint: 'server rendering',
    kind: 'app',
    server: 'its own server: +server.ts endpoints in src/routes',
    scaffold: (dir, pm) =>
      pm.exec('sv@latest', ['create', dir, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install']),
  },
  {
    name: 'astro',
    label: 'Astro',
    hint: 'static pages',
    kind: 'app',
    server: 'its own server: endpoints in src/pages, with a server adapter',
    scaffold: (dir, pm) =>
      pm.exec('create-astro@latest', [
        dir,
        '--template',
        'minimal',
        '--no-install',
        '--no-git',
        '--no-ai',
        '--yes',
        '--skip-houston',
      ]),
  },
  {
    name: 'desktop',
    label: 'Desktop',
    hint: 'a full-screen page behind every window, its services and apps',
    kind: 'desktop',
    server: 'no backend: desktop services run in the runtime',
  },
]

export class Creator {
  static readonly ROOT = realpathSync(join(import.meta.dirname, '..'))
  static readonly TEMPLATES = join(Creator.ROOT, 'templates')
  static readonly INSTALLED = installed(Creator.ROOT)
  static readonly VITE = '^8'

  static starter(name: string): Starter {
    const found = STARTERS.find((s) => s.name === name)
    if (!found) throw new Error(`template ${JSON.stringify(name)}: one of ${STARTERS.map((s) => s.name).join(', ')}`)
    return found
  }

  static backs(starter: Starter): boolean {
    return starter.server === undefined
  }

  static checkBackend(starter: Starter, backend: boolean | undefined): void {
    if (backend && !Creator.backs(starter)) throw new Error(`--backend: ${starter.label} has ${starter.server}`)
  }

  static idOf(dir: string): string {
    return Project.idOf(basename(resolve(dir))) ?? ''
  }

  static #free(dir: string): string {
    const full = resolve(dir)
    for (let n = 2; ; n++) {
      const next = join(dirname(full), `${basename(full)}-${n}`)
      if (!existsSync(next)) return relative(process.cwd(), next) || next
    }
  }

  static vacant(dir: string): string | undefined {
    if (!dir.trim()) return 'a directory, please'
    if (existsSync(dir) && readdirSync(dir).some((name) => name !== '.git'))
      return `${dir} is not empty: pick another name, such as ${Creator.#free(dir)}`
    const id = Creator.idOf(dir)
    if (!Project.ID.test(id)) return `${JSON.stringify(id)} is no id: lowercase letters, digits and -`
    return undefined
  }

  static async ask(given: CreateOptions): Promise<CreateOptions | null> {
    p.intro('acde: a new project')
    const answer = async <T>(value: Promise<T>): Promise<Exclude<T, symbol>> => {
      const got = await value
      if (p.isCancel(got)) throw new Cancelled()
      return got as Exclude<T, symbol>
    }
    try {
      const dir =
        given.dir ??
        (await answer(
          p.text({
            message: 'Project directory',
            placeholder: 'my-app',
            defaultValue: 'my-app',
            validate: (v) => Creator.vacant(v || 'my-app'),
          }),
        ))
      let template = given.template
      if (template === undefined) {
        const kind = await answer(
          p.select<Kind>({
            message: 'What are you making?',
            options: [
              { value: 'app', label: 'A window app', hint: 'a web page (any framework) in its own window' },
              { value: 'desktop', label: 'A desktop', hint: 'the whole screen: a page behind every window' },
            ],
          }),
        )
        template =
          kind === 'desktop'
            ? 'desktop'
            : await answer(
                p.select<string>({
                  message: 'Template',
                  options: STARTERS.filter((s) => s.kind === 'app').map((s) => ({
                    value: s.name,
                    label: s.label,
                    hint: s.hint,
                  })),
                  maxItems: 12,
                }),
              )
      }
      const starter = Creator.starter(template)
      const label =
        given.label ??
        (await answer(
          p.text({
            message: 'Name people see',
            placeholder: given.id ?? Creator.idOf(dir),
            defaultValue: given.id ?? Creator.idOf(dir),
          }),
        ))
      const backend =
        given.backend ??
        (Creator.backs(starter)
          ? await answer(
              p.confirm({ message: 'Add a backend (server.ts, any Bun / Node server)?', initialValue: false }),
            )
          : false)
      const pm = given.pm ? PackageManager.named(given.pm) : await Creator.#choose(answer)
      const install =
        given.install ??
        (await answer(p.confirm({ message: `Install dependencies (${pm.name} install)?`, initialValue: true })))
      const git =
        given.git ??
        (which('git') && !Creator.#inRepo(dir)
          ? await answer(p.confirm({ message: 'Start a git repository?', initialValue: true }))
          : false)
      return { ...given, dir, template, label, backend, install, git, pm: pm.name }
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error
      p.cancel('Cancelled')
      return null
    }
  }

  static async create(options: CreateOptions, chatty: boolean): Promise<Created> {
    const dir = options.dir!
    const starter = Creator.starter(options.template ?? 'html')
    const id = options.id ?? Creator.idOf(dir)
    const label = options.label || id
    Creator.checkBackend(starter, options.backend)
    const problem = Creator.vacant(dir)
    if (problem) throw new Error(problem)
    if (!Project.ID.test(id)) throw new Error(`id ${JSON.stringify(id)}: lowercase letters, digits and -`)
    const pm = options.pm ? PackageManager.named(options.pm) : PackageManager.invoking()
    const step = Creator.#steps(chatty)
    const existed = existsSync(dir)
    try {
      if (starter.scaffold) {
        const target = resolve(dir)
        const [at, name] = target === process.cwd() ? [target, '.'] : [dirname(target), basename(target)]
        await step(`${starter.label}: its own scaffolding`, [starter.scaffold(name, pm)], at, { CI: '1' })
        Creator.adopt(dir, id, label, starter.label)
        if (options.backend) Creator.serve(dir, id, label)
      } else {
        Creator.lay(dir, starter.kind, pm.name, id, label, options.backend ? ['backend'] : [])
      }
      if (pm.name === 'yarn' && !existsSync(join(dir, '.yarnrc.yml')))
        writeFileSync(join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
      Creator.#pin(dir, pm)
    } catch (error) {
      Creator.#undo(dir, existed)
      const left = existed ? `${dir} is empty again` : `${dir} was removed`
      throw new Error(`the ${starter.label} project was not made (${left}): ${Creator.#why(error)}`, { cause: error })
    }
    const pkg = new AppPackage(dir)
    const install = options.install ?? true
    if (install) {
      await step(`${pm.name} install`, [pm.install], dir).catch((error: unknown) => {
        throw new Error(`the project is in ${dir}, but its dependencies are not installed; once the cause below is `
          + `fixed, run ${pm.name} install there: ${Creator.#why(error)}`, { cause: error })
      })
    }
    if (options.git && !Creator.#inRepo(dir)) {
      await step(
        'git init',
        [
          ['git', 'init', '--quiet'],
          ['git', 'add', '--all'],
        ],
        dir,
      ).catch((error: unknown) => {
        const why = `the project is in ${dir} and ready, but it is not a git repository yet: ${Creator.#why(error)}`
        throw new Error(why, { cause: error })
      })
      const commit = spawnSync('git', ['commit', '--quiet', '--message', 'Initial commit (acde new)'], {
        cwd: dir,
        stdio: 'ignore',
      })
      if (chatty) p.log.step(commit.status === 0 ? 'git commit' : 'git commit: skipped (no git user.name / user.email)')
    }
    return { pkg, dir, starter, installed: install, pm }
  }

  static next(created: Created): string[] {
    const rel = relative(process.cwd(), created.pkg.dir)
    const { pm } = created
    const quoted = !/\s/.test(rel) ? rel : process.platform === 'win32' ? `"${rel}"` : JSON.stringify(rel)
    return [
      ...(rel ? [`cd ${quoted}`] : []),
      ...(created.installed ? [] : [`${pm.name} install`]),
      pm.run(created.starter.scaffold ? 'acde:dev' : 'dev').join(' '),
    ]
  }

  static readonly LATER: readonly string[] = [
    'while acde dev runs, acde inspect / eval / console / network / shot look into its pages',
    'acde test runs *.e2e.ts end to end, each test on its own acdert',
    'acde install builds it and puts it on the desktop of this machine (acde build only builds)',
  ]

  static lay(dir: string, kind: Kind, pm: PmName, id: string, label: string, layers: readonly string[] = []): void {
    for (const layer of [kind, ...layers]) Creator.#copy(join(Creator.TEMPLATES, layer), dir, { id, label })
    Creator.#wire(dir, { dev: 'dev', build: 'build', check: 'check' }, pm === 'bun' ? {} : { vite: Creator.VITE })
  }

  static serve(dir: string, id: string, label: string): void {
    const file = 'server.ts'
    if (existsSync(join(dir, file))) throw new Error(`${file} is there already`)
    Creator.#copy(join(Creator.TEMPLATES, 'backend'), dir, { id, label }, [file])
  }

  static adopt(dir: string, id: string, label: string, framework: string): void {
    if (!existsSync(join(dir, 'package.json'))) throw new Error(`${framework} made no package.json in ${dir}`)
    Creator.#copy(join(Creator.TEMPLATES, 'framework'), dir, { id, label, framework })
    Creator.#wire(dir, { 'acde:dev': 'dev', 'acde:build': 'build', 'acde:check': 'check' })
    Creator.#title(dir, label)
    Creator.ignoreBuild(dir)
  }

  static ignoreBuild(dir: string): string {
    const ignore = join(dir, '.gitignore')
    const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
    if (!/^\/?\.acde\/?$/m.test(ignored))
      writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}.acde/\n`)
    return ignore
  }

  static #title(dir: string, label: string): void {
    const html = label.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
    const edit = (path: string, change: (text: string) => string) => {
      const file = join(dir, path)
      if (existsSync(file)) writeFileSync(file, change(readFileSync(file, 'utf8')))
    }
    const titled = (text: string) => text.replace(/(<title>)[^<]*(<\/title>)/i, (_, open: string, close: string) =>
      open + html + close)
    edit('index.html', titled)
    for (const page of ['src/pages/index.astro', 'src/layouts/Layout.astro']) edit(page, titled)
    for (const layout of ['app/layout.tsx', 'app/layout.jsx', 'src/app/layout.tsx', 'src/app/layout.jsx']) {
      edit(layout, (text) =>
        text.replace(/(\btitle:\s*)(["'`])[^"'`]*\2/, (_, key: string) => key + JSON.stringify(label)))
    }
    edit('src/app.html', (text) => (/<title>/i.test(text) ? titled(text)
      : text.replace(/(\s*)%sveltekit\.head%/, (all, space: string) => `${space}<title>${html}</title>${all}`)))
    for (const app of ['app/app.vue', 'app.vue']) {
      edit(app, (text) => (/<script\b/.test(text) ? text
        : `<script setup lang="ts">\nconst label = ${JSON.stringify(label)}\n`
          + `useHead({ titleTemplate: (title) => (title && title !== 'Welcome to Nuxt!' ? title : label) })\n`
          + `</script>\n\n${text}`))
    }
  }

  static async #choose(answer: <T>(value: Promise<T>) => Promise<Exclude<T, symbol>>): Promise<PackageManager> {
    if (process.env['npm_config_user_agent']) return PackageManager.invoking()
    const found = runtimes()
    if (!found.bun || !found.node) return new PackageManager(found.bun ? 'bun' : 'npm')
    const runtime = await answer(
      p.select<'bun' | 'node'>({
        message: 'Run this project on',
        options: [
          { value: 'bun', label: 'Bun', hint: 'bun install, builds with Bun' },
          { value: 'node', label: 'Node.js', hint: 'npm install, builds with Vite' },
        ],
        initialValue: Runtime.bun ? 'bun' : 'node',
      }),
    )
    return new PackageManager(runtime === 'bun' ? 'bun' : 'npm')
  }

  static #pin(dir: string, pm: PackageManager): void {
    const file = join(dir, 'package.json')
    const json = JSON.parse(readFileSync(file, 'utf8')) as { packageManager?: string }
    if (json.packageManager) return
    const version = pm.version()
    if (!version) return
    json.packageManager = `${pm.name}@${version}`
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  }

  static #wire(
    dir: string,
    scripts: Readonly<Record<string, string>>,
    extra: Readonly<Record<string, string>> = {},
  ): void {
    const file = join(dir, 'package.json')
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    json.scripts = {
      ...json.scripts,
      ...Object.fromEntries(Object.entries(scripts).map(([name, command]) => [name, `acde ${command}`])),
    }
    json.devDependencies = { ...json.devDependencies, [Sdk.NAME]: Sdk.url(), ...extra }
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  }

  static #copy(
    from: string,
    to: string,
    vars: Readonly<Record<string, string>>,
    only?: readonly string[],
  ): void {
    for (const name of only ?? readdirSync(from)) {
      const source = join(from, name)
      if (statSync(source).isDirectory()) {
        Creator.#copy(source, join(to, name), vars)
        continue
      }
      const file = resolve(to, name === 'gitignore' ? '.gitignore' : name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        readFileSync(source, 'utf8').replace(/\{\{(\w+)\}\}/g, (all, key: string) => vars[key] ?? all),
      )
    }
  }

  static #inRepo(dir: string): boolean {
    return up(resolve(dir), (at) => existsSync(join(at, '.git'))) !== null
  }

  static async #run(
    argv: readonly string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; output: string }> {
    const chunks: Buffer[] = []
    try {
      const child = Runtime.spawn(argv, { ...(cwd !== undefined && { cwd }), env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.process.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.process.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk))
      return { code: await child.exited, output: Buffer.concat(chunks).toString() }
    } catch (error) {
      return { code: 127, output: `${Buffer.concat(chunks).toString()}${(error as Error).message}` }
    }
  }

  static #undo(dir: string, existed: boolean): void {
    if (!existsSync(dir)) return
    const gone = { recursive: true, force: true } as const
    if (!existed) rmSync(dir, gone)
    else for (const name of readdirSync(dir)) if (name !== '.git') rmSync(join(dir, name), gone)
  }

  static #why(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  static #steps(chatty: boolean) {
    return async (
      title: string,
      commands: readonly (readonly string[])[],
      cwd?: string,
      env: Readonly<Record<string, string>> = {},
    ): Promise<void> => {
      const spin = chatty ? p.spinner() : null
      spin?.start(title)
      for (const argv of commands) {
        const { code, output } = await Creator.#run(argv, cwd, { ...process.env, ...env })
        if (code === 0) continue
        spin?.error(`${title} failed`)
        throw new Error(`${argv.join(' ')} failed (exit ${code})\n${output.trim()}`)
      }
      spin?.stop(title)
    }
  }
}

class Cancelled extends Error {}
