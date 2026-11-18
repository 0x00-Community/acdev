import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { Duplex } from 'node:stream'
import { CHECKOUT, crateBinary } from './binary.ts'

type Reply = { return?: unknown; error?: { class?: string; desc?: string }; event?: string }

export function relayed(path: string, env: NodeJS.ProcessEnv = process.env): Duplex {
  const binary = crateBinary(CHECKOUT, { crate: 'relay', name: 'acdev-relay', variable: 'ACDEV_RELAY' }, env)
  const child = spawn(binary, [path], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let failed = ''
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      child.stdin.write(chunk, done)
    },
    final(done) {
      child.stdin.end()
      done()
    },
    destroy(error, done) {
      child.kill()
      done(error)
    },
  })
  child.stdout.on('data', (chunk: Buffer) => stream.push(chunk))
  child.stdout.on('end', () => stream.push(null))
  child.stderr.on('data', (chunk: Buffer) => {
    failed += chunk.toString()
  })
  child.stdin.on('error', () => {})
  child.on('error', (error) => stream.destroy(error))
  child.on('exit', (code) => {
    if (code !== 0) stream.destroy(new Error(failed.trim() || `acdev-relay exited with ${code}`))
  })
  return stream
}

export class Channel {
  readonly #socket: Duplex
  #buffer = ''
  readonly #lines: string[] = []
  #waiting: ((line: string) => void) | null = null
  #failed: Error | null = null

  private constructor(socket: Duplex) {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.#take(chunk))
    socket.on('error', (error) => this.#fail(error))
    socket.on('close', () => this.#fail(new Error('the socket closed')))
  }

  static open(path: string): Promise<Channel> {
    if (process.platform === 'win32') return Promise.resolve(new Channel(relayed(path)))
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      socket.once('connect', () => resolve(new Channel(socket)))
      socket.once('error', reject)
    })
  }

  #take(chunk: string): void {
    this.#buffer += chunk
    for (let end = this.#buffer.indexOf('\n'); end >= 0; end = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, end).trim()
      this.#buffer = this.#buffer.slice(end + 1)
      if (line) this.#push(line)
    }
  }

  #push(line: string): void {
    const waiting = this.#waiting
    if (!waiting) {
      this.#lines.push(line)
      return
    }
    this.#waiting = null
    waiting(line)
  }

  #fail(error: Error): void {
    this.#failed ??= error
    const waiting = this.#waiting
    this.#waiting = null
    waiting?.('')
  }

  line(timeoutMs: number): Promise<string> {
    const ready = this.#lines.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    if (this.#failed) return Promise.reject(this.#failed)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = null
        reject(new Error(`no answer in ${timeoutMs} ms`))
      }, timeoutMs)
      this.#waiting = (line) => {
        clearTimeout(timer)
        if (line) resolve(line)
        else reject(this.#failed ?? new Error('the socket closed'))
      }
    })
  }

  send(command: string, args?: unknown): void {
    this.#socket.write(`${JSON.stringify(args === undefined ? { execute: command } : { execute: command, arguments: args })}\n`)
  }

  async reply(timeoutMs: number): Promise<unknown> {
    for (;;) {
      const message = JSON.parse(await this.line(timeoutMs)) as Reply
      if (message.event) continue
      if (message.error) throw new Error(`${message.error.class ?? 'error'}: ${message.error.desc ?? ''}`)
      return message.return
    }
  }

  async call(command: string, args?: unknown, timeoutMs = 30_000): Promise<unknown> {
    this.send(command, args)
    return this.reply(timeoutMs)
  }

  close(): void {
    this.#socket.destroy()
  }
}

export async function monitor(path: string, command: string, args?: unknown, timeoutMs = 120_000): Promise<unknown> {
  const channel = await Channel.open(path)
  try {
    await channel.line(10_000)
    await channel.call('qmp_capabilities')
    return await channel.call(command, args, timeoutMs)
  } finally {
    channel.close()
  }
}

type ExecStatus = { exited: boolean; exitcode?: number; signal?: number; 'out-data'?: string; 'err-data'?: string }

export interface ExecResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export class GuestAgent {
  static readonly CHUNK = 1 << 20
  readonly #channel: Channel

  private constructor(channel: Channel) {
    this.#channel = channel
  }

  static async open(path: string, timeoutMs = 10_000): Promise<GuestAgent> {
    const channel = await Channel.open(path)
    const id = Math.floor(Math.random() * 2 ** 31)
    channel.send('guest-sync', { id })
    try {
      for (;;) {
        const answer = await channel.reply(timeoutMs).catch((error: Error) => {
          if (error instanceof SyntaxError) return undefined
          throw error
        })
        if (answer === id) return new GuestAgent(channel)
      }
    } catch (error) {
      channel.close()
      throw error
    }
  }

  static async ping(path: string, seconds: number): Promise<boolean> {
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      try {
        const agent = await GuestAgent.open(path, 5_000)
        await agent.#channel.call('guest-ping')
        agent.close()
        return true
      } catch (error) {
        const said = (error as Error).message
        if (/os error 10022|\bEINVAL\b|invalid argument/i.test(said)) {
          throw new Error(`vm: cannot connect to ${path}: ${said} (a Unix socket there does not work; see docs/vm.md "Windows")`)
        }
        if (Date.now() > deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
  }

  async exec(command: string, timeoutMs: number): Promise<ExecResult> {
    const args = { path: '/bin/sh', arg: ['-c', command], 'capture-output': true }
    const started = (await this.#channel.call('guest-exec', args)) as { pid: number }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const status = (await this.#channel.call('guest-exec-status', { pid: started.pid })) as ExecStatus
      if (status.exited) {
        return {
          code: status.exitcode ?? 128 + (status.signal ?? 0),
          stdout: Buffer.from(status['out-data'] ?? '', 'base64'),
          stderr: Buffer.from(status['err-data'] ?? '', 'base64'),
        }
      }
      if (Date.now() > deadline) throw new Error(`still running after ${timeoutMs} ms: ${command}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  async write(remote: string, data: Buffer): Promise<void> {
    const handle = (await this.#channel.call('guest-file-open', { path: remote, mode: 'w' })) as number
    try {
      for (let done = 0; done < data.length; done += GuestAgent.CHUNK) {
        const chunk = data.subarray(done, done + GuestAgent.CHUNK).toString('base64')
        await this.#channel.call('guest-file-write', { handle, 'buf-b64': chunk }, 120_000)
      }
      await this.#channel.call('guest-file-flush', { handle })
    } finally {
      await this.#channel.call('guest-file-close', { handle })
    }
  }

  close(): void {
    this.#channel.close()
  }
}
