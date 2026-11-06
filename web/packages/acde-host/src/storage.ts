import { mkdirSync, readTextOr, renameSync, writeFileSync } from './sys/fs'
import { xdgHome } from './sys/os'
import { dirname, join } from './sys/path'
import { process } from './sys/process'
import { Level, Log } from './log'

export class StorageFile {
  static readonly WRITE_AFTER_MS = 1000
  readonly #path: string
  #pending: Record<string, string> | null = null
  #timer: number | null = null

  constructor(path: string) {
    this.#path = path
  }

  static forApp(id: string): string | null {
    if (process.env['ACDE_STORAGE'] === '') return null
    return join(xdgHome('config'), 'acde', 'storage', `app-${id}.json`)
  }

  read(): Record<string, string> | null {
    const text = readTextOr(this.#path, null)
    if (text === null) return null
    try {
      const saved = JSON.parse(text) as Record<string, unknown>
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    } catch (error) {
      const aside = `${this.#path}.bad-${Date.now()}`
      try {
        renameSync(this.#path, aside)
      } catch {
      }
      Log.write(Level.Warn, 'acde_host', `page storage ${this.#path} unreadable (${(error as Error).message}); kept as ${aside}, starting empty`)
      return null
    }
  }

  changed(entries: Record<string, string>): void {
    this.#pending = entries
    this.#timer ??= setTimeout(() => this.flush(), StorageFile.WRITE_AFTER_MS) as unknown as number
  }

  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    const entries = this.#pending
    this.#pending = null
    if (!entries) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.tmp`
      writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 })
      renameSync(temp, this.#path)
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `page storage ${this.#path} not written: ${(error as Error).message}`)
    }
  }
}
