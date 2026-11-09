import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { which } from '../launcher.mjs'
import { BunBundler } from '../src/bundler.ts'
import {
  CHANNEL_MARK, type ChannelSocket, CREDIT, channelMode, DATA, Decoder, encode, FIN, type Frame, GRANT_AT, HEADER,
  MAX_PAYLOAD, Mux, OPEN, RST, SHUTDOWN, u32, WINDOW,
} from '../src/channel.ts'
import { cleanup, env, tmp } from './helpers.ts'

const port = (p: number) => Buffer.from([p >> 8, p & 0xff])
const tick = () => new Promise((resolve) => setImmediate(resolve))

function harness(ports: number[] = [3000]) {
  const sent: Frame[] = []
  const decoder = new Decoder()
  const sockets: ChannelSocket[] = []
  const mux = new Mux({
    write: (frame) => void sent.push(...decoder.push(frame)),
    lookup: (p) => (ports.includes(p) ? (socket) => void sockets.push(socket) : undefined),
  })
  const feed = (type: number, stream: number, payload?: Uint8Array) => mux.receive(encode(type, stream, payload))
  const take = () => sent.splice(0)
  return { mux, sockets, feed, take }
}

describe('channel frames', () => {
  test('a frame is type u8, stream u32, length u32, payload, big-endian', () => {
    expect([...encode(OPEN, 0x01020304, port(3000))]).toEqual([1, 1, 2, 3, 4, 0, 0, 0, 2, 0x0b, 0xb8])
    expect([...encode(SHUTDOWN, 0)]).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(() => encode(DATA, 1, Buffer.alloc(MAX_PAYLOAD + 1))).toThrow()
    expect(CHANNEL_MARK).toBe('acde-listen-channel/1')
  })

  test('the decoder reassembles frames split at any byte', () => {
    const bytes = Buffer.concat([encode(DATA, 5, Buffer.from('hello')), encode(FIN, 5), encode(WINDOW, 9, u32(70000))])
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoder = new Decoder()
      const frames = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))]
      expect(frames.map((f) => [f.type, f.stream, f.payload.toString('hex')])).toEqual([
        [DATA, 5, Buffer.from('hello').toString('hex')], [FIN, 5, ''], [WINDOW, 9, u32(70000).toString('hex')],
      ])
    }
  })

  test('a frame longer than 64 KiB is a protocol error', () => {
    const head = Buffer.alloc(HEADER)
    head[0] = DATA
    head.writeUInt32BE(MAX_PAYLOAD + 1, 5)
    expect(() => new Decoder().push(head)).toThrow('at most')
  })

  test('the mode: node with ACDE_APP_CHANNEL=fd only', () => {
    expect(channelMode({ ACDE_APP_CHANNEL: 'fd' }, false)).toBe(true)
    expect(channelMode({ ACDE_APP_CHANNEL: 'fd', ACDE_APP_SOCKETS: 'x' }, true)).toBe(false)
    expect(channelMode({ ACDE_APP_SOCKETS: 'x' }, false)).toBe(false)
    expect(channelMode({ ACDE_APP_CHANNEL: '1' }, false)).toBe(false)
  })
})

describe('channel streams', () => {
  test('OPEN hands a connection to the server of that port; data both ways, FIN both ways', async () => {
    const { sockets, feed, take } = harness()
    feed(OPEN, 1, port(3000))
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]!
    const got: Buffer[] = []
    socket.on('data', (chunk: Buffer) => got.push(chunk))
    feed(DATA, 1, Buffer.from('ping'))
    feed(FIN, 1)
    await tick()
    expect(Buffer.concat(got).toString()).toBe('ping')
    socket.end('pong')
    await tick()
    expect(take().map((f) => [f.type, f.stream, f.payload.toString()])).toEqual([[DATA, 1, 'pong'], [FIN, 1, '']])
    await tick()
    expect(socket.destroyed).toBe(true)
    feed(DATA, 1, Buffer.from('late'))
    expect(take().map((f) => [f.type, f.stream])).toEqual([[RST, 1]])
  })

  test('OPEN on a port nobody listens on, bad OPEN payloads', () => {
    const { sockets, feed, take } = harness()
    feed(OPEN, 2, port(4000))
    feed(OPEN, 3, Buffer.from([1]))
    expect(sockets).toHaveLength(0)
    expect(take().map((f) => [f.type, f.stream, f.payload.toString()])).toEqual([
      [RST, 2, 'no server listens on port 4000'], [RST, 3, 'bad OPEN payload'],
    ])
  })

  test('DATA and FIN on unknown streams get RST; RST, WINDOW, SHUTDOWN and unknown types do not', () => {
    const { feed, take } = harness()
    feed(DATA, 7, Buffer.from('x'))
    feed(FIN, 8)
    feed(RST, 9, Buffer.from('gone'))
    feed(WINDOW, 9, u32(10))
    feed(SHUTDOWN, 0)
    feed(99, 1, Buffer.from('future'))
    expect(take().map((f) => [f.type, f.stream])).toEqual([[RST, 7], [RST, 8]])
  })

  test('writes are cut into DATA frames of at most 64 KiB', async () => {
    const { sockets, feed, take } = harness()
    feed(OPEN, 1, port(3000))
    sockets[0]!.write(Buffer.alloc(200 * 1024, 1))
    await tick()
    const sizes = take().map((f) => f.payload.length)
    expect(sizes.every((n) => n <= MAX_PAYLOAD)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(200 * 1024)
  })

  test('sending stops when the credit is used up and resumes on WINDOW; FIN waits for the data', async () => {
    const { sockets, feed, take } = harness()
    feed(OPEN, 1, port(3000))
    const socket = sockets[0]!
    socket.end(Buffer.alloc(CREDIT + 100_000, 2))
    await tick()
    const total = (frames: Frame[]) => frames.filter((f) => f.type === DATA).reduce((a, f) => a + f.payload.length, 0)
    let frames = take()
    expect(total(frames)).toBe(CREDIT)
    expect(frames.some((f) => f.type === FIN)).toBe(false)
    feed(WINDOW, 1, u32(60_000))
    await tick()
    frames = take()
    expect(total(frames)).toBe(60_000)
    expect(frames.some((f) => f.type === FIN)).toBe(false)
    feed(WINDOW, 1, u32(CREDIT))
    await tick()
    frames = take()
    expect(total(frames)).toBe(40_000)
    expect(frames.at(-1)!.type).toBe(FIN)
  })

  test('WINDOW goes back only once the server has taken the data; DATA beyond the window is reset', async () => {
    const { sockets, feed, take } = harness()
    feed(OPEN, 1, port(3000))
    const socket = sockets[0]!
    socket.pause()
    for (let sent = 0; sent < CREDIT; sent += MAX_PAYLOAD) feed(DATA, 1, Buffer.alloc(MAX_PAYLOAD, 3))
    await tick()
    expect(take()).toEqual([])
    let read = 0
    socket.on('data', (chunk: Buffer) => void (read += chunk.length))
    socket.resume()
    await tick()
    await tick()
    expect(read).toBe(CREDIT)
    const granted = take().filter((f) => f.type === WINDOW).reduce((a, f) => a + f.payload.readUInt32BE(0), 0)
    expect(granted).toBeGreaterThanOrEqual(CREDIT - GRANT_AT)
    const errors: string[] = []
    socket.on('error', (error) => errors.push(error.message))
    socket.pause()
    for (let left = granted + 1; left > 0; left -= MAX_PAYLOAD) feed(DATA, 1, Buffer.alloc(Math.min(left, MAX_PAYLOAD)))
    await tick()
    expect(take().map((f) => [f.type, f.payload.toString()])).toEqual([[RST, 'DATA beyond the granted window']])
    expect(errors).toEqual(['DATA beyond the granted window'])
  })

  test('RST from the runtime fails the connection without an answer', async () => {
    const { sockets, feed, take } = harness()
    feed(OPEN, 1, port(3000))
    const errors: unknown[] = []
    sockets[0]!.on('error', (error) => errors.push((error as NodeJS.ErrnoException).code))
    feed(RST, 1, Buffer.from('page closed'))
    await tick()
    expect(errors).toEqual(['ECONNRESET'])
    expect(take()).toEqual([])
    feed(DATA, 1, Buffer.from('x'))
    expect(take().map((f) => f.type)).toEqual([RST])
  })

  test('destroy with an error sends RST; plain destroy sends FIN and keeps the stream until its FIN', async () => {
    const { sockets, feed, take, mux } = harness()
    feed(OPEN, 1, port(3000))
    feed(OPEN, 2, port(3000))
    feed(OPEN, 3, port(3000))
    sockets[0]!.on('error', () => undefined).destroy(new Error('boom'))
    sockets[1]!.destroy()
    sockets[2]!.destroy()
    await tick()
    expect(take().map((f) => [f.type, f.stream, f.payload.toString()])).toEqual([
      [RST, 1, 'boom'], [FIN, 2, ''], [FIN, 3, ''],
    ])
    expect(mux.active).toBe(0)
    feed(FIN, 2)
    feed(DATA, 3, Buffer.from('after close'))
    expect(take().map((f) => [f.type, f.stream])).toEqual([[RST, 3]])
    feed(FIN, 2)
    expect(take().map((f) => [f.type, f.stream])).toEqual([[RST, 2]])
  })

  test('streams interleave independently', async () => {
    const { sockets, feed, take } = harness([3000, 3001])
    const ids = [11, 12, 13, 14]
    for (const id of ids) feed(OPEN, id, port(id % 2 ? 3001 : 3000))
    for (const socket of sockets) socket.on('data', (chunk: Buffer) => socket.write(`${socket.stream}:${chunk}`))
    for (const round of [1, 2]) for (const id of ids.toReversed()) feed(DATA, id, Buffer.from(`r${round}`))
    await tick()
    const got = new Map<number, string>()
    for (const f of take()) got.set(f.stream, (got.get(f.stream) ?? '') + f.payload.toString())
    expect(Object.fromEntries(got)).toEqual({ 11: '11:r111:r2', 12: '12:r112:r2', 13: '13:r113:r2', 14: '14:r114:r2' })
  })
})

function realNode(): string | null {
  const node = process.env['ACDE_TEST_NODE'] || which('node')
  if (!node) return null
  const probe = Bun.spawnSync([node, '-p', 'process.versions.bun ? "bun" : process.versions.node'])
  const version = probe.stdout.toString().trim()
  return probe.exitCode === 0 && Number.parseInt(version, 10) >= 22 ? node : null
}

const NODE = realNode()
if (!NODE) console.warn('no Node.js >= 22: the channel tests on node are skipped')

interface Remote {
  data: Buffer[]
  fin: boolean
  rst: string | null
  credit: number
  readonly waiters: (() => void)[]
}

class FakeRuntime {
  readonly child: ChildProcess
  readonly stderr: string[] = []
  readonly #to: Writable
  readonly #decoder = new Decoder()
  readonly #streams = new Map<number, Remote>()
  #next = 1

  constructor(child: ChildProcess) {
    this.child = child
    this.#to = child.stdio[3] as Writable
    this.#to.on('error', () => undefined)
    ;(child.stdio[4] as Readable).on('data', (chunk: Buffer) => {
      for (const frame of this.#decoder.push(chunk)) this.#frame(frame)
    })
    child.stderr!.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString()))
  }

  open(p: number): number {
    const id = this.#next++
    this.#streams.set(id, { data: [], fin: false, rst: null, credit: CREDIT, waiters: [] })
    this.#to.write(encode(OPEN, id, port(p)))
    return id
  }

  async send(id: number, bytes: Uint8Array): Promise<void> {
    const stream = this.#streams.get(id)!
    for (let at = 0; at < bytes.length;) {
      if (stream.rst !== null) throw new Error(`reset: ${stream.rst}`)
      if (stream.credit === 0) {
        await this.#wait(id)
        continue
      }
      const take = Math.min(stream.credit, MAX_PAYLOAD, bytes.length - at)
      this.#to.write(encode(DATA, id, bytes.subarray(at, at + take)))
      stream.credit -= take
      at += take
    }
  }

  fin(id: number): void {
    this.#to.write(encode(FIN, id))
  }

  async done(id: number): Promise<{ text: string; bytes: Buffer; rst: string | null }> {
    const stream = this.#streams.get(id)!
    while (!stream.fin && stream.rst === null) await this.#wait(id)
    const bytes = Buffer.concat(stream.data)
    return { text: bytes.toString('latin1'), bytes, rst: stream.rst }
  }

  async until(id: number, text: string): Promise<string> {
    const stream = this.#streams.get(id)!
    for (;;) {
      const got = Buffer.concat(stream.data).toString('latin1')
      if (got.includes(text) || stream.fin || stream.rst !== null) return got
      await this.#wait(id)
    }
  }

  async request(path: string, method = 'GET', body?: Buffer): Promise<{ status: number; body: Buffer }> {
    const id = this.open(3000)
    const head = `${method} ${path} HTTP/1.1\r\nHost: app\r\nConnection: close\r\n`
    await this.send(id, Buffer.from(`${head}${body ? `Content-Length: ${body.length}\r\n` : ''}\r\n`, 'latin1'))
    if (body) await this.send(id, body)
    const { bytes, rst } = await this.done(id)
    if (rst !== null) throw new Error(`reset: ${rst}`)
    const split = bytes.indexOf('\r\n\r\n')
    const status = Number(bytes.subarray(0, split).toString('latin1').split(' ')[1])
    const rest = bytes.subarray(split + 4)
    const chunked = /transfer-encoding: chunked/i.test(bytes.subarray(0, split).toString('latin1'))
    return { status, body: chunked ? dechunk(rest) : rest }
  }

  #wait(id: number): Promise<void> {
    return new Promise((resolve) => this.#streams.get(id)!.waiters.push(resolve))
  }

  #frame({ type, stream: id, payload }: Frame): void {
    const stream = this.#streams.get(id)
    if (!stream) return
    if (type === DATA) {
      stream.data.push(payload)
      this.#to.write(encode(WINDOW, id, u32(payload.length)))
    } else if (type === FIN) stream.fin = true
    else if (type === RST) stream.rst = payload.toString()
    else if (type === WINDOW) stream.credit += payload.readUInt32BE(0)
    for (const wake of stream.waiters.splice(0)) wake()
  }
}

function dechunk(bytes: Buffer): Buffer {
  const parts: Buffer[] = []
  let at = 0
  for (;;) {
    const eol = bytes.indexOf('\r\n', at)
    const size = Number.parseInt(bytes.subarray(at, eol).toString('latin1'), 16)
    if (!size) return Buffer.concat(parts)
    parts.push(bytes.subarray(eol + 2, eol + 2 + size))
    at = eol + 2 + size + 2
  }
}

describe.skipIf(!NODE)('a node backend served from the channel (fd 3 in, fd 4 out)', () => {
  let preload: string
  const runtimes: FakeRuntime[] = []

  beforeAll(async () => {
    const out = join(tmp(), 'backend')
    await new BunBundler().preload(out)
    preload = join(out, 'acde-listen.js')
  })
  afterEach(async () => {
    for (const { child } of runtimes.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await new Promise((resolve) => child.once('exit', resolve))
      }
    }
  })
  afterAll(cleanup)

  async function start(extra: Record<string, string> = {}): Promise<FakeRuntime> {
    const fixture = join(import.meta.dir, 'fixtures/listen/channel-node.mjs')
    const child = spawn(NODE!, ['--import', pathToFileURL(preload).href, fixture], {
      env: env({ ACDE_APP_CHANNEL: 'fd', ...extra }),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    const runtime = new FakeRuntime(child)
    runtimes.push(runtime)
    const ready = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const found = out.split('\n').find((l) => l.startsWith('ready'))
        if (found) resolve(found.trim())
      })
      child.once('exit', (code) => reject(new Error(`exited ${code}: ${runtime.stderr.join('')}`)))
    })
    expect(ready).toBe('ready 3000 true')
    return runtime
  }

  test('the built preload carries the channel mark', () => {
    expect(readFileSync(preload, 'utf8')).toContain(CHANNEL_MARK)
  })

  test('GET, POST of 2 MiB both ways, a large response, a 404', async () => {
    const runtime = await start()
    expect((await runtime.request('/hello')).body.toString()).toBe('hello')
    const upload = Buffer.alloc(2 * 1024 * 1024)
    for (let i = 0; i < upload.length; i++) upload[i] = (i * 7) & 0xff
    const echoed = await runtime.request('/echo', 'POST', upload)
    expect(echoed.status).toBe(200)
    expect(echoed.body.equals(upload)).toBe(true)
    const big = await runtime.request('/big?n=3000000')
    expect(big.body.length).toBe(3_000_000)
    expect((await runtime.request('/nope')).status).toBe(404)
  }, 30_000)

  test('eight streams at once', async () => {
    const runtime = await start()
    const bodies = Array.from({ length: 8 }, (_, i) => Buffer.alloc(100_000 + i * 50_000, 65 + i))
    const answers = await Promise.all(bodies.map((body) => runtime.request('/echo', 'POST', body)))
    expect(answers.map((a, i) => a.body.equals(bodies[i]!))).toEqual(bodies.map(() => true))
  }, 30_000)

  test('an upgrade hands over the connection; OPEN on another port is reset', async () => {
    const runtime = await start()
    const id = runtime.open(3000)
    await runtime.send(id, Buffer.from('GET /ws HTTP/1.1\r\nHost: app\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n'))
    expect(await runtime.until(id, '\r\n\r\n')).toStartWith('HTTP/1.1 101 Switching Protocols')
    await runtime.send(id, Buffer.from('frame-1'))
    expect(await runtime.until(id, 'frame-1')).toEndWith('frame-1')
    runtime.fin(id)
    expect((await runtime.done(id)).rst).toBeNull()
    const other = runtime.open(4000)
    expect((await runtime.done(other)).rst).toBe('no server listens on port 4000')
  }, 30_000)

  test('reading the channel does not hold the libuv thread pool', async () => {
    const runtime = await start({ UV_THREADPOOL_SIZE: '1' })
    expect((await runtime.request('/fs')).body.toString()).toBe('fs ok')
  }, 30_000)

  test('server.close() stops serving the port and the process exits; EOF on fd 3 ends it too', async () => {
    const first = await start()
    const exited = new Promise((resolve) => first.child.once('exit', resolve))
    expect((await first.request('/close')).body.toString()).toBe('closed')
    expect(await exited).toBe(0)

    const second = await start()
    const ended = new Promise((resolve) => second.child.once('exit', resolve))
    ;(second.child.stdio[3] as Writable).end()
    expect(await ended).toBe(0)
    expect(second.stderr.join('')).toContain('the backend channel closed (end of input)')
  }, 30_000)
})
