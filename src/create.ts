import * as p from '@clack/prompts'
import { existsSync, readdirSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { AppPackage } from './package.ts'
import { PackageManager, type PmName } from './pm.ts'

export type Kind = 'app' | 'desktop'

export interface Starter {
  readonly name: string
  readonly label: string
  readonly hint: string
  readonly kind: Kind
  readonly scaffold?: (dir: string, pm: PmName) => readonly string[]
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

const X = [process.execPath, 'x', '--bun']

const vite = (template: string) => (dir: string) => [...X, 'create-vite@latest', dir, '--template', template, '--no-interactive', '--no-immediate']

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
    scaffold: (dir, pm) => [...X, 'create-next-app@latest', dir, '--yes', '--ts', '--app', `--use-${pm === 'deno' ? 'npm' : pm}`, '--skip-install', '--disable-git', '--no-agent-feedback'],
  },
  {
    name: 'nuxt',
    label: 'Nuxt',
    hint: 'server rendering',
    kind: 'app',
    scaffold: (dir, pm) => [...X, 'create-nuxt@latest', dir, '--template', 'minimal', '--no-install', '--no-gitInit', '--packageManager', pm],
  },
  {
    name: 'sveltekit',
    label: 'SvelteKit',
    hint: 'server rendering',
    kind: 'app',
    scaffold: (dir) => [...X, 'sv@latest', 'create', dir, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install'],
  },
  {
    name: 'astro',
    label: 'Astro',
    hint: 'static pages',
    kind: 'app',
    scaffold: (dir) => [...X, 'create-astro@latest', dir, '--template', 'minimal', '--no-install', '--no-git', '--no-ai', '--yes', '--skip-houston'],
  },
  { name: 'desktop', label: 'Desktop', hint: 'a full-screen page behind every window, its services and apps', kind: 'desktop' },
]

export class Creator {
  static readonly ID = /^[a-z0-9][a-z0-9-]*$/

  static starter(name: string): Starter {
    const found = STARTERS.find((s) => s.name === name)
    if (!found) throw new Error(`template ${JSON.stringify(name)}: one of ${STARTERS.map((s) => s.name).join(', ')}`)
    return found
  }

  static idOf(dir: string): string {
    return basename(resolve(dir))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  static vacant(dir: string): string | undefined {
    if (!dir.trim()) return 'a directory, please'
    if (existsSync(dir) && readdirSync(dir).some((name) => name !== '.git')) return `${dir} is not empty`
    const id = Creator.idOf(dir)
    if (!Creator.ID.test(id)) return `${JSON.stringify(id)} is no id: lowercase letters, digits and -`
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
      const dir = given.dir ?? (await answer(p.text({ message: 'Project directory', placeholder: 'my-app', defaultValue: 'my-app', validate: (v) => Creator.vacant(v || 'my-app') })))
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
                  options: STARTERS.filter((s) => s.kind === 'app').map((s) => ({ value: s.name, label: s.label, hint: s.hint })),
                  maxItems: 12,
                }),
              )
      }
      const starter = Creator.starter(template)
      const label = given.label ?? (await answer(p.text({ message: 'Name people see', placeholder: given.id ?? Creator.idOf(dir), defaultValue: given.id ?? Creator.idOf(dir) })))
      const backend = given.backend ?? (starter.name === 'html' ? await answer(p.confirm({ message: 'Add a backend (server.ts, any Bun / Node server)?', initialValue: false })) : false)
      const pm = given.pm ? PackageManager.named(given.pm) : PackageManager.invoking()
      const install = given.install ?? (await answer(p.confirm({ message: `Install dependencies (${pm.name} install)?`, initialValue: true })))
      const git = given.git ?? (Bun.which('git') && !Creator.#inRepo(dir) ? await answer(p.confirm({ message: 'Start a git repository?', initialValue: true })) : false)
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
    const problem = Creator.vacant(dir)
    if (problem) throw new Error(problem)
    if (!Creator.ID.test(id)) throw new Error(`id ${JSON.stringify(id)}: lowercase letters, digits and -`)
    const pm = options.pm ? PackageManager.named(options.pm) : PackageManager.invoking()
    const step = Creator.#steps(chatty)
    let pkg: AppPackage
    if (starter.scaffold) {
      await step(`${starter.label}: its own scaffolding`, [starter.scaffold(dir, pm.name)], undefined, { CI: '1' })
      pkg = AppPackage.adopt(dir, id, label, starter.label)
    } else {
      pkg = AppPackage.create(dir, starter.kind, id, label, undefined, options.backend ? ['backend'] : [])
    }
    AppPackage.prepare(dir, pm)
    if (options.install) await step(`${pm.name} install`, [pm.install], dir)
    if (options.git && !Creator.#inRepo(dir)) {
      await step('git init', [['git', 'init', '--quiet'], ['git', 'add', '--all']], dir)
      const commit = Bun.spawnSync(['git', 'commit', '--quiet', '--message', 'Initial commit (acde new)'], { cwd: dir, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      if (chatty) p.log.step(commit.exitCode === 0 ? 'git commit' : 'git commit: skipped (no git user.name / user.email)')
    }
    return { pkg, dir, starter, installed: options.install === true, pm }
  }

  static next(created: Created): string[] {
    const rel = relative(process.cwd(), created.pkg.dir)
    const { pm } = created
    return [...(rel ? [`cd ${/\s/.test(rel) ? JSON.stringify(rel) : rel}`] : []), ...(created.installed ? [] : [`${pm.name} install`]), pm.run(created.starter.scaffold ? 'acde:dev' : 'dev').join(' ')]
  }

  static #inRepo(dir: string): boolean {
    let at = resolve(dir)
    for (;;) {
      if (existsSync(resolve(at, '.git'))) return true
      const up = resolve(at, '..')
      if (up === at) return false
      at = up
    }
  }

  static #steps(chatty: boolean) {
    return async (title: string, commands: readonly (readonly string[])[], cwd?: string, env: Readonly<Record<string, string>> = {}): Promise<void> => {
      const spin = chatty ? p.spinner() : null
      spin?.start(title)
      for (const argv of commands) {
        const child = Bun.spawn([...argv], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        if (code === 0) continue
        spin?.error(`${title} failed`)
        throw new Error(`${argv.join(' ')} failed (exit ${code})\n${(out + err).trim()}`)
      }
      spin?.stop(title)
    }
  }
}

class Cancelled extends Error {}
