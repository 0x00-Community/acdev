import { mkdirSync, readTextOr, renameSync, writeFileSync } from './sys/fs'
import { xdgHome } from './sys/os'
import { dirname, join } from './sys/path'
import { process } from './sys/process'
import { Level, Log } from './log'

export interface StoragePlace {
  readonly key: string
  readonly dir: string | null
  readonly legacy: string | null
}

export class StoragePlaces {
  static root(): string | null {
    const set = process.env['ACDE_STORAGE']
    if (set !== undefined) return set || null
    return join(xdgHome('data'), 'acde', 'storage')
  }

  static app(id: string): StoragePlace {
    return StoragePlaces.#place(`app-${id}`, `app-${id}.json`)
  }

  static desktop(id: string): StoragePlace {
    return StoragePlaces.#place(`desktop-${id}`, `${id}.json`)
  }

  static memory(key: string): StoragePlace {
    return { key, dir: null, legacy: null }
  }

  static #place(key: string, legacy: string): StoragePlace {
    const root = StoragePlaces.root()
    const old = process.env['ACDE_STORAGE'] === undefined ? join(xdgHome('config'), 'acde', 'storage', legacy) : null
    return { key, dir: root === null ? null : join(root, key), legacy: old }
  }
}

export class StorageFile {
  static readonly WRITE_AFTER_MS = 1000
  readonly #path: string
  #pending: Record<string, string> | null = null
  #timer: number | null = null

  constructor(path: string) {
    this.#path = path
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
