import type { WebInternals } from '@dopame/acde-dom'
import type { Rpc } from './rpc'
import { existsSync, readFileSync, stat, writeFileSync } from './sys/fs'
import { basename } from './sys/path'
import { Level, Log } from './log'

type Env = WebInternals['env']
type Chooser = NonNullable<Env['files']>
type Picked = { readonly name: string; readonly path: string }
type Kind = 'file' | 'directory'

export interface FolderPicker {
  directory(title: string, writable: boolean): Promise<string | null>
  entries(dir: string): Promise<{ name: string; kind: Kind }[]>
  entry(dir: string, name: string, create: Kind | null): Promise<Kind | 'other' | null>
  remove(dir: string, name: string, recursive: boolean): Promise<boolean>
  read(path: string): Promise<{ bytes: Uint8Array; lastModified: number } | null>
  write(path: string, bytes: Uint8Array): Promise<void>
}

interface FolderSetup {
  readonly picker: FolderPicker | null
  readonly label: string
}

export class PageCalls {
  readonly #rpc: Rpc
  readonly #name: string
  readonly #page: WebInternals
  readonly #granted = new Set<string>()
  readonly #folders = new Set<string>()
  readonly #setup: FolderSetup
  #warned = false

  constructor(page: WebInternals, rpc: Rpc, name: string, setup: FolderSetup) {
    this.#page = page
    this.#rpc = rpc
    this.#name = name
    this.#setup = setup
    page.env.files = this.#chooser()
    page.env.download = (request) => void this.#download(request).catch((error: Error) => this.#log(`download of ${request.url.slice(0, 120)}: ${error.message}`))
    page.env.notify = (notification) => void this.#notify(notification).catch((error: Error) => this.#log(`notification: ${error.message}`))
  }

  #chooser(): Chooser {
    const grant = (path: string): Picked => {
      this.#granted.add(path)
      return { name: basename(path), path }
    }
    const check = (file: Picked): string => {
      if (!this.#granted.has(file.path)) throw new Error('not a file the user picked')
      return file.path
    }
    const picker = this.#setup.picker
    const inFolder = (path: string): FolderPicker | null => {
      if (!picker) return null
      for (const folder of this.#folders) if (path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)) return picker
      return null
    }
    const folder = (dir: Picked): FolderPicker => {
      const found = inFolder(dir.path)
      if (!found) throw new Error('not in a folder the user picked')
      return found
    }
    const child = (dir: Picked, name: string): string => (dir.path === '/' ? `/${name}` : `${dir.path}/${name}`)
    return {
      open: async (options) => {
        const paths = await this.#ask('open', options)
        return Array.isArray(paths) && paths.length ? paths.map((path) => grant(String(path))) : null
      },
      save: async (options) => {
        const path = await this.#ask('save', options)
        return typeof path === 'string' && path ? grant(path) : null
      },
      directory: async ({ mode }) => {
        if (!picker) return null
        try {
          const writable = mode === 'readwrite'
          const prompt = writable ? '选择要授权读写的文件夹' : '选择要读取的文件夹'
          const path = await picker.directory(`${this.#setup.label}: ${prompt}`, writable)
          if (!path) return null
          this.#folders.add(path)
          return { name: basename(path) || path, path }
        } catch (error) {
          if (!this.#warned) this.#log(`folder chooser: ${(error as Error).message}`)
          this.#warned = true
          return null
        }
      },
      entries: async (dir) => (await folder(dir).entries(dir.path)).map(({ name, kind }) => ({ name, kind, path: child(dir, name) })),
      entry: async (dir, name, create) => {
        const kind = await folder(dir).entry(dir.path, name, create)
        return kind ? { name, kind, path: child(dir, name) } : null
      },
      remove: (dir, name, recursive) => folder(dir).remove(dir.path, name, recursive),
      read: async (file) => {
        const from = inFolder(file.path)
        if (from) return from.read(file.path)
        const path = check(file)
        if (!existsSync(path)) return null
        const bytes = readFileSync(path)
        return { bytes, lastModified: stat(path)?.mtimeMs ?? Date.now() }
      },
      write: async (file, bytes) => {
        const to = inFolder(file.path)
        if (to) return to.write(file.path, bytes)
        writeFileSync(check(file), bytes)
      },
    }
  }

  async #ask(method: 'open' | 'save', options: unknown): Promise<unknown> {
    try {
      return await this.#rpc.call('page', method, [options])
    } catch (error) {
      if (!this.#warned) this.#log(`file chooser: ${(error as Error).message}`)
      this.#warned = true
      return null
    }
  }

  async #download(request: Parameters<NonNullable<Env['download']>>[0]): Promise<void> {
    let bytes: Uint8Array
    let type: string
    let name = request.name
    if (request.blob) {
      bytes = new Uint8Array(await request.blob.arrayBuffer())
      type = request.blob.type
    } else {
      const fetch = (this.#page.window as unknown as { fetch: typeof globalThis.fetch }).fetch
      const response = await fetch(request.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      bytes = new Uint8Array(await response.arrayBuffer())
      type = response.headers.get('content-type') ?? ''
      name ||= PageCalls.dispositionName(response.headers.get('content-disposition'))
    }
    name ||= PageCalls.urlName(request.url)
    await this.#rpc.call('page', 'download', [name, type, bytes])
  }

  async #notify(notification: { title: string; body: string; icon: string; tag: string }): Promise<void> {
    let icon = notification.icon
    if (icon.startsWith('http://acde.local/')) {
      icon = ''
      try {
        const fetch = (this.#page.window as unknown as { fetch: typeof globalThis.fetch }).fetch
        const response = await fetch(notification.icon)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (response.ok && bytes.length <= PageCalls.ICON_BYTES) {
          let binary = ''
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          icon = `data:${response.headers.get('content-type') || 'image/png'};base64,${btoa(binary)}`
        }
      } catch {
      }
    }
    await this.#rpc.call('page', 'notify', [{ ...notification, icon }])
  }

  static readonly ICON_BYTES = 128 * 1024

  static dispositionName(header: string | null): string {
    if (!header) return ''
    const star = /filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]+)/.exec(header)
    if (star) {
      try {
        return decodeURIComponent(star[1]!.trim())
      } catch {
      }
    }
    return /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header)?.slice(1).find((v) => v !== undefined)?.trim() ?? ''
  }

  static urlName(url: string): string {
    if (!/^https?:/i.test(url)) return ''
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    } catch {
      return ''
    }
  }

  #log(text: string): void {
    Log.write(Level.Warn, 'acde_host', `[${this.#name}] ${text}`)
  }
}
