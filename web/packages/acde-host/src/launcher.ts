import type { NativeApp } from '@dopame/acde-api'
import { DesktopEntry } from './desktopentry'
import { DesktopEntries } from './open'
import { readFileSync, stat } from './sys/fs'
import { homedir, xdgDirs } from './sys/os'
import { isAbsolute, join } from './sys/path'
import { process, type Env } from './sys/process'

export class NativeApps {
  static readonly #THEMES = ['hicolor', 'breeze', 'Adwaita', 'AdwaitaLegacy']
  static readonly #CONTEXTS = new Set(['Applications', 'Legacy'])

  readonly #env: Env
  #stamp = ''
  #apps: NativeApp[] = []
  #files = new Map<string, string>()

  constructor(env: Env = process.env) {
    this.#env = env
  }

  list(): NativeApp[] {
    const dirs = xdgDirs('data', 'applications', this.#env)
    const stamp = dirs.map((dir) => stat(dir)?.mtimeMs ?? -1).join(':')
    if (stamp === this.#stamp) return this.#apps
    this.#stamp = stamp
    this.#files.clear()
    const desktops = (this.#env['XDG_CURRENT_DESKTOP'] || 'acde').split(':').filter(Boolean)
    const apps: NativeApp[] = []
    const themes = this.#themes().filter((dir) => stat(dir)?.isDirectory)
    for (const { name: id, file } of DesktopEntry.files(dirs)) {
      if (DesktopEntries.appOf(id)) continue
      const entry = DesktopEntry.read(file)
      if (!entry || !NativeApps.#shown(entry, desktops, this.#env)) continue
      this.#files.set(id, file)
      const name = entry.localized('Name', this.#env) ?? id.replace(/\.desktop$/, '')
      apps.push({
        id,
        name,
        comment: entry.localized('GenericName', this.#env) ?? entry.localized('Comment', this.#env),
        icon: this.#icon(entry.string('Icon'), themes),
        keywords: [...DesktopEntry.locales(this.#env).flatMap((locale) => entry.list(`Keywords[${locale}]`)), ...entry.list('Keywords')],
        wmClass: entry.string('StartupWMClass'),
      })
    }
    this.#apps = apps.sort((a, b) => a.name.localeCompare(b.name))
    return this.#apps
  }

  file(id: string): string | null {
    this.list()
    return this.#files.get(id) ?? null
  }

  static #shown(entry: DesktopEntry, desktops: readonly string[], env: Env): boolean {
    if (!entry.application || entry.flag('Hidden') || entry.flag('NoDisplay') || entry.flag('Terminal')) return false
    const only = entry.list('OnlyShowIn')
    if (only.length && !only.some((d) => desktops.includes(d))) return false
    if (entry.list('NotShowIn').some((d) => desktops.includes(d))) return false
    const tryExec = entry.string('TryExec')
    if (tryExec && !DesktopEntry.executable(tryExec, env)) return false
    const argv = entry.exec()
    return !!argv && DesktopEntry.executable(argv[0]!, env)
  }

  #icon(icon: string | null, themes: readonly string[]): string {
    if (!icon) return ''
    if (isAbsolute(icon)) return stat(icon)?.isFile ? icon : ''
    const name = icon.replace(/\.(png|svg)$/i, '')
    for (const ext of ['svg', 'png']) {
      for (const dir of [...themes, ...xdgDirs('data', 'pixmaps', this.#env, false)]) {
        const file = join(dir, `${name}.${ext}`)
        if (stat(file)?.isFile) return file
      }
    }
    return ''
  }

  static #groups(text: string): Map<string, Map<string, string>> {
    const groups = new Map<string, Map<string, string>>()
    let keys: Map<string, string> | null = null
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('[') && line.endsWith(']')) {
        const name = line.slice(1, -1)
        keys = groups.get(name) ?? new Map<string, string>()
        groups.set(name, keys)
        continue
      }
      const at = line.indexOf('=')
      if (keys && at > 0) {
        const key = line.slice(0, at).trim()
        if (!keys.has(key)) keys.set(key, line.slice(at + 1).trim())
      }
    }
    return groups
  }

  #themes(): string[] {
    const bases = [join(this.#env['HOME'] || homedir(), '.icons'), ...xdgDirs('data', 'icons', this.#env)]
    return NativeApps.#THEMES.flatMap((theme) => {
      let text: string | null = null
      for (const base of bases) {
        try {
          text = readFileSync(join(base, theme, 'index.theme'), 'utf8')
          break
        } catch {
        }
      }
      if (text === null) return []
      const groups = NativeApps.#groups(text)
      const dirs = (groups.get('Icon Theme')?.get('Directories') ?? '').split(',').map((d) => d.trim()).flatMap((dir) => {
        const keys = groups.get(dir)
        if (!keys || dir.includes('symbolic') || !NativeApps.#CONTEXTS.has(keys.get('Context') ?? '') || Number(keys.get('Scale') ?? 1) !== 1) return []
        const size = Number(keys.get('Size')) || 0
        return size >= 32 ? [{ dir, rank: size }] : []
      }).sort((a, b) => b.rank - a.rank)
      return dirs.flatMap(({ dir }) => bases.map((base) => join(base, theme, dir)))
    })
  }
}
