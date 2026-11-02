import { readdirSync, readFileSync, stat } from './sys/fs'
import { isAbsolute, join } from './sys/path'
import { process, type Env } from './sys/process'

export class DesktopEntry {
  static readonly #DROPPED = new Set(['f', 'F', 'u', 'U', 'd', 'D', 'n', 'N', 'v', 'm'])

  readonly file: string
  readonly #keys: Map<string, string>

  constructor(file: string, text: string) {
    this.file = file
    this.#keys = DesktopEntry.group(text, 'Desktop Entry')
  }

  static group(text: string, name: string): Map<string, string> {
    const keys = new Map<string, string>()
    let inGroup = false
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('[')) {
        inGroup = line === `[${name}]`
        continue
      }
      const at = line.indexOf('=')
      if (!inGroup || at <= 0) continue
      const key = line.slice(0, at).trim()
      if (!keys.has(key)) keys.set(key, line.slice(at + 1).trim())
    }
    return keys
  }

  static line(value: string): string {
    return value.replace(/[\r\n]+/g, ' ')
  }

  static read(file: string): DesktopEntry | null {
    try {
      return new DesktopEntry(file, readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  static files(dirs: readonly string[]): { name: string; file: string }[] {
    const seen = new Set<string>()
    const out: { name: string; file: string }[] = []
    for (const dir of dirs) {
      let names: string[]
      try {
        names = readdirSync(dir).filter((name) => name.endsWith('.desktop')).sort()
      } catch {
        continue
      }
      for (const name of names) {
        if (seen.has(name)) continue
        seen.add(name)
        out.push({ name, file: join(dir, name) })
      }
    }
    return out
  }

  get application(): boolean {
    return (this.#keys.get('Type') ?? 'Application') === 'Application'
  }

  string(key: string): string | null {
    const value = this.#keys.get(key)
    return value ? DesktopEntry.unescape(value) : null
  }

  flag(key: string): boolean {
    return this.#keys.get(key) === 'true'
  }

  list(key: string): string[] {
    return (this.#keys.get(key) ?? '').split(/(?<!\\);/).map((item) => DesktopEntry.unescape(item.trim())).filter(Boolean)
  }

  localized(key: string, env: Env = process.env): string | null {
    for (const locale of DesktopEntry.locales(env)) {
      const value = this.string(`${key}[${locale}]`)
      if (value) return value
    }
    return this.string(key)
  }

  exec(): string[] | null {
    const line = this.string('Exec')
    if (!line) return null
    const argv: string[] = []
    let current = '', open = false, quoted = false
    const push = () => {
      if (open) argv.push(current)
      current = ''
      open = false
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quoted) {
        if (c === '\\' && i + 1 < line.length && '"`$\\'.includes(line[i + 1]!)) current += line[++i]
        else if (c === '"') quoted = false
        else current += c
      } else if (c === '"') {
        quoted = open = true
      } else if (c === ' ' || c === '\t') {
        push()
      } else if (c === '%' && i + 1 < line.length) {
        const code = line[++i]!
        if (code === 'i') {
          const icon = this.string('Icon')
          if (icon && !open) argv.push('--icon', icon)
        } else if (code === '%' || code === 'c' || code === 'k') {
          current += code === '%' ? '%' : code === 'c' ? (this.string('Name') ?? '') : this.file
          open = true
        } else if (!DesktopEntry.#DROPPED.has(code)) {
          current += '%'
          open = true
          i--
        }
      } else {
        current += c
        open = true
      }
    }
    if (quoted) return null
    push()
    return argv.length ? argv : null
  }

  static unescape(value: string): string {
    return value.replace(/\\([sntr\\;])/g, (_, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r' })[c] ?? c)
  }

  static executable(program: string, env: Env = process.env): boolean {
    const runs = (path: string) => {
      const found = stat(path)
      return !!found?.isFile && (found.mode & 0o111) !== 0
    }
    if (program.includes('/')) return isAbsolute(program) && runs(program)
    return (env['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/bin').split(':').filter(Boolean).some((dir) => runs(join(dir, program)))
  }

  static locales(env: Env = process.env): string[] {
    const locale = (env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || '').replace(/[.@].*$/, '')
    if (!locale || locale === 'C' || locale === 'POSIX') return []
    const lang = locale.split('_')[0]!
    return lang === locale ? [lang] : [locale, lang]
  }
}
