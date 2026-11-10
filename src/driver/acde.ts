import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  ApprovalCapability, InspectAction, InspectArg, InspectMatch, InspectNode, InspectWindow, PermissionDecision,
  PermissionPrompt,
} from '@dopame/acde-api'
import { cliEnv, cliFile, runtimes } from 'acde/launcher'
import { DevClient } from '../ipc.ts'
import { PackageManager } from '../pm.ts'
import { Runtime, type Child } from '../runtime.ts'
import { Sessions, type Session } from '../sessions.ts'
import { Logs } from './logs.ts'
import { Poll } from './poll.ts'
import { Trace } from './trace.ts'
import { AppWindow, type WindowMatch } from './window.ts'

export interface Web {
  readonly name: string
  readonly app: string | null
  readonly kind: string
  readonly window: number
  readonly title: string | null
}

export interface Shot {
  readonly png: Buffer
  readonly width: number
  readonly height: number
  readonly path: string | null
}

export interface SnapshotOptions {
  readonly window?: string
  readonly ref?: string
  readonly all?: boolean
  readonly diff?: boolean
  readonly limit?: number
  readonly find?: string
  readonly tree?: boolean
  readonly offscreen?: boolean
}

export interface QueryOptions {
  readonly selector: string
  readonly window?: string
  readonly ref?: string
  readonly limit?: number
  readonly attributes?: readonly string[]
}

export interface QueryResult {
  readonly window: string
  readonly count: number
  readonly nodes: readonly InspectMatch[]
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  readonly seq: number
  readonly time: number
  readonly web: string
  readonly app: string | null
  readonly kind: 'console' | 'error' | 'rejection'
  readonly level: ConsoleLevel
  readonly text: string
}

export interface RequestEntry {
  readonly seq: number
  readonly time: number
  readonly web: string
  readonly app: string | null
  readonly id: number
  readonly kind: 'fetch' | 'xhr' | 'websocket' | 'eventsource' | 'image' | 'stylesheet' | 'font'
  readonly method: string
  readonly url: string
  readonly requestBytes: number
  readonly status: number | null
  readonly statusText: string | null
  readonly responseBytes: number | null
  readonly ms: number | null
  readonly error: string | null
  readonly done: boolean
  readonly mocked?: true
}

export interface DevPage<T> {
  readonly entries: readonly T[]
  readonly next: number
  readonly dropped: number
}

export interface ConsoleOptions {
  readonly web?: string
  readonly since?: number
  readonly limit?: number
  readonly level?: ConsoleLevel | 'errors'
}

export interface NetworkOptions {
  readonly web?: string
  readonly since?: number
  readonly limit?: number
  readonly failed?: boolean
}

export interface Emulation {
  readonly colorScheme?: 'light' | 'dark' | null
  readonly reducedMotion?: boolean | null
}

export interface Snapshot {
  readonly text: string
  readonly windows: readonly InspectWindow[]
  readonly trees: Readonly<Record<string, readonly InspectNode[]>>
}

export interface ActResult {
  readonly ok: boolean
  readonly text: string
}

export const ACTIONS: readonly InspectAction[] = [
  'click', 'double', 'right', 'hover', 'drag', 'type', 'settext', 'select', 'key', 'scroll', 'focus', 'close',
  'minimize', 'restore',
]

export interface Step {
  readonly ref: string
  readonly action: InspectAction
  readonly arg?: InspectArg
}

export type UrlMatch = string | RegExp

export type RouteResponse =
  | {
      readonly status?: number
      readonly statusText?: string
      readonly headers?: Readonly<Record<string, string>>
      readonly contentType?: string
      readonly body?: string | Uint8Array
      readonly json?: unknown
    }
  | { readonly abort: true | string }

export interface RouteOptions {
  readonly method?: string
  readonly web?: string
  readonly times?: number
}

export interface WaitRequestOptions {
  readonly method?: string
  readonly web?: string
  readonly timeout?: number
}

export interface WaitConsoleOptions {
  readonly level?: ConsoleLevel | 'errors'
  readonly web?: string
  readonly timeout?: number
}

export interface AttachOptions {
  readonly session?: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout?: number
}

export interface LaunchOptions {
  readonly dirs?: readonly string[]
  readonly desktop?: string
  readonly app?: string
  readonly out?: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly headless?: boolean
  readonly timeout?: number
  readonly startTimeout?: number
}

export interface Permissions {
  readonly pending: readonly PermissionPrompt[]
  readonly decisions: readonly PermissionDecision[]
}

export interface PromptMatch {
  readonly app?: string
  readonly capability?: ApprovalCapability
  readonly timeout?: number
}

export interface DropOptions {
  readonly web?: string
  readonly x?: number
  readonly y?: number
}

export interface Dropped {
  readonly web: string
  readonly window: number
  readonly files: readonly string[]
}

interface Launched {
  readonly child: Child
  readonly dir: string
}

interface Unrouted {
  removed: number
  left: number
}

interface Emulated {
  colorScheme: 'light' | 'dark'
  emulated: boolean
  reducedMotion: boolean
}

export class ActError extends Error {
  readonly result: ActResult

  constructor(what: string, result: ActResult) {
    super(`${what}: ${result.text}`)
    this.name = 'ActError'
    this.result = result
  }
}

export class Acde {
  static readonly TIMEOUT_MS = 5_000
  static readonly START_TIMEOUT_MS = 120_000

  readonly session: Session
  readonly logs: Logs | null
  readonly trace: Trace
  timeout: number
  readonly #client: DevClient
  readonly #owned: Launched | null
  #closed = false

  private constructor(
    session: Session,
    client: DevClient,
    owned: Launched | null,
    logs: Logs | null,
    timeout: number,
  ) {
    this.session = session
    this.#client = client
    this.#owned = owned
    this.logs = logs
    this.timeout = timeout
    this.trace = new Trace(this)
    client.closed.then(() => {
      this.#closed = true
    })
  }

  static async attach(options: AttachOptions = {}): Promise<Acde> {
    const sessions = Sessions.list(Sessions.dir({ ...process.env, ...options.env }))
    const session = Sessions.pick(sessions, options.cwd ?? process.cwd(), options.session)
    return new Acde(session, await Acde.#connect(session), null, null, options.timeout ?? Acde.TIMEOUT_MS)
  }

  static runtime(dir: string, file = cliFile(), found: () => Record<'bun' | 'node', string | null> = runtimes): string {
    const wanted = PackageManager.of(dir).runtime
    if (!file?.endsWith('.js') || wanted === (Runtime.bun ? 'bun' : 'node')) return process.execPath
    return found()[wanted] ?? process.execPath
  }

  static async launch(options: LaunchOptions = {}): Promise<Acde> {
    const cwd = resolve(options.cwd ?? process.cwd())
    const runtime = Acde.runtime(resolve(cwd, options.dirs?.[0] ?? '.'))
    const argv = [
      runtime,
      cliFile(),
      'dev',
      ...(options.dirs ?? []).map((dir) => resolve(cwd, dir)),
      ...(options.desktop !== undefined ? ['--desktop', options.desktop] : []),
      ...(options.app !== undefined ? ['--app', options.app] : []),
      ...(options.out !== undefined ? ['--out', options.out] : []),
      ...(options.headless ? ['--headless'] : []),
    ]
    const env = cliEnv(runtime, { ...process.env, ...options.env, ACDE_FOLLOWED: '1' })
    const child = Runtime.spawn(argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const logs = new Logs()
    logs.follow(child.process.stdout!, 'stdout')
    logs.follow(child.process.stderr!, 'stderr')
    let exited: number | null = null
    void child.exited.then(
      (code) => {
        exited = code
      },
      () => {
        exited = -1
      },
    )
    const dir = Sessions.dir({ ...process.env, ...options.env })
    const limit = options.startTimeout ?? Acde.START_TIMEOUT_MS
    const deadline = Date.now() + limit
    const since = Date.now() - 1_000
    const within = `within ${Math.round(limit / 1000)} s`
    const late = () => `acde dev did not start ${within}:\n${logs.tail(40).text}`
    const unregistered = () => {
      const others = Sessions.list(dir).filter((s) => s.pid !== child.pid && s.started >= since)
      const instead = others.length
        ? '; another process registered instead (acde dev handed over to it):\n' +
          others.map((s) => `  ${Sessions.describe(s)}`).join('\n')
        : ` in ${dir}`
      return `acde dev (pid ${child.pid}) did not register a session ${within}${instead}\n${logs.tail(40).text}`
    }
    const alive = () => {
      if (exited !== null) throw new Error(`acde dev exited (${exited}) before it was ready:\n${logs.tail(40).text}`)
    }
    try {
      const session = await Poll.until(limit, () => {
        alive()
        return Sessions.list(dir).find((s) => s.pid === child.pid) ?? null
      }, unregistered)
      const client = await Acde.#connect(session)
      const acde = new Acde(session, client, { child, dir }, logs, options.timeout ?? Acde.TIMEOUT_MS)
      await Poll.until(Math.max(0, deadline - Date.now()), async () => {
        alive()
        return (await acde.ready()) || (await acde.#prompting()) || null
      }, late)
      return acde
    } catch (error) {
      child.kill('SIGTERM')
      await child.exited.catch(() => -1)
      throw error
    }
  }

  static async #connect(session: Session): Promise<DevClient> {
    try {
      return await DevClient.connect(session.endpoint)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        Sessions.remove(session.pid)
        throw new Error(`acde dev ${session.pid} is gone (nothing answers on ${session.endpoint})`)
      }
      throw error
    }
  }

  async ready(): Promise<boolean> {
    const [webs, windows] = await Promise.all([this.webs(), this.windows()])
    return windows.length > 0 && webs.every((web) => windows.some((w) => w.id === web.window))
  }

  get closed(): boolean {
    return this.#closed
  }

  get desktop(): AppWindow {
    return new AppWindow(this, { ref: 'w0' })
  }

  window(match: WindowMatch | string): AppWindow {
    if (typeof match !== 'string') return new AppWindow(this, match)
    return new AppWindow(this, /^w\d+$/.test(match) ? { ref: match } : { app: match })
  }

  async webs(): Promise<Web[]> {
    const webs = ((await this.#request('webs')) as { webs?: Web[] } | null)?.webs
    if (!Array.isArray(webs)) throw new Error('acdert answered webs without a list')
    return webs
  }

  async evaluate<T = unknown>(web: string, code: string): Promise<NoInfer<T>> {
    return ((await this.#request('eval', { web, code })) as { value: T }).value
  }

  async screenshot(web: string, options: { readonly path?: string } = {}): Promise<Shot> {
    const answer = (await this.#request('shot', { web })) as { png?: unknown; width?: unknown; height?: unknown } | null
    if (typeof answer?.png !== 'string') throw new Error('acdert answered shot without a png')
    const png = Buffer.from(answer.png, 'base64')
    const path = options.path === undefined ? null : resolve(options.path)
    if (path !== null) writeFileSync(path, png)
    return { png, width: Number(answer.width) || 0, height: Number(answer.height) || 0, path }
  }

  async snapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
    const answer = (await this.#request('snapshot', { ...options })) as Snapshot | null
    if (typeof answer?.text !== 'string') throw new Error('acdert answered snapshot without text')
    return { text: answer.text, windows: answer.windows ?? [], trees: answer.trees ?? {} }
  }

  async query(options: QueryOptions): Promise<QueryResult> {
    const answer = (await this.#request('query', { ...options })) as QueryResult | null
    if (!Array.isArray(answer?.nodes)) throw new Error('acdert answered query without nodes')
    return answer
  }

  async console(options: ConsoleOptions = {}): Promise<DevPage<ConsoleEntry>> {
    return Acde.#page<ConsoleEntry>('console', await this.#request('console', { ...options }))
  }

  async network(options: NetworkOptions = {}): Promise<DevPage<RequestEntry>> {
    return Acde.#page<RequestEntry>('network', await this.#request('network', { ...options }))
  }

  async screen(options: { readonly path?: string } = {}): Promise<Shot> {
    const scratch = options.path === undefined ? mkdtempSync(join(tmpdir(), 'acde-screen-')) : null
    const path = options.path === undefined ? join(scratch!, 'screen.png') : resolve(options.path)
    try {
      const answer = (await this.#request('screen', { path })) as { width?: unknown; height?: unknown } | null
      return {
        png: readFileSync(path),
        width: Number(answer?.width) || 0,
        height: Number(answer?.height) || 0,
        path: scratch === null ? path : null,
      }
    } finally {
      if (scratch !== null) rmSync(scratch, { recursive: true, force: true })
    }
  }

  async emulate(options: Emulation): Promise<Emulated> {
    return this.trace.step(`emulate(${JSON.stringify(options)})`,
      async () => (await this.#request('emulate', { ...options })) as Emulated)
  }

  async chooseFolder(folder: string | null): Promise<void> {
    const answer = folder === null ? null : resolve(folder)
    await this.trace.step(`chooseFolder(${JSON.stringify(answer)})`, () => this.#request('choose', { folder: answer }))
  }

  async chooseFiles(files: string | readonly string[] | null): Promise<void> {
    const answer = files === null ? null : (typeof files === 'string' ? [files] : files).map((file) => resolve(file))
    await this.trace.step(`chooseFiles(${JSON.stringify(answer)})`, () => this.#request('choose', { open: answer }))
  }

  async chooseSaveFile(file: string | null): Promise<void> {
    const answer = file === null ? null : resolve(file)
    await this.trace.step(`chooseSaveFile(${JSON.stringify(answer)})`, () => this.#request('choose', { save: answer }))
  }

  async route(url: UrlMatch, response: RouteResponse, options: RouteOptions = {}): Promise<number> {
    const args = {
      ...Acde.#routeUrl(url),
      ...Acde.#routeResponse(response),
      ...(options.method !== undefined && { method: options.method }),
      ...(options.web !== undefined && { web: options.web }),
      ...(options.times !== undefined && { times: options.times }),
    }
    return this.trace.step(`route(${String(url instanceof RegExp ? url : JSON.stringify(url))})`, async () => {
      const answer = (await this.#request('route', args)) as { id?: unknown } | null
      if (typeof answer?.id !== 'number') throw new Error(`acdert answered route with ${JSON.stringify(answer)}`)
      return answer.id
    }, (id) => `route ${id}`)
  }

  async unroute(id?: number): Promise<{ removed: number; left: number }> {
    return this.trace.step(`unroute(${id ?? ''})`,
      async () => (await this.#request('unroute', id === undefined ? {} : { route: id })) as Unrouted)
  }

  async permissions(): Promise<Permissions> {
    const answer = (await this.#request('permissions')) as Partial<Permissions> | null
    if (!Array.isArray(answer?.pending) || !Array.isArray(answer?.decisions)) {
      throw new Error(`acdert answered permissions with ${JSON.stringify(answer)}`)
    }
    return answer as Permissions
  }

  async waitForPrompt(match: PromptMatch = {}): Promise<PermissionPrompt> {
    const ms = match.timeout ?? this.timeout
    const fits = (prompt: PermissionPrompt) => (match.app === undefined || prompt.app === match.app)
      && (match.capability === undefined || prompt.capability === match.capability)
    return Poll.until(ms, async () => (await this.permissions()).pending.find(fits) ?? null,
      () => `waitForPrompt: no approval prompt${Acde.#describe(match)} within ${ms} ms`)
  }

  async answer(prompt: PermissionPrompt | number, allow: boolean): Promise<void> {
    const id = typeof prompt === 'number' ? prompt : prompt.id
    await this.trace.step(`answer(${id}, ${allow})`, () => this.#request('answer', { prompt: id, allow }))
  }

  async allow(match: PromptMatch = {}): Promise<PermissionPrompt> {
    return this.#settle(match, true)
  }

  async deny(match: PromptMatch = {}): Promise<PermissionPrompt> {
    return this.#settle(match, false)
  }

  async #settle(match: PromptMatch, allow: boolean): Promise<PermissionPrompt> {
    return this.trace.step(`${allow ? 'allow' : 'deny'}(${Acde.#describe(match).trim()})`, async () => {
      const prompt = await this.waitForPrompt(match)
      await this.#request('answer', { prompt: prompt.id, allow })
      return prompt
    }, (prompt) => `${prompt.app}: ${prompt.capability}`)
  }

  async revoke(app: string, capability: ApprovalCapability): Promise<boolean> {
    return this.trace.step(`revoke(${JSON.stringify(app)}, ${JSON.stringify(capability)})`, async () => {
      const answer = (await this.#request('revoke', { app, capability })) as { revoked?: unknown } | null
      if (typeof answer?.revoked !== 'boolean') throw new Error(`acdert answered revoke with ${JSON.stringify(answer)}`)
      return answer.revoked
    }, (revoked) => (revoked ? 'revoked' : 'nothing to revoke'))
  }

  async drop(files: string | readonly string[], options: DropOptions = {}): Promise<Dropped> {
    const list = (typeof files === 'string' ? [files] : files).map((file) => resolve(file))
    if (list.length === 0) throw new Error('drop: give at least one file')
    if ((options.x === undefined) !== (options.y === undefined)) throw new Error('drop: give x and y together')
    const args = {
      files: list,
      ...(options.web !== undefined && { web: options.web }),
      ...(options.x !== undefined && { x: options.x, y: options.y }),
    }
    return this.trace.step(`drop(${JSON.stringify(list)}${options.web ? `, ${options.web}` : ''})`, async () => {
      const answer = (await this.#request('drop', args)) as Partial<Dropped> | null
      if (typeof answer?.web !== 'string' || typeof answer.window !== 'number' || !Array.isArray(answer.files)) {
        throw new Error(`acdert answered drop with ${JSON.stringify(answer)}`)
      }
      return answer as Dropped
    }, (dropped) => `onto ${dropped.web}`)
  }

  async #prompting(): Promise<boolean> {
    try {
      return (await this.permissions()).pending.length > 0
    } catch {
      return false
    }
  }

  static #describe(match: PromptMatch): string {
    const parts = [match.app && `app ${match.app}`, match.capability && `capability ${match.capability}`]
      .filter(Boolean)
    return parts.length > 0 ? ` for ${parts.join(', ')}` : ''
  }

  async clipboard(): Promise<string> {
    return String(((await this.#request('clipboard')) as { text?: unknown } | null)?.text ?? '')
  }

  async setClipboard(text: string): Promise<void> {
    await this.trace.step(`setClipboard(${JSON.stringify(text)})`, () => this.#request('clipboard', { text }))
  }

  async waitForRequest(url: UrlMatch, options: WaitRequestOptions = {}): Promise<RequestEntry> {
    const since = (await this.network({ limit: 1 })).next
    const matches = Acde.urlMatcher(url)
    const method = options.method?.toUpperCase()
    const ms = options.timeout ?? this.timeout
    const target = url instanceof RegExp ? String(url) : JSON.stringify(url)
    const what = `request to ${target}${method ? ` (${method})` : ''}`
    let open: RequestEntry | null = null
    return Poll.until(ms, async () => {
      const page = await this.network({ since, limit: 5000, ...(options.web !== undefined && { web: options.web }) })
      const hit = page.entries.find((e) => (method === undefined || e.method === method) && matches(e.url))
      open = hit ?? null
      return hit?.done ? hit : null
    }, () => `waitForRequest: ${open ? `the ${what} started but did not finish` : `no ${what}`} within ${ms} ms`)
  }

  async waitForConsole(text: string | RegExp, options: WaitConsoleOptions = {}): Promise<ConsoleEntry> {
    const since = (await this.console({ limit: 1 })).next
    const ms = options.timeout ?? this.timeout
    const matches = (line: string) => (text instanceof RegExp ? text.test(line) : line.includes(text))
    return Poll.until(ms, async () => {
      const page = await this.console({
        since,
        limit: 5000,
        ...(options.level !== undefined && { level: options.level }),
        ...(options.web !== undefined && { web: options.web }),
      })
      return page.entries.find((e) => matches(e.text)) ?? null
    }, () => {
      const line = text instanceof RegExp ? String(text) : `containing ${JSON.stringify(text)}`
      return `waitForConsole: no console line ${line}${options.level ? ` at ${options.level}` : ''} within ${ms} ms`
    })
  }

  static urlMatcher(url: UrlMatch): (href: string) => boolean {
    if (url instanceof RegExp) return (href) => new RegExp(url.source, url.flags.replace(/[gy]/g, '')).test(href)
    let source = ''
    for (let i = 0; i < url.length; i++) {
      const c = url[i]!
      if (c === '*') {
        if (url[i + 1] === '*') {
          source += '.*'
          i++
        } else source += '[^/]*'
      } else source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
    const glob = new RegExp(`^${source}$`)
    if (!url.startsWith('/')) return (href) => glob.test(href)
    return (href) => {
      try {
        const parsed = new URL(href)
        return glob.test(`${parsed.pathname}${parsed.search}`)
      } catch {
        return false
      }
    }
  }

  static #routeUrl(url: UrlMatch): { url: string | { regex: string; flags: string } } {
    return { url: url instanceof RegExp ? { regex: url.source, flags: url.flags.replace(/[gy]/g, '') } : url }
  }

  static #routeResponse(response: RouteResponse): Record<string, unknown> {
    if ('abort' in response) return { abort: response.abort }
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    )
    let body: Uint8Array | null = null
    if (response.json !== undefined) {
      body = Buffer.from(JSON.stringify(response.json))
      headers['content-type'] ??= 'application/json'
    } else if (response.body !== undefined) {
      body = typeof response.body === 'string' ? Buffer.from(response.body) : response.body
      if (typeof response.body === 'string') headers['content-type'] ??= 'text/plain;charset=utf-8'
    }
    if (response.contentType !== undefined) headers['content-type'] = response.contentType
    return {
      ...(response.status !== undefined && { status: response.status }),
      ...(response.statusText !== undefined && { statusText: response.statusText }),
      headers,
      ...(body !== null && { body: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64') }),
    }
  }

  async windows(): Promise<InspectWindow[]> {
    return [...(await this.snapshot({ tree: false })).windows]
  }

  async act(ref: string, action: InspectAction, arg?: InspectArg): Promise<ActResult> {
    const given = arg !== undefined && arg !== null
    const shown = [ref, action, ...(given ? [arg] : [])].map((value) => JSON.stringify(value)).join(', ')
    return this.trace.step(`act(${shown})`,
      async () => Acde.#result(await this.#request('act', { ref, action, ...(given && { arg }) })), Acde.#said)
  }

  async run(steps: readonly Step[]): Promise<ActResult> {
    return this.trace.step(`run(${steps.map((s) => `${s.ref} ${s.action}`).join(', ')})`,
      async () => {
        const sent = steps.map((s) => ({ ref: s.ref, action: s.action, text: s.arg ?? null }))
        return Acde.#result(await this.#request('run', { steps: sent }))
      }, Acde.#said)
  }

  static #said(result: ActResult): string {
    return `${result.ok ? '' : 'not done: '}${result.text.split('\n')[0] ?? ''}`
  }

  async open(name: string, options: { readonly timeout?: number } = {}): Promise<AppWindow> {
    return this.trace.step(`open(${JSON.stringify(name)})`, () => this.#open(name, options))
  }

  async #open(name: string, options: { readonly timeout?: number }): Promise<AppWindow> {
    const before = new Set((await this.windows()).map((w) => w.id))
    const result = Acde.#result(await this.#request('open', { name }))
    if (!result.ok) throw new ActError(`open ${name}`, result)
    const opened = await Poll.until(options.timeout ?? this.timeout, async () => {
      const fresh = (await this.windows()).filter((w) => !before.has(w.id) && w.kind !== 'desktop')
      return fresh.find((w) => w.app === name) ?? fresh.find((w) => w.focus) ?? fresh[0] ?? null
    }, () => `open ${name}: no new window appeared`)
    return new AppWindow(this, { id: opened.id })
  }

  async webOf(window: number): Promise<Web> {
    const web = (await this.webs()).find((w) => w.window === window)
    if (!web) throw new Error(`window ${window} has no running page`)
    return web
  }

  async close(): Promise<void> {
    this.#client.close()
    if (!this.#owned) return
    const { child, dir } = this.#owned
    child.kill('SIGTERM')
    const stopped = await Promise.race([child.exited.catch(() => -1), sleep(10_000).then(() => null)])
    if (stopped === null) {
      child.kill('SIGKILL')
      await child.exited.catch(() => -1)
    }
    Sessions.removeIfCurrent(this.session, dir)
  }

  async #request(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (this.#closed) throw new Error(`acde dev ${this.session.pid} is no longer connected`)
    return this.#client.request(op, args)
  }

  static #page<T>(op: string, answer: unknown): DevPage<T> {
    const page = answer as DevPage<T> | null
    if (!Array.isArray(page?.entries)) throw new Error(`acdert answered ${op} without entries`)
    return page
  }

  static #result(answer: unknown): ActResult {
    const result = answer as { ok?: unknown; text?: unknown } | null
    if (typeof result?.text !== 'string') throw new Error(`acdert answered with ${JSON.stringify(answer)}`)
    return { ok: result.ok !== false, text: result.text }
  }
}
