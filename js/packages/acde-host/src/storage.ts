import { mkdirSync, readFileSync, renameSync, writeFileSync } from './sys/fs'
import { xdgHome } from './sys/os'
import { dirname, join } from './sys/path'
import { process } from './sys/process'
import { Level, Log } from './log'

/** Where a storage file's text lives: a path through the Broker's `sys`, or a desktop / window isolate's own `storage`. */
export interface StorageStore {
  readonly name: string
  read(): string | null
  write(text: string): void
  aside(): string
}

export class StorageFile {
  static readonly WRITE_AFTER_MS = 1000
  readonly #store: StorageStore
  #pending: Record<string, string> | null = null
  #timer: number | null = null

  constructor(store: StorageStore) {
    this.#store = store
  }

  /** A file the Broker reads and writes itself. */
  static at(path: string): StorageFile {
    return new StorageFile({
      name: path,
      read: () => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      },
      write: (text) => {
        mkdirSync(dirname(path), { recursive: true })
        const temp = `${path}.tmp`
        writeFileSync(temp, text, { mode: 0o600 })
        renameSync(temp, path)
      },
      aside: () => {
        const aside = `${path}.bad-${Date.now()}`
        try {
          renameSync(path, aside)
        } catch {
        }
        return aside
      },
    })
  }

  static forApp(id: string): string | null {
    if (process.env['ACDE_STORAGE'] === '') return null
    return join(xdgHome('config'), 'acde', 'storage', `app-${id}.json`)
  }

  read(): Record<string, string> | null {
    const text = this.#store.read()
    if (text === null) return null
    try {
      const saved = JSON.parse(text) as Record<string, unknown>
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    } catch (error) {
      const aside = this.#store.aside()
      Log.write(Level.Warn, 'acde_host', `page storage ${this.#store.name} unreadable (${(error as Error).message}); kept as ${aside}, starting empty`)
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
      this.#store.write(JSON.stringify(entries))
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `page storage ${this.#store.name} not written: ${(error as Error).message}`)
    }
  }
}
