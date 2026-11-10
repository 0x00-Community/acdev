import type { WindowMenusEvent, WindowsEvent, WindowState, WindowTitleEvent } from '@dopame/acde-api'
import { Level, Log } from '../../log'
import { PageSource } from '../../page'
import { WindowRecords } from '../records'
import type { AnimateOptions, BrokerShell, WindowRecord, WireMenu } from '../types'
import { Web } from '../web'

export interface WindowsHost {
  readonly shell: BrokerShell
  record(id: number): WindowRecord | undefined
  claim(web: Web, pid: number): void
  closeWeb(id: number, force?: boolean): Promise<boolean>
  hide(id: number, hidden: boolean): void
  toDesktop(event: Record<string, unknown>): void
  usable(appId: string): boolean
  launch(appId: string, request: Record<string, unknown>): void
  allow(web: Web, capability: 'launch' | 'slots'): void
}

export class WindowCalls {
  static readonly BROWSER = 'browser'
  static readonly STATES = WindowRecords.STATES
  readonly #host: WindowsHost

  constructor(host: WindowsHost) {
    this.#host = host
  }

  async windows(web: Web, method: string, args: unknown[]): Promise<unknown> {
    const desktop = web.shell('windows')
    const caps = web.app?.capabilities ?? {}
    const id = Number(args[0])
    const mine = (window: number) => desktop || web.owns.has(window)
    switch (method) {
      case 'launch': {
        const [argv, options] = args as [string[], { cwd?: string; env?: Record<string, string>; slot?: boolean } | undefined]
        const slot = !!options?.slot && web.kind !== 'desktop'
        if (web.kind !== 'desktop' && !(slot ? caps.slots : caps.launch)) throw Web.refused(web, slot ? 'native programs in its slots' : 'starting programs')
        this.#host.allow(web, slot ? 'slots' : 'launch')
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
      case 'requestState':
        if (!desktop) throw Web.refused(web, `the state of window ${id}`)
        return this.#state(id, args[1])
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

  async launch(web: Web, method: string, args: unknown[]): Promise<unknown> {
    const desktop = web.kind === 'desktop'
    const caps = web.app?.capabilities ?? {}
    if (method === 'start' || method === 'embed') {
      const [argv, options] = args as [unknown, { cwd?: string; env?: Record<string, string> } | undefined]
      const embed = method === 'embed'
      if (!desktop && !(embed ? caps.slots : caps.launch)) throw Web.refused(web, embed ? 'embedding programs (slots)' : 'starting programs (launch)')
      if (!Array.isArray(argv) || argv.length === 0) throw new TypeError(`acde.launch.${method}: argv is a non-empty array`)
      this.#host.allow(web, embed ? 'slots' : 'launch')
      const pid = this.#host.shell.launch(argv.map(String), { cwd: options?.cwd, env: options?.env })
      if (embed) this.#host.claim(web, pid)
      else web.startedPids.add(pid)
      return pid
    }
    if (method === 'close') {
      const id = Number(args[0])
      if (!web.started.has(id) && !web.owns.has(id)) {
        throw Object.assign(new Error(`acde.launch.close: window ${id} was not started by ${web.app?.label ?? web.kind}`), { status: 403, code: 'forbidden' })
      }
      this.#host.shell.close(id)
      return true
    }
    throw new Error(`acde.launch has no ${method}`)
  }

  #state(id: number, state: unknown): void {
    if (!WindowCalls.STATES.includes(state as never)) {
      throw Object.assign(new TypeError(`no window state ${String(state)} (${WindowCalls.STATES.join(', ')})`), { status: 400 })
    }
    if (!this.#host.shell.setState) throw Object.assign(new Error('window states are not carried out here yet'), { status: 501 })
    if (state === 'minimized' && this.#host.shell.windows().find((row) => row.id === id)?.minimize === false) {
      const reason = 'a standalone app has no Dock to bring it back'
      throw Object.assign(new Error(`window ${id} cannot be minimized: ${reason}`), { status: 409, code: 'unavailable' })
    }
    this.#host.shell.setState(id, state as WindowState)
  }

  self(web: Web, method: string, args: unknown[]): unknown {
    const record = this.#host.record(web.window)
    if (web.kind !== 'window' || !record) throw new Error('acde.window: only a window web has a window')
    switch (method) {
      case 'setTitle':
        record.title = String(args[0])
        return this.#host.toDesktop({ type: 'windowtitle', window: record.id, appId: record.app!.id, title: record.title } satisfies WindowTitleEvent)
      case 'setMenus':
        record.menus = (args[0] as WireMenu[]) ?? []
        return this.#host.toDesktop({ type: 'windowmenus', window: record.id, menus: record.menus } satisfies WindowMenusEvent)
      case 'close':
        return this.#host.closeWeb(record.id, true)
      case 'minimize':
        if (this.#host.shell.setState) return this.#state(record.id, 'minimized')
        return web.rpc.call('window', 'minimize', [])
      case 'requestAttention':
        return this.#host.toDesktop({ type: 'windowattention', window: record.id } satisfies WindowsEvent)
      case 'shortcut':
        return this.#host.shell.shortcut(String(args[0]), 'app', record.id)
      case 'unshortcut':
        return this.#host.shell.unshortcut(String(args[0]), 'app', record.id)
      case 'ready':
        return this.#host.toDesktop({ type: 'windowready', window: record.id } satisfies WindowsEvent)
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
