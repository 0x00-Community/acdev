import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, normalize, posix, relative, sep } from 'node:path'
import { crateBinary, crateDir, crateVersion } from './binary.ts'
import type { Guest } from './host.ts'

export const PORT = 5252
const MAX = 16 << 20
const CHUNK = 1 << 20

export const Kind = {
  AUTH: 'A', VERSION: 'V', PUSH: 'P', PULL: 'G', DATA: 'D', END: 'E', DONE: 'Z', RUN: 'R', KILL: 'K', SHELL: 'S', RESIZE: 'W',
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
  readonly address: Address

  constructor(address: Address) {
    this.address = address
  }

  open(): Connection {
    const socket = connect(this.address)
    socket.setNoDelay(true)
    let failed: Error | null = null
    socket.on('error', (error) => {
      failed ??= error
    })
    const decoder = new Frames()
    const frames = (async function* () {
      try {
        for await (const chunk of socket) yield* decoder.push(chunk as Buffer)
      } catch (error) {
        throw failed ?? error
      }
      if (failed) throw failed
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
  readonly binary: string
  readonly cid: number
  readonly port: number

  constructor(binary: string, cid: number, port = PORT) {
    this.binary = binary
    this.cid = cid
    this.port = port
  }

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
  readonly transport: Transport
  readonly key: Buffer | null

  constructor(transport: Transport, key: Buffer | null = null) {
    this.transport = transport
    this.key = key
  }

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

  async pull(remote: string, local: string): Promise<number> {
    const conn = this.#open()
    let open: { fd: number; part: string; target: string; mode: number } | null = null
    try {
      conn.write(encode(Kind.PULL, Buffer.from(remote)))
      for await (const frame of conn.frames) {
        if (frame.kind === Kind.PUSH) {
          const target = Devd.#landing(local, frame.body.subarray(4).toString())
          mkdirSync(dirname(target), { recursive: true })
          const part = `${target}.acdev-part`
          open = { fd: openSync(part, 'w'), part, target, mode: frame.body.readUInt32LE(0) }
        } else if (frame.kind === Kind.DATA && open) writeSync(open.fd, frame.body)
        else if (frame.kind === Kind.END && open) {
          closeSync(open.fd)
          chmodSync(open.part, open.mode & 0o777)
          renameSync(open.part, open.target)
          open = null
        } else if (frame.kind === Kind.OK) return frame.body.readUInt32LE(0)
        else fail(frame, 'pull')
      }
      return fail(undefined, 'pull')
    } finally {
      if (open) {
        closeSync(open.fd)
        rmSync(open.part, { force: true })
      }
      conn.close()
    }
  }

  static #landing(local: string, name: string): string {
    if (name === '') return local
    const inside = normalize(name)
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error(`acdevd: ${name} is outside the pulled directory`)
    return join(local, inside)
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

  static binary(root: string, env: NodeJS.ProcessEnv = process.env, guest: Guest = 'x86_64'): string {
    const wanted = { crate: 'devd', name: 'acdevd', variable: 'ACDEV_DEVD', shared: 'acdev-devd', installed: Devd.shipped(guest) }
    return crateBinary(root, wanted, env)
  }

  static shipped(guest: Guest): string {
    return `acdevd-${guest}`
  }

  static checkVersion(binary: string, root: string): void {
    const want = crateVersion(root, 'devd')
    if (want === null) return
    const ran = spawnSync(binary, ['--version'], { encoding: 'utf8' })
    const got = /^acdevd (\S+)/.exec(ran.stdout ?? '')?.[1] ?? `unknown (${(ran.stderr || ran.error?.message || 'no answer').trim()})`
    if (got === want) return
    const manifest = join(crateDir(root, 'devd'), 'Cargo.toml')
    throw new Error(`vm: ${binary} is acdevd ${got}, this acdev needs ${want}: rebuild it with `
      + `cargo build --release --manifest-path ${manifest} (CARGO_TARGET_DIR picks where it goes) or set ACDEV_DEVD to a current build`)
  }
}
