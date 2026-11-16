import { rmSync } from 'node:fs'
import net from 'node:net'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sessions } from './sessions.ts'

export type Message = Readonly<Record<string, unknown>>

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

export class DevClient {
  static readonly TIMEOUT_MS = 30_000
  static readonly RETRY_MS = 50
  static readonly CLOSE_MS = 1_000

  readonly closed: Promise<void>
  readonly #socket: net.Socket
  readonly #timeoutMs: number
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  #next = 1
  #closed: Error | null = null
  #ended = false
  /** Events acdert sends on its own (`{ type: 'event', event, ... }`), only to the connection that said hello as acde dev. */
  onEvent: (message: Message) => void = () => undefined

  private constructor(socket: net.Socket, timeoutMs: number) {
    this.#socket = socket
    this.#timeoutMs = timeoutMs
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()))
    Lines.read(socket, (message) => this.#response(message))
    socket.on('close', () => {
      this.#ended = true
      this.#fail(this.#closed ?? new Error('acdebin-dbg closed the connection'))
    })
    socket.on('error', (error) => {
      this.#closed = error
    })
  }

  static endpoint(pid = process.pid): string {
    return process.platform === 'win32' ? `\\\\.\\pipe\\acde-dev-${pid}` : Sessions.socket(pid)
  }

  static prepare(endpoint: string): void {
    if (process.platform === 'win32') return
    Sessions.prepare(dirname(endpoint))
    rmSync(endpoint, { force: true })
  }

  static connect(endpoint: string, timeoutMs = DevClient.TIMEOUT_MS): Promise<DevClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.off('error', reject)
        resolve(new DevClient(socket, timeoutMs))
      })
    })
  }

  static async reach(endpoint: string, alive: () => boolean, waiting?: () => void, waitMs = 10_000): Promise<DevClient | null> {
    const started = Date.now()
    let told = false
    while (alive()) {
      try {
        return await DevClient.connect(endpoint)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
      }
      if (!told && waiting && Date.now() - started >= waitMs) {
        told = true
        waiting()
      }
      await sleep(DevClient.RETRY_MS)
    }
    return null
  }

  get ended(): boolean {
    return this.#ended
  }

  send(message: Message): void {
    Lines.write(this.#socket, message)
  }

  request(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (this.#closed || this.#socket.destroyed)
      return Promise.reject(this.#closed ?? new Error('acdebin-dbg closed the connection'))
    const id = this.#next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        const seconds = Math.round(this.#timeoutMs / 1000)
        reject(new Error(`timed out: acdebin-dbg did not answer "${op}" within ${seconds} s`))
      }, this.#timeoutMs)
      this.#waiting.set(id, { resolve, reject, timer })
      Lines.write(this.#socket, { ...args, type: 'request', id, op })
    })
  }

  close(): void {
    this.#closed ??= new Error('the connection to acdebin-dbg was closed')
    this.#fail(this.#closed)
    const socket = this.#socket
    socket.end(() => socket.destroy())
    setTimeout(() => socket.destroy(), DevClient.CLOSE_MS).unref()
    socket.unref()
  }

  #response(message: Message): void {
    if (message['type'] === 'event' && typeof message['event'] === 'string') return this.onEvent(message)
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
