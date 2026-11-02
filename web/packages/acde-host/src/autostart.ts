import { DesktopEntry } from './desktopentry'
import { xdgDirs } from './sys/os'
import { process, type Env } from './sys/process'

interface AutostartEntry {
  readonly file: string
  readonly name: string
  readonly argv: string[]
  readonly cwd?: string
}

export class Autostart {
  constructor(
    readonly desktop: string,
    readonly env: Env = process.env,
  ) {}

  static wanted(session: boolean, env: Env = process.env): boolean {
    return env['ACDE_AUTOSTART'] === '1' || (session && env['ACDE_AUTOSTART'] !== '0')
  }

  entries(skip: ReadonlySet<string> = new Set()): AutostartEntry[] {
    return DesktopEntry.files(xdgDirs('config', 'autostart', this.env))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .flatMap(({ file }) => {
        const entry = this.#entry(file)
        return entry && !skip.has(entry.argv[0]!.split('/').at(-1)!) ? [entry] : []
      })
  }

  start(launch: (argv: string[], options?: { cwd?: string }) => number, skip?: ReadonlySet<string>, report = (line: string) => process.stderr.write(`${line}\n`)): AutostartEntry[] {
    const started: AutostartEntry[] = []
    for (const entry of this.entries(skip)) {
      try {
        launch(entry.argv, entry.cwd ? { cwd: entry.cwd } : undefined)
        started.push(entry)
        report(`acde-host: autostart ${entry.name}: ${entry.argv.join(' ')}`)
      } catch (error) {
        report(`acde-host: autostart ${entry.file} not started: ${(error as Error).message}`)
      }
    }
    return started
  }

  #entry(file: string): AutostartEntry | null {
    const entry = DesktopEntry.read(file)
    if (!entry?.application || entry.flag('Hidden') || entry.string('X-GNOME-Autostart-enabled') === 'false') return null
    const desktops = (this.env['XDG_CURRENT_DESKTOP'] || this.desktop).split(':')
    const only = entry.list('OnlyShowIn'), not = entry.list('NotShowIn')
    if (only.length && !only.some((d) => desktops.includes(d))) return null
    if (not.some((d) => desktops.includes(d))) return null
    const tryExec = entry.string('TryExec')
    if (tryExec && !DesktopEntry.executable(tryExec, this.env)) return null
    const argv = entry.exec()
    if (!argv) return null
    const cwd = entry.string('Path')
    return { file, name: entry.string('Name') ?? file, argv, ...(cwd ? { cwd } : {}) }
  }
}
