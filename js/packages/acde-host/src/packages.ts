import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, stat, writeFileSync } from './sys/fs'
import { xdgDirs, xdgHome } from './sys/os'
import { dirname, isAbsolute, join, resolve } from './sys/path'
import { fileURLToPath } from './sys/url'
import type { DesktopManifest, PackageManifest, ServiceManifest } from '@dopame/acde-api'
import { process } from './sys/process'
import { Manifest } from '@dopame/acde-app/manifest'
import { DesktopEntry } from './desktopentry'
import { WaylandSessions, type ForeignSession } from './foreign'
import { Level, Log } from './log'

interface InstalledPackage {
  readonly dir: string
  readonly name: string
  readonly manifest: PackageManifest
}

export interface InstalledDesktop {
  readonly kind: 'acde'
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly package: InstalledPackage
  readonly html: string
  readonly services: readonly ServiceManifest[]
  readonly heapMb: number
  /** The desktop's window frame: a module (an own-origin asset path) each app window that wants a frame runs. */
  readonly frame: string | null
}

export class Packages {
  static readonly HEAP_MB = 1024
  static readonly RENAMED: Readonly<Record<string, string>> = { dopamine: 'dopame' }

  static get HOST(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..')
  }

  readonly packages: InstalledPackage[] = []
  readonly #desktops = new Map<string, InstalledDesktop>()
  #sessions: ForeignSession[] = []
  readonly #extra: readonly string[]

  constructor(extra: readonly string[] = []) {
    this.#extra = extra
    this.rescan()
  }

  rescan(): void {
    this.packages.length = 0
    this.#desktops.clear()
    this.#sessions = WaylandSessions.list()
    for (const dir of [Packages.HOST, ...this.#extra, ...Packages.#dirs()]) {
      if (this.packages.some((p) => p.dir === dir)) continue
      const found = Packages.#read(dir)
      if (!found) continue
      this.packages.push(found)
      for (const raw of found.manifest.desktops ?? []) {
        const desktop = Packages.#desktop(found, raw)
        if (!desktop) Packages.#warn(`${dir}/package.json: a desktop needs id, name and an entry file that exists`)
        else if (this.#desktops.has(desktop.id)) Packages.#warn(`desktop ${desktop.id} in ${dir} is already defined; the first one stays`)
        else this.#desktops.set(desktop.id, desktop)
      }
    }
  }

  static #warn(line: string): void {
    Log.write(Level.Warn, 'acde_host', line)
  }

  static #dirs(): string[] {
    const listed = (process.env['ACDE_PATH'] ?? '').split(':').filter(Boolean).map((dir) => resolve(dir))
    const inRoots = xdgDirs('data', 'acde/packages').flatMap((root) => {
      try {
        return readdirSync(root).filter((name) => !name.startsWith('.')).sort().map((name) => join(root, name)).filter((dir) => !!stat(dir)?.isDirectory)
      } catch {
        return []
      }
    })
    return [...listed, ...inRoots]
  }

  static #read(dir: string): InstalledPackage | null {
    const file = join(dir, 'package.json')
    if (!existsSync(file)) return null
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; acde?: unknown }
      if (typeof pkg.acde !== 'object' || pkg.acde === null) return null
      return { dir, name: typeof pkg.name === 'string' && pkg.name ? pkg.name : dir.split('/').pop()!, manifest: pkg.acde as PackageManifest }
    } catch (error) {
      Packages.#warn(`${file}: ${(error as Error).message}`)
      return null
    }
  }

  static #desktop(pkg: InstalledPackage, raw: DesktopManifest): InstalledDesktop | null {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
    const id = text(raw?.id), name = text(raw?.name), entry = text(raw?.entry)
    if (!id || !name || !entry || !/^[\w-]+$/.test(id) || isAbsolute(entry)) return null
    const html = join(pkg.dir, entry)
    if (!existsSync(html)) return null
    const all = pkg.manifest.services ?? []
    const named = Array.isArray(raw.services) ? raw.services.map((s) => (typeof s === 'string' ? s : s?.name)) : null
    const wanted = named ? all.filter((s) => named.includes(s.name)) : all
    return { kind: 'acde', id, name, description: text(raw.description), package: pkg, html, services: wanted, heapMb: Manifest.heapMb(raw.heapMb, Packages.HEAP_MB), frame: text(raw.frame)?.startsWith('/') ? text(raw.frame) : null }
  }

  desktops(): InstalledDesktop[] {
    return [...this.#desktops.values()]
  }

  desktop(id: string): InstalledDesktop | null {
    return this.#desktops.get(id) ?? null
  }

  bare(): InstalledDesktop {
    const pkg = this.packages.find((p) => p.dir === Packages.HOST) ?? { dir: Packages.HOST, name: '@dopame/acde-host', manifest: {} }
    return { kind: 'acde', id: 'window', name: 'acde window', description: null, package: pkg, html: '', services: [], heapMb: Packages.HEAP_MB, frame: null }
  }

  sessions(): ForeignSession[] {
    return [...this.#sessions]
  }

  find(id: string): InstalledDesktop | ForeignSession | null {
    return this.desktop(id) ?? this.#sessions.find((s) => s.id === id) ?? null
  }

  resources(): { prefix: string; dirs: string[] }[] {
    const seen = new Set<string>()
    const out: { prefix: string; dirs: string[] }[] = []
    for (const pkg of this.packages) {
      for (const [prefix, dirs] of Object.entries(pkg.manifest.assets ?? {})) {
        if (!/^\/[\w./-]*\/$/.test(prefix) || seen.has(prefix) || !Array.isArray(dirs)) continue
        seen.add(prefix)
        out.push({ prefix, dirs: dirs.filter((dir) => typeof dir === 'string' && !isAbsolute(dir)).map((dir) => join(pkg.dir, dir, '/')) })
      }
    }
    return out
  }

  static #installId(pkg: InstalledPackage): string {
    const app = pkg.manifest.apps?.[0]?.id
    if (typeof app === 'string' && /^[\w-]+$/.test(app)) return app
    const id = pkg.name.replace(/^@[^/]*\//, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!id) throw Object.assign(new Error(`${pkg.dir}: no app id nor package name to install it as`), { status: 400 })
    return id
  }

  static install(dir: string): { id: string; dir: string } {
    const from = resolve(dir)
    const pkg = Packages.#read(from)
    if (!pkg) throw Object.assign(new Error(`${from}: no package.json with an acde field`), { status: 400 })
    const id = Packages.#installId(pkg)
    const root = join(xdgHome('data'), 'acde', 'packages')
    const to = join(root, id)
    if (from === to) return { id, dir: to }
    if (`${to}/`.startsWith(`${from}/`) || `${from}/`.startsWith(`${to}/`)) throw Object.assign(new Error(`${from}: cannot install a package into itself`), { status: 400 })
    mkdirSync(root, { recursive: true })
    const fresh = join(root, `.${id}.new-${Date.now()}`)
    try {
      Packages.#copy(from, fresh)
      rmSync(to, { recursive: true, force: true })
      renameSync(fresh, to)
    } catch (error) {
      rmSync(fresh, { recursive: true, force: true })
      throw error
    }
    return { id, dir: to }
  }

  static #copy(from: string, to: string): void {
    const info = stat(from)
    if (!info) return
    if (info.isDirectory) {
      mkdirSync(to, { recursive: true, mode: (info.mode & 0o777) | 0o700 })
      for (const name of readdirSync(from)) Packages.#copy(join(from, name), join(to, name))
    } else if (info.isFile) {
      writeFileSync(to, readFileSync(from), { mode: info.mode & 0o777 })
    }
  }

  static rememberFile(): string {
    return join(xdgHome('state'), 'acde', 'desktop')
  }

  static remember(id: string): void {
    const file = Packages.rememberFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${id}\n`)
  }

  choose(wanted: string | null, foreign = true, quiet = false): InstalledDesktop | ForeignSession {
    const warn = quiet ? () => {} : Packages.#warn
    const find = (id: string) => {
      const found = this.find(Object.hasOwn(Packages.RENAMED, id) ? Packages.RENAMED[id]! : id) ?? this.find(id)
      return found && (foreign || found.kind === 'acde') ? found : null
    }
    if (wanted) {
      const byId = find(wanted)
      if (byId) return byId
      const dir = resolve(wanted)
      const inDir = this.desktops().find((d) => d.package.dir === dir)
      if (inDir) return inDir
      throw new Error(`no desktop ${wanted}: not an installed desktop's id nor a package directory with one (acde desktops lists them)`)
    }
    const remembered = (() => {
      try {
        return readFileSync(Packages.rememberFile(), 'utf8').trim()
      } catch {
        return null
      }
    })()
    for (const [id, where] of [[process.env['ACDE_DESKTOP'], 'ACDE_DESKTOP'], [remembered, Packages.rememberFile()]] as const) {
      if (!id) continue
      const found = find(id)
      if (found && found.id !== id && id === remembered) {
        try {
          Packages.remember(found.id)
        } catch (error) {
          warn(`${Packages.rememberFile()}: desktop ${id} is now ${found.id}, not rewritten: ${(error as Error).message}`)
        }
      }
      if (found) return found
      warn(`${where} names desktop ${id}, which is not installed${this.find(id) ? ' as an acde desktop' : ''}`)
    }
    const first = this.desktops()[0] ?? (foreign ? this.#sessions[0] : undefined)
    if (first) return first
    throw new Error('no desktop installed: install a desktop package (acde-dopame) or give one with --desktop <package dir>')
  }

  static sessionFile(desktop: { id: string; name: string; description: string | null }): { name: string; text: string } {
    return {
      name: `acde-${desktop.id}.desktop`,
      text: [
        '[Desktop Entry]',
        `Name=${DesktopEntry.line(desktop.name)}`,
        `Comment=${DesktopEntry.line(desktop.description ?? `${desktop.name} on acde`)}`,
        `Exec=acde --desktop ${desktop.id}`,
        'TryExec=acde',
        'Type=Application',
        'DesktopNames=acde',
        '',
      ].join('\n'),
    }
  }
}
