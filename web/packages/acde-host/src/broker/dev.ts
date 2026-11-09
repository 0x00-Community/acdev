import type { InspectArg } from '@dopame/acde-api'
import type { DevLog } from '../devlog'
import { DevRoutes, type DevRoute } from '../devroutes'
import type { Inspect } from '../inspect'
import { Level, Log } from '../log'
import { isAbsolute } from '../sys/path'
import type { BrokerShell, WebInfo } from './types'
import type { Web } from './web'

export interface DevHost {
  readonly shell: BrokerShell
  readonly inspect: Inspect
  readonly devlog: DevLog
  webs(): Web[]
  desktop(): Web | null
  title(web: Web): string
  emulate(options: { readonly colorScheme?: 'light' | 'dark' | null; readonly reducedMotion?: boolean | null }): unknown
}

export class DevRequests {
  static readonly #OPS = 'webs, eval, shot, snapshot, act, run, open, query, console, network, screen, emulate, choose, route, unroute, clipboard'
  readonly #host: DevHost
  #routes: DevRoute[] = []
  #nextRoute = 1

  constructor(host: DevHost) {
    this.#host = host
  }

  infos(): WebInfo[] {
    return this.#host.webs().map((web) => ({
      name: web.name,
      app: web.app?.id ?? null,
      kind: web.kind === 'desktop' ? 'desktop' : 'app',
      window: web.window,
      title: this.#host.title(web),
    }))
  }

  web(name: string): Web {
    const webs = this.#host.webs()
    const wanted = String(name)
    const web =
      webs.find((w) => w.name === wanted) ??
      (wanted === 'desktop' ? this.#host.desktop() : null) ??
      webs.filter((w) => w.app?.id === wanted).sort((a, b) => a.window - b.window)[0]
    if (!web) {
      const names = webs.map((w) => w.name).join(', ') || 'none'
      throw Object.assign(new Error(`no web ${wanted} (webs: ${names}; a web name, an app id or desktop)`), { status: 404 })
    }
    return web
  }

  async stats(reset: boolean): Promise<Record<string, unknown>> {
    const webs = this.#host.webs()
    const stats = await Promise.all(webs.map((w) => w.rpc.call('debug', 'stats', [reset]).catch((e: Error) => ({ error: e.message }))))
    return Object.fromEntries(webs.map((w, i) => [w.name, { ...(stats[i] as object), cpuMs: w.thread.cpuMs() }]))
  }

  async request(line: string): Promise<void> {
    let id: number | null = null
    let ok = true
    let payload: string
    try {
      const request = JSON.parse(line) as Record<string, unknown> & { id: number; op: string }
      id = request.id
      payload = JSON.stringify(await this.#op(request))
    } catch (error) {
      ok = false
      payload = (error as Error)?.message ?? String(error)
    }
    if (id === null) return Log.write(Level.Warn, 'acde_host', `acde dev: not a request: ${line.slice(0, 200)}`)
    try {
      this.#host.shell.devRespond?.(id, ok, payload)
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `acde dev: response ${id}: ${(error as Error).message}`)
    }
  }

  async #op(request: Record<string, unknown> & { op: string }): Promise<unknown> {
    const { type: _type, id: _id, op, ...args } = request
    switch (op) {
      case 'webs':
        return { webs: this.infos() }
      case 'eval': {
        if (typeof args['code'] !== 'string') throw new Error('eval: code is a string')
        let value: unknown
        try {
          value = await this.web(String(args['web'] ?? 'desktop')).rpc.call('debug', 'eval', [args['code']])
        } catch (error) {
          throw new Error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
        }
        try {
          return { value: JSON.parse(JSON.stringify(value) ?? 'null') as unknown }
        } catch (error) {
          throw new Error(`eval: the value is not JSON: ${(error as Error).message}`)
        }
      }
      case 'shot': {
        const web = this.web(String(args['web'] ?? 'desktop'))
        if (!this.#host.shell.capture) throw new Error('shot: this backend cannot read a window back (host windows only)')
        return this.#host.shell.capture(web.window)
      }
      case 'snapshot':
        return this.#host.inspect.api.snapshot(args)
      case 'act':
        return this.#host.inspect.api.act(String(args['ref'] ?? ''), args['action'] as never, (args['arg'] ?? null) as InspectArg)
      case 'run':
        return this.#host.inspect.api.run(args['steps'] as never)
      case 'open':
        if (typeof args['name'] !== 'string' || !args['name']) throw new Error('open: name is an app id or name')
        return this.#host.inspect.api.open(args['name'])
      case 'query':
        return this.#host.inspect.api.query(args as never)
      case 'console':
        return this.#host.devlog.console(DevRequests.#query(args, { level: args['level'] as never }))
      case 'network':
        return this.#host.devlog.requests(DevRequests.#query(args, { failed: args['failed'] === true }))
      case 'screen': {
        if (typeof args['path'] !== 'string' || !isAbsolute(args['path'])) throw new Error('screen: path is an absolute file path for the PNG')
        const size = await this.#host.shell.screenshot(args['path'])
        return { ...size, path: args['path'] }
      }
      case 'emulate':
        return this.#host.emulate(args as never)
      case 'choose':
        return this.#choose(args)
      case 'route': {
        const route = DevRoutes.parse(args, this.#nextRoute++)
        this.#routes.push(route)
        this.#push()
        return { id: route.id }
      }
      case 'unroute': {
        const id = args['route']
        if (id !== undefined && id !== null && !Number.isInteger(id)) {
          throw new Error('unroute: route is the id route answered, or leave it out to remove every route')
        }
        const before = this.#routes.length
        this.#routes = id === undefined || id === null ? [] : this.#routes.filter((r) => r.id !== id)
        this.#push()
        return { removed: before - this.#routes.length, left: this.#routes.length }
      }
      case 'clipboard': {
        const shell = this.#host.shell
        if (!shell.readClipboard || !shell.writeClipboard) throw new Error('clipboard: this backend has no clipboard of its own to read (host windows only)')
        if (args['text'] !== undefined) {
          if (typeof args['text'] !== 'string') throw new Error('clipboard: text is a string')
          shell.writeClipboard(args['text'])
        }
        return { text: shell.readClipboard() }
      }
      default:
        throw new Error(`no op ${String(op)} (${DevRequests.#OPS})`)
    }
  }

  routesFor(name: string, app: string | null): DevRoute[] {
    return this.#routes.filter((r) => r.web === null || r.web === name || (app !== null && r.web === app))
  }

  #push(): void {
    for (const web of this.#host.webs()) web.thread.post({ type: 'devroutes', routes: this.routesFor(web.name, web.app?.id ?? null) })
  }

  used(id: number): void {
    const route = this.#routes.find((r) => r.id === id)
    if (!route || route.times === null) return
    if (route.times > 1) {
      this.#routes = this.#routes.map((r) => (r.id === id ? { ...r, times: route.times! - 1 } : r))
      return
    }
    this.#routes = this.#routes.filter((r) => r.id !== id)
    this.#push()
  }

  #choose(args: Record<string, unknown>): Record<string, unknown> {
    const kinds = (['folder', 'open', 'save'] as const).filter((kind) => args[kind] !== undefined)
    if (kinds.length !== 1) throw new Error('choose: give exactly one of folder, open or save')
    const kind = kinds[0]!
    const answer = args[kind]
    const path = (value: unknown) => typeof value === 'string' && isAbsolute(value)
    const shell = this.#host.shell
    if (!shell.answerFolder || !shell.answerOpen || !shell.answerSave) {
      throw new Error('choose: this backend asks the portal, it cannot be answered beforehand (host windows only)')
    }
    if (kind === 'open') {
      if (answer !== null && !(Array.isArray(answer) && answer.length > 0 && answer.every(path))) {
        throw new Error('choose: open is a non-empty list of absolute file paths, or null to cancel')
      }
      shell.answerOpen(answer as string[] | null)
    } else {
      if (answer !== null && !path(answer)) throw new Error(`choose: ${kind} is an absolute path, or null to cancel`)
      if (kind === 'folder') shell.answerFolder(answer as string | null)
      else shell.answerSave(answer as string | null)
    }
    return { [kind]: answer }
  }

  static #query<T extends object>(args: Record<string, unknown>, extra: T): { web?: string; since?: number; limit?: number } & T {
    const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const since = number(args['since'])
    const limit = number(args['limit'])
    return {
      ...(typeof args['web'] === 'string' && { web: args['web'] }),
      ...(since !== undefined && { since }),
      ...(limit !== undefined && { limit }),
      ...extra,
    }
  }
}
