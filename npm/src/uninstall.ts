import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import * as p from '@clack/prompts'
import { Project } from './app.ts'
import { Exit } from './output.ts'
import { AppPackage } from './package.ts'
import { Jsonc } from './runtime.ts'
import { Sessions, type Session } from './sessions.ts'

export interface Installed {
  readonly id: string
  readonly path: string
  readonly link: string | null
  readonly apps: readonly string[]
  readonly desktops: readonly string[]
}

export interface UninstallOptions {
  readonly yes: boolean
  readonly confirm: ((question: string) => Promise<boolean>) | null
  readonly say: (line: string) => void
  readonly dir?: string
  readonly sessions?: readonly Session[]
  readonly data?: boolean
  readonly env?: NodeJS.ProcessEnv
}

export interface Entries {
  readonly file: string
  readonly keys: readonly string[]
}

export class Uninstall {
  static readonly NOT_INSTALLED = Exit.NOTHING
  static readonly IN_USE = Exit.ERROR
  static readonly DECLINED = Exit.DECLINED

  static list(dir = AppPackage.packagesDir()): Installed[] {
    if (!Uninstall.#isDir(dir)) return []
    return readdirSync(dir)
      .filter((name) => !/\.new-\d+$/.test(name))
      .sort()
      .map((name) => Uninstall.#entry(join(dir, name)))
      .filter((entry): entry is Installed => entry !== null)
  }

  static find(target: string, dir = AppPackage.packagesDir()): Installed | null {
    const installed = Uninstall.list(dir)
    const pathLike = /[\\/]/.test(target) || target === '.' || target === '..' || isAbsolute(target)
    const byId = pathLike ? undefined : installed.find((entry) => entry.id === target)
    if (byId) return byId
    if (!Uninstall.#isDir(resolve(target))) return null
    const project = realpathSync(resolve(target))
    const linked = installed.find((entry) => entry.link !== null && Uninstall.#same(entry.link, project))
    if (linked) return linked
    const id = Uninstall.#idOf(project)
    return installed.find((entry) => entry.id === id && entry.link === null) ?? null
  }

  static users(entry: Installed, sessions: readonly Session[] = Sessions.list()): Session[] {
    return sessions.filter((session) =>
      (session.desktop !== null && (entry.desktops.includes(session.desktop) || entry.apps.length > 0))
      || session.apps.some((app) => entry.apps.includes(app)))
  }

  static describe(entry: Installed): string {
    return entry.link === null ? `${entry.id}  ${entry.path}` : `${entry.id}  ${entry.path} -> ${entry.link}`
  }

  static async run(target: string | undefined, options: UninstallOptions): Promise<number> {
    const dir = options.dir ?? AppPackage.packagesDir()
    if (target === undefined) {
      const installed = Uninstall.list(dir)
      if (installed.length === 0) options.say(`acdev: no packages installed in ${dir}`)
      for (const entry of installed) options.say(Uninstall.describe(entry))
      return 0
    }
    const entry = Uninstall.find(target, dir)
    if (!entry) {
      console.error(`acdev: ${target} is not installed in ${dir} (acdev uninstall lists what is)`)
      return Uninstall.NOT_INSTALLED
    }
    const users = Uninstall.users(entry, options.sessions ?? Sessions.list())
    if (users.length > 0) {
      const pids = users.map((session) => session.pid).join(', ')
      console.error(`acdev: ${entry.id} is in use by acdev dev ${pids}; stop it first (acdev stop --session <pid>)`)
      return Uninstall.IN_USE
    }
    const what = entry.link === null
      ? `${entry.path} (a copy acdev install made)`
      : `the link ${entry.path} (the project it points at, ${entry.link}, stays)`
    options.say(`acdev: removes ${entry.id}: ${what}`)
    if (!options.yes) {
      if (!options.confirm) {
        console.error(`acdev: not removed: pass --yes to remove ${entry.id} without asking`)
        return Uninstall.DECLINED
      }
      if (!(await options.confirm(`Remove ${entry.id}?`))) {
        console.error(`acdev: not removed: ${entry.id}`)
        return Uninstall.DECLINED
      }
    }
    const data = Uninstall.data(entry, options.env)
    const entries = Uninstall.entries(entry, options.env)
    const listed = [...data, ...entries.map(Uninstall.describeEntries)]
    let drop = options.data
    if (drop === undefined && listed.length > 0 && !options.yes && options.confirm)
      drop = await options.confirm(`Also remove the data of ${entry.id} (${listed.join(', ')})?`)
    Uninstall.remove(entry)
    options.say(`acdev: uninstalled ${entry.id} from ${entry.path}`)
    if (drop === true) {
      for (const path of data) rmSync(path, { recursive: true, force: true })
      for (const path of data) options.say(`acdev: removed its data ${path}`)
      for (const found of entries) {
        const problem = Uninstall.forget(found)
        options.say(problem === null
          ? `acdev: removed its entries from ${found.file} (${found.keys.join(', ')})`
          : `acdev: could not remove its entries from ${found.file}: ${problem}`)
      }
    } else if (listed.length > 0) {
      options.say(`acdev: kept its data (delete it by hand; --data removes it while uninstalling): ${listed.join(', ')}`)
    }
    return 0
  }

  static describeEntries(found: Entries): string {
    return `${found.file} (${found.keys.join(', ')})`
  }

  static #home(env: NodeJS.ProcessEnv, kind: 'DATA' | 'CONFIG' | 'STATE'): string {
    const set = env[`XDG_${kind}_HOME`]
    if (set && isAbsolute(set)) return set
    const base = env['HOME'] || homedir()
    return kind === 'DATA' ? join(base, '.local', 'share') : kind === 'STATE' ? join(base, '.local', 'state') : join(base, '.config')
  }

  static entries(entry: Installed, env: NodeJS.ProcessEnv = process.env): Entries[] {
    const apps = new Set(entry.apps)
    const stores: [string, (key: string) => boolean][] = [
      [join(Uninstall.#home(env, 'CONFIG'), 'acde', 'permissions.json'), (key) => Uninstall.#permission(key, apps)],
      [join(Uninstall.#home(env, 'STATE'), 'acde', 'windows.json'), (key) => apps.has(key)],
    ]
    return stores.flatMap(([file, mine]) => {
      const saved = Uninstall.#object(file)
      const keys = saved ? Object.keys(saved).filter(mine) : []
      return keys.length > 0 ? [{ file, keys }] : []
    })
  }

  static #permission(key: string, apps: ReadonlySet<string>): boolean {
    const at = key.lastIndexOf(':')
    return at > 0 && apps.has(key.slice(0, at)) && Project.ID.test(key.slice(at + 1))
  }

  static #inside(parent: string, path: string): boolean {
    const step = relative(resolve(parent), resolve(path))
    return step !== '' && !step.startsWith('..') && !isAbsolute(step)
  }

  static forget(found: Entries): string | null {
    const saved = Uninstall.#object(found.file)
    if (!saved) return 'it is no longer a JSON object'
    for (const key of found.keys) delete saved[key]
    const temp = `${found.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(saved))
      renameSync(temp, found.file)
      return null
    } catch (error) {
      rmSync(temp, { force: true })
      return (error as Error).message
    }
  }

  static #object(file: string): Record<string, unknown> | null {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  static data(entry: Installed, env: NodeJS.ProcessEnv = process.env): string[] {
    const data = join(Uninstall.#home(env, 'DATA'), 'acde')
    const config = join(Uninstall.#home(env, 'CONFIG'), 'acde', 'storage')
    const grants = join(Uninstall.#home(env, 'STATE'), 'acde', 'grants')
    const set = env['ACDE_STORAGE']
    const storage = set === undefined ? join(data, 'storage') : set || null
    const legacy = set === undefined ? config : null
    const apps = entry.apps.filter((id) => Project.ID.test(id))
    const desktops = entry.desktops.filter((id) => Project.ID.test(id))
    const under = (parent: string, child: string): [string, string] => [parent, join(parent, child)]
    const paths: [string, string][] = [
      ...apps.flatMap((id) => [
        ...(storage ? [under(storage, `app-${id}`)] : []), under(join(data, 'apps'), id), under(join(data, 'files'), id),
        under(grants, `${id}.json`), ...(legacy ? [under(legacy, `app-${id}.json`)] : []),
      ]),
      ...desktops.flatMap((id) => [
        ...(storage ? [under(storage, `desktop-${id}`)] : []), ...(legacy ? [under(legacy, `${id}.json`)] : []),
      ]),
    ]
    return paths.filter(([parent, path]) => Uninstall.#inside(parent, path) && existsSync(path)).map(([, path]) => path)
  }

  static remove(entry: Installed): void {
    if (entry.link !== null) rmSync(entry.path)
    else rmSync(entry.path, { recursive: true, force: true })
  }

  static async ask(question: string): Promise<boolean> {
    const answer = await p.confirm({ message: question, initialValue: false })
    return !p.isCancel(answer) && answer === true
  }

  static #entry(path: string): Installed | null {
    const info = lstatSync(path, { throwIfNoEntry: false })
    if (!info) return null
    const isLink = info.isSymbolicLink()
    if (!isLink && !info.isDirectory()) return null
    const link = isLink ? Uninstall.#target(path) : null
    const manifest = Uninstall.#manifest(path)
    const ids = (list: unknown) => Array.isArray(list)
      ? list.map((item) => (item as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && Project.ID.test(id))
      : []
    const id = path.split(/[\\/]/).pop()!
    return { id, path, link, apps: ids(manifest?.apps), desktops: ids(manifest?.desktops) }
  }

  static #target(path: string): string {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path, '..', readlinkSync(path))
    }
  }

  static #manifest(dir: string): { apps?: unknown; desktops?: unknown } | null {
    const file = join(dir, 'package.json')
    try {
      const json = Jsonc.parse(readFileSync(file, 'utf8'), 'package.json') as { acde?: unknown }
      return typeof json.acde === 'object' && json.acde !== null ? json.acde : null
    } catch {
      return null
    }
  }

  static #idOf(project: string): string | null {
    try {
      const pkg = new AppPackage(project)
      return pkg.project ? pkg.project.id : pkg.name.replace(/^@[^/]*\//, '')
    } catch {
      return null
    }
  }

  static #same(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }

  static #isDir(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory()
  }
}
