import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join, posix, relative, sep } from 'node:path'

export const PORT = 5252
const MAX = 16 << 20
const CHUNK = 1 << 20

export const Kind = {
  AUTH: 'A', VERSION: 'V', PUSH: 'P', DATA: 'D', END: 'E', DONE: 'Z', RUN: 'R', KILL: 'K', SHELL: 'S', RESIZE: 'W',
  OK: 'O', ERROR: 'X', PID: 'I', STDOUT: '1', STDERR: '2', EXIT: 'Q',
} as const

export interface Frame {
  readonly kind: string
  readonly body: Buffer
}

export function encode(kind: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32LE(body.length + 1, 0)
  head.write(kind, 4, 'latin1')
  return Buffer.concat([head, body])
}

export class Frames {
  #buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    const out: Frame[] = []
    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32LE(0)
      if (len === 0 || len > MAX) throw new Error(`acdevd sent a frame of ${len} bytes`)
      if (this.#buffer.length < 4 + len) break
      out.push({ kind: String.fromCharCode(this.#buffer[4]!), body: this.#buffer.subarray(5, 4 + len) })
      this.#buffer = this.#buffer.subarray(4 + len)
    }
    return out
  }
}

export interface PushFile {
  readonly path: string
  readonly mode: number
  readonly data: Buffer
}

export interface RunHandlers {
  readonly stdout?: (chunk: Buffer) => void
  readonly stderr?: (chunk: Buffer) => void
  readonly pid?: (pid: number) => void
}

export interface ShellOptions {
  readonly argv: readonly string[]
  readonly rows: number
  readonly cols: number
  readonly term: string
}

export interface ShellSession {
  input(data: Buffer): void
  resize(rows: number, cols: number): void
  readonly exit: Promise<number>
}

export interface Connection {
  write(data: Buffer): void
  end(): void
  readonly frames: AsyncIterable<Frame>
  close(): void
}

export interface Transport {
  open(): Connection
}

export type Address = { readonly path: string } | { readonly host: string; readonly port: number }

export class SocketTransport implements Transport {
  constructor(readonly address: Address) {}

  open(): Connection {
    const socket = connect(this.address)
    socket.setNoDelay(true)
    const decoder = new Frames()
    const frames = (async function* () {
      for await (const chunk of socket) yield* decoder.push(chunk as Buffer)
    })()
    return {
      write: (data: Buffer) => void socket.write(data),
      end: () => void socket.end(),
      frames,
      close: () => void socket.destroy(),
    }
  }
}

export class RelayTransport implements Transport {
  constructor(readonly binary: string, readonly cid: number, readonly port = PORT) {}

  open() {
    const child: ChildProcess = spawn(this.binary, ['connect', String(this.cid), String(this.port)], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin!.on('error', () => {})
    let failed = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      failed += chunk.toString()
    })
    const decoder = new Frames()
    const stdout = child.stdout!
    const frames = (async function* () {
      for await (const chunk of stdout) yield* decoder.push(chunk as Buffer)
      if (failed.trim()) throw new Error(failed.trim())
    })()
    return {
      write: (data: Buffer) => void child.stdin!.write(data),
      end: () => void child.stdin!.end(),
      frames,
      close: () => void child.kill(),
    }
  }
}

function fail(frame: Frame | undefined, what: string): never {
  if (frame?.kind === Kind.ERROR) throw new Error(`acdevd: ${frame.body.toString()}`)
  throw new Error(`acdevd: ${frame ? `unexpected ${frame.kind}` : 'no answer'} to ${what}`)
}

function words(list: readonly string[]): Buffer[] {
  return list.map((word) => Buffer.from(`${word}\0`))
}

function size(rows: number, cols: number): Buffer {
  const body = Buffer.alloc(4)
  body.writeUInt16LE(Math.min(rows, 0xffff), 0)
  body.writeUInt16LE(Math.min(cols, 0xffff), 2)
  return body
}

async function first(frames: AsyncIterable<Frame>): Promise<Frame | undefined> {
  for await (const frame of frames) return frame
  return undefined
}

export class Devd {
  constructor(readonly transport: Transport, readonly key: Buffer | null = null) {}

  #open(): Connection {
    const conn = this.transport.open()
    if (this.key) conn.write(encode(Kind.AUTH, this.key))
    return conn
  }

  async version(): Promise<string> {
    const conn = this.#open()
    try {
      conn.write(encode(Kind.VERSION))
      const reply = await first(conn.frames)
      if (reply?.kind !== Kind.OK) fail(reply, 'version')
      return reply.body.toString()
    } finally {
      conn.close()
    }
  }

  async push(files: readonly PushFile[]): Promise<number> {
    const conn = this.#open()
    try {
      for (const file of files) {
        const head = Buffer.alloc(4)
        head.writeUInt32LE(file.mode, 0)
        conn.write(encode(Kind.PUSH, Buffer.concat([head, Buffer.from(file.path)])))
        for (let at = 0; at < file.data.length; at += CHUNK) conn.write(encode(Kind.DATA, file.data.subarray(at, at + CHUNK)))
        conn.write(encode(Kind.END))
      }
      conn.write(encode(Kind.DONE))
      const reply = await first(conn.frames)
      if (reply?.kind !== Kind.OK) fail(reply, 'push')
      return reply.body.readUInt32LE(0)
    } finally {
      conn.close()
    }
  }

  async run(argv: readonly string[], handlers: RunHandlers = {}): Promise<number> {
    const conn = this.#open()
    try {
      conn.write(encode(Kind.RUN, Buffer.concat([Buffer.from([0]), ...words(argv)])))
      for await (const frame of conn.frames) {
        if (frame.kind === Kind.PID) handlers.pid?.(frame.body.readUInt32LE(0))
        else if (frame.kind === Kind.STDOUT) handlers.stdout?.(frame.body)
        else if (frame.kind === Kind.STDERR) handlers.stderr?.(frame.body)
        else if (frame.kind === Kind.EXIT) return frame.body.readInt32LE(0)
        else fail(frame, 'run')
      }
      return fail(undefined, 'run')
    } finally {
      conn.close()
    }
  }

  async detach(argv: readonly string[]): Promise<{ pid: number; log: string }> {
    const conn = this.#open()
    try {
      conn.write(encode(Kind.RUN, Buffer.concat([Buffer.from([1]), ...words(argv)])))
      let pid = 0
      for await (const frame of conn.frames) {
        if (frame.kind === Kind.PID) pid = frame.body.readUInt32LE(0)
        else if (frame.kind === Kind.OK) return { pid, log: frame.body.toString() }
        else fail(frame, 'run --detach')
      }
      return fail(undefined, 'run --detach')
    } finally {
      conn.close()
    }
  }

  shell(options: ShellOptions, output: (chunk: Buffer) => void): ShellSession {
    const conn = this.#open()
    conn.write(encode(Kind.SHELL, Buffer.concat([size(options.rows, options.cols), ...words([options.term, ...options.argv])])))
    const exit = (async () => {
      try {
        for await (const frame of conn.frames) {
          if (frame.kind === Kind.STDOUT) output(frame.body)
          else if (frame.kind === Kind.EXIT) return frame.body.readInt32LE(0)
          else if (frame.kind !== Kind.PID) fail(frame, 'shell')
        }
        return fail(undefined, 'shell')
      } finally {
        conn.close()
      }
    })()
    return {
      input: (data) => conn.write(encode(Kind.DATA, data)),
      resize: (rows, cols) => conn.write(encode(Kind.RESIZE, size(rows, cols))),
      exit,
    }
  }

  async kill(pid: number, force = false): Promise<void> {
    const conn = this.#open()
    try {
      const body = Buffer.alloc(force ? 5 : 4)
      body.writeUInt32LE(pid, 0)
      if (force) body[4] = 9
      conn.write(encode(Kind.KILL, body))
      const reply = await first(conn.frames)
      if (reply?.kind !== Kind.OK) fail(reply, 'kill')
    } finally {
      conn.close()
    }
  }

  static files(local: string, remote: string): PushFile[] {
    const file = (path: string, to: string): PushFile => {
      const mode = statSync(path).mode & 0o111 ? 0o755 : 0o644
      return { path: to, mode, data: readFileSync(path) }
    }
    if (!statSync(local).isDirectory()) return [file(local, remote)]
    const out: PushFile[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, entry.name)
        if (entry.isDirectory()) walk(at)
        else if (entry.isFile()) out.push(file(at, posix.join(remote, relative(local, at).split(sep).join('/'))))
      }
    }
    walk(local)
    return out
  }

  static binary(root: string, env: NodeJS.ProcessEnv = process.env): string {
    const given = env['ACDEV_DEVD']
    if (given) {
      if (!existsSync(given)) throw new Error(`ACDEV_DEVD=${given}: no such file`)
      return given
    }
    const crate = join(root, '..', 'crates', 'devd')
    const built = join(crate, 'target', 'release', 'acdevd')
    if (existsSync(built)) return built
    if (!existsSync(join(crate, 'Cargo.toml'))) throw new Error('vm: no acdevd: set ACDEV_DEVD to the acdevd binary')
    const made = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', join(crate, 'Cargo.toml')], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    if (made.status !== 0 || !existsSync(built)) throw new Error(`vm: building acdevd failed (cargo exited ${made.status})`)
    return built
  }
}
