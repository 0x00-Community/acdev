import { DesktopEntry } from './desktopentry'
import { Level, Log } from './log'
import { xdgDirs } from './sys/os'
import { process } from './sys/process'

interface AutostartEntry {
  readonly file: string
  readonly name: string
  readonly argv: string[]
  readonly cwd?: string
}

export class Autostart {
  static wanted(session: boolean): boolean {
    const set = process.env['ACDE_AUTOSTART']
    return set === '1' || (session && set !== '0')
  }

  static start(launch: (argv: string[], options?: { cwd?: string }) => number, skip: ReadonlySet<string>): void {
    const files = DesktopEntry.files(xdgDirs('config', 'autostart')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const { file } of files) {
      const entry = Autostart.#entry(file)
      if (!entry || skip.has(entry.argv[0]!.split('/').at(-1)!)) continue
      try {
        launch(entry.argv, entry.cwd ? { cwd: entry.cwd } : undefined)
        Log.write(Level.Info, 'acde_host', `autostart ${entry.name}: ${entry.argv.join(' ')}`)
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `autostart ${entry.file} not started: ${(error as Error).message}`)
      }
    }
  }

  static #entry(file: string): AutostartEntry | null {
    const entry = DesktopEntry.read(file)
    if (!entry?.application || entry.flag('Hidden') || entry.string('X-GNOME-Autostart-enabled') === 'false') return null
    const desktops = (process.env['XDG_CURRENT_DESKTOP'] || 'acde').split(':')
    const only = entry.list('OnlyShowIn'), not = entry.list('NotShowIn')
    if (only.length && !only.some((d) => desktops.includes(d))) return null
    if (not.some((d) => desktops.includes(d))) return null
    const tryExec = entry.string('TryExec')
    if (tryExec && !DesktopEntry.executable(tryExec)) return null
    const argv = entry.exec()
    if (!argv) return null
    const cwd = entry.string('Path')
    return { file, name: entry.string('Name') ?? file, argv, ...(cwd ? { cwd } : {}) }
  }
}
