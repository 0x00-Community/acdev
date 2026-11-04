import { DesktopEntry } from './desktopentry'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from './sys/fs'
import { runtimeDir, xdgDirs } from './sys/os'
import { basename, dirname, join } from './sys/path'
import { Level, Log } from './log'

export interface ForeignSession {
  readonly kind: 'session'
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly file: string
  readonly argv: readonly string[]
  readonly desktopNames: readonly string[]
}

export class WaylandSessions {
  static readonly PREFIX = 'session:'
  static readonly HANDOFF_EXIT = 3

  static list(): ForeignSession[] {
    return DesktopEntry.files(xdgDirs('data', 'wayland-sessions', false)).flatMap(({ file }) => {
      try {
        const session = WaylandSessions.#parse(file, readFileSync(file, 'utf8'))
        return session ? [session] : []
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `${file}: ${(error as Error).message}`)
        return []
      }
    })
  }

  static #parse(file: string, text: string): ForeignSession | null {
    const base = basename(file).replace(/\.desktop$/, '')
    if (base === 'acde' || base.startsWith('acde-') || !/^[\w.+@-]+$/.test(base)) return null
    const entry = new DesktopEntry(file, text)
    if (!entry.application || entry.flag('Hidden') || entry.flag('NoDisplay')) return null
    const argv = entry.exec()
    if (!argv || basename(argv[0]!) === 'acde') return null
    const tryExec = entry.string('TryExec')
    if (tryExec && !DesktopEntry.executable(tryExec)) return null
    if (!DesktopEntry.executable(argv[0]!)) return null
    const desktopNames = entry.list('DesktopNames')
    return {
      kind: 'session',
      id: `${WaylandSessions.PREFIX}${base}`,
      name: WaylandSessions.#title(entry.localized('Name') ?? base, desktopNames),
      description: entry.localized('Comment'),
      file,
      argv,
      desktopNames,
    }
  }

  static #title(name: string, desktopNames: readonly string[]): string {
    const short = name.replace(/\s*\(Wayland\)\s*$/i, '') || name
    const desktop = desktopNames[0]
    return desktop === 'KDE' && !/\bKDE\b/i.test(short) ? `KDE ${short}` : short
  }

  static environment(session: ForeignSession): [string, string][] {
    const base = basename(session.file).replace(/\.desktop$/, '')
    return [
      ['XDG_CURRENT_DESKTOP', session.desktopNames.length ? session.desktopNames.join(':') : base],
      ['XDG_SESSION_DESKTOP', session.desktopNames[0] ?? base],
      ['XDG_SESSION_TYPE', 'wayland'],
      ['DESKTOP_SESSION', base],
    ]
  }

  static #command(session: ForeignSession): string {
    const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`
    const vars = WaylandSessions.environment(session)
    return [session.argv.map(quote).join(' '), ...vars.map(([name, value]) => `${name}=${DesktopEntry.line(value)}`), ''].join('\n')
  }

  static handOff(session: ForeignSession): string {
    const file = join(runtimeDir(), 'acde', 'exec')
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.new`, WaylandSessions.#command(session), { mode: 0o600 })
    renameSync(`${file}.new`, file)
    return file
  }
}
