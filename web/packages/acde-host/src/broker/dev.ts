import type { InspectArg } from '@dopame/acde-api'
import type { DevLog } from '../devlog'
import { Frame } from '../frame'
import { DevRoutes, type DevRoute } from '../devroutes'
import type { Inspect } from '../inspect'
import { Level, Log } from '../log'
import { isAbsolute } from '../sys/path'
import { unref, within } from '../sys/timers'
import type { BrokerShell, WebInfo } from './types'
import type { Web } from './web'
import type { Permissions } from './access/approval/permissions'
import type { Screen } from './output'
import type { NativeDevTools, NativeDevToolsTarget } from '../native'
import { PageSource } from '../page'

export interface DevHost {
  readonly shell: BrokerShell
  readonly inspect: Inspect
  readonly devlog: DevLog
  readonly permissions: Permissions
  webs(): Web[]
  desktop(): Web | null
  title(web: Web): string
  emulate(options: { readonly colorScheme?: 'light' | 'dark' | null; readonly reducedMotion?: boolean | null }): unknown
  reload(app: string | null): Promise<void>
  screen(): Screen
  readonly devtools: NativeDevTools | null
  services(): readonly string[]
}

interface DevInit {
  readonly id: number
  readonly web: string | null
  readonly code: string
  readonly once: boolean
}

export class DevRequests {
  static readonly STATE_MS = 500
  static readonly TARGETS_MS = 250
  static readonly SERVICES = 'broker'
  static readonly #OPS =
    'webs, eval, shot, snapshot, act, run, open, query, console, network, screen, emulate, choose, route, unroute, pointer, clipboard, ' +
    'permissions, answer, revoke, drop, input, clock, dialog, init, uninit, reload, resize, devtools'
  readonly #host: DevHost
  readonly #devtools: NativeDevTools | null
  #targets = ''
  readonly #states = new Map<string, unknown>()
  #routes: DevRoute[] = []
  #nextRoute = 1
  #inits: DevInit[] = []
  #nextInit = 1

  constructor(host: DevHost) {
    this.#host = host
    this.#devtools = host.devtools?.open() ? host.devtools : null
    if (this.#devtools) unref(setInterval(() => this.publish(), DevRequests.TARGETS_MS))
  }

  async snapshot(web: Web | null): Promise<unknown> {
    return !web || web.closing ? null : within(web.rpc.call('dev', 'state', []).catch(() => null), DevRequests.STATE_MS, null)
  }

  keep(key: string, state: unknown): void {
    if (state) this.#states.set(key, state)
  }

  take(key: string): unknown {
    const state = this.#states.get(key)
    this.#states.delete(key)
    return state
  }

  publish(): void {
    if (!this.#devtools) return
    const targets: NativeDevToolsTarget[] = this.#host.webs().map((web) => ({
      id: web.name,
      kind: 'page',
      title: `${this.#host.title(web)} (${web.kind === 'desktop' ? 'desktop' : (web.app?.id ?? web.name)})`,
      url: web.url ?? `${PageSource.ORIGIN}/`,
    }))
    const services = this.#host.services()
    if (services.length) targets.push({ id: DevRequests.SERVICES, kind: 'service', title: `services: ${services.join(', ')}`, url: '' })
    const key = JSON.stringify(targets)
    if (key === this.#targets) return
    this.#targets = key
    this.#devtools.targets(targets)
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
      case 'devtools': {
        const endpoint = this.#devtools?.open()
        if (!endpoint) throw new Error('devtools: this session serves no DevTools endpoint')
        return { port: endpoint.port }
      }
      case 'eval': {
        if (typeof args['code'] !== 'string') throw new Error('eval: code is a string')
        let value: unknown
        try {
          const web = this.web(String(args['web'] ?? 'desktop'))
          const node = args['node']
          value =
            node === undefined || node === null
              ? await web.rpc.call('debug', 'eval', [args['code']])
              : await web.rpc.call('debug', 'evalOn', [Number(node), args['code'], args['arg'] ?? null])
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
      case 'init': {
        if (typeof args['code'] !== 'string' || !args['code']) throw new Error('init: code is the script to run before the page')
        const web = args['web'] === undefined || args['web'] === null ? null : String(args['web'])
        const init = { id: this.#nextInit++, web, code: args['code'], once: args['once'] === true }
        this.#inits.push(init)
        return { id: init.id }
      }
      case 'uninit': {
        const id = args['init']
        const before = this.#inits.length
        this.#inits = id === undefined || id === null ? [] : this.#inits.filter((i) => i.id !== id)
        return { removed: before - this.#inits.length, left: this.#inits.length }
      }
      case 'reload': {
        const web = this.web(String(args['web'] ?? 'desktop'))
        await this.#host.reload(web === this.#host.desktop() ? null : (web.app?.id ?? null))
        return { web: web.name }
      }
      case 'resize':
        return this.#resize(args)
      case 'dialog': {
        if (args['text'] !== undefined && typeof args['text'] !== 'string') throw new Error('dialog: text is the string a prompt answers')
        const web = this.web(String(args['web'] ?? 'desktop'))
        web.thread.post({ type: 'devdialog', accept: args['accept'] !== false, ...(args['text'] !== undefined && { text: args['text'] }) })
        return { web: web.name, accept: args['accept'] !== false }
      }
      case 'clock':
        return this.web(String(args['web'] ?? 'desktop')).rpc.call('dev', 'clock', [DevRequests.#clockRequest(args)])
      case 'input':
        return this.#host.inspect.api.input(this.web(String(args['web'] ?? 'desktop')).window, args['events'] as never)
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
      case 'drop':
        return this.#drop(args)
      case 'permissions':
        return { pending: this.#host.permissions.pending(), decisions: this.#host.permissions.list() }
      case 'answer': {
        if (!Number.isInteger(args['prompt']) || typeof args['allow'] !== 'boolean') throw new Error('answer: prompt is a prompt id and allow is true or false')
        this.#host.permissions.answer(args['prompt'] as number, args['allow'])
        return { prompt: args['prompt'], allow: args['allow'] }
      }
      case 'revoke': {
        const { app, capability } = args
        if (typeof app !== 'string' || !app || typeof capability !== 'string' || !capability) {
          throw new Error('revoke: app is an app id and capability is the approved capability (as in permissions)')
        }
        return { app, capability, revoked: this.#host.permissions.revoke(app, capability) }
      }
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
      case 'pointer': {
        const { x, y } = args
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('pointer: x and y are numbers in screen coordinates')
        }
        this.#host.shell.inject({ type: 'move', x, y })
        return { x, y }
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

  initsFor(name: string, app: string | null): string[] {
    const used = this.#inits.filter((i) => i.web === null || i.web === name || (app !== null && i.web === app))
    this.#inits = this.#inits.filter((i) => !(i.once && used.includes(i)))
    return used.map((i) => i.code)
  }

  #resize(args: Record<string, unknown>): { width: number; height: number } {
    const web = this.web(String(args['web'] ?? 'desktop'))
    const width = Number(args['width'])
    const height = Number(args['height'])
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('resize: width and height are whole CSS pixels of the page (without the title bar)')
    }
    const shell = this.#host.shell
    const desktop = web === this.#host.desktop()
    const row = desktop ? null : shell.windows().find((w) => (w.window ?? w.id) === web.window)
    if (!desktop && !row) throw new Error(`resize: window ${web.window} is gone`)
    const frame = Frame.height(web.app)
    if (!row || row.mode === 'fullscreen') {
      if (!shell.resizeScreen) throw new Error('resize: this one fills the screen, and only host windows (acde dev) can change the screen size')
      shell.resizeScreen(width, height + frame)
      return { width, height }
    }
    if (row.mode !== 'free') throw new Error(`resize: the window is ${row.mode}; only a free window changes size`)
    const screen = this.#host.screen()
    const w = Math.min(width, screen.width)
    const h = Math.min(height + frame, screen.height)
    const x = Math.round(Math.min(Math.max(0, row.x), screen.width - w))
    const y = Math.round(Math.min(Math.max(0, row.y), screen.height - h))
    shell.place(web.window, x, y, w, h)
    return { width: w, height: h - frame }
  }

  static #clockRequest(args: Record<string, unknown>): Record<string, unknown> {
    const action = String(args['action'] ?? '')
    const number = (key: string) => {
      const value = args[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`clock ${action}: ${key} is a number of milliseconds`)
      return value
    }
    switch (action) {
      case 'install':
        return args['time'] === undefined || args['time'] === null ? { action } : { action, time: number('time') }
      case 'fastForward':
      case 'runFor':
        return { action, ms: number('ms') }
      case 'pauseAt':
      case 'setFixedTime':
      case 'setSystemTime':
        return { action, time: number('time') }
      case 'resume':
      case 'state':
        return { action }
      default:
        throw new Error(
          `clock: action is install, fastForward, runFor, pauseAt, resume, setFixedTime, setSystemTime or state, not ${JSON.stringify(action)}`,
        )
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

  #drop(args: Record<string, unknown>): Record<string, unknown> {
    const files = args['files']
    if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === 'string' && isAbsolute(f))) {
      throw new Error('drop: files is a non-empty list of absolute paths')
    }
    const point = ['x', 'y'].map((k) => args[k]).filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
    if (point.length === 1 || (point.length === 0 && (args['x'] !== undefined || args['y'] !== undefined))) {
      throw new Error('drop: x and y are page coordinates given together, or leave both out for the middle of the page')
    }
    const shell = this.#host.shell
    if (!shell.drop) throw new Error('drop: this backend takes drops from the system only (host windows only)')
    const web = this.web(String(args['web'] ?? 'desktop'))
    shell.drop(web.window, files as string[], ...point)
    return { web: web.name, window: web.window, files }
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
