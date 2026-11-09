import type { NativeApps } from '../launcher'
import type { Opener, OpenOptions } from '../open'
import type { BrokerShell } from './types'
import { Web } from './web'

interface ListedApp {
  readonly id: string
  readonly label: string
}

export interface AppsHost {
  readonly shell: BrokerShell
  readonly natives: NativeApps
  readonly opener: Opener
  list(): ListedApp[]
  refresh(): unknown
  install(dir: string): unknown
  launch(appId: string, request: Record<string, unknown> | null): { window: number }
  raise(opened: { window: number }): unknown
}

export class AppCalls {
  readonly #host: AppsHost

  constructor(host: AppsHost) {
    this.#host = host
  }

  call(web: Web, method: string, args: unknown[]): unknown {
    const desktop = web.kind === 'desktop'
    const caps = web.app?.capabilities ?? null
    if (method === 'list') return this.#host.list()
    if (method === 'refresh' || method === 'install') {
      if (!desktop) throw Web.refused(web, `acde.apps.${method}`)
      return method === 'refresh' ? this.#host.refresh() : this.#host.install(String(args[0]))
    }
    if (method === 'natives' || method === 'runNative') {
      if (!desktop) throw Web.refused(web, `acde.apps.${method}`)
      if (method === 'natives') return this.#host.natives.list()
      const file = this.#host.natives.file(String(args[0]))
      if (!file) throw Object.assign(new Error(`no native app ${String(args[0])}`), { status: 404 })
      return this.#host.shell.launch(['gio', 'launch', file])
    }
    if (method === 'openPath' || method === 'handlers' || method === 'setDefault') {
      if (!desktop && !caps?.['openFiles']) throw Web.refused(web, 'opening files with their apps')
      if (method === 'openPath') return this.#host.opener.open(String(args[0]), (args[1] ?? {}) as OpenOptions, desktop ? null : Web.caller(web.app!))
      if (method === 'handlers') return this.#host.opener.handlers(String(args[0]))
      return this.#host.opener.setDefault(String(args[0]), String(args[1]))
    }
    if (method === 'launch' || method === 'open') {
      const [appId, request] = args as [string, Record<string, unknown> | undefined]
      const open = caps?.open
      if (!desktop && !(open === true || (Array.isArray(open) && open.includes(appId)))) throw Web.refused(web, `open ${appId}`)
      return this.#host.launch(appId, request ?? null)
    }
    throw new Error(`acde.apps has no ${method}`)
  }

  async openByName(name: string): Promise<string> {
    const wanted = name.trim().toLowerCase()
    const apps = this.#host.list()
    const app =
      apps.find((a) => a.id.toLowerCase() === wanted) ??
      apps.find((a) => a.label.toLowerCase() === wanted) ??
      apps.find((a) => a.label.toLowerCase().includes(wanted))
    if (app) {
      this.#host.raise(this.#host.launch(app.id, null))
      return `打开了应用 ${app.label} (${app.id})`
    }
    const natives = this.#host.natives.list()
    const native =
      natives.find((n) => n.id.toLowerCase() === wanted || n.id.toLowerCase() === `${wanted}.desktop`) ??
      natives.find((n) => n.name.toLowerCase() === wanted) ??
      natives.find((n) => n.name.toLowerCase().includes(wanted))
    const file = native && this.#host.natives.file(native.id)
    if (!native || !file) {
      throw Object.assign(new Error(`没有叫 ${name} 的应用 (acde 应用: ${apps.map((a) => a.label).join(', ')})`), { status: 404 })
    }
    this.#host.shell.launch(['gio', 'launch', file])
    return `起了原生程序 ${native.name} (${native.id})`
  }
}
