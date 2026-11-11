import type { NativeApps } from '../../launcher'
import { Opener, type OpenOptions } from '../../open'
import { Family, type FamilyWindow, type WindowFamily } from '../access/family'
import type { BrokerShell } from '../types'
import { Web } from '../web'

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
  launch(appId: string, request: Record<string, unknown> | null, family?: WindowFamily | null): Promise<{ window: number }>
  record(id: number): FamilyWindow | undefined
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
    if (method === 'openPath' || method === 'handlers' || method === 'setDefault') {
      const allowed = method === 'setDefault' ? web.shell('setDefault') : desktop || !!caps?.['openFiles']
      if (!allowed) throw Web.refused(web, method === 'setDefault' ? 'acde:setDefault' : 'opening files with their apps')
      if (method === 'openPath') return this.#host.opener.open(String(args[0]), (args[1] ?? {}) as OpenOptions, desktop ? null : this.#caller(web))
      if (method === 'handlers') return this.#host.opener.handlers(String(args[0]))
      return this.#host.opener.setDefault(String(args[0]), String(args[1]))
    }
    if (method === 'open' && Opener.isSystem(typeof args[0] === 'string' ? args[1] : args[0])) {
      const [target, request] = typeof args[0] === 'string' ? [args[0], args[1]] : [null, args[0]]
      const open = caps?.open
      const allowed = target === null ? desktop || !!caps?.['openFiles'] : desktop || open === true || (Array.isArray(open) && open.includes(target))
      if (!allowed) throw Web.refused(web, target === null ? 'opening files and links by type' : `open ${target}`)
      return this.#host.opener.request(request as Parameters<Opener['request']>[0], target, desktop ? null : this.#caller(web))
    }
    if (method === 'open') {
      const [appId, request, options] = args as [string, Record<string, unknown> | undefined, unknown]
      const open = caps?.open
      if (!desktop && !(open === true || (Array.isArray(open) && open.includes(appId)))) throw Web.refused(web, `open ${appId}`)
      const caller = { desktop, appId: web.app?.id ?? null, label: web.app?.label ?? web.kind }
      const kind = (request as { kind?: unknown } | undefined)?.kind
      const target = this.#host.opener.app(appId)
      if (request !== undefined && request !== null && typeof kind !== 'string') {
        throw Object.assign(new Error(`a request to ${appId} needs a kind`), { status: 400, code: 'untyped_request' })
      }
      if (typeof kind === 'string' && target && !target.requests.includes(kind)) {
        throw Object.assign(new Error(`${appId} does not accept ${kind} requests (its manifest's requests)`), { status: 409, code: 'not_accepted' })
      }
      return this.#host.launch(appId, request ?? null, Family.of(options, caller, (id) => this.#host.record(id)))
    }
    throw new Error(`acde.apps has no ${method}`)
  }

  #caller(web: Web) {
    const app = web.app!
    return Web.caller(app, web.tier)
  }

  packages(web: Web, method: string, args: unknown[]): unknown {
    if (!web.shell('packages')) throw Web.refused(web, 'acde:packages')
    switch (method) {
      case 'refresh':
        return this.#host.refresh()
      case 'install':
        return this.#host.install(String(args[0]))
      case 'natives':
        return this.#host.natives.list()
      case 'runNative': {
        const file = this.#host.natives.file(String(args[0]))
        if (!file) throw Object.assign(new Error(`no native app ${String(args[0])}`), { status: 404 })
        return this.#host.shell.launch(['gio', 'launch', file])
      }
    }
    throw new Error(`acde.packages has no ${method}`)
  }

  async openByName(name: string): Promise<string> {
    const wanted = name.trim().toLowerCase()
    const apps = this.#host.list()
    const app =
      apps.find((a) => a.id.toLowerCase() === wanted) ??
      apps.find((a) => a.label.toLowerCase() === wanted) ??
      apps.find((a) => a.label.toLowerCase().includes(wanted))
    if (app) {
      this.#host.raise(await this.#host.launch(app.id, null))
      return `opened app ${app.label} (${app.id})`
    }
    const natives = this.#host.natives.list()
    const native =
      natives.find((n) => n.id.toLowerCase() === wanted || n.id.toLowerCase() === `${wanted}.desktop`) ??
      natives.find((n) => n.name.toLowerCase() === wanted) ??
      natives.find((n) => n.name.toLowerCase().includes(wanted))
    const file = native && this.#host.natives.file(native.id)
    if (!native || !file) {
      throw Object.assign(new Error(`no app named ${name} (acde apps: ${apps.map((a) => a.label).join(', ')})`), { status: 404 })
    }
    this.#host.shell.launch(['gio', 'launch', file])
    return `started native program ${native.name} (${native.id})`
  }
}
