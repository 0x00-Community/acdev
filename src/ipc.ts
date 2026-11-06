import { chmodSync, rmSync } from 'node:fs'
import net from 'node:net'
import { dirname } from 'node:path'
import { Sessions } from './sessions.ts'

export type Message = Readonly<Record<string, unknown>>

export interface Response {
  readonly type: 'response'
  readonly id: unknown
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

export class Lines {
  static read(socket: net.Socket, line: (message: Message) => void, bad: (text: string) => void = () => undefined): void {
    socket.setEncoding('utf8')
    let parts: string[] = []
    socket.on('data', (chunk: string) => {
      let start = 0
      for (let end = chunk.indexOf('\n'); end >= 0; end = chunk.indexOf('\n', start)) {
        parts.push(chunk.slice(start, end))
        const text = parts.join('')
        parts = []
        start = end + 1
        if (!text.trim()) continue
        let message: unknown
        try {
          message = JSON.parse(text)
        } catch {
          bad(text)
          continue
        }
        if (typeof message === 'object' && message !== null && !Array.isArray(message)) line(message as Message)
        else bad(text)
      }
      if (start < chunk.length) parts.push(chunk.slice(start))
    })
  }

  static write(socket: net.Socket, message: Message): void {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
  }
}

interface Pending {
  readonly tool: net.Socket
  readonly id: unknown
  readonly op: string
  readonly message: Message
  readonly timer: ReturnType<typeof setTimeout>
  sent: boolean
}

interface Runtime {
  readonly socket: net.Socket
  readonly pid: number | null
  readonly legacy: boolean
}

export interface DevServerOptions {
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

export class DevServer {
  static readonly TIMEOUT_MS = 30_000

  readonly endpoint: string
  readonly #timeoutMs: number
  readonly #log: (line: string) => void
  readonly #server: net.Server
  readonly #tools = new Set<net.Socket>()
  readonly #pending = new Map<number, Pending>()
  #runtime: Runtime | null = null
  #next = 1

  constructor(options: DevServerOptions = {}) {
    this.endpoint = options.endpoint ?? DevServer.endpoint()
    this.#timeoutMs = options.timeoutMs ?? DevServer.TIMEOUT_MS
    this.#log = options.log ?? ((line) => console.error(`acde: ${line}`))
    this.#server = net.createServer((socket) => this.#accept(socket))
  }

  static endpoint(pid = process.pid): string {
    return process.platform === 'win32' ? `\\\\.\\pipe\\acde-dev-${pid}` : Sessions.socket(pid)
  }

  get runtime(): { readonly pid: number | null; readonly legacy: boolean } | null {
    return this.#runtime && { pid: this.#runtime.pid, legacy: this.#runtime.legacy }
  }

  async listen(): Promise<void> {
    const unix = process.platform !== 'win32'
    if (unix) {
      Sessions.prepare(dirname(this.endpoint))
      rmSync(this.endpoint, { force: true })
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.endpoint, () => {
        this.#server.off('error', reject)
        resolve()
      })
    })
    if (unix) chmodSync(this.endpoint, 0o600)
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.#pending) this.#answer(id, pending, { ok: false, error: 'acde dev is stopping' })
    for (const tool of this.#tools) tool.end(() => tool.destroy())
    this.#runtime?.socket.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
    if (process.platform !== 'win32') rmSync(this.endpoint, { force: true })
  }

  send(message: Message): boolean {
    if (!this.#runtime) return false
    Lines.write(this.#runtime.socket, message)
    return true
  }

  #accept(socket: net.Socket): void {
    let role: 'runtime' | 'tool' | null = null
    socket.on('error', () => undefined)
    Lines.read(
      socket,
      (message) => {
        if (role === null) {
          role = this.#hello(socket, message)
          return
        }
        if (role === 'runtime') this.#fromRuntime(message)
        else this.#fromTool(socket, message)
      },
      (text) => this.#log(`dev IPC: not a JSON object: ${text.slice(0, 200)}`),
    )
    socket.on('close', () => {
      if (role === 'tool') this.#dropTool(socket)
      if (role === 'runtime' && this.#runtime?.socket === socket) this.#dropRuntime()
    })
  }

  #hello(socket: net.Socket, message: Message): 'runtime' | 'tool' | null {
    if (message['type'] !== 'hello') {
      this.#log(`dev IPC: the first message must be hello, not ${JSON.stringify(message).slice(0, 200)}`)
      socket.destroy()
      return null
    }
    if (message['role'] === 'tool') {
      this.#tools.add(socket)
      return 'tool'
    }
    if (message['role'] !== undefined && message['role'] !== 'runtime') {
      this.#log(`dev IPC: unknown role ${JSON.stringify(message['role'])}`)
      socket.destroy()
      return null
    }
    if (this.#runtime) {
      this.#log(`dev IPC: a second runtime (pid ${String(message['pid'])}) connected while acdert ${String(this.#runtime.pid)} is; closing it`)
      socket.destroy()
      return null
    }
    const pid = typeof message['pid'] === 'number' ? message['pid'] : null
    this.#runtime = { socket, pid, legacy: message['role'] === undefined }
    for (const [id, pending] of this.#pending) if (!pending.sent) this.#forward(id, pending)
    return 'runtime'
  }

  #fromTool(tool: net.Socket, message: Message): void {
    const id = message['id']
    if (message['type'] !== 'request') {
      if (id !== undefined) Lines.write(tool, { type: 'response', id, ok: false, error: `acde dev: ${JSON.stringify(message['type'])} is not a request` })
      return
    }
    const op = message['op']
    if (typeof op !== 'string' || !op) {
      Lines.write(tool, { type: 'response', id: id ?? null, ok: false, error: 'acde dev: a request needs an "op"' })
      return
    }
    const own = this.#next++
    const timer = setTimeout(() => {
      const pending = this.#pending.get(own)
      if (pending) this.#answer(own, pending, { ok: false, error: this.#timedOut(pending) })
    }, this.#timeoutMs)
    const pending: Pending = { tool, id, op, message, timer, sent: false }
    this.#pending.set(own, pending)
    if (this.#runtime) this.#forward(own, pending)
  }

  #forward(own: number, pending: Pending): void {
    const runtime = this.#runtime!
    if (runtime.legacy) {
      const who = runtime.pid === null ? 'acdert' : `acdert (pid ${runtime.pid})`
      this.#answer(own, pending, { ok: false, error: `${who} is older than the dev tools: its hello has no role and it ignores "${pending.op}"; build or install a newer acdert` })
      return
    }
    pending.sent = true
    Lines.write(runtime.socket, { ...pending.message, id: own })
  }

  #fromRuntime(message: Message): void {
    if (message['type'] !== 'response') return
    const own = message['id']
    const pending = typeof own === 'number' ? this.#pending.get(own) : undefined
    if (!pending) return
    const ok = message['ok'] === true
    this.#answer(own as number, pending, ok ? { ok, result: message['result'] ?? null } : { ok, error: typeof message['error'] === 'string' ? message['error'] : 'acdert failed without saying why' })
  }

  #answer(own: number, pending: Pending, answer: { ok: boolean; result?: unknown; error?: string }): void {
    clearTimeout(pending.timer)
    this.#pending.delete(own)
    Lines.write(pending.tool, { type: 'response', id: pending.id, ...answer })
  }

  #timedOut(pending: Pending): string {
    const seconds = Math.round(this.#timeoutMs / 1000)
    if (!pending.sent) return `timed out: acdert did not connect to acde dev within ${seconds} s`
    return `timed out: acdert did not answer "${pending.op}" within ${seconds} s`
  }

  #dropTool(tool: net.Socket): void {
    this.#tools.delete(tool)
    for (const [own, pending] of this.#pending) {
      if (pending.tool !== tool) continue
      clearTimeout(pending.timer)
      this.#pending.delete(own)
    }
  }

  #dropRuntime(): void {
    this.#runtime = null
    for (const [own, pending] of this.#pending) if (pending.sent) this.#answer(own, pending, { ok: false, error: `acdert disconnected before answering "${pending.op}"` })
  }
}

export class DevClient {
  static readonly TIMEOUT_MS = DevServer.TIMEOUT_MS + 5_000

  readonly #socket: net.Socket
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  #next = 1
  #closed: Error | null = null

  private constructor(socket: net.Socket) {
    this.#socket = socket
    Lines.read(socket, (message) => this.#response(message))
    socket.on('close', () => this.#fail(this.#closed ?? new Error('acde dev closed the connection')))
    socket.on('error', (error) => {
      this.#closed = error
    })
  }

  static connect(endpoint: string): Promise<DevClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.off('error', reject)
        Lines.write(socket, { type: 'hello', role: 'tool' })
        resolve(new DevClient(socket))
      })
    })
  }

  request(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (this.#closed || this.#socket.destroyed) return Promise.reject(this.#closed ?? new Error('acde dev closed the connection'))
    const id = this.#next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        reject(new Error(`acde dev did not answer "${op}" within ${Math.round(DevClient.TIMEOUT_MS / 1000)} s`))
      }, DevClient.TIMEOUT_MS)
      this.#waiting.set(id, { resolve, reject, timer })
      Lines.write(this.#socket, { ...args, type: 'request', id, op })
    })
  }

  close(): void {
    this.#socket.end()
  }

  #response(message: Message): void {
    const id = message['id']
    const waiting = typeof id === 'number' ? this.#waiting.get(id) : undefined
    if (message['type'] !== 'response' || !waiting) return
    clearTimeout(waiting.timer)
    this.#waiting.delete(id as number)
    if (message['ok'] === true) waiting.resolve(message['result'] ?? null)
    else waiting.reject(new Error(typeof message['error'] === 'string' ? message['error'] : 'failed without saying why'))
  }

  #fail(error: Error): void {
    for (const [id, waiting] of this.#waiting) {
      clearTimeout(waiting.timer)
      this.#waiting.delete(id)
      waiting.reject(error)
    }
  }
}
