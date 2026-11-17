import { connect, type Socket } from 'node:net'
import { openSync, readSync, closeSync, statSync } from 'node:fs'

type Reply = { return?: unknown; error?: { class?: string; desc?: string }; event?: string }

class Channel {
  readonly #socket: Socket
  #buffer = ''
  readonly #lines: string[] = []
  #waiting: ((line: string) => void) | null = null
  #failed: Error | null = null

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk
      let end = this.#buffer.indexOf('\n')
      while (end >= 0) {
        const line = this.#buffer.slice(0, end).trim()
        this.#buffer = this.#buffer.slice(end + 1)
        if (line) this.#push(line)
        end = this.#buffer.indexOf('\n')
      }
    })
    socket.on('error', (error) => this.#fail(error))
    socket.on('close', () => this.#fail(new Error('the socket closed')))
  }

  static open(path: string): Promise<Channel> {
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      socket.once('connect', () => resolve(new Channel(socket)))
      socket.once('error', reject)
    })
  }

  #push(line: string): void {
    if (this.#waiting) {
      const waiting = this.#waiting
      this.#waiting = null
      waiting(line)
    } else {
      this.#lines.push(line)
    }
  }

  #fail(error: Error): void {
    this.#failed ??= error
    if (this.#waiting) {
      const waiting = this.#waiting
      this.#waiting = null
      waiting('')
    }
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

const CHUNK = 1 << 20

async function openAgent(path: string, timeoutMs: number): Promise<Channel> {
  const channel = await Channel.open(path)
  const id = Math.floor(Math.random() * 2 ** 31)
  channel.send('guest-sync', { id })
  for (;;) {
    const answer = await channel.reply(timeoutMs).catch((error: Error) => {
      if (error instanceof SyntaxError) return undefined
      throw error
    })
    if (answer === id) return channel
  }
}

async function openMonitor(path: string): Promise<Channel> {
  const channel = await Channel.open(path)
  await channel.line(10_000)
  await channel.call('qmp_capabilities')
  return channel
}

type ExecStatus = { exited: boolean; exitcode?: number; signal?: number; 'out-data'?: string; 'err-data'?: string }

async function exec(channel: Channel, command: string, timeoutMs: number): Promise<number> {
  const started = (await channel.call('guest-exec', { path: '/bin/sh', arg: ['-c', command], 'capture-output': true })) as { pid: number }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = (await channel.call('guest-exec-status', { pid: started.pid })) as ExecStatus
    if (status.exited) {
      if (status['out-data']) process.stdout.write(Buffer.from(status['out-data'], 'base64'))
      if (status['err-data']) process.stderr.write(Buffer.from(status['err-data'], 'base64'))
      return status.exitcode ?? 128 + (status.signal ?? 0)
    }
    if (Date.now() > deadline) throw new Error(`still running after ${timeoutMs} ms: ${command}`)
    await Bun.sleep(200)
  }
}

async function push(channel: Channel, local: string, remote: string): Promise<number> {
  const size = statSync(local).size
  const handle = (await channel.call('guest-file-open', { path: remote, mode: 'w' })) as number
  const fd = openSync(local, 'r')
  const chunk = Buffer.alloc(CHUNK)
  try {
    for (let done = 0; done < size; ) {
      const read = readSync(fd, chunk, 0, chunk.length, done)
      if (read === 0) break
      await channel.call('guest-file-write', { handle, 'buf-b64': chunk.subarray(0, read).toString('base64') }, 120_000)
      done += read
    }
    await channel.call('guest-file-flush', { handle })
  } finally {
    closeSync(fd)
    await channel.call('guest-file-close', { handle })
  }
  return size
}

async function ping(socket: string, seconds: number): Promise<number> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    try {
      const channel = await openAgent(socket, 5_000)
      await channel.call('guest-ping')
      channel.close()
      return 0
    } catch (error) {
      if (Date.now() > deadline) {
        console.error(`vm-agent: no guest agent: ${(error as Error).message}`)
        return 1
      }
      await Bun.sleep(2_000)
    }
  }
}

async function monitor(socket: string, command: string, args: string | undefined): Promise<number> {
  const channel = await openMonitor(socket)
  try {
    console.log(JSON.stringify(await channel.call(command, args === undefined ? undefined : JSON.parse(args), 120_000)))
    return 0
  } finally {
    channel.close()
  }
}

async function agent(socket: string, verb: string, rest: string[]): Promise<number> {
  if (verb === 'ping') return ping(socket, Number(rest[0] ?? '0'))
  if (rest.length !== 2 || (verb !== 'exec' && verb !== 'push')) return fail()
  const [first, second] = rest as [string, string]
  const channel = await openAgent(socket, 10_000)
  try {
    if (verb === 'exec') return await exec(channel, second, Number(first) * 1000)
    const size = await push(channel, first, second)
    console.error(`vm-agent: ${first} -> ${second} (${size} bytes)`)
    return 0
  } finally {
    channel.close()
  }
}

const usage = `usage: vm-agent.ts ga SOCKET ping [SECONDS]
       vm-agent.ts ga SOCKET exec SECONDS COMMAND
       vm-agent.ts ga SOCKET push LOCAL REMOTE
       vm-agent.ts qmp SOCKET COMMAND [JSON-ARGUMENTS]`

function fail(): number {
  console.error(usage)
  return 2
}

function main(argv: string[]): Promise<number> {
  const [kind, socket, verb, ...rest] = argv
  if (!socket || !verb) return Promise.resolve(fail())
  if (kind === 'qmp') return monitor(socket, verb, rest[0])
  if (kind === 'ga') return agent(socket, verb, rest)
  return Promise.resolve(fail())
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`vm-agent: ${error.message}`)
    process.exit(1)
  },
)
