import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import * as p from '@clack/prompts'
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
}

export class Uninstall {
  static readonly NOT_INSTALLED = 1
  static readonly IN_USE = 2
  static readonly DECLINED = 3

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
      if (installed.length === 0) options.say(`acde: no packages installed in ${dir}`)
      for (const entry of installed) options.say(Uninstall.describe(entry))
      return 0
    }
    const entry = Uninstall.find(target, dir)
    if (!entry) {
      console.error(`acde: ${target} is not installed in ${dir} (acde uninstall lists what is)`)
      return Uninstall.NOT_INSTALLED
    }
    const users = Uninstall.users(entry, options.sessions ?? Sessions.list())
    if (users.length > 0) {
      const pids = users.map((session) => session.pid).join(', ')
      console.error(`acde: ${entry.id} is in use by acde dev ${pids}; stop it first (acde stop --session <pid>)`)
      return Uninstall.IN_USE
    }
    const what = entry.link === null
      ? `${entry.path} (a copy acde install made)`
      : `the link ${entry.path} (the project it points at, ${entry.link}, stays)`
    options.say(`acde: removes ${entry.id}: ${what}`)
    if (!options.yes) {
      if (!options.confirm) {
        console.error(`acde: not removed: pass --yes to remove ${entry.id} without asking`)
        return Uninstall.DECLINED
      }
      if (!(await options.confirm(`Remove ${entry.id}?`))) {
        console.error(`acde: not removed: ${entry.id}`)
        return Uninstall.DECLINED
      }
    }
    Uninstall.remove(entry)
    options.say(`acde: uninstalled ${entry.id} from ${entry.path}`)
    return 0
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
      ? list.map((item) => (item as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string')
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
