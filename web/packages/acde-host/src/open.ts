import type { OpenHandler } from '@dopame/acde-api'
import type { AppManifest } from './apps'
import { DesktopEntry } from './desktopentry'
import { FileTypes, type MimeDb } from './mimedb'
import { spawnSync } from './sys/child_process'
import { existsSync, mkdirSync, readTextOr, stat, writeFileSync } from './sys/fs'
import { sys } from './sys/natives'
import { xdgDirs, xdgHome } from './sys/os'
import { basename, dirname, isAbsolute, join, normalize } from './sys/path'
import { fileURLToPath, pathToFileURL } from './sys/url'

interface NativeEntry {
  readonly id: string
  readonly file: string
  readonly name: string
  readonly icon: string
  readonly mimeTypes: readonly string[]
}

/** A program Windows registers for a file extension (`IAssocHandler`); `id` is its name there (a path or a packaged app id). */
export interface SystemHandler {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly default: boolean
}

/** Windows' file associations: what replaces `.desktop` files there. The system default is only read, never written. */
export interface FileAssociations {
  handlers(extension: string): Promise<readonly SystemHandler[]>
  open(handler: string, path: string): Promise<void>
}

interface OpenerHost {
  apps(): AppManifest[]
  associations(): FileAssociations | null
  locate(path: string): Promise<{ root: string; path: string } | null>
  admit(path: string, caller: OpenCaller | null): Promise<string | null>
  launch(app: string, request: Record<string, unknown>): Promise<{ window: number }>
  spawn(argv: string[]): void
  system(): ((target: string) => Promise<void>) | null
  unsupported(app: string): Error | null
  view(app: AppManifest): OpenView
}

export type OpenView = 'roots' | 'url' | 'handle'

type Opened = { kind: 'acde' | 'native'; id: string; window?: number }
type Chosen = { kind: 'acde' | 'native'; id: string }

/** What `handlers()` answers: the type, the key `setDefault` remembers a choice under, and the apps to choose from. */
export interface Handlers {
  readonly mime: string
  readonly association: string | null
  readonly handlers: OpenHandler[]
}

export interface OpenCaller {
  readonly roots: readonly string[] | null
  readonly owner: string | null
}

class MimeTypes {
  static readonly DIRECTORY = 'inode/directory'
  static readonly #NAME = /^[\w.+-]+\/[\w.+-]+$/

  static valid(mime: string): boolean {
    return MimeTypes.#NAME.test(mime)
  }

  static match(patterns: readonly string[], mime: string): 0 | 1 | 2 {
    if (patterns.includes(mime)) return 2
    const [type] = mime.split('/')
    return patterns.includes(`${type}/*`) ? 1 : 0
  }

  static of(path: string, types = FileTypes.system()): string {
    if (stat(path)?.isDirectory) return MimeTypes.DIRECTORY
    if (types.associations) return types.byName(basename(path))
    const gio = spawnSync('gio', ['info', '--attributes=standard::content-type', path], 3000)
    const fromGio = /standard::content-type:\s*(\S+)/.exec(gio.stdout ?? '')?.[1]
    if (gio.status === 0 && fromGio && MimeTypes.valid(fromGio)) return fromGio
    const db = types.database()
    const candidates = db ? db.candidates(basename(path)) : []
    if (db && candidates.length === 1) return candidates[0]!
    const sniffed = MimeTypes.#sniff(path)
    if (db && candidates.length > 1) return MimeTypes.#pick(db, candidates, sniffed)
    return sniffed ?? 'application/octet-stream'
  }

  static describe(mime: string): string {
    return mime || 'a type the system does not know'
  }

  static #sniff(path: string): string | null {
    const file = spawnSync('file', ['--brief', '--mime-type', path], 3000)
    const sniffed = (file.stdout ?? '').trim()
    return file.status === 0 && MimeTypes.valid(sniffed) && sniffed !== 'application/octet-stream' ? sniffed : null
  }

  static #pick(db: MimeDb, candidates: readonly string[], sniffed: string | null): string {
    if (sniffed && candidates.includes(sniffed)) return sniffed
    if (!sniffed) return candidates[0]!
    const text = db.isText(sniffed)
    return candidates.find((mime) => db.isText(mime) === text) ?? candidates[0]!
  }
}

/** Windows' "Open with": the acde apps and the programs Windows registers, keyed by extension (as Windows keys its own). */
export class OpenWith {
  static readonly #TAKES = /^[\w.+-]+\/([\w.+-]+|\*)$/

  /** Whether `key` is one file extension (`.png`, any case), what Windows remembers choices under. */
  static isExtension(key: string): boolean {
    return key.startsWith('.') && FileTypes.extension(key) === key.toLowerCase()
  }

  /** The key a choice for this file is remembered under: its extension, else its type, else none. */
  static association(extension: string, mime: string): string | null {
    return extension || (MimeTypes.valid(mime) ? mime : null)
  }

  /** Whether an app opens files at all (its manifest has a file type), so it is offered for files of unknown type. */
  static takesFiles(mimeTypes: readonly string[]): boolean {
    return mimeTypes.some((m) => OpenWith.#TAKES.test(m) && m !== MimeTypes.DIRECTORY)
  }

  static list(apps: readonly AppManifest[], natives: readonly SystemHandler[], chosen: Chosen | null): OpenHandler[] {
    const chosenAs = (kind: 'acde' | 'native', id: string) => chosen?.kind === kind && chosen.id === id
    const acde = apps.map((app) => ({ kind: 'acde' as const, id: app.id, label: app.label, icon: app.icon, default: chosenAs('acde', app.id) }))
    const native = natives.map((n) => ({
      kind: 'native' as const,
      id: n.id,
      label: n.label,
      icon: n.icon,
      default: chosenAs('native', n.id),
      system: n.default,
    }))
    return [...acde, ...native]
  }
}

class MimeApps {
  static readonly DESKTOP = 'acde'
  static readonly MIME_LIST = `${MimeApps.DESKTOP}-mimeapps.list`
  /** Windows: the user's choices per file extension, as Windows itself keys them (same format, extensions as keys). */
  static readonly EXTENSION_LIST = `${MimeApps.DESKTOP}-extensions.list`

  static #lists(): string[] {
    const dirs = [...xdgDirs('config', ''), ...xdgDirs('data', 'applications')]
    return dirs.flatMap((dir) => [join(dir, `${MimeApps.DESKTOP}-mimeapps.list`), join(dir, 'mimeapps.list')])
  }

  static defaultFor(mime: string, installed: (id: string) => boolean): string | null {
    for (const list of MimeApps.#lists()) {
      const found = MimeApps.#first(readTextOr(list, null), mime, installed)
      if (found) return found
    }
    return null
  }

  static byExtension(extension: string, installed: (id: string) => boolean): string | null {
    return MimeApps.#first(readTextOr(join(xdgHome('config'), MimeApps.EXTENSION_LIST), null), extension, installed)
  }

  static #first(text: string | null, key: string, installed: (id: string) => boolean): string | null {
    if (text === null || !key) return null
    const ids = DesktopEntry.group(text, 'Default Applications').get(key) ?? ''
    for (const id of ids.split(';').map((id) => id.trim()).filter(Boolean)) if (installed(id)) return id
    return null
  }

  static natives(): NativeEntry[] {
    return DesktopEntry.files(xdgDirs('data', 'applications')).flatMap(({ name: id, file }) => {
      if (DesktopEntries.appOf(id)) return []
      const entry = DesktopEntry.read(file)
      if (!entry?.application || entry.flag('Hidden') || !entry.string('Exec')) return []
      const mimeTypes = entry.list('MimeType')
      return mimeTypes.length ? [{ id, file, name: entry.localized('Name') ?? id, icon: entry.string('Icon') ?? '', mimeTypes }] : []
    })
  }

  static setDefault(mime: string, id: string, list = MimeApps.MIME_LIST): string {
    const file = join(xdgHome('config'), list)
    const text = readTextOr(file, '')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, MimeApps.#withDefault(text, mime, id))
    return file
  }

  static #withDefault(text: string, mime: string, id: string): string {
    const lines = text.split(/\r?\n/)
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    let group = lines.findIndex((line) => line.trim() === '[Default Applications]')
    if (group < 0) {
      if (lines.length) lines.push('')
      lines.push('[Default Applications]')
      group = lines.length - 1
    }
    let end = group + 1
    while (end < lines.length && !lines[end]!.trim().startsWith('[')) end++
    const kept = lines.slice(group + 1, end).filter((line) => line.split('=')[0]!.trim() !== mime)
    return [...lines.slice(0, group + 1), `${mime}=${id};`, ...kept, ...lines.slice(end), ''].join('\n')
  }
}

export class DesktopEntries {
  static readonly #ACDE = /^acde-([\w-]+)\.desktop$/

  static appOf(id: string): string | null {
    return DesktopEntries.#ACDE.exec(id)?.[1] ?? null
  }

  static idOf(app: string): string {
    return `acde-${app}.desktop`
  }

  static entries(apps: readonly AppManifest[], exec = 'acdert'): { name: string; text: string }[] {
    return apps.flatMap((app) => {
      const types = app.mimeTypes.filter((m) => MimeTypes.valid(m))
      if (!types.length) return []
      return [{
        name: DesktopEntries.idOf(app.id),
        text: [
          '[Desktop Entry]',
          'Type=Application',
          `Name=${DesktopEntry.line(app.label)}`,
          `Exec=${exec} open --app ${app.id} %U`,
          `TryExec=${exec}`,
          `MimeType=${types.join(';')};`,
          'NoDisplay=true',
          'OnlyShowIn=acde;',
          'Terminal=false',
          '',
        ].join('\n'),
      }]
    })
  }

  static mimeapps(apps: readonly AppManifest[]): string {
    const first = new Map<string, string>()
    for (const app of apps) for (const m of app.mimeTypes) if (MimeTypes.valid(m) && !first.has(m)) first.set(m, DesktopEntries.idOf(app.id))
    return ['[Default Applications]', ...[...first].map(([m, id]) => `${m}=${id};`), ''].join('\n')
  }
}

export interface OpenOptions {
  readonly app?: string
  readonly select?: boolean
  readonly readOnly?: boolean
}

type SystemRequestLike = { kind: 'open-file' | 'open-link'; url?: unknown; path?: unknown; held?: unknown }

export class Opener {
  readonly #host: OpenerHost

  constructor(host: OpenerHost) {
    this.#host = host
  }

  static #path(target: string): string | null {
    if (target.startsWith('file:')) {
      try {
        return normalize(fileURLToPath(target))
      } catch {
        return null
      }
    }
    return isAbsolute(target) ? normalize(target) : null
  }

  async handlers(target: string): Promise<Handlers> {
    const path = Opener.#existing(target)
    const mime = MimeTypes.of(path)
    const windows = this.#host.associations()
    if (windows) return this.#windowsHandlers(windows, path, mime)
    const natives = MimeApps.natives()
    const chosen = this.#chosen(mime, natives)
    const chosenAs = (kind: 'acde' | 'native', id: string) => chosen?.kind === kind && chosen.id === id
    const acde = this.#acdeFor(mime).map((app) => ({ kind: 'acde' as const, id: app.id, label: app.label, icon: app.icon, default: chosenAs('acde', app.id) }))
    const native = natives
      .filter((n) => MimeTypes.match(n.mimeTypes, mime))
      .map((n) => ({ kind: 'native' as const, id: n.id, label: n.name, icon: n.icon, default: chosenAs('native', n.id) }))
    return { mime, association: mime, handlers: [...acde, ...native] }
  }

  async #windowsHandlers(windows: FileAssociations, path: string, mime: string): Promise<Handlers> {
    const directory = mime === MimeTypes.DIRECTORY
    const extension = directory ? '' : FileTypes.extension(basename(path))
    const chosen = this.#chosen(mime, [], extension)
    const apps = mime ? this.#acdeFor(mime) : this.#host.apps().filter((app) => OpenWith.takesFiles(app.mimeTypes))
    const natives = extension ? await windows.handlers(extension).catch(() => []) : []
    return { mime, association: OpenWith.association(extension, mime), handlers: OpenWith.list(apps, natives, chosen) }
  }

  async setDefault(key: string, handler: string): Promise<string> {
    const windows = this.#host.associations()
    const extension = windows && OpenWith.isExtension(key) ? key.toLowerCase() : null
    if (!extension && !MimeTypes.valid(key)) {
      throw Object.assign(new Error(`not a MIME type${windows ? ' or file extension' : ''}: ${key}`), { status: 400 })
    }
    const acde = this.#host.apps().some((a) => a.id === handler) || !!DesktopEntries.appOf(handler)
    if (windows && !acde) {
      if (!extension) throw Object.assign(new Error(`a Windows program is remembered for a file extension, not for ${key}`), { status: 400 })
      const registered = await windows.handlers(extension).catch(() => [])
      if (!registered.some((n) => n.id === handler)) throw Object.assign(new Error(`no program ${handler} for ${extension} files`), { status: 404 })
      return MimeApps.setDefault(extension, handler, MimeApps.EXTENSION_LIST)
    }
    const id = handler.endsWith('.desktop') ? handler : DesktopEntries.idOf(handler)
    const app = DesktopEntries.appOf(id)
    const known = app ? this.#host.apps().some((a) => a.id === app) : !windows && MimeApps.natives().some((n) => n.id === id)
    if (!known) throw Object.assign(new Error(`no app ${handler}`), { status: 404 })
    return extension ? MimeApps.setDefault(extension, id, MimeApps.EXTENSION_LIST) : MimeApps.setDefault(key, id)
  }

  async open(target: string, options: OpenOptions = {}, caller: OpenCaller | null = null): Promise<Opened> {
    const scheme = Opener.#scheme(String(target))
    if (scheme) return this.#openUrl(String(target), scheme, options)
    const path = Opener.#existing(target)
    const isDir = !!stat(path)?.isDirectory
    const select = !!options.select && !isDir
    const mime = select ? MimeTypes.DIRECTORY : MimeTypes.of(path)
    const windows = this.#host.associations()
    const extension = windows && !select && !isDir ? FileTypes.extension(basename(path)) : ''
    const natives = this.#natives()
    let chosen = options.app ? this.#asked(options.app, natives, caller) : this.#chosen(mime, natives, extension)
    const system = !chosen && !options.app && !select && !isDir ? this.#host.system() : null
    if (system) return this.#toSystem(system, path, mime, caller)
    if (!chosen) throw Object.assign(new Error(`no app can open this kind of file (${MimeTypes.describe(mime)})`), { status: 404, code: 'no_app' })
    if (chosen.kind === 'acde') {
      const id = chosen.id
      const app = this.#host.apps().find((a) => a.id === id)!
      const request = await this.#request(app, path, isDir, select, !!options.readOnly)
      if (request) return { ...chosen, window: (await this.#host.launch(app.id, request)).window }
      const native = options.app ? null : natives.find((n) => MimeTypes.match(n.mimeTypes, mime))
      if (!native) throw Object.assign(new Error(`${path} is not in any finder root (desktop, downloads, workspace)`), { status: 404, code: 'outside_roots' })
      chosen = { kind: 'native', id: native.id }
    }
    if (windows) return this.#openWindows(windows, chosen.id, path, caller)
    const id = chosen.id
    const entry = natives.find((n) => n.id === id)!
    this.#host.spawn(['gio', 'launch', entry.file, select ? dirname(path) : path])
    return chosen
  }

  static isSystem(request: unknown): request is SystemRequestLike {
    const kind = (request as { kind?: unknown } | null)?.kind
    return typeof request === 'object' && request !== null && (kind === 'open-file' || kind === 'open-link')
  }

  app(id: string): AppManifest | undefined {
    return this.#host.apps().find((a) => a.id === id)
  }

  async request(request: SystemRequestLike, target: string | null, caller: OpenCaller | null): Promise<Opened> {
    const text = String(request.url ?? request.path ?? '')
    const app = target === null ? null : this.#host.apps().find((a) => a.id === target)
    if (target !== null && !app) throw Object.assign(new Error(`no app ${target}`), { status: 404 })
    const refuse = (what: string) => Object.assign(new Error(`${target} does not accept ${what}`), { status: 409, code: 'not_accepted' })
    if (request.kind === 'open-link') {
      const scheme = Opener.#scheme(text)
      if (!scheme) throw Object.assign(new Error(`open-link needs a URL with a scheme: ${text}`), { status: 400 })
      if (app && !app.schemes.includes(scheme)) throw refuse(`${scheme}: links (its manifest's schemes)`)
      return this.#openUrl(text, scheme, target ? { app: target } : {})
    }
    const held = Opener.#held(request.held)
    const file = held ?? text
    if (!held && Opener.#scheme(text)) throw Object.assign(new Error(`open-file needs a file URL or an absolute path: ${text}`), { status: 400 })
    const mime = MimeTypes.of(Opener.#existing(file))
    if (app && MimeTypes.match(app.mimeTypes, mime) === 0) throw refuse(`${MimeTypes.describe(mime)} files (its manifest's mimeTypes)`)
    const vouched = held && caller?.roots ? { ...caller, roots: [...caller.roots, dirname(held)] } : caller
    const readOnly = (request.held as { writable?: unknown } | undefined)?.writable === false
    return this.open(file, { ...(target && { app: target }), ...(held && readOnly && { readOnly }) }, vouched)
  }

  static #held(held: unknown): string | null {
    const path = (held as { path?: unknown } | null | undefined)?.path
    return typeof path === 'string' && isAbsolute(path) ? normalize(path) : null
  }

  async #openUrl(url: string, scheme: string, options: OpenOptions): Promise<Opened> {
    const declared = options.app ? null : this.#host.apps().find((a) => a.schemes.includes(scheme))
    if (declared) return { kind: 'acde', id: declared.id, window: (await this.#host.launch(declared.id, { kind: 'open-link', url })).window }
    const mime = `x-scheme-handler/${scheme}`
    const natives = this.#natives()
    const chosen = options.app ? this.#asked(options.app, natives) : this.#chosen(mime, natives)
    const app = chosen?.kind === 'acde' ? this.#host.apps().find((a) => a.id === chosen.id) : null
    if (app && (!app.capabilities.fs || app.schemes.includes(scheme))) {
      return { kind: 'acde', id: app.id, window: (await this.#host.launch(app.id, { kind: 'open-link', url })).window }
    }
    const native = chosen?.kind === 'native' ? natives.find((n) => n.id === chosen.id) : null
    const system = !native && !options.app && Opener.#WEB.includes(scheme) ? this.#host.system() : null
    if (system) return Opener.#handOff(system, Opener.#webLink(url), `${scheme}: links`)
    if (!native) throw Object.assign(new Error(`no app can open ${scheme}: links`), { status: 404, code: 'no_app' })
    this.#host.spawn(['gio', 'launch', native.file, url])
    return { kind: 'native', id: native.id }
  }

  static readonly SYSTEM = 'system'
  static readonly #WEB = ['http', 'https']

  static #webLink(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
    } catch {}
    throw Object.assign(new Error(`not a web link: ${url}`), { status: 400 })
  }

  async #openWindows(windows: FileAssociations, handler: string, path: string, caller: OpenCaller | null): Promise<Opened> {
    const real = await this.#host.admit(path, caller)
    if (!real) throw Object.assign(new Error(`${path} is not in a folder the caller may open`), { status: 404, code: 'outside_roots' })
    try {
      await windows.open(handler, real)
    } catch (error) {
      throw Object.assign(new Error(`${handler} did not open ${real}: ${(error as Error).message}`), { status: 404, code: 'no_app' })
    }
    return { kind: 'native', id: handler }
  }

  #natives(): NativeEntry[] {
    return this.#host.associations() ? [] : MimeApps.natives()
  }

  async #toSystem(system: (target: string) => Promise<void>, path: string, mime: string, caller: OpenCaller | null): Promise<Opened> {
    const real = await this.#host.admit(path, caller)
    if (!real) throw Object.assign(new Error(`${path} is not in a folder the caller may open`), { status: 404, code: 'outside_roots' })
    return Opener.#handOff(system, real, `this kind of file (${MimeTypes.describe(mime)})`)
  }

  static async #handOff(system: (target: string) => Promise<void>, target: string, what: string): Promise<Opened> {
    try {
      await system(target)
    } catch (error) {
      throw Object.assign(new Error(`no app can open ${what}: ${(error as Error).message}`), { status: 404, code: 'no_app' })
    }
    return { kind: 'native', id: Opener.SYSTEM }
  }

  static #scheme(target: string): string | null {
    if (sys().platform === 'win32' && /^[a-z]:[\\/]/i.test(target)) return null
    const scheme = /^([a-z][\w+.-]*):/i.exec(target)?.[1]?.toLowerCase() ?? null
    return scheme === 'file' ? null : scheme
  }

  async #request(app: AppManifest, path: string, isDir: boolean, select: boolean, readOnly: boolean): Promise<Record<string, unknown> | null> {
    const inFolder = select || (!isDir && MimeTypes.match(app.mimeTypes, MimeTypes.DIRECTORY) === 2)
    const at = inFolder ? dirname(path) : path
    const entry = { path: at, kind: inFolder || isDir ? 'directory' : 'file', writable: !readOnly && ((stat(at)?.mode ?? 0) & 0o200) !== 0 }
    const view = this.#host.view(app)
    if (view === 'handle') return { kind: 'open-file', entry, ...(inFolder && { file: basename(path) }) }
    if (view === 'url') return { kind: 'open-file', url: pathToFileURL(path).href, entry }
    const place = await this.#host.locate(path)
    if (!place) return null
    if (inFolder) {
      const cut = place.path.lastIndexOf('/')
      return { kind: 'open-file', root: place.root, path: cut < 0 ? '' : place.path.slice(0, cut), file: basename(path), entry }
    }
    return { kind: 'open-file', root: place.root, path: place.path, file: null, entry }
  }

  #asked(id: string, natives: readonly NativeEntry[], caller: OpenCaller | null): Chosen {
    if (this.#host.associations() && !this.#host.apps().some((a) => a.id === id) && !this.#host.unsupported(id)) {
      if (caller) throw Object.assign(new Error(`only the desktop opens files in a Windows program it names (${id})`), { status: 403, code: 'refused' })
      return { kind: 'native', id }
    }
    const native = id.endsWith('.desktop')
    const unsupported = native ? null : this.#host.unsupported(id)
    if (unsupported) throw unsupported
    if (native ?!natives.some((n) => n.id === id) : !this.#host.apps().some((a) => a.id === id)) throw Object.assign(new Error(`no app ${id}`), { status: 404 })
    return { kind: native ? 'native' : 'acde', id }
  }

  #chosen(mime: string, natives: readonly NativeEntry[], extension = ''): Chosen | null {
    const apps = this.#host.apps()
    const windows = !!this.#host.associations()
    const installed = (id: string) => {
      const app = DesktopEntries.appOf(id)
      return app ? apps.some((a) => a.id === app) : windows || natives.some((n) => n.id === id)
    }
    const listed = (extension ? MimeApps.byExtension(extension, installed) : null) ?? (mime ? MimeApps.defaultFor(mime, installed) : null)
    if (listed) {
      const app = DesktopEntries.appOf(listed)
      return app ? { kind: 'acde', id: app } : { kind: 'native', id: listed }
    }
    const acde = this.#acdeFor(mime)[0]
    if (acde) return { kind: 'acde', id: acde.id }
    const native = natives.find((n) => MimeTypes.match(n.mimeTypes, mime))
    return native ? { kind: 'native', id: native.id } : null
  }

  #acdeFor(mime: string): AppManifest[] {
    const apps = this.#host.apps().filter((a) => MimeTypes.match(a.mimeTypes, mime) > 0)
    return [...apps.filter((a) => MimeTypes.match(a.mimeTypes, mime) === 2), ...apps.filter((a) => MimeTypes.match(a.mimeTypes, mime) === 1)]
  }

  static #existing(target: string): string {
    const path = Opener.#path(String(target))
    if (!path) throw Object.assign(new Error(`not a local file: ${target}`), { status: 400 })
    if (!existsSync(path)) throw Object.assign(new Error(`${path} does not exist`), { status: 404 })
    return path
  }
}
