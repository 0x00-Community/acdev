import { Level, Log } from '../log'
import { PageSource } from '../page'
import type { AnimateOptions, BrokerShell, WindowRecord, WireMenu } from './types'
import { Web } from './web'

export interface WindowsHost {
  readonly shell: BrokerShell
  record(id: number): WindowRecord | undefined
  claim(web: Web, pid: number): void
  closeWeb(id: number, force?: boolean): Promise<boolean>
  hide(id: number, hidden: boolean): void
  toDesktop(event: Record<string, unknown>): void
  usable(appId: string): boolean
  launch(appId: string, request: Record<string, unknown>): void
}

export class WindowCalls {
  static readonly BROWSER = 'browser'
  readonly #host: WindowsHost

  constructor(host: WindowsHost) {
    this.#host = host
  }

  async windows(web: Web, method: string, args: unknown[]): Promise<unknown> {
    const desktop = web.kind === 'desktop'
    const caps = web.app?.capabilities ?? {}
    const id = Number(args[0])
    const mine = (window: number) => desktop || web.owns.has(window)
    switch (method) {
      case 'launch': {
        const [argv, options] = args as [string[], { cwd?: string; env?: Record<string, string>; slot?: boolean } | undefined]
        const slot = !!options?.slot && !desktop
        if (!desktop && !(slot ? caps.slots : caps.launch)) throw Web.refused(web, slot ? 'native programs in its slots' : 'starting programs')
        const pid = this.#host.shell.launch(argv, { cwd: options?.cwd, env: options?.env })
        if (slot) this.#host.claim(web, pid)
        return pid
      }
      case 'close': {
        if (!mine(id)) throw Web.refused(web, `window ${id}`)
        if (this.#host.record(id)?.kind === 'web') return this.#host.closeWeb(id)
        this.#host.shell.close(id)
        return true
      }
      case 'kill':
        if (!desktop) throw Web.refused(web, `window ${id}`)
        return this.#host.closeWeb(id, true)
      case 'invokeMenu': {
        if (!desktop) throw Web.refused(web, `the menus of window ${id}`)
        const record = this.#host.record(id)
        return record?.web?.rpc.call('window', 'menu', [args[1], args[2]])
      }
      case 'focus':
      case 'hide':
      case 'show':
        if (!desktop) throw Web.refused(web, `window ${id}`)
        if (method === 'focus') return this.#host.shell.focus(id)
        return this.#host.hide(id, method === 'hide')
      case 'stats':
        if (!desktop) throw Web.refused(web, 'compositor stats')
        return this.#host.shell.stats()
      case 'screenshot':
        if (!desktop) throw Web.refused(web, 'screenshots')
        return this.#host.shell.screenshot(String(args[0]))
      case 'animate':
        if (!desktop) throw Web.refused(web, `animating window ${id}`)
        return this.#host.shell.animate(id, (args[1] ?? {}) as AnimateOptions)
      case 'shortcut':
      case 'unshortcut': {
        const [combo, scope] = [String(args[0]), String(args[1] ?? 'desktop')]
        if (!desktop || (scope !== 'session' && scope !== 'desktop')) throw Web.refused(web, `${scope} shortcuts`)
        return method === 'shortcut' ? this.#host.shell.shortcut(combo, scope, 0) : this.#host.shell.unshortcut(combo, scope, 0)
      }
    }
    throw new Error(`acde.windows has no ${method}`)
  }

  self(web: Web, method: string, args: unknown[]): unknown {
    const record = this.#host.record(web.window)
    if (web.kind !== 'window' || !record) throw new Error('acde.window: only a window web has a window')
    switch (method) {
      case 'setTitle':
        record.title = String(args[0])
        return this.#host.toDesktop({ type: 'windowtitle', window: record.id, appId: record.app!.id, title: record.title })
      case 'setMenus':
        record.menus = (args[0] as WireMenu[]) ?? []
        return this.#host.toDesktop({ type: 'windowmenus', window: record.id, menus: record.menus })
      case 'close':
        return this.#host.closeWeb(record.id, true)
      case 'minimize':
        return this.#host.toDesktop({ type: 'windowminimize', window: record.id })
      case 'requestAttention':
        return this.#host.toDesktop({ type: 'windowattention', window: record.id })
      case 'shortcut':
        return this.#host.shell.shortcut(String(args[0]), 'app', record.id)
      case 'unshortcut':
        return this.#host.shell.unshortcut(String(args[0]), 'app', record.id)
      case 'ready':
        return this.#host.toDesktop({ type: 'windowready', window: record.id })
      case 'reload': {
        if (record.web !== web || web.closing) return false
        const url = args[0] === undefined || args[0] === null ? null : String(args[0])
        if (url !== null && !url.startsWith(`${PageSource.ORIGIN}/`)) return false
        if (url !== null) record.url = url
        web.reloading = true
        void web.terminate().catch(() => 0)
        return true
      }
      case 'openUrl': {
        const url = String(args[0])
        if (!/^https?:\/\//i.test(url)) return false
        if (!this.#host.usable(WindowCalls.BROWSER)) {
          Log.write(Level.Warn, 'acde_host', `[${web.name}] opens ${url}: no ${WindowCalls.BROWSER} app that works here`)
          return false
        }
        this.#host.launch(WindowCalls.BROWSER, { url })
        return true
      }
    }
    throw new Error(`acde.window has no ${method}`)
  }
}
