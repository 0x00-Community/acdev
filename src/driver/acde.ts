import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Subprocess } from 'bun'
import { readFileSync as readBytes, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { InspectAction, InspectMatch, InspectNode, InspectWindow } from '@dopame/acde-api'
import { cliEnv, cliFile, findBun } from 'acde/launcher'
import { DevClient } from '../ipc.ts'
import { Sessions, type Session } from '../sessions.ts'
import { Logs } from './logs.ts'
import { Poll } from './poll.ts'
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
  readonly kind: 'fetch' | 'xhr' | 'websocket' | 'eventsource'
  readonly method: string
  readonly url: string
  readonly requestBytes: number
  readonly status: number | null
  readonly statusText: string | null
  readonly responseBytes: number | null
  readonly ms: number | null
  readonly error: string | null
  readonly done: boolean
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

export interface ScreenShot {
  readonly png: Buffer
  readonly width: number
  readonly height: number
  readonly path: string | null
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

export interface Step {
  readonly ref: string
  readonly action: InspectAction
  readonly arg?: string | number | null
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
  timeout: number
  readonly #client: DevClient
  readonly #child: Subprocess<'ignore', 'pipe', 'pipe'> | null
  #closed = false

  private constructor(session: Session, client: DevClient, child: Subprocess<'ignore', 'pipe', 'pipe'> | null, logs: Logs | null, timeout: number) {
    this.session = session
    this.#client = client
    this.#child = child
    this.logs = logs
    this.timeout = timeout
    client.closed.then(() => {
      this.#closed = true
    })
  }

  static async attach(options: AttachOptions = {}): Promise<Acde> {
    const session = Sessions.pick(Sessions.list(Sessions.dir({ ...process.env, ...options.env })), options.cwd ?? process.cwd(), options.session)
    return new Acde(session, await Acde.#connect(session), null, null, options.timeout ?? Acde.TIMEOUT_MS)
  }

  static async launch(options: LaunchOptions = {}): Promise<Acde> {
    const cwd = resolve(options.cwd ?? process.cwd())
    const bun = await findBun()
    const argv = [
      bun,
      cliFile(),
      'dev',
      ...(options.dirs ?? []).map((dir) => resolve(cwd, dir)),
      ...(options.desktop !== undefined ? ['--desktop', options.desktop] : []),
      ...(options.app !== undefined ? ['--app', options.app] : []),
      ...(options.out !== undefined ? ['--out', options.out] : []),
      ...(options.headless ? ['--headless'] : []),
    ]
    const child = Bun.spawn(argv, { cwd, env: cliEnv(bun, { ...process.env, ...options.env }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const logs = new Logs()
    logs.follow(child.stdout, 'stdout')
    logs.follow(child.stderr, 'stderr')
    let exited: number | null = null
    void child.exited.then((code) => {
      exited = code
    })
    const dir = Sessions.dir({ ...process.env, ...options.env })
    const limit = options.startTimeout ?? Acde.START_TIMEOUT_MS
    const deadline = Date.now() + limit
    const late = () => `acde dev did not start within ${Math.round(limit / 1000)} s:\n${logs.tail(40).text}`
    const alive = () => {
      if (exited !== null) throw new Error(`acde dev exited (${exited}) before it was ready:\n${logs.tail(40).text}`)
    }
    try {
      const session = await Poll.until(limit, () => {
        alive()
        return Sessions.list(dir).find((s) => s.pid === child.pid) ?? null
      }, late)
      const acde = new Acde(session, await Acde.#connect(session), child, logs, options.timeout ?? Acde.TIMEOUT_MS)
      await Poll.until(Math.max(0, deadline - Date.now()), async () => {
        alive()
        return (await acde.ready()) || null
      }, late)
      return acde
    } catch (error) {
      child.kill('SIGTERM')
      await child.exited
      throw error
    }
  }

  static root(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'acde') return dir
      if (dirname(dir) === dir) throw new Error(`the acde package is not above ${fileURLToPath(import.meta.url)}`)
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

  get launched(): boolean {
    return this.#child !== null
  }

  get desktop(): AppWindow {
    return new AppWindow(this, { ref: 'w0' })
  }

  window(match: WindowMatch | string): AppWindow {
    return new AppWindow(this, typeof match === 'string' ? (/^w\d+$/.test(match) ? { ref: match } : { app: match }) : match)
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

  async screen(options: { readonly path?: string } = {}): Promise<ScreenShot> {
    const scratch = options.path === undefined ? mkdtempSync(join(tmpdir(), 'acde-screen-')) : null
    const path = options.path === undefined ? join(scratch!, 'screen.png') : resolve(options.path)
    try {
      const answer = (await this.#request('screen', { path })) as { width?: unknown; height?: unknown } | null
      return { png: readBytes(path), width: Number(answer?.width) || 0, height: Number(answer?.height) || 0, path: scratch === null ? path : null }
    } finally {
      if (scratch !== null) rmSync(scratch, { recursive: true, force: true })
    }
  }

  async emulate(options: Emulation): Promise<{ colorScheme: 'light' | 'dark'; emulated: boolean; reducedMotion: boolean }> {
    return (await this.#request('emulate', { ...options })) as { colorScheme: 'light' | 'dark'; emulated: boolean; reducedMotion: boolean }
  }

  async chooseFolder(folder: string | null): Promise<void> {
    await this.#request('choose', { folder: folder === null ? null : resolve(folder) })
  }

  async windows(): Promise<InspectWindow[]> {
    return [...(await this.snapshot({ tree: false })).windows]
  }

  async act(ref: string, action: InspectAction, arg?: string | number | null): Promise<ActResult> {
    return Acde.#result(await this.#request('act', { ref, action, ...(arg !== undefined && arg !== null && { arg }) }))
  }

  async run(steps: readonly Step[]): Promise<ActResult> {
    return Acde.#result(await this.#request('run', { steps: steps.map((s) => ({ ref: s.ref, action: s.action, text: s.arg ?? null })) }))
  }

  async open(name: string, options: { readonly timeout?: number } = {}): Promise<AppWindow> {
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
    const child = this.#child
    if (!child) return
    child.kill('SIGTERM')
    const stopped = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)])
    if (stopped === null) {
      child.kill('SIGKILL')
      await child.exited
    }
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
