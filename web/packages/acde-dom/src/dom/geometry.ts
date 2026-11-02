import { DOMException } from '../core/exception'
import { tag } from '../core/host'

export class DOMRectReadOnly {
  protected _x: number
  protected _y: number
  protected _w: number
  protected _h: number

  constructor(x = 0, y = 0, width = 0, height = 0) {
    this._x = +x
    this._y = +y
    this._w = +width
    this._h = +height
  }

  static fromRect(rect?: { x?: number; y?: number; width?: number; height?: number }): DOMRectReadOnly {
    return new this(rect?.x, rect?.y, rect?.width, rect?.height)
  }

  get x(): number {
    return this._x
  }
  get y(): number {
    return this._y
  }
  get width(): number {
    return this._w
  }
  get height(): number {
    return this._h
  }
  get left(): number {
    return Math.min(this._x, this._x + this._w)
  }
  get right(): number {
    return Math.max(this._x, this._x + this._w)
  }
  get top(): number {
    return Math.min(this._y, this._y + this._h)
  }
  get bottom(): number {
    return Math.max(this._y, this._y + this._h)
  }

  toJSON(): object {
    return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }
  }
}
tag(DOMRectReadOnly)

export class DOMRect extends DOMRectReadOnly {
  static override fromRect(rect?: { x?: number; y?: number; width?: number; height?: number }): DOMRect {
    return new DOMRect(rect?.x, rect?.y, rect?.width, rect?.height)
  }
  override get x(): number {
    return this._x
  }
  override set x(v: number) {
    this._x = +v
  }
  override get y(): number {
    return this._y
  }
  override set y(v: number) {
    this._y = +v
  }
  override get width(): number {
    return this._w
  }
  override set width(v: number) {
    this._w = +v
  }
  override get height(): number {
    return this._h
  }
  override set height(v: number) {
    this._h = +v
  }
}
tag(DOMRect)

export class DOMRectList {
  readonly #rects: DOMRect[]
  constructor(rects: DOMRect[]) {
    this.#rects = rects
    for (let i = 0; i < rects.length; i++) Object.defineProperty(this, i, { value: rects[i], enumerable: true })
  }
  get length(): number {
    return this.#rects.length
  }
  item(index: number): DOMRect | null {
    return this.#rects[index] ?? null
  }
  [Symbol.iterator](): IterableIterator<DOMRect> {
    return this.#rects[Symbol.iterator]()
  }
}
tag(DOMRectList)

export function rectList(values: Float64Array): DOMRectList {
  const rects: DOMRect[] = []
  for (let i = 0; i + 3 < values.length; i += 4) rects.push(new DOMRect(values[i], values[i + 1], values[i + 2], values[i + 3]))
  return new DOMRectList(rects)
}

export class DOMPointReadOnly {
  protected _p: [number, number, number, number]

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this._p = [+x, +y, +z, +w]
  }

  static fromPoint(p?: { x?: number; y?: number; z?: number; w?: number }): DOMPointReadOnly {
    return new this(p?.x, p?.y, p?.z, p?.w)
  }

  get x(): number {
    return this._p[0]
  }
  get y(): number {
    return this._p[1]
  }
  get z(): number {
    return this._p[2]
  }
  get w(): number {
    return this._p[3]
  }

  matrixTransform(matrix?: DOMMatrixInit): DOMPoint {
    const m = DOMMatrixReadOnly.fromMatrix(matrix)
    const [x, y, z, w] = this._p
    const v = m.m
    return new DOMPoint(v[0]! * x + v[4]! * y + v[8]! * z + v[12]! * w, v[1]! * x + v[5]! * y + v[9]! * z + v[13]! * w, v[2]! * x + v[6]! * y + v[10]! * z + v[14]! * w, v[3]! * x + v[7]! * y + v[11]! * z + v[15]! * w)
  }

  toJSON(): object {
    return { x: this.x, y: this.y, z: this.z, w: this.w }
  }
}
tag(DOMPointReadOnly)

export class DOMPoint extends DOMPointReadOnly {
  static override fromPoint(p?: { x?: number; y?: number; z?: number; w?: number }): DOMPoint {
    return new DOMPoint(p?.x, p?.y, p?.z, p?.w)
  }
  override get x(): number {
    return this._p[0]
  }
  override set x(v: number) {
    this._p[0] = +v
  }
  override get y(): number {
    return this._p[1]
  }
  override set y(v: number) {
    this._p[1] = +v
  }
  override get z(): number {
    return this._p[2]
  }
  override set z(v: number) {
    this._p[2] = +v
  }
  override get w(): number {
    return this._p[3]
  }
  override set w(v: number) {
    this._p[3] = +v
  }
}
tag(DOMPoint)

export class DOMQuad {
  readonly p1: DOMPoint
  readonly p2: DOMPoint
  readonly p3: DOMPoint
  readonly p4: DOMPoint
  constructor(p1?: DOMPointInit, p2?: DOMPointInit, p3?: DOMPointInit, p4?: DOMPointInit) {
    this.p1 = DOMPoint.fromPoint(p1)
    this.p2 = DOMPoint.fromPoint(p2)
    this.p3 = DOMPoint.fromPoint(p3)
    this.p4 = DOMPoint.fromPoint(p4)
  }
  static fromRect(r?: { x?: number; y?: number; width?: number; height?: number }): DOMQuad {
    const x = r?.x ?? 0, y = r?.y ?? 0, w = r?.width ?? 0, h = r?.height ?? 0
    return new DOMQuad({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h })
  }
  getBounds(): DOMRect {
    const xs = [this.p1.x, this.p2.x, this.p3.x, this.p4.x], ys = [this.p1.y, this.p2.y, this.p3.y, this.p4.y]
    const x = Math.min(...xs), y = Math.min(...ys)
    return new DOMRect(x, y, Math.max(...xs) - x, Math.max(...ys) - y)
  }
}
tag(DOMQuad)

interface DOMPointInit {
  x?: number
  y?: number
  z?: number
  w?: number
}

interface DOMMatrixInit {
  a?: number
  b?: number
  c?: number
  d?: number
  e?: number
  f?: number
  m11?: number
  m12?: number
  m13?: number
  m14?: number
  m21?: number
  m22?: number
  m23?: number
  m24?: number
  m31?: number
  m32?: number
  m33?: number
  m34?: number
  m41?: number
  m42?: number
  m43?: number
  m44?: number
  is2D?: boolean
}

type M16 = number[]

function identity(): M16 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

function multiply(a: M16, b: M16): M16 {
  const out = new Array(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

function from2d(a: number, b: number, c: number, d: number, e: number, f: number): M16 {
  return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]
}

const ANGLE: Record<string, number> = { deg: Math.PI / 180, rad: 1, grad: Math.PI / 200, turn: 2 * Math.PI }

function angle(text: string): number {
  const m = /^(-?[\d.e+-]+)(deg|rad|grad|turn)?$/.exec(text.trim())
  if (!m) throw new DOMException(`Failed to parse '${text}'`, 'SyntaxError')
  return parseFloat(m[1]!) * (m[2] ? ANGLE[m[2]]! : Math.PI / 180)
}

function length(text: string): number {
  const v = parseFloat(text)
  if (Number.isNaN(v)) throw new DOMException(`Failed to parse '${text}'`, 'SyntaxError')
  return v
}

export function parseTransform(text: string, svg = false): { m: M16; is2D: boolean } {
  let m = identity()
  let is2D = true
  const source = text.trim()
  if (source === '' || source === 'none') return { m, is2D }
  const re = /([a-zA-Z0-9]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  let consumed = 0
  while ((match = re.exec(source))) {
    if (source.slice(consumed, match.index).replace(/[\s,]/g, '')) throw new DOMException(`Failed to parse '${text}'`, 'SyntaxError')
    consumed = match.index + match[0].length
    const name = match[1]!.toLowerCase()
    const args = match[2]!.split(/[\s,]+/).filter(Boolean)
    const n = args.map((a) => (svg ? parseFloat(a) : a)) as (string | number)[]
    const num = (i: number, fallback?: number) => (n[i] === undefined ? fallback! : typeof n[i] === 'number' ? (n[i] as number) : length(n[i] as string))
    const ang = (i: number) => (typeof n[i] === 'number' ? ((n[i] as number) * Math.PI) / 180 : angle(n[i] as string))
    let t: M16
    switch (name) {
      case 'matrix': t = from2d(num(0), num(1), num(2), num(3), num(4), num(5)); break
      case 'matrix3d': t = args.map(Number); is2D = false; break
      case 'translate': t = from2d(1, 0, 0, 1, num(0), num(1, 0)); break
      case 'translatex': t = from2d(1, 0, 0, 1, num(0), 0); break
      case 'translatey': t = from2d(1, 0, 0, 1, 0, num(0)); break
      case 'translate3d': t = identity(); t[12] = num(0); t[13] = num(1); t[14] = num(2); is2D = false; break
      case 'scale': t = from2d(num(0), 0, 0, num(1, num(0)), 0, 0); break
      case 'scalex': t = from2d(num(0), 0, 0, 1, 0, 0); break
      case 'scaley': t = from2d(1, 0, 0, num(0), 0, 0); break
      case 'rotate':
      case 'rotatez': {
        const r = ang(0), cos = Math.cos(r), sin = Math.sin(r)
        t = from2d(cos, sin, -sin, cos, 0, 0)
        if (svg && n.length >= 3) {
          const cx = num(1), cy = num(2)
          t = multiply(multiply(from2d(1, 0, 0, 1, cx, cy), t), from2d(1, 0, 0, 1, -cx, -cy))
        }
        break
      }
      case 'skew': t = from2d(1, Math.tan(n.length > 1 ? ang(1) : 0), Math.tan(ang(0)), 1, 0, 0); break
      case 'skewx': t = from2d(1, 0, Math.tan(ang(0)), 1, 0, 0); break
      case 'skewy': t = from2d(1, Math.tan(ang(0)), 0, 1, 0, 0); break
      default: throw new DOMException(`Failed to parse '${text}'`, 'SyntaxError')
    }
    m = multiply(m, t)
  }
  if (source.slice(consumed).trim()) throw new DOMException(`Failed to parse '${text}'`, 'SyntaxError')
  return { m, is2D }
}

const NAMES = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'] as const

export class DOMMatrixReadOnly {
  m: M16
  protected _2d: boolean

  constructor(init?: string | number[] | Float32Array | Float64Array) {
    if (init === undefined) {
      this.m = identity()
      this._2d = true
    } else if (typeof init === 'string') {
      const { m, is2D } = parseTransform(init)
      this.m = m
      this._2d = is2D
    } else {
      const list = Array.from(init, Number)
      if (list.length === 6) {
        this.m = from2d(list[0]!, list[1]!, list[2]!, list[3]!, list[4]!, list[5]!)
        this._2d = true
      } else if (list.length === 16) {
        this.m = list
        this._2d = false
      } else throw new TypeError(`Failed to construct 'DOMMatrix': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.`)
    }
  }

  static fromMatrix(init?: DOMMatrixInit | DOMMatrixReadOnly): DOMMatrix {
    if (init instanceof DOMMatrixReadOnly) {
      const copy = new DOMMatrix()
      copy.m = init.m.slice()
      copy._2d = init._2d
      return copy
    }
    const out = new DOMMatrix()
    if (!init) return out
    const v = out.m
    v[0] = init.m11 ?? init.a ?? 1
    v[1] = init.m12 ?? init.b ?? 0
    v[4] = init.m21 ?? init.c ?? 0
    v[5] = init.m22 ?? init.d ?? 1
    v[12] = init.m41 ?? init.e ?? 0
    v[13] = init.m42 ?? init.f ?? 0
    v[2] = init.m13 ?? 0
    v[3] = init.m14 ?? 0
    v[6] = init.m23 ?? 0
    v[7] = init.m24 ?? 0
    v[8] = init.m31 ?? 0
    v[9] = init.m32 ?? 0
    v[10] = init.m33 ?? 1
    v[11] = init.m34 ?? 0
    v[14] = init.m43 ?? 0
    v[15] = init.m44 ?? 1
    out._2d = init.is2D ?? ([2, 3, 6, 7, 8, 9, 11, 14].every((i) => v[i] === 0) && v[10] === 1 && v[15] === 1)
    return out
  }

  static fromFloat32Array(array: Float32Array): DOMMatrix {
    return new DOMMatrix(array)
  }
  static fromFloat64Array(array: Float64Array): DOMMatrix {
    return new DOMMatrix(array)
  }

  get a(): number {
    return this.m[0]!
  }
  get b(): number {
    return this.m[1]!
  }
  get c(): number {
    return this.m[4]!
  }
  get d(): number {
    return this.m[5]!
  }
  get e(): number {
    return this.m[12]!
  }
  get f(): number {
    return this.m[13]!
  }
  get is2D(): boolean {
    return this._2d
  }
  get isIdentity(): boolean {
    const id = identity()
    return this.m.every((v, i) => v === id[i])
  }

  multiply(other?: DOMMatrixInit | DOMMatrixReadOnly): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).multiplySelf(other)
  }
  translate(tx = 0, ty = 0, tz = 0): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).translateSelf(tx, ty, tz)
  }
  scale(sx = 1, sy = sx, sz = 1, ox = 0, oy = 0, oz = 0): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).scaleSelf(sx, sy, sz, ox, oy, oz)
  }
  scaleNonUniform(sx = 1, sy = 1): DOMMatrix {
    return this.scale(sx, sy, 1)
  }
  scale3d(s = 1, ox = 0, oy = 0, oz = 0): DOMMatrix {
    return this.scale(s, s, s, ox, oy, oz)
  }
  rotate(rx = 0, ry?: number, rz?: number): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).rotateSelf(rx, ry, rz)
  }
  rotateFromVector(x = 0, y = 0): DOMMatrix {
    return this.rotate((Math.atan2(y, x) * 180) / Math.PI)
  }
  skewX(sx = 0): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).skewXSelf(sx)
  }
  skewY(sy = 0): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).skewYSelf(sy)
  }
  flipX(): DOMMatrix {
    return this.multiply({ a: -1 })
  }
  flipY(): DOMMatrix {
    return this.multiply({ d: -1 })
  }
  inverse(): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(this).invertSelf()
  }

  transformPoint(point?: DOMPointInit): DOMPoint {
    return DOMPoint.fromPoint(point).matrixTransform(this)
  }

  toFloat32Array(): Float32Array {
    return Float32Array.from(this.m)
  }
  toFloat64Array(): Float64Array {
    return Float64Array.from(this.m)
  }

  toJSON(): object {
    const out: Record<string, number | boolean> = { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f, is2D: this.is2D, isIdentity: this.isIdentity }
    NAMES.forEach((name, i) => (out[name] = this.m[i]!))
    return out
  }

  toString(): string {
    return this._2d ? `matrix(${[this.a, this.b, this.c, this.d, this.e, this.f].join(', ')})` : `matrix3d(${this.m.join(', ')})`
  }
}
NAMES.forEach((name, i) => Object.defineProperty(DOMMatrixReadOnly.prototype, name, { get(this: DOMMatrixReadOnly) { return this.m[i] }, enumerable: true, configurable: true }))
tag(DOMMatrixReadOnly)

export class DOMMatrix extends DOMMatrixReadOnly {
  static override fromMatrix(init?: DOMMatrixInit | DOMMatrixReadOnly): DOMMatrix {
    return DOMMatrixReadOnly.fromMatrix(init)
  }

  multiplySelf(other?: DOMMatrixInit | DOMMatrixReadOnly): this {
    const o = DOMMatrixReadOnly.fromMatrix(other)
    this.m = multiply(this.m, o.m)
    this._2d = this._2d && o.is2D
    return this
  }
  preMultiplySelf(other?: DOMMatrixInit | DOMMatrixReadOnly): this {
    const o = DOMMatrixReadOnly.fromMatrix(other)
    this.m = multiply(o.m, this.m)
    this._2d = this._2d && o.is2D
    return this
  }
  translateSelf(tx = 0, ty = 0, tz = 0): this {
    const t = identity()
    t[12] = tx
    t[13] = ty
    t[14] = tz
    this.m = multiply(this.m, t)
    if (tz) this._2d = false
    return this
  }
  scaleSelf(sx = 1, sy = sx, sz = 1, ox = 0, oy = 0, oz = 0): this {
    this.translateSelf(ox, oy, oz)
    const t = identity()
    t[0] = sx
    t[5] = sy
    t[10] = sz
    this.m = multiply(this.m, t)
    if (sz !== 1) this._2d = false
    return this.translateSelf(-ox, -oy, -oz)
  }
  scale3dSelf(s = 1, ox = 0, oy = 0, oz = 0): this {
    return this.scaleSelf(s, s, s, ox, oy, oz)
  }
  rotateSelf(rx = 0, ry?: number, rz?: number): this {
    if (ry === undefined && rz === undefined) {
      rz = rx
      rx = 0
      ry = 0
    }
    const rad = Math.PI / 180
    if (rz) {
      const c = Math.cos(rz * rad), s = Math.sin(rz * rad)
      this.m = multiply(this.m, from2d(c, s, -s, c, 0, 0))
    }
    if (ry) {
      const c = Math.cos(ry * rad), s = Math.sin(ry * rad)
      this.m = multiply(this.m, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
      this._2d = false
    }
    if (rx) {
      const c = Math.cos(rx * rad), s = Math.sin(rx * rad)
      this.m = multiply(this.m, [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
      this._2d = false
    }
    return this
  }
  skewXSelf(sx = 0): this {
    this.m = multiply(this.m, from2d(1, 0, Math.tan((sx * Math.PI) / 180), 1, 0, 0))
    return this
  }
  skewYSelf(sy = 0): this {
    this.m = multiply(this.m, from2d(1, Math.tan((sy * Math.PI) / 180), 0, 1, 0, 0))
    return this
  }
  invertSelf(): this {
    const inv = invert(this.m)
    if (!inv) {
      this.m = new Array(16).fill(NaN)
      this._2d = false
    } else this.m = inv
    return this
  }
  setMatrixValue(text: string): this {
    const { m, is2D } = parseTransform(text)
    this.m = m
    this._2d = is2D
    return this
  }
}
for (const [name, i] of [['a', 0], ['b', 1], ['c', 4], ['d', 5], ['e', 12], ['f', 13]] as const) {
  Object.defineProperty(DOMMatrix.prototype, name, { get(this: DOMMatrix) { return this.m[i] }, set(this: DOMMatrix, v: number) { this.m[i] = +v }, enumerable: true, configurable: true })
}
NAMES.forEach((name, i) => Object.defineProperty(DOMMatrix.prototype, name, { get(this: DOMMatrix) { return this.m[i] }, set(this: DOMMatrix, v: number) { this.m[i] = +v }, enumerable: true, configurable: true }))
tag(DOMMatrix)

function invert(m: M16): M16 | null {
  const inv = new Array(16)
  inv[0] = m[5]! * m[10]! * m[15]! - m[5]! * m[11]! * m[14]! - m[9]! * m[6]! * m[15]! + m[9]! * m[7]! * m[14]! + m[13]! * m[6]! * m[11]! - m[13]! * m[7]! * m[10]!
  inv[4] = -m[4]! * m[10]! * m[15]! + m[4]! * m[11]! * m[14]! + m[8]! * m[6]! * m[15]! - m[8]! * m[7]! * m[14]! - m[12]! * m[6]! * m[11]! + m[12]! * m[7]! * m[10]!
  inv[8] = m[4]! * m[9]! * m[15]! - m[4]! * m[11]! * m[13]! - m[8]! * m[5]! * m[15]! + m[8]! * m[7]! * m[13]! + m[12]! * m[5]! * m[11]! - m[12]! * m[7]! * m[9]!
  inv[12] = -m[4]! * m[9]! * m[14]! + m[4]! * m[10]! * m[13]! + m[8]! * m[5]! * m[14]! - m[8]! * m[6]! * m[13]! - m[12]! * m[5]! * m[10]! + m[12]! * m[6]! * m[9]!
  inv[1] = -m[1]! * m[10]! * m[15]! + m[1]! * m[11]! * m[14]! + m[9]! * m[2]! * m[15]! - m[9]! * m[3]! * m[14]! - m[13]! * m[2]! * m[11]! + m[13]! * m[3]! * m[10]!
  inv[5] = m[0]! * m[10]! * m[15]! - m[0]! * m[11]! * m[14]! - m[8]! * m[2]! * m[15]! + m[8]! * m[3]! * m[14]! + m[12]! * m[2]! * m[11]! - m[12]! * m[3]! * m[10]!
  inv[9] = -m[0]! * m[9]! * m[15]! + m[0]! * m[11]! * m[13]! + m[8]! * m[1]! * m[15]! - m[8]! * m[3]! * m[13]! - m[12]! * m[1]! * m[11]! + m[12]! * m[3]! * m[9]!
  inv[13] = m[0]! * m[9]! * m[14]! - m[0]! * m[10]! * m[13]! - m[8]! * m[1]! * m[14]! + m[8]! * m[2]! * m[13]! + m[12]! * m[1]! * m[10]! - m[12]! * m[2]! * m[9]!
  inv[2] = m[1]! * m[6]! * m[15]! - m[1]! * m[7]! * m[14]! - m[5]! * m[2]! * m[15]! + m[5]! * m[3]! * m[14]! + m[13]! * m[2]! * m[7]! - m[13]! * m[3]! * m[6]!
  inv[6] = -m[0]! * m[6]! * m[15]! + m[0]! * m[7]! * m[14]! + m[4]! * m[2]! * m[15]! - m[4]! * m[3]! * m[14]! - m[12]! * m[2]! * m[7]! + m[12]! * m[3]! * m[6]!
  inv[10] = m[0]! * m[5]! * m[15]! - m[0]! * m[7]! * m[13]! - m[4]! * m[1]! * m[15]! + m[4]! * m[3]! * m[13]! + m[12]! * m[1]! * m[7]! - m[12]! * m[3]! * m[5]!
  inv[14] = -m[0]! * m[5]! * m[14]! + m[0]! * m[6]! * m[13]! + m[4]! * m[1]! * m[14]! - m[4]! * m[2]! * m[13]! - m[12]! * m[1]! * m[6]! + m[12]! * m[2]! * m[5]!
  inv[3] = -m[1]! * m[6]! * m[11]! + m[1]! * m[7]! * m[10]! + m[5]! * m[2]! * m[11]! - m[5]! * m[3]! * m[10]! - m[9]! * m[2]! * m[7]! + m[9]! * m[3]! * m[6]!
  inv[7] = m[0]! * m[6]! * m[11]! - m[0]! * m[7]! * m[10]! - m[4]! * m[2]! * m[11]! + m[4]! * m[3]! * m[10]! + m[8]! * m[2]! * m[7]! - m[8]! * m[3]! * m[6]!
  inv[11] = -m[0]! * m[5]! * m[11]! + m[0]! * m[7]! * m[9]! + m[4]! * m[1]! * m[11]! - m[4]! * m[3]! * m[9]! - m[8]! * m[1]! * m[7]! + m[8]! * m[3]! * m[5]!
  inv[15] = m[0]! * m[5]! * m[10]! - m[0]! * m[6]! * m[9]! - m[4]! * m[1]! * m[10]! + m[4]! * m[2]! * m[9]! + m[8]! * m[1]! * m[6]! - m[8]! * m[2]! * m[5]!
  const det = m[0]! * inv[0] + m[1]! * inv[4] + m[2]! * inv[8] + m[3]! * inv[12]
  if (!det) return null
  return inv.map((v: number) => v / det)
}
