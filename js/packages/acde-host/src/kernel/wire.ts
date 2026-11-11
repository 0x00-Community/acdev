import { decodeUtf8, encodeUtf8 } from 'jsrt:host'

const UNDEFINED = 0
const NULL = 1
const FALSE = 2
const TRUE = 3
const NUMBER = 4
const STRING = 5
const BYTES = 6
const U32S = 7
const F64S = 8
const LIST = 9
const OBJECT = 10
const BIGINT = 11

export class Writer {
  private buf = new Uint8Array(256)
  private view = new DataView(this.buf.buffer)
  length = 0

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(n: number): void {
    this.room(1)
    this.buf[this.length++] = n
  }

  u32(n: number): void {
    this.room(4)
    this.view.setUint32(this.length, n, true)
    this.length += 4
  }

  f64(n: number): void {
    this.room(8)
    this.view.setFloat64(this.length, n, true)
    this.length += 8
  }

  raw(bytes: Uint8Array): void {
    this.room(bytes.length)
    this.buf.set(bytes, this.length)
    this.length += bytes.length
  }

  bytes(bytes: Uint8Array): void {
    this.u32(bytes.length)
    this.raw(bytes)
  }

  string(text: string): void {
    this.bytes(encodeUtf8(text))
  }

  value(v: unknown): void {
    switch (typeof v) {
      case 'undefined':
        return this.u8(UNDEFINED)
      case 'boolean':
        return this.u8(v ? TRUE : FALSE)
      case 'number':
        this.u8(NUMBER)
        return this.f64(v)
      case 'string':
        this.u8(STRING)
        return this.string(v)
      case 'bigint':
        this.u8(BIGINT)
        this.room(8)
        this.view.setBigInt64(this.length, v, true)
        this.length += 8
        return
      case 'function':
      case 'symbol':
        return this.u8(UNDEFINED)
    }
    if (v === null) return this.u8(NULL)
    if (v instanceof Uint32Array) {
      this.u8(U32S)
      return this.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    }
    if (v instanceof Float64Array) {
      this.u8(F64S)
      return this.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    }
    if (ArrayBuffer.isView(v)) {
      this.u8(BYTES)
      return this.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    }
    if (v instanceof ArrayBuffer) {
      this.u8(BYTES)
      return this.bytes(new Uint8Array(v))
    }
    if (Array.isArray(v)) {
      this.u8(LIST)
      this.u32(v.length)
      for (const item of v) this.value(item)
      return
    }
    const entries = Object.entries(v as object).filter(([, item]) => typeof item !== 'function' && item !== undefined)
    this.u8(OBJECT)
    this.u32(entries.length)
    for (const [key, item] of entries) {
      this.string(key)
      this.value(item)
    }
  }

  take(): Uint8Array {
    return this.buf.subarray(0, this.length)
  }
}

export class Reader {
  private view: DataView
  private pos = 0

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  u8(): number {
    return this.buf[this.pos++]!
  }

  u32(): number {
    const n = this.view.getUint32(this.pos, true)
    this.pos += 4
    return n
  }

  f64(): number {
    const n = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return n
  }

  bytes(): Uint8Array {
    const n = this.u32()
    const out = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  string(): string {
    const n = this.u32()
    const out = decodeUtf8(this.buf.subarray(this.pos, this.pos + n), false, true)
    this.pos += n
    return out
  }

  rest(): Uint8Array {
    return this.buf.subarray(this.pos)
  }

  value(): unknown {
    switch (this.u8()) {
      case UNDEFINED:
        return undefined
      case NULL:
        return null
      case FALSE:
        return false
      case TRUE:
        return true
      case NUMBER:
        return this.f64()
      case STRING:
        return this.string()
      case BYTES:
        return this.bytes()
      case U32S: {
        const bytes = this.bytes()
        return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      }
      case F64S: {
        const bytes = this.bytes()
        return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8)
      }
      case LIST: {
        const n = this.u32()
        const out: unknown[] = new Array(n)
        for (let i = 0; i < n; i++) out[i] = this.value()
        return out
      }
      case OBJECT: {
        const n = this.u32()
        const out: Record<string, unknown> = {}
        for (let i = 0; i < n; i++) {
          const key = this.string()
          out[key] = this.value()
        }
        return out
      }
      case BIGINT: {
        const n = this.view.getBigInt64(this.pos, true)
        this.pos += 8
        return n
      }
      default:
        throw new Error('kernel: a malformed value')
    }
  }
}
