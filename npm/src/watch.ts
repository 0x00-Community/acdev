import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface Watching {
  close(): void
}

export type Changed = (file: string) => void

export class Settled {
  readonly #since: number
  readonly #seen = new Map<string, string>()

  constructor(since = Date.now()) {
    this.#since = since
  }

  changed(path: string): boolean {
    let mark = 'gone'
    let old = false
    try {
      const stat = statSync(path)
      mark = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      old = stat.mtimeMs < this.#since && stat.ctimeMs < this.#since
    } catch {}
    const before = this.#seen.get(path)
    this.#seen.set(path, mark)
    return before === undefined ? !old : before !== mark
  }
}

export class TreeWatch implements Watching {
  readonly #root: string
  readonly #skip: (dir: string) => boolean
  readonly #changed: Changed
  readonly #dirs = new Map<string, { readonly watcher: FSWatcher; readonly ino: number }>()
  #closed = false

  private constructor(root: string, skip: (dir: string) => boolean, changed: Changed) {
    this.#root = root
    this.#skip = skip
    this.#changed = changed
  }

  static start(root: string, skip: (dir: string) => boolean, changed: Changed, platform = process.platform): Watching {
    if (platform !== 'linux') {
      const settled = new Settled()
      const watcher = watch(root, { recursive: true }, (_, file) => {
        if (file !== null && settled.changed(join(root, String(file)))) changed(String(file))
      })
      return { close: () => watcher.close() }
    }
    const tree = new TreeWatch(root, skip, changed)
    tree.#add(root, false)
    return tree
  }

  get watched(): readonly string[] {
    return [...this.#dirs.keys()]
  }

  close(): void {
    this.#closed = true
    for (const { watcher } of this.#dirs.values()) watcher.close()
    this.#dirs.clear()
  }

  #add(dir: string, report: boolean): void {
    if (this.#closed || this.#dirs.has(dir) || (dir !== this.#root && this.#skip(dir))) return
    let watcher: FSWatcher
    let ino: number
    try {
      ino = statSync(dir).ino
      watcher = watch(dir, (_, name) => {
        if (name !== null) this.#event(join(dir, String(name)))
      })
    } catch {
      return
    }
    watcher.on('error', () => this.#drop(dir))
    this.#dirs.set(dir, { watcher, ino })
    let entries: { name: string; isDirectory(): boolean }[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) this.#add(path, report)
      else if (report) this.#changed(relative(this.#root, path))
    }
  }

  #drop(dir: string): void {
    for (const [path, { watcher }] of this.#dirs) {
      if (path !== dir && !path.startsWith(dir + sep)) continue
      watcher.close()
      this.#dirs.delete(path)
    }
  }

  #event(path: string): void {
    if (this.#closed) return
    let ino: number | null = null
    try {
      const stat = statSync(path)
      if (stat.isDirectory()) ino = stat.ino
    } catch {
      this.#drop(path)
    }
    if (ino !== null && this.#dirs.get(path)?.ino !== ino) {
      this.#drop(path)
      this.#add(path, true)
    }
    this.#changed(relative(this.#root, path))
  }
}
