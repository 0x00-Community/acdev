import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { InspectAction, InspectArg, InspectWindow } from '@acde/api'
import { cliEnv, cliFile, runtimes } from 'acdev/launcher'
import { DevClient } from '../ipc.ts'
import { PackageManager } from '../pm.ts'
import { Runtime, type Child } from '../runtime.ts'
import { Sessions, type Session } from '../sessions.ts'
import { Logs, PageLogs } from './logs.ts'
import type { ClockState } from './clock.ts'
import type { InputEvent } from './input.ts'
import * as Call from './call/index.ts'
import * as Gone from './gone/index.ts'
import * as GuestPlace from './place/index.ts'
import { paced } from './pacing/index.ts'
import * as Ready from './ready/index.ts'
import type { PlaceAction } from './place/index.ts'
import { Poll } from './poll.ts'
import { Trace } from './trace.ts'
import { AppWindow, type WindowMatch } from './window.ts'

import {
  ActError, LaunchError, type ActResult, type Appearance, type AppearanceChange, type AttachOptions,
  type ConsoleEntry, type ConsoleOptions, type DevPage,
  type Dialog, type DialogAnswer, type DialogType, type DropOptions, type Dropped, type Emulation, type LaunchOptions,
  type NetworkOptions, type OpenTarget, type PermissionDecision, type PermissionPrompt, type Permissions, type PromptMatch,
  type QueryOptions, type QueryResult, type RequestEntry, type RouteOptions, type RouteResponse, type Shot,
  type Snapshot, type SnapshotOptions, type Step, type UrlMatch, type WaitConsoleOptions, type WaitRequestOptions,
  type Web, type WebList,
} from './types.ts'

export * from './types.ts'

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
}

export class Acde {
  static readonly TIMEOUT_MS = 5_000
  static readonly START_TIMEOUT_MS = 120_000
  static readonly STOP_MS = 10_000
  static readonly DRAIN_MS = 1_000

  readonly session: Session
  readonly logs: Logs | null
  readonly trace: Trace
  timeout: number
  readonly #client: DevClient
  readonly #owned: Launched | null
  #closing = false

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
  }

  static async attach(options: AttachOptions = {}): Promise<Acde> {
    const timeout = options.timeout ?? Acde.TIMEOUT_MS
    if (options.session === Sessions.VM) return await Acde.attachGuest(undefined, timeout)
    const dir = Sessions.dir({ ...process.env, ...options.env })
    const session = await Sessions.find(options.cwd ?? process.cwd(), options.session, options.say, dir)
    return new Acde(session, await Acde.#connect(session), null, null, timeout)
  }

  static async attachGuest(open?: () => Promise<Duplex>, timeout = Acde.TIMEOUT_MS): Promise<Acde> {
    return new Acde(Sessions.guest(), await Acde.guest(open), null, null, timeout)
  }

  static async guest(open?: () => Promise<Duplex>): Promise<DevClient> {
    const tunnel = await (open ?? Acde.#managerSocket)()
    const client = DevClient.over(tunnel)
    client.send({ type: 'hello', role: 'dev' })
    return client
  }

  static async #managerSocket(): Promise<Duplex> {
    const { Machine } = await import('../vm/machine.ts')
    try {
      return await new Machine().devd().socket()
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new Error(`--session vm: no session in the guest of acdev vm answers (${why}); acdev vm start, then log in`)
    }
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
      ...(options.force ? ['--force'] : []),
      '--verbose',
    ]
    const env = cliEnv(runtime, { ...process.env, ...options.env, ACDEV_FOLLOWED: '1' })
    const child = Runtime.spawn(argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const logs = new Logs()
    logs.follow(child.process.stdout!, 'stdout')
    logs.follow(child.process.stderr!, 'stderr')
    let exited: number | null = null
    void child.gone.catch(() => -1).then(async (code) => {
      await logs.drained(Acde.DRAIN_MS)
      exited = code
    })
    const dir = Sessions.dir({ ...process.env, ...options.env })
    const limit = options.startTimeout ?? Acde.START_TIMEOUT_MS
    const deadline = Date.now() + limit
    const since = Date.now() - 1_000
    const within = `within ${Math.round(limit / 1000)} s`
    const last = 'last output:'
    const seen = { pages: 0, windows: 0, lost: false }
    const late = () => {
      const state = seen.lost
        ? 'acdev runtime closed the connection, and acdev dev has not exited'
        : `acdev runtime runs and answers, but no window appeared (pages: ${seen.pages}, windows: ${seen.windows}) `
          + 'and no approval prompt waits'
      return LaunchError.stalled('window', `acdev dev did not start ${within}:\n${state}; ${last}`, logs)
    }
    const unregistered = () => {
      const others = Sessions.list(dir).filter((s) => s.pid !== child.pid && s.started >= since)
      const instead = others.length
        ? '; another process registered instead (acdev dev handed over to it):\n' +
          others.map((s) => `  ${Sessions.describe(s)}`).join('\n')
        : ` in ${dir}`
      const state = others.length ? last
        : `no session yet: its build did not finish, or acdev runtime did not start listening; ${last}`
      const head = `acdev dev (pid ${child.pid}) did not register a session ${within}${instead}\n${state}`
      return LaunchError.stalled('session', head, logs)
    }
    const alive = () => {
      if (exited !== null)
        throw LaunchError.stalled('exited', `acdev dev exited (${exited}) before it was ready:`, logs, exited)
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
        try {
          const { webs, windows } = await acde.#shown()
          seen.pages = webs.length
          seen.windows = windows.length
          return Ready.ready(webs, windows) || (await acde.#prompting()) || null
        } catch (error) {
          if (!acde.closed) throw error
          seen.lost = true
          return null
        }
      }, late)
      return acde
    } catch (error) {
      await Acde.#stop(child)
      await logs.drained(Acde.DRAIN_MS)
      Acde.#release(child)
      if (error instanceof LaunchError) throw error
      const said = error instanceof Error ? error.message : String(error)
      throw new LaunchError('failed', said, logs, { cause: error })
    }
  }

  static async #stop(child: Child, quitting = false): Promise<void> {
    const timer = new AbortController()
    const gone = child.gone.catch(() => -1)
    const late = sleep(Acde.STOP_MS, null, { signal: timer.signal }).catch(() => null)
    const windows = process.platform === 'win32'
    if (!windows) child.kill('SIGTERM')
    try {
      if ((!windows || quitting) && (await Promise.race([gone, late])) !== null) return
      Runtime.killTree(child)
      await gone
    } finally {
      timer.abort()
    }
  }

  static #release(child: Child): void {
    child.process.stdout?.destroy()
    child.process.stderr?.destroy()
  }

  static async #connect(session: Session): Promise<DevClient> {
    try {
      return await DevClient.connect(session.endpoint)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        Sessions.remove(session.pid)
        throw new Error(`acdev dev ${session.pid} is gone (nothing answers on ${session.endpoint})`)
      }
      throw error
    }
  }

  async ready(): Promise<boolean> {
    const { webs, windows } = await this.#shown()
    return Ready.ready(webs, windows)
  }

  async #shown(): Promise<{ webs: Web[]; windows: InspectWindow[] }> {
    const [webs, windows] = await Promise.all([this.webs(), this.windows()])
    return { webs, windows }
  }

  get closed(): boolean {
    return this.#client.ended
  }

  get desktop(): AppWindow {
    return new AppWindow(this, { ref: 'w0' })
  }

  window(match: WindowMatch | string): AppWindow {
    if (typeof match !== 'string') return new AppWindow(this, match)
    return new AppWindow(this, /^w\d+$/.test(match) ? { ref: match } : { app: match })
  }

  async webs(): Promise<Web[]> {
    return [...(await this.webList()).webs]
  }

  async webList(): Promise<WebList> {
    const answer = (await this.#request('webs')) as { webs?: Web[]; locked?: unknown } | null
    if (!Array.isArray(answer?.webs)) throw new Error('acdev runtime answered webs without a list')
    return { webs: answer.webs, locked: typeof answer.locked === 'boolean' ? answer.locked : null }
  }

  async devtools(): Promise<unknown> {
    return await this.#request('devtools')
  }

  async evaluate<T = unknown>(web: string, code: string): Promise<NoInfer<T>> {
    return ((await this.#request('eval', { web, code })) as { value: T }).value
  }

  async evaluateOn<T = unknown>(web: string, node: number, fn: string, arg: unknown = null): Promise<NoInfer<T>> {
    return ((await this.#request('eval', { web, node, code: fn, arg })) as { value: T }).value
  }

  async screenshot(web: string, options: { readonly path?: string } = {}): Promise<Shot> {
    type Answer = { png?: unknown; width?: unknown; height?: unknown } | null
    const answer = (await this.#request('shot', { web })) as Answer
    if (typeof answer?.png !== 'string') throw new Error('acdev runtime answered shot without a png')
    const png = Buffer.from(answer.png, 'base64')
    const path = options.path === undefined ? null : resolve(options.path)
    if (path !== null) writeFileSync(path, png)
    return { png, width: Number(answer.width) || 0, height: Number(answer.height) || 0, path }
  }

  async snapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
    const answer = (await this.#request('snapshot', { ...options })) as Snapshot | null
    if (typeof answer?.text !== 'string') throw new Error('acdev runtime answered snapshot without text')
    return { text: answer.text, windows: answer.windows ?? [], trees: answer.trees ?? {} }
  }

  async query(options: QueryOptions): Promise<QueryResult> {
    const answer = (await this.#request('query', { ...options })) as QueryResult | null
    if (!Array.isArray(answer?.nodes)) throw new Error('acdev runtime answered query without nodes')
    return answer
  }

  async console(options: ConsoleOptions = {}): Promise<DevPage<ConsoleEntry>> {
    return PageLogs.read<ConsoleEntry>('console', options, (args) => this.#request('console', args), this.guest)
  }

  async network(options: NetworkOptions = {}): Promise<DevPage<RequestEntry>> {
    return PageLogs.read<RequestEntry>('network', options, (args) => this.#request('network', args), this.guest)
  }

  async screen(options: { readonly path?: string } = {}): Promise<Shot> {
    if (this.guest) return await this.#guestScreen(options.path)
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

  async #guestScreen(given: string | undefined): Promise<Shot> {
    const answer = (await this.#request('screen')) as { png?: unknown; width?: unknown; height?: unknown } | null
    if (typeof answer?.png !== 'string') throw new Error('the session in the guest answered screen without a png')
    const png = Buffer.from(answer.png, 'base64')
    const path = given === undefined ? null : resolve(given)
    if (path !== null) writeFileSync(path, png)
    return { png, width: Number(answer.width) || 0, height: Number(answer.height) || 0, path }
  }

  async emulate(options: Emulation): Promise<Emulated> {
    return this.trace.step(`emulate(${JSON.stringify(options)})`,
      async () => (await this.#request('emulate', { ...options })) as Emulated)
  }

  async appearance(change: AppearanceChange = {}): Promise<Appearance> {
    return this.trace.step(`appearance(${JSON.stringify(change)})`,
      async () => (await this.#request('appearance', { ...change })) as Appearance)
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
      if (typeof answer?.id !== 'number') throw new Error(`acdev runtime answered route with ${JSON.stringify(answer)}`)
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
      throw new Error(`acdev runtime answered permissions with ${JSON.stringify(answer)}`)
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

  async revoke(app: string, capability: PermissionDecision['capability']): Promise<boolean> {
    return this.trace.step(`revoke(${JSON.stringify(app)}, ${JSON.stringify(capability)})`, async () => {
      const answer = (await this.#request('revoke', { app, capability })) as { revoked?: unknown } | null
      if (typeof answer?.revoked !== 'boolean')
        throw new Error(`acdev runtime answered revoke with ${JSON.stringify(answer)}`)
      return answer.revoked
    }, (revoked) => (revoked ? 'revoked' : 'nothing to revoke'))
  }

  async drop(files: string | readonly string[], options: DropOptions = {}): Promise<Dropped> {
    const local = (typeof files === 'string' ? [files] : files).map((file) => resolve(file))
    if (local.length === 0) throw new Error('drop: give at least one file')
    if ((options.x === undefined) !== (options.y === undefined)) throw new Error('drop: give x and y together')
    const list = this.guest ? await Acde.#stage(local) : local
    const args = {
      files: list,
      ...(options.web !== undefined && { web: options.web }),
      ...(options.x !== undefined && { x: options.x, y: options.y }),
    }
    return this.trace.step(`drop(${JSON.stringify(list)}${options.web ? `, ${options.web}` : ''})`, async () => {
      return Acde.dropped(await this.#request('drop', args), options.web ?? 'desktop')
    }, (dropped) => `onto ${dropped.web}`)
  }

  static dropped(answer: unknown, asked: string): Dropped {
    const given = answer as Partial<Dropped> | null
    if (typeof given?.window !== 'number' || !Array.isArray(given.files)) {
      throw new Error(`drop: the session gave an unexpected answer: ${JSON.stringify(answer)}`)
    }
    return { web: typeof given.web === 'string' ? given.web : asked, window: given.window, files: given.files }
  }

  static async #stage(files: readonly string[]): Promise<string[]> {
    const [{ Machine }, { stageInGuest }] = await Promise.all([import('../vm/machine.ts'), import('../vm/guest.ts')])
    return await stageInGuest(new Machine().devd(), files)
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

  async pointer(x: number, y: number): Promise<{ x: number; y: number }> {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error('pointer: x and y are numbers in screen coordinates')
    return this.trace.step(`pointer(${x}, ${y})`, async () => {
      const answer = (await this.#request('pointer', { x, y })) as { x?: unknown; y?: unknown } | null
      if (typeof answer?.x !== 'number' || typeof answer.y !== 'number') {
        throw new Error(`acdev runtime answered pointer with ${JSON.stringify(answer)}`)
      }
      return { x: answer.x, y: answer.y }
    })
  }

  async call(target: Call.CallTarget, method: string, params?: unknown): Promise<unknown> {
    return Call.run({ guest: this.guest, trace: this.trace, request: (body) => this.#request('call', body) }, target, method, params)
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

  async addInitScript(code: string, options: { readonly web?: string; readonly once?: boolean } = {}): Promise<number> {
    const args = { code, ...(options.web !== undefined && { web: options.web }), once: options.once === true }
    const answer = (await this.#request('init', args)) as { id?: unknown } | null
    if (typeof answer?.id !== 'number') throw new Error(`acdev runtime answered init with ${JSON.stringify(answer)}`)
    return answer.id
  }

  async removeInitScript(id?: number): Promise<{ removed: number; left: number }> {
    return (await this.#request('uninit', id === undefined ? {} : { init: id })) as { removed: number; left: number }
  }

  async reload(web: string): Promise<void> {
    await this.#request('reload', { web })
  }

  async resize(web: string, width: number, height: number): Promise<{ width: number; height: number }> {
    return (await this.#request('resize', { web, width, height })) as { width: number; height: number }
  }

  async answerDialog(web: string, answer: DialogAnswer = {}): Promise<void> {
    const args = { web, accept: answer.accept !== false, ...(answer.text !== undefined && { text: answer.text }) }
    const step = `answerDialog(${JSON.stringify(web)}, ${JSON.stringify(answer)})`
    await this.trace.step(step, () => this.#request('dialog', args))
  }

  async dialogs(options: { readonly web?: string } = {}): Promise<Dialog[]> {
    const entries: ConsoleEntry[] = []
    let since = 0
    for (;;) {
      const web = options.web !== undefined && { web: options.web }
      const page = await this.console({ since, limit: 5000, level: 'info', ...web })
      entries.push(...page.entries)
      if (page.entries.length < 5000) break
      since = page.next
    }
    return entries.flatMap((e) => (e.kind === 'dialog' && e.dialog ? [e.dialog] : []))
  }

  async waitForDialog(
    options: { readonly web?: string; readonly type?: DialogType; readonly timeout?: number } = {},
  ): Promise<Dialog> {
    const since = (await this.console({ limit: 1 })).next
    const ms = options.timeout ?? this.timeout
    return Poll.until(ms, async () => {
      const web = options.web !== undefined && { web: options.web }
      const page = await this.console({ since, limit: 5000, level: 'info', ...web })
      const wanted = (dialog: Dialog) => options.type === undefined || dialog.type === options.type
      return page.entries.find((e) => e.kind === 'dialog' && e.dialog && wanted(e.dialog))?.dialog ?? null
    }, () => `waitForDialog: no ${options.type ?? 'dialog'} within ${ms} ms`)
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
    return this.trace.step(`act(${shown})`, async () => {
      this.#connected()
      const placed = this.guest && GuestPlace.ACTIONS.has(action) && /^w\d+$/.test(ref)
      if (placed) {
        const host = { windows: () => this.windows(), request: (op: string, body: Readonly<Record<string, unknown>>) => this.#client.request(op, body) }
        return GuestPlace.act(host, ref, action as PlaceAction, arg)
      }
      try {
        const sent = () => this.#client.request('act', { ref, action, ...(given && { arg }) })
        return Acde.#result(await Gone.ask(sent, { op: 'act', guest: this.guest }))
      } catch (error) {
        const ended = action === 'close' ? this.endedBy(ref) : null
        if (ended === null) throw error
        return ended
      }
    }, Acde.#said)
  }

  endedBy(ref: string): ActResult | null {
    if (!this.#client.ended || this.#closing || this.session.desktop !== null || !/^w\d+$/.test(ref)) return null
    const text = `closed ${ref}; acdev runtime exited with it, so acdev dev ${this.session.pid} ended`
    return { ok: true, text, ended: true }
  }

  async clock(web: string, request: Readonly<Record<string, unknown>>): Promise<ClockState> {
    const state = (await this.#request('clock', { web, ...request })) as ClockState | null
    if (typeof state?.installed !== 'boolean')
      throw new Error(`acdev runtime answered clock with ${JSON.stringify(state)}`)
    return state
  }

  async input(web: string, events: readonly InputEvent[]): Promise<ActResult> {
    return Acde.inputResult(await this.#request('input', { web, events: paced(events) }))
  }

  static inputResult(answer: unknown): ActResult {
    const guest = answer as { done?: unknown; textSkipped?: unknown } | null
    if (typeof guest?.done !== 'boolean') return Acde.#result(answer)
    const skipped = Number(guest.textSkipped) || 0
    if (skipped > 0) {
      return {
        ok: false,
        text: `${skipped} character${skipped === 1 ? '' : 's'} of the text did not reach the page: in the guest, injected text keeps `
          + 'only ASCII in web pages; type it with act type or settext, which go through the page',
      }
    }
    return { ok: guest.done, text: guest.done ? 'done' : 'not done' }
  }

  get guest(): boolean {
    return Sessions.isGuest(this.session)
  }

  async typeInPage(web: string, text: string): Promise<ActResult> {
    const page = (await this.webs()).find((w) => w.name === web || w.app === web || (web === 'desktop' && w.kind === 'desktop'))
    const window = page && (await this.windows()).find((w) => w.id === page.window)
    if (!window) return { ok: false, text: `no window shows ${web} to type into` }
    const focused = (await this.query({ selector: ':focus', window: window.ref, limit: 1 })).nodes[0]
    if (!focused) return { ok: false, text: `nothing has the focus in ${web} to type ${JSON.stringify(text)} into` }
    return await this.act(focused.ref, 'type', text)
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

  async openWith(given: OpenTarget): Promise<ActResult> {
    const shown = [given.name, given.path, given.url].filter((v) => v !== undefined).map((v) => JSON.stringify(v)).join(', ')
    return this.trace.step(`openWith(${shown})`, async () => Acde.#result(await this.#request('open', { ...given })))
  }

  async webOf(window: number): Promise<Web> {
    const web = (await this.webs()).find((w) => w.window === window)
    if (!web) throw new Error(`window ${window} has no running page`)
    return web
  }

  async close(): Promise<void> {
    this.#closing = true
    if (this.#owned) this.#client.send({ type: 'quit' })
    this.#client.close()
    if (!this.#owned) return
    const { child, dir } = this.#owned
    await Acde.#stop(child, true)
    await this.logs?.drained(Acde.DRAIN_MS)
    Acde.#release(child)
    Sessions.removeIfCurrent(this.session, dir)
  }

  async #request(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.#connected()
    try {
      return await Gone.ask(() => this.#client.request(op, args), { op, guest: this.guest })
    } catch (error) {
      throw Acde.unsupported(op, error)
    }
  }

  static unsupported(op: string, error: unknown): unknown {
    if (!(error instanceof Error) || !error.message.startsWith(`no op ${op} (`)) return error
    return new Error(`this acdev runtime does not support ${op}; acdev doctor checks the pairing`, { cause: error })
  }

  #connected(): void {
    if (!this.#client.ended) return
    const what = Sessions.isGuest(this.session) ? 'the session in the guest' : `acdev dev ${this.session.pid}`
    throw new Error(`${what} is no longer connected`)
  }

  static #result(answer: unknown): ActResult {
    const result = answer as { ok?: unknown; text?: unknown } | null
    if (typeof result?.text !== 'string') throw new Error(`acdev runtime answered with ${JSON.stringify(answer)}`)
    return { ok: result.ok !== false, text: result.text }
  }
}
