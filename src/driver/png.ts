import { deflateSync, inflateSync } from 'node:zlib'

export interface Image {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export interface DiffOptions {
  readonly threshold?: number
  readonly antialiasing?: boolean
}

export interface Diff {
  readonly pixels: number
  readonly image: Image
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export class Png {
  static readonly DIFF_THRESHOLD = 0.2

  static decode(png: Uint8Array): Image {
    const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file')
    let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null
    let palette: Uint8Array | null = null
    let transparency: Uint8Array | null = null
    const idat: Buffer[] = []
    for (let at = 8; at + 8 <= bytes.length; ) {
      const length = bytes.readUInt32BE(at)
      const type = bytes.toString('latin1', at + 4, at + 8)
      const data = bytes.subarray(at + 8, at + 8 + length)
      if (data.length !== length) throw new Error(`PNG: the ${type} chunk is cut short`)
      at += 12 + length
      if (type === 'IHDR') {
        header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8]!, color: data[9]!, interlace: data[12]! }
      } else if (type === 'PLTE') palette = data
      else if (type === 'tRNS') transparency = data
      else if (type === 'IDAT') idat.push(data)
      else if (type === 'IEND') break
    }
    if (!header) throw new Error('PNG: no IHDR chunk')
    const { width, height, depth, color, interlace } = header
    const channels = CHANNELS[color]
    if (channels === undefined) throw new Error(`PNG: unknown colour type ${color}`)
    if (color === 3 && !palette) throw new Error('PNG: a palette image without PLTE')
    if (![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && color !== 0 && color !== 3) || (depth === 16 && color === 3)) throw new Error(`PNG: bit depth ${depth} with colour type ${color}`)
    const raw = inflateSync(Buffer.concat(idat))
    const bitsPerPixel = channels * depth
    const bpp = Math.max(1, bitsPerPixel >> 3)
    const out = new Uint8Array(width * height * 4)
    const max = depth === 16 ? 0xffff : (1 << depth) - 1
    const sample = (row: Uint8Array, index: number): number => {
      if (depth === 8) return row[index]!
      if (depth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!
      const bit = index * depth
      return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & max
    }
    const eight = (v: number) => (depth === 8 ? v : depth === 16 ? Math.round(v / 257) : Math.round((v * 255) / max))
    const key = (index: number) => (transparency![index * 2]! << 8) | transparency![index * 2 + 1]!
    const put = (row: Uint8Array, column: number, x: number, y: number) => {
      const o = (y * width + x) * 4
      const s = (c: number) => sample(row, column * channels + c)
      if (color === 3) {
        const i = s(0)
        out[o] = palette![i * 3] ?? 0
        out[o + 1] = palette![i * 3 + 1] ?? 0
        out[o + 2] = palette![i * 3 + 2] ?? 0
        out[o + 3] = transparency?.[i] ?? 255
      } else if (color === 0 || color === 4) {
        const g = s(0)
        out[o] = out[o + 1] = out[o + 2] = eight(g)
        out[o + 3] = color === 4 ? eight(s(1)) : transparency && transparency.length >= 2 && g === key(0) ? 0 : 255
      } else {
        const [r, g, b] = [s(0), s(1), s(2)]
        out[o] = eight(r)
        out[o + 1] = eight(g)
        out[o + 2] = eight(b)
        const keyed = color === 2 && transparency && transparency.length >= 6 && r === key(0) && g === key(1) && b === key(2)
        out[o + 3] = color === 6 ? eight(s(3)) : keyed ? 0 : 255
      }
    }
    const passes = interlace === 0 ? [[0, 0, 1, 1]] : interlace === 1 ? ADAM7 : null
    if (!passes) throw new Error(`PNG: unknown interlace method ${interlace}`)
    let offset = 0
    for (const [x0, y0, dx, dy] of passes as readonly (readonly [number, number, number, number])[]) {
      const columns = Math.ceil((width - x0) / dx)
      const lines = Math.ceil((height - y0) / dy)
      if (columns <= 0 || lines <= 0) continue
      const stride = Math.ceil((columns * bitsPerPixel) / 8)
      const size = (stride + 1) * lines
      if (raw.length < offset + size) throw new Error('PNG: the image data is cut short')
      const rows = Png.#unfilter(raw.subarray(offset, offset + size), stride, lines, bpp)
      offset += size
      for (let j = 0; j < lines; j++) {
        const row = rows.subarray(j * stride, (j + 1) * stride)
        for (let i = 0; i < columns; i++) put(row, i, x0 + i * dx, y0 + j * dy)
      }
    }
    return { width, height, data: out }
  }

  static encode(image: Image): Buffer {
    const { width, height, data } = image
    if (data.length !== width * height * 4) throw new Error(`PNG: ${width}×${height} RGBA needs ${width * height * 4} bytes, got ${data.length}`)
    const stride = width * 4
    const raw = Buffer.alloc((stride + 1) * height)
    for (let y = 0; y < height; y++) {
      const at = y * (stride + 1)
      raw[at] = 1
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? data[y * stride + i - 4]! : 0
        raw[at + 1 + i] = (data[y * stride + i]! - left) & 0xff
      }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    return Buffer.concat([SIGNATURE, Png.#chunk('IHDR', ihdr), Png.#chunk('IDAT', deflateSync(raw, { level: 6 })), Png.#chunk('IEND', Buffer.alloc(0))])
  }

  static crop(image: Image, x: number, y: number, width: number, height: number): Image {
    const left = Math.max(0, Math.min(image.width, Math.round(x)))
    const top = Math.max(0, Math.min(image.height, Math.round(y)))
    const w = Math.max(0, Math.min(image.width - left, Math.round(width)))
    const h = Math.max(0, Math.min(image.height - top, Math.round(height)))
    const out = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row++) out.set(image.data.subarray(((top + row) * image.width + left) * 4, ((top + row) * image.width + left + w) * 4), row * w * 4)
    return { width: w, height: h, data: out }
  }

  static fill(image: Image, x: number, y: number, width: number, height: number, rgba: readonly [number, number, number, number]): Image {
    const data = Uint8Array.from(image.data)
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(image.width, Math.ceil(x + width))
    const y1 = Math.min(image.height, Math.ceil(y + height))
    for (let row = y0; row < y1; row++) for (let col = x0; col < x1; col++) data.set(rgba, (row * image.width + col) * 4)
    return { width: image.width, height: image.height, data }
  }

  static same(a: Image, b: Image): boolean {
    return a.width === b.width && a.height === b.height && Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength))
  }

  static diff(actual: Image, expected: Image, options: DiffOptions = {}): Diff {
    if (actual.width !== expected.width || actual.height !== expected.height) throw new Error(`the sizes differ: ${actual.width}×${actual.height} against ${expected.width}×${expected.height}`)
    const { width, height } = actual
    const a = actual.data
    const b = expected.data
    const out = new Uint8Array(a.length)
    const limit = 35215 * (options.threshold ?? Png.DIFF_THRESHOLD) ** 2
    let pixels = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4
        const delta = Png.#delta(a, b, at, at, false)
        if (Math.abs(delta) > limit) {
          if (!options.antialiasing && (Png.#antialiased(a, b, x, y, width, height) || Png.#antialiased(b, a, x, y, width, height))) out.set([255, 255, 0, 255], at)
          else {
            out.set([255, 0, 0, 255], at)
            pixels++
          }
        } else {
          const gray = 255 + (Png.#luma(a, at) - 255) * 0.1 * (a[at + 3]! / 255)
          out.set([gray, gray, gray, 255], at)
        }
      }
    }
    return { pixels, image: { width, height, data: out } }
  }

  static #unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
    const out = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]!
      const src = y * (stride + 1) + 1
      const row = y * stride
      for (let i = 0; i < stride; i++) {
        const v = raw[src + i]!
        const left = i >= bpp ? out[row + i - bpp]! : 0
        const up = y > 0 ? out[row - stride + i]! : 0
        const corner = y > 0 && i >= bpp ? out[row - stride + i - bpp]! : 0
        let value: number
        switch (filter) {
          case 0:
            value = v
            break
          case 1:
            value = v + left
            break
          case 2:
            value = v + up
            break
          case 3:
            value = v + ((left + up) >> 1)
            break
          case 4: {
            const p = left + up - corner
            const pa = Math.abs(p - left)
            const pb = Math.abs(p - up)
            const pc = Math.abs(p - corner)
            value = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner)
            break
          }
          default:
            throw new Error(`PNG: unknown filter ${filter} on row ${y}`)
        }
        out[row + i] = value & 0xff
      }
    }
    return out
  }

  static #chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(Png.#crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }

  static #crc(bytes: Uint8Array): number {
    let c = 0xffffffff
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  static #luma(d: Uint8Array, at: number): number {
    return d[at]! * 0.29889531 + d[at + 1]! * 0.58662247 + d[at + 2]! * 0.11448223
  }

  static #delta(a: Uint8Array, b: Uint8Array, i: number, j: number, brightness: boolean): number {
    let r1 = a[i]!, g1 = a[i + 1]!, b1 = a[i + 2]!
    let r2 = b[j]!, g2 = b[j + 1]!, b2 = b[j + 2]!
    const a1 = a[i + 3]!, a2 = b[j + 3]!
    if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0
    if (a1 < 255) {
      const k = a1 / 255
      r1 = 255 + (r1 - 255) * k
      g1 = 255 + (g1 - 255) * k
      b1 = 255 + (b1 - 255) * k
    }
    if (a2 < 255) {
      const k = a2 / 255
      r2 = 255 + (r2 - 255) * k
      g2 = 255 + (g2 - 255) * k
      b2 = 255 + (b2 - 255) * k
    }
    const y1 = r1 * 0.29889531 + g1 * 0.58662247 + b1 * 0.11448223
    const y2 = r2 * 0.29889531 + g2 * 0.58662247 + b2 * 0.11448223
    const y = y1 - y2
    if (brightness) return y
    const i1 = r1 * 0.59597799 - g1 * 0.2741761 - b1 * 0.32180189
    const i2 = r2 * 0.59597799 - g2 * 0.2741761 - b2 * 0.32180189
    const q1 = r1 * 0.21147017 - g1 * 0.52261711 + b1 * 0.31114694
    const q2 = r2 * 0.21147017 - g2 * 0.52261711 + b2 * 0.31114694
    const delta = 0.5053 * y * y + 0.299 * (i1 - i2) ** 2 + 0.1957 * (q1 - q2) ** 2
    return y1 > y2 ? -delta : delta
  }

  static #antialiased(img: Uint8Array, other: Uint8Array, x1: number, y1: number, width: number, height: number): boolean {
    const x0 = Math.max(x1 - 1, 0)
    const y0 = Math.max(y1 - 1, 0)
    const x2 = Math.min(x1 + 1, width - 1)
    const y2 = Math.min(y1 + 1, height - 1)
    const at = (y1 * width + x1) * 4
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0
    let min = 0
    let max = 0
    let minX = 0, minY = 0, maxX = 0, maxY = 0
    for (let x = x0; x <= x2; x++) {
      for (let y = y0; y <= y2; y++) {
        if (x === x1 && y === y1) continue
        const delta = Png.#delta(img, img, at, (y * width + x) * 4, true)
        if (delta === 0) {
          if (++zeroes > 2) return false
        } else if (delta < min) {
          min = delta
          minX = x
          minY = y
        } else if (delta > max) {
          max = delta
          maxX = x
          maxY = y
        }
      }
    }
    if (min === 0 || max === 0) return false
    return (Png.#siblings(img, minX, minY, width, height) && Png.#siblings(other, minX, minY, width, height)) || (Png.#siblings(img, maxX, maxY, width, height) && Png.#siblings(other, maxX, maxY, width, height))
  }

  static #siblings(img: Uint8Array, x1: number, y1: number, width: number, height: number): boolean {
    const x0 = Math.max(x1 - 1, 0)
    const y0 = Math.max(y1 - 1, 0)
    const x2 = Math.min(x1 + 1, width - 1)
    const y2 = Math.min(y1 + 1, height - 1)
    const at = (y1 * width + x1) * 4
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0
    for (let x = x0; x <= x2; x++) {
      for (let y = y0; y <= y2; y++) {
        if (x === x1 && y === y1) continue
        const other = (y * width + x) * 4
        if (img[at] === img[other] && img[at + 1] === img[other + 1] && img[at + 2] === img[other + 2] && img[at + 3] === img[other + 3]) zeroes++
        if (zeroes > 2) return true
      }
    }
    return false
  }
}
