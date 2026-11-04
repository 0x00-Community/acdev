import type { WebInternals } from '@dopame/acde-dom'
import type { IsolateDesk } from './desk'
import type { OwnFiles } from './native'
import { basename } from './sys/path'
import { Level, Log } from './log'

type Env = WebInternals['env']
type Chooser = NonNullable<Env['files']>
type Picked = { readonly name: string; readonly path: string }

export class PageCalls {
  readonly #desk: IsolateDesk
  readonly #name: string
  readonly #page: WebInternals
  #warned = false

  readonly #files: OwnFiles

  readonly #label: string

  constructor(page: WebInternals, desk: IsolateDesk, name: string, label: string, files: OwnFiles) {
    this.#label = label
    this.#files = files
    this.#page = page
    this.#desk = desk
    this.#name = name
    page.env.files = this.#chooser()
    page.env.download = (request) => void this.#download(request).catch((error: Error) => this.#log(`download of ${request.url.slice(0, 120)}: ${error.message}`))
    page.env.notify = (notification) => void this.#notify(notification).catch((error: Error) => this.#log(`notification: ${error.message}`))
  }

  #chooser(): Chooser {
    const picked = (path: string): Picked => ({ name: basename(path), path })
    return {
      open: async (options) => {
        const paths = await this.#ask('open', options)
        return paths.length ? paths.map(picked) : null
      },
      save: async (options) => {
        const [path] = await this.#ask('save', options)
        return path ? picked(path) : null
      },
      read: async (file) => {
        const read = this.#files.read(file.path)
        if (!read) throw new Error(`${file.name}: not readable any more`)
        return read
      },
      write: async (file, bytes) => {
        this.#files.write(file.path, bytes)
      },
    }
  }

  async #ask(method: 'open' | 'save', options: unknown): Promise<string[]> {
    const o = (options ?? {}) as Record<string, unknown>
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).slice(0, max)
    const filters = (Array.isArray(o['filters']) ? o['filters'] : []).slice(0, 32).map((f: { name?: unknown; globs?: unknown; mimes?: unknown }) => ({
      name: text(f?.name, 200),
      globs: (Array.isArray(f?.globs) ? f.globs : []).map((g: unknown) => text(g, 100)).filter(Boolean),
      mimes: (Array.isArray(f?.mimes) ? f.mimes : []).map((m: unknown) => text(m, 100)).filter(Boolean),
    })).filter((f) => f.globs.length || f.mimes.length)
    const asked = method === 'open'
      ? { title: `${this.#label}: 打开`, multiple: o['multiple'] === true, directory: o['directory'] === true, filters }
      : { title: `${this.#label}: 保存`, name: text(o['name'], 255), filters }
    try {
      return await this.#files[method](asked)
    } catch (error) {
      if (!this.#warned) this.#log(`file chooser: ${(error as Error).message}`)
      this.#warned = true
      return []
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
    await this.#desk.download(name, type, bytes)
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
    this.#desk.notify({ ...notification, icon })
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
