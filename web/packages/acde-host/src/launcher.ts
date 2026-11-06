import type { NativeApp } from '@dopame/acde-api'
import { DesktopEntry } from './desktopentry'
import { DesktopEntries } from './open'
import { readTextOr, stat } from './sys/fs'
import { homedir, xdgDirs } from './sys/os'
import { isAbsolute, join } from './sys/path'
import { process } from './sys/process'

export class NativeApps {
  static readonly #THEMES = ['hicolor', 'breeze', 'Adwaita', 'AdwaitaLegacy']
  static readonly #CONTEXTS = new Set(['Applications', 'Legacy'])

  #stamp = ''
  #apps: NativeApp[] = []
  readonly #files = new Map<string, string>()

  list(): NativeApp[] {
    const dirs = xdgDirs('data', 'applications')
    const stamp = dirs.map((dir) => stat(dir)?.mtimeMs ?? -1).join(':')
    if (stamp === this.#stamp) return this.#apps
    this.#stamp = stamp
    this.#files.clear()
    const desktops = (process.env['XDG_CURRENT_DESKTOP'] || 'acde').split(':').filter(Boolean)
    const apps: NativeApp[] = []
    const themes = NativeApps.#themes().filter((dir) => stat(dir)?.isDirectory)
    for (const { name: id, file } of DesktopEntry.files(dirs)) {
      if (DesktopEntries.appOf(id)) continue
      const entry = DesktopEntry.read(file)
      if (!entry || !NativeApps.#shown(entry, desktops)) continue
      this.#files.set(id, file)
      const name = entry.localized('Name') ?? id.replace(/\.desktop$/, '')
      apps.push({
        id,
        name,
        comment: entry.localized('GenericName') ?? entry.localized('Comment'),
        icon: NativeApps.#icon(entry.string('Icon'), themes),
        keywords: [...DesktopEntry.locales().flatMap((locale) => entry.list(`Keywords[${locale}]`)), ...entry.list('Keywords')],
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

  static #shown(entry: DesktopEntry, desktops: readonly string[]): boolean {
    if (!entry.application || entry.flag('Hidden') || entry.flag('NoDisplay') || entry.flag('Terminal') || !entry.shownIn(desktops)) return false
    const argv = entry.runnable()
    return !!argv && DesktopEntry.executable(argv[0]!)
  }

  static #icon(icon: string | null, themes: readonly string[]): string {
    if (!icon) return ''
    if (isAbsolute(icon)) return stat(icon)?.isFile ? icon : ''
    const name = icon.replace(/\.(png|svg)$/i, '')
    for (const ext of ['svg', 'png']) {
      for (const dir of [...themes, ...xdgDirs('data', 'pixmaps', false)]) {
        const file = join(dir, `${name}.${ext}`)
        if (stat(file)?.isFile) return file
      }
    }
    return ''
  }

  static #themes(): string[] {
    const bases = [join(process.env['HOME'] || homedir(), '.icons'), ...xdgDirs('data', 'icons')]
    return NativeApps.#THEMES.flatMap((theme) => {
      const text = bases.reduce<string | null>((found, base) => found ?? readTextOr(join(base, theme, 'index.theme'), null), null)
      if (text === null) return []
      const groups = DesktopEntry.groups(text)
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
