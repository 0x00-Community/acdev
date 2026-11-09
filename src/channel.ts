import type { Socket as NetSocket } from 'node:net'

const net = process.getBuiltinModule('node:net')
const { Duplex } = process.getBuiltinModule('node:stream')

export const CHANNEL_MARK = 'acde-listen-channel/1'
export const OPEN = 1
export const DATA = 2
export const FIN = 3
export const RST = 4
export const WINDOW = 5
export const SHUTDOWN = 6
export const HEADER = 9
export const MAX_PAYLOAD = 64 * 1024
export const CREDIT = 256 * 1024
export const GRANT_AT = 32 * 1024
const EMPTY = Buffer.alloc(0)

export interface Frame {
  readonly type: number
  readonly stream: number
  readonly payload: Buffer
}

export function encode(type: number, stream: number, payload: Uint8Array = EMPTY): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new RangeError(`acde: channel payload of ${payload.length} bytes`)
  const frame = Buffer.allocUnsafe(HEADER + payload.length)
  frame[0] = type
  frame.writeUInt32BE(stream, 1)
  frame.writeUInt32BE(payload.length, 5)
  frame.set(payload, HEADER)
  return frame
}

export function u32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

export class Decoder {
  #pending: Buffer = EMPTY

  push(chunk: Buffer): Frame[] {
    const bytes = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk
    const frames: Frame[] = []
    let at = 0
    while (bytes.length - at >= HEADER) {
      const size = bytes.readUInt32BE(at + 5)
      if (size > MAX_PAYLOAD) throw new Error(`acde: channel frame of ${size} bytes (at most ${MAX_PAYLOAD})`)
      if (bytes.length - at - HEADER < size) break
      const payload = Buffer.from(bytes.subarray(at + HEADER, at + HEADER + size))
      frames.push({ type: bytes[at]!, stream: bytes.readUInt32BE(at + 1), payload })
      at += HEADER + size
    }
    this.#pending = at < bytes.length ? Buffer.from(bytes.subarray(at)) : EMPTY
    return frames
  }
}

export type Accept = (socket: ChannelSocket) => void

export interface MuxOptions {
  readonly write: (frame: Buffer) => void
  readonly lookup: (port: number) => Accept | undefined
  readonly changed?: () => void
}

export class Mux {
  readonly #options: MuxOptions
  readonly #decoder = new Decoder()
  readonly #streams = new Map<number, ChannelSocket>()
  readonly #draining = new Set<number>()

  constructor(options: MuxOptions) {
    this.#options = options
  }

  get active(): number {
    return this.#streams.size
  }

  receive(chunk: Buffer): void {
    for (const frame of this.#decoder.push(chunk)) this.#dispatch(frame)
  }

  send(type: number, stream: number, payload?: Uint8Array): void {
    this.#options.write(encode(type, stream, payload))
  }

  close(reason: string): void {
    for (const stream of [...this.#streams.values()]) stream.reset(reason)
    this.#draining.clear()
  }

  forget(id: number, draining: boolean): void {
    this.#streams.delete(id)
    if (draining) this.#draining.add(id)
    this.#options.changed?.()
  }

  #dispatch({ type, stream: id, payload }: Frame): void {
    const stream = this.#streams.get(id)
    switch (type) {
      case OPEN:
        if (!stream && !this.#draining.has(id) && id !== 0) this.#open(id, payload)
        return
      case DATA:
        if (stream) stream.received(payload)
        else this.#refuse(id, 'no such stream')
        return
      case FIN:
        if (stream) stream.ended()
        else if (!this.#draining.delete(id)) this.#refuse(id, 'no such stream')
        return
      case RST:
        if (stream) stream.reset(payload.toString('utf8') || 'reset by the runtime')
        else this.#draining.delete(id)
        return
      case WINDOW:
        if (stream && payload.length === 4) stream.grant(payload.readUInt32BE(0))
        return
    }
  }

  #refuse(id: number, reason: string): void {
    this.#draining.delete(id)
    this.send(RST, id, Buffer.from(reason))
  }

  #open(id: number, payload: Buffer): void {
    if (payload.length !== 2) return this.send(RST, id, Buffer.from('bad OPEN payload'))
    const port = payload.readUInt16BE(0)
    const accept = this.#options.lookup(port)
    if (!accept) return this.send(RST, id, Buffer.from(`no server listens on port ${port}`))
    const socket = new ChannelSocket(this, id)
    this.#streams.set(id, socket)
    this.#options.changed?.()
    accept(socket)
  }
}

interface Pending {
  data: Buffer
  readonly done: (error?: Error | null) => void
}

export class ChannelSocket extends Duplex {
  readonly remoteAddress: string | undefined = undefined
  readonly remotePort: number | undefined = undefined
  readonly connecting = false
  readonly #mux: Mux
  readonly #id: number
  #credit = CREDIT
  #allowed = CREDIT
  #owed = 0
  #pending: Pending[] = []
  #finish: ((error?: Error | null) => void) | null = null
  #sentFin = false
  #gotFin = false
  #reset = false
  #idle = 0
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(mux: Mux, id: number) {
    super({ allowHalfOpen: true })
    this.#mux = mux
    this.#id = id
  }

  get stream(): number {
    return this.#id
  }

  received(data: Buffer): void {
    if (this.#gotFin) return this.#abort('DATA after FIN')
    if (data.length > this.#allowed) return this.#abort('DATA beyond the granted window')
    this.#allowed -= data.length
    this.#owed += data.length
    this.#touch()
    this.push(data)
  }

  ended(): void {
    if (this.#gotFin) return
    this.#gotFin = true
    this.push(null)
  }

  grant(bytes: number): void {
    this.#credit += bytes
    this.#flush()
  }

  reset(reason: string): void {
    if (this.destroyed) return
    this.#reset = true
    this.destroy(Object.assign(new Error(reason), { code: 'ECONNRESET' }))
  }

  setTimeout(ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback)
    this.#idle = ms > 0 ? ms : 0
    this.#touch()
    return this
  }

  setNoDelay(): this {
    return this
  }

  setKeepAlive(): this {
    return this
  }

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }

  address(): object {
    return {}
  }

  destroySoon(): void {
    if (this.writableFinished) this.destroy()
    else {
      this.once('finish', () => this.destroy())
      this.end()
    }
  }

  override _read(): void {
    if (this.#owed < GRANT_AT) return
    const owed = this.#owed
    this.#owed = 0
    this.#allowed += owed
    this.#mux.send(WINDOW, this.#id, u32(owed))
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.#pending.push({ data: chunk, done })
    this.#touch()
    this.#flush()
  }

  override _final(done: (error?: Error | null) => void): void {
    this.#finish = done
    this.#flush()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    clearTimeout(this.#timer)
    const closedBoth = this.#sentFin && this.#gotFin
    if (this.#reset || closedBoth) this.#mux.forget(this.#id, false)
    else if (error) {
      this.#mux.send(RST, this.#id, Buffer.from(error.message || 'closed'))
      this.#mux.forget(this.#id, false)
    } else {
      if (!this.#sentFin) this.#mux.send(FIN, this.#id)
      this.#sentFin = true
      this.#mux.forget(this.#id, true)
    }
    done(error)
  }

  #abort(reason: string): void {
    this.#mux.send(RST, this.#id, Buffer.from(reason))
    this.reset(reason)
  }

  #touch(): void {
    clearTimeout(this.#timer)
    if (this.#idle === 0 || this.destroyed) return
    this.#timer = setTimeout(() => this.emit('timeout'), this.#idle)
    this.#timer.unref?.()
  }

  #flush(): void {
    while (this.#pending.length > 0 && this.#credit > 0 && !this.destroyed) {
      const item = this.#pending[0]!
      const take = Math.min(this.#credit, MAX_PAYLOAD, item.data.length)
      this.#mux.send(DATA, this.#id, item.data.subarray(0, take))
      this.#credit -= take
      item.data = item.data.subarray(take)
      if (item.data.length === 0) {
        this.#pending.shift()
        item.done()
      }
    }
    if (this.#pending.length === 0 && this.#finish && !this.destroyed) {
      const finish = this.#finish
      this.#finish = null
      this.#sentFin = true
      this.#mux.send(FIN, this.#id)
      finish()
    }
  }
}

const accepts = new Map<number, Accept>()
let channel: { readonly mux: Mux; readonly input: NetSocket } | null = null

function gone(reason: string): never {
  channel?.mux.close(reason)
  process.stderr.write(`acde: the backend channel closed (${reason}); exiting\n`)
  process.exit(0)
}

function hold(): void {
  if (!channel) return
  if (accepts.size > 0 || channel.mux.active > 0) channel.input.ref()
  else channel.input.unref()
}

function open(): NonNullable<typeof channel> {
  const input = new net.Socket({ fd: 3, readable: true, writable: false })
  const output = new net.Socket({ fd: 4, readable: false, writable: true })
  const write = (frame: Buffer) => void output.write(frame)
  const mux = new Mux({ write, lookup: (port) => accepts.get(port), changed: hold })
  input.on('data', (chunk: Buffer) => {
    try {
      mux.receive(chunk)
    } catch (error) {
      gone((error as Error).message)
    }
  })
  input.on('end', () => gone('end of input'))
  input.on('error', (error) => gone(error.message))
  output.on('error', (error) => gone(error.message))
  return { mux, input }
}

export function channelMode(env: Readonly<Record<string, string | undefined>>, bun: boolean): boolean {
  return !bun && env['ACDE_APP_CHANNEL'] === 'fd'
}

export function serveChannel(port: number, accept: Accept): boolean {
  if (accepts.has(port)) return false
  accepts.set(port, accept)
  channel ??= open()
  hold()
  return true
}

export function unserveChannel(port: number): void {
  accepts.delete(port)
  hold()
}
