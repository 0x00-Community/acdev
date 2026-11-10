import type { DownloadEvent, NotificationEvent } from '@dopame/acde-api'
import type { Native, NativeFileChooser } from '../../native'
import { Downloads } from '../../downloads'
import { Level, Log } from '../../log'
import { basename } from '../../sys/path'
import type { BrokerShell } from '../types'
import { Web } from '../web'

export interface PageHost {
  readonly native: Native
  readonly shell: BrokerShell
  desktop(): Web | null
  shown(): void
  desktopShown(): boolean
  notifications(): boolean
  devReload(app: string | null): Promise<void>
  toDesktop(event: Record<string, unknown>): void
}

export class PanelCalls {
  readonly #ids = new Set<number>()
  readonly #shell: BrokerShell

  constructor(shell: BrokerShell) {
    this.#shell = shell
  }

  has(id: number): boolean {
    return this.#ids.has(id)
  }

  call(web: Web, method: string, args: unknown[]): unknown {
    if (web.kind !== 'desktop') throw Web.refused(web, 'pinned panels')
    const rect = (value: unknown): [number, number, number, number] => {
      const v = Array.isArray(value) ? value.map((n) => Math.round(Number(n) || 0)) : []
      return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]
    }
    const id = Number(args[0])
    switch (method) {
      case 'open': {
        const grant = this.#shell.grant({ mode: 'pinned', rect: rect(args[0]) })
        this.#ids.add(grant.window)
        return grant
      }
      case 'place': {
        if (!this.#ids.has(id)) throw Web.refused(web, `window ${id}`)
        const [x, y, width, height] = rect(args[1])
        if (width <= 0 || height <= 0) return this.#shell.hide(id, true)
        this.#shell.place(id, x, y, width, height)
        return this.#shell.hide(id, false)
      }
      case 'close':
        if (this.#ids.delete(id)) this.#shell.release(id)
        return
    }
    throw new Error(`acde.panel has no ${method}`)
  }
}

export class PageCalls {
  readonly #host: PageHost
  #chooser: Promise<NativeFileChooser | null> | null = null
  #chooserWarned = false

  constructor(host: PageHost) {
    this.#host = host
  }

  async call(web: Web, method: string, args: unknown[]): Promise<unknown> {
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).slice(0, max)
    const filters = (value: unknown) =>
      (Array.isArray(value) ? value : []).slice(0, 32).map((f: { name?: unknown; globs?: unknown; mimes?: unknown }) => ({
        name: text(f?.name, 200),
        globs: (Array.isArray(f?.globs) ? f.globs : []).map((g: unknown) => text(g, 100)).filter(Boolean),
        mimes: (Array.isArray(f?.mimes) ? f.mimes : []).map((m: unknown) => text(m, 100)).filter(Boolean),
      })).filter((f) => f.globs.length || f.mimes.length)
    switch (method) {
      case 'shown':
        if (web === this.#host.desktop()) this.#host.shown()
        return
      case 'devreload':
        if (web !== this.#host.desktop() && !web.app) return
        return this.#host.devReload(web === this.#host.desktop() ? null : web.app!.id)
      case 'open':
      case 'save': {
        const options = (args[0] ?? {}) as Record<string, unknown>
        const chooser = await this.#fileChooser()
        if (!chooser) return null
        const label = web.app?.label ?? '桌面'
        if (method === 'open') {
          const multiple = options['multiple'] === true
          return chooser.openFile({ title: `${label}: 打开`, multiple, directory: options['directory'] === true, filters: filters(options['filters']) })
        }
        return chooser.saveFile({ title: `${label}: 保存`, name: text(options['name'], 255), filters: filters(options['filters']) })
      }
      case 'download': {
        const [name, type, bytes] = args as [unknown, unknown, unknown]
        if (!(bytes instanceof Uint8Array)) throw new TypeError('acde: a download is bytes')
        const path = Downloads.save(text(name, 1000), text(type, 200), bytes)
        Log.write(Level.Info, 'acde_host', `[${web.name}] saved ${path} (${bytes.length} bytes)`)
        const saved = { type: 'download', window: web.window, app: web.app?.id ?? null, path, name: basename(path), size: bytes.length } satisfies DownloadEvent
        this.#host.toDesktop(saved)
        return path
      }
      case 'notify': {
        const n = (args[0] ?? {}) as Record<string, unknown>
        const icon = text(n['icon'], 256 * 1024)
        const notice = {
          type: 'notification',
          window: web.window,
          app: web.app?.id ?? null,
          label: web.app?.label ?? null,
          title: text(n['title'], 200),
          body: text(n['body'], 2000),
          icon: /^(data:image\/|http:\/\/acde\.local\/)/.test(icon) ? icon : '',
          tag: text(n['tag'], 200),
        } satisfies NotificationEvent
        if (!this.#host.notifications()) throw Object.assign(new Error('notifications are unsupported here'), { status: 501, code: 'unsupported' })
        if (this.#host.desktopShown() || !this.#host.shell.notify) this.#host.toDesktop(notice)
        else this.#host.shell.notify(notice.title, notice.body, notice.label ?? '')
        return true
      }
    }
    throw new Error(`acde: no page call ${method}`)
  }

  #fileChooser(): Promise<NativeFileChooser | null> {
    this.#chooser ??= (async () => {
      const FileChooser = this.#host.native.FileChooser
      if (!FileChooser) {
        if (!this.#chooserWarned) Log.write(Level.Warn, 'acde_host', 'no file chooser on this platform: open and save pickers are cancelled')
        this.#chooserWarned = true
        this.#chooser = null
        return null
      }
      try {
        return await FileChooser.open()
      } catch (error) {
        if (!this.#chooserWarned) Log.write(Level.Warn, 'acde_host', `no file chooser: ${(error as Error).message}`)
        this.#chooserWarned = true
        this.#chooser = null
        return null
      }
    })()
    return this.#chooser
  }
}
