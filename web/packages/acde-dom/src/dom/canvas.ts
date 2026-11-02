import { DOMException } from '../core/exception'
import { host, tag } from '../core/host'
import { DOMMatrix } from './geometry'
import type { Element } from './element'
import { dom, ID } from './realm'

const finite = Number.isFinite

export interface CanvasElement extends Element {
  width: number
  height: number
}

export class TextMetrics {
  readonly width: number
  readonly actualBoundingBoxLeft: number
  readonly actualBoundingBoxRight: number
  readonly actualBoundingBoxAscent: number
  readonly actualBoundingBoxDescent: number
  readonly fontBoundingBoxAscent: number
  readonly fontBoundingBoxDescent: number
  readonly emHeightAscent: number
  readonly emHeightDescent: number
  readonly hangingBaseline = 0
  readonly alphabeticBaseline = 0
  readonly ideographicBaseline = 0

  constructor(m: ArrayLike<number>) {
    this.width = m[0] ?? 0
    this.actualBoundingBoxLeft = m[1] ?? 0
    this.actualBoundingBoxRight = m[2] ?? 0
    this.actualBoundingBoxAscent = m[3] ?? 0
    this.actualBoundingBoxDescent = m[4] ?? 0
    this.fontBoundingBoxAscent = m[5] ?? 0
    this.fontBoundingBoxDescent = m[6] ?? 0
    this.emHeightAscent = this.fontBoundingBoxAscent
    this.emHeightDescent = this.fontBoundingBoxDescent
  }
}
tag(TextMetrics)

export class ImageData {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
  readonly colorSpace = 'srgb'

  constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
    if (typeof a === 'number') {
      if (!(a > 0) || !(b > 0)) throw new DOMException('The source width or height is 0.', 'IndexSizeError')
      this.width = a
      this.height = b
      this.data = new Uint8ClampedArray(a * b * 4)
    } else {
      const height = c ?? a.length / 4 / b
      if (a.length !== b * height * 4) throw new DOMException('The input data length is not equal to (4 * width * height).', 'IndexSizeError')
      this.data = a
      this.width = b
      this.height = height
    }
  }
}
tag(ImageData)

type Rgba = [number, number, number, number]

const colors = new Map<string, Rgba | null>()

function parseColor(text: string): Rgba | null {
  let rgba = colors.get(text)
  if (rgba === undefined) {
    const parsed = dom.parseColor(text)
    rgba = parsed ? [parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!] : null
    if (colors.size > 1024) colors.clear()
    colors.set(text, rgba)
  }
  return rgba
}

export class CanvasGradient {
  static #next = 1
  readonly id = CanvasGradient.#next++
  version = 0
  readonly stops: [number, Rgba][] = []

  constructor(
    readonly kind: 1 | 2,
    readonly coords: readonly number[],
  ) {}

  addColorStop(offset: number, color: string): void {
    const rgba = parseColor(String(color))
    if (!rgba || !(offset >= 0 && offset <= 1)) throw new DOMException(`addColorStop(${offset}, ${color})`, 'SyntaxError')
    this.stops.push([offset, rgba])
    this.stops.sort((a, b) => a[0] - b[0])
    this.version++
  }
}

class CommandWriter {
  #buf = new Uint8Array(1024)
  #view = new DataView(this.#buf.buffer)
  len = 0

  u8(v: number): this {
    this.#reserve(1)
    this.#buf[this.len++] = v
    return this
  }
  u32(v: number): this {
    this.#reserve(4)
    this.#view.setUint32(this.len, v, true)
    this.len += 4
    return this
  }
  f(v: number): this {
    this.#reserve(4)
    this.#view.setFloat32(this.len, v, true)
    this.len += 4
    return this
  }
  f32(...vs: number[]): this {
    this.#reserve(4 * vs.length)
    for (const v of vs) {
      this.#view.setFloat32(this.len, v, true)
      this.len += 4
    }
    return this
  }
  str(s: string): this {
    const bytes = host.encodeUtf8(s)
    this.#reserve(4 + bytes.length)
    this.#view.setUint32(this.len, bytes.length, true)
    this.#buf.set(bytes, this.len + 4)
    this.len += 4 + bytes.length
    return this
  }
  bytes(b: Uint8Array): this {
    this.#reserve(b.length)
    this.#buf.set(b, this.len)
    this.len += b.length
    return this
  }
  take(): Uint8Array {
    const out = this.#buf.slice(0, this.len)
    this.len = 0
    return out
  }
  #reserve(n: number): void {
    if (this.len + n <= this.#buf.length) return
    const grown = new Uint8Array(Math.max(this.#buf.length * 2, this.len + n))
    grown.set(this.#buf.subarray(0, this.len))
    this.#buf = grown
    this.#view = new DataView(grown.buffer)
  }
}

type Matrix = [number, number, number, number, number, number]
export class CanvasPattern {
  static #next = 1
  static readonly REPEATS = ['repeat', 'repeat-x', 'repeat-y', 'no-repeat']
  readonly id = CanvasPattern.#next++
  version = 0
  m: Matrix = [1, 0, 0, 1, 0, 0]

  constructor(
    readonly source: Element,
    readonly repetition: number,
  ) {}

  setTransform(t: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number } = {}): void {
    this.m = [t.a ?? 1, t.b ?? 0, t.c ?? 0, t.d ?? 1, t.e ?? 0, t.f ?? 0]
    this.version++
  }
}

type Style = string | CanvasGradient | CanvasPattern | object

interface State {
  m: Matrix
  fill: Style
  stroke: Style
  lineWidth: number
  cap: string
  join: string
  miter: number
  dash: number[]
  dashOffset: number
  alpha: number
  gco: string
  font: string
  align: string
  baseline: string
  direction: string
  shadow: { color: string; rgba: Rgba; blur: number; x: number; y: number }
}

const M = 1, FILL = 2, STROKE = 4, LINE_WIDTH = 8, LINE = 16, DASH = 32, ALPHA = 64, GCO = 128, FONT = 256, TEXT = 512, SHADOW = 1024
const ALL = 2047
const LINES = LINE_WIDTH | LINE | DASH
const NEEDS_FILL = M | FILL | ALPHA | GCO | SHADOW
const NEEDS_STROKE = M | STROKE | LINES | ALPHA | GCO | SHADOW
const NEEDS_IMAGE = M | ALPHA | GCO | SHADOW

interface Sent {
  dirty: number
  fill: number
  stroke: number
}

function styleVersion(style: Style): number {
  return style instanceof CanvasGradient || style instanceof CanvasPattern ? style.version : -1
}

const Sub = {
  Save: 1, Restore: 2, SetTransform: 3, FillStyle: 4, StrokeStyle: 5, LineWidth: 6, Line: 7, Dash: 8, Alpha: 9, Composite: 10, Font: 11, Text: 12, Shadow: 13,
  BeginPath: 20, MoveTo: 21, LineTo: 22, Quadratic: 23, Bezier: 24, Arc: 25, ArcTo: 26, Ellipse: 27, Rect: 28, RoundRect: 29, ClosePath: 30, SvgPath: 31,
  Fill: 40, Stroke: 41, Clip: 42, Rects: 43, DrawText: 44, DrawImage: 45, PutImageData: 46,
} as const

const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel']
const ALIGNS = ['start', 'end', 'left', 'right', 'center'], BASELINES = ['alphabetic', 'top', 'hanging', 'middle', 'ideographic', 'bottom']
const DIRECTIONS = ['inherit', 'ltr', 'rtl']
const COMPOSITES = ['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out', 'destination-atop',
  'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']

export class CanvasContext2d {
  #state: State = CanvasContext2d.#initial()
  #stack: State[] = []
  #sent: Sent = { dirty: ALL, fill: -1, stroke: -1 }
  #sentStack: Sent[] = []
  readonly #out = new CommandWriter()
  #size: [number, number]
  target: number | null = null
  imageSmoothingEnabled = true
  imageSmoothingQuality = 'low'
  filter = 'none'

  constructor(
    readonly canvas: CanvasElement,
    readonly owner: CanvasContexts,
  ) {
    this.#size = [canvas.width, canvas.height]
  }

  static #initial(): State {
    return { m: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000', lineWidth: 1, cap: 'butt', join: 'miter', miter: 10, dash: [], dashOffset: 0, alpha: 1, gco: 'source-over', font: '10px sans-serif', align: 'start', baseline: 'alphabetic', direction: 'inherit', shadow: { color: 'rgba(0, 0, 0, 0)', rgba: [0, 0, 0, 0], blur: 0, x: 0, y: 0 } }
  }

  take(): Uint8Array {
    return this.#out.take()
  }

  get pending(): boolean {
    return this.#out.len > 0
  }

  forget(): void {
    this.#out.take()
    this.#sent = { dirty: ALL, fill: -1, stroke: -1 }
    this.#sentStack = []
  }

  #changed(bits: number): void {
    this.#sent.dirty |= bits
  }
  #shadow(key: 'blur' | 'x' | 'y', v: number): void {
    if (Number.isFinite(v) && (key !== 'blur' || v >= 0) && v !== this.#state.shadow[key]) {
      this.#state.shadow = { ...this.#state.shadow, [key]: v }
      this.#changed(SHADOW)
    }
  }
  #choice(key: 'cap' | 'join' | 'gco' | 'align' | 'baseline' | 'direction', values: readonly string[], v: string, bits: number): void {
    if (values.includes(v) && v !== this.#state[key]) {
      this.#state[key] = v
      this.#changed(bits)
    }
  }

  get shadowColor(): string {
    return this.#state.shadow.color
  }
  set shadowColor(v: string) {
    const rgba = parseColor(String(v))
    if (rgba) {
      this.#state.shadow = { ...this.#state.shadow, color: String(v), rgba }
      this.#changed(SHADOW)
    }
  }
  get shadowBlur(): number {
    return this.#state.shadow.blur
  }
  set shadowBlur(v: number) {
    this.#shadow('blur', v)
  }
  get shadowOffsetX(): number {
    return this.#state.shadow.x
  }
  set shadowOffsetX(v: number) {
    this.#shadow('x', v)
  }
  get shadowOffsetY(): number {
    return this.#state.shadow.y
  }
  set shadowOffsetY(v: number) {
    this.#shadow('y', v)
  }

  get fillStyle(): Style {
    return this.#state.fill
  }
  set fillStyle(v: Style) {
    if (v !== this.#state.fill && (typeof v === 'string' ? parseColor(v) : v instanceof CanvasGradient || v instanceof CanvasPattern)) {
      this.#state.fill = v
      this.#changed(FILL)
    }
  }
  get strokeStyle(): Style {
    return this.#state.stroke
  }
  set strokeStyle(v: Style) {
    if (v !== this.#state.stroke && (typeof v === 'string' ? parseColor(v) : v instanceof CanvasGradient || v instanceof CanvasPattern)) {
      this.#state.stroke = v
      this.#changed(STROKE)
    }
  }
  get lineWidth(): number {
    return this.#state.lineWidth
  }
  set lineWidth(v: number) {
    if (v > 0 && Number.isFinite(v) && v !== this.#state.lineWidth) {
      this.#state.lineWidth = v
      this.#changed(LINE_WIDTH)
    }
  }
  get lineCap(): string {
    return this.#state.cap
  }
  set lineCap(v: string) {
    this.#choice('cap', CAPS, v, LINE)
  }
  get lineJoin(): string {
    return this.#state.join
  }
  set lineJoin(v: string) {
    this.#choice('join', JOINS, v, LINE)
  }
  get miterLimit(): number {
    return this.#state.miter
  }
  set miterLimit(v: number) {
    if (v > 0 && Number.isFinite(v) && v !== this.#state.miter) {
      this.#state.miter = v
      this.#changed(LINE)
    }
  }
  get lineDashOffset(): number {
    return this.#state.dashOffset
  }
  set lineDashOffset(v: number) {
    if (Number.isFinite(v) && v !== this.#state.dashOffset) {
      this.#state.dashOffset = v
      this.#changed(DASH)
    }
  }
  setLineDash(segments: number[]): void {
    if (segments.some((s) => !(s >= 0) || !Number.isFinite(s))) return
    this.#state.dash = segments.length % 2 ? [...segments, ...segments] : [...segments]
    this.#changed(DASH)
  }
  getLineDash(): number[] {
    return [...this.#state.dash]
  }
  get globalAlpha(): number {
    return this.#state.alpha
  }
  set globalAlpha(v: number) {
    if (v >= 0 && v <= 1 && v !== this.#state.alpha) {
      this.#state.alpha = v
      this.#changed(ALPHA)
    }
  }
  get globalCompositeOperation(): string {
    return this.#state.gco
  }
  set globalCompositeOperation(v: string) {
    this.#choice('gco', COMPOSITES, v, GCO)
  }
  get font(): string {
    return this.#state.font
  }
  set font(v: string) {
    if (typeof v === 'string' && v.trim() && v !== this.#state.font) {
      this.#state.font = v
      this.#changed(FONT)
    }
  }
  get textAlign(): string {
    return this.#state.align
  }
  set textAlign(v: string) {
    this.#choice('align', ALIGNS, v, TEXT)
  }
  get textBaseline(): string {
    return this.#state.baseline
  }
  set textBaseline(v: string) {
    this.#choice('baseline', BASELINES, v, TEXT)
  }
  get direction(): string {
    return this.#state.direction
  }
  set direction(v: string) {
    this.#choice('direction', DIRECTIONS, v, TEXT)
  }

  save(): void {
    this.#check()
    this.#stack.push({ ...this.#state, m: [...this.#state.m] as Matrix, dash: [...this.#state.dash] })
    this.#sentStack.push({ ...this.#sent })
    this.#cmd().u8(Sub.Save)
  }
  restore(): void {
    this.#check()
    const state = this.#stack.pop()
    if (!state) return
    this.#state = state
    this.#sent = this.#sentStack.pop() ?? { dirty: ALL, fill: -1, stroke: -1 }
    this.#cmd().u8(Sub.Restore)
  }
  reset(): void {
    this.#check()
    while (this.#stack.length) this.restore()
    this.#state = CanvasContext2d.#initial()
    this.#changed(ALL)
    this.#sync(M)
    this.#cmd().u8(Sub.Rects).u8(2).f32(0, 0, this.canvas.width, this.canvas.height)
  }

  setTransform(a: number | { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number } = {}, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    const m = typeof a === 'object' ? [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0] : [a, b!, c!, d!, e!, f!]
    if (m.every(Number.isFinite)) {
      this.#state.m = m as Matrix
      this.#changed(M)
    }
  }
  resetTransform(): void {
    this.#state.m = [1, 0, 0, 1, 0, 0]
    this.#changed(M)
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (![a, b, c, d, e, f].every(Number.isFinite)) return
    const [A, B, C, D, E, F] = this.#state.m
    this.#state.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F]
    this.#changed(M)
  }
  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y)
  }
  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0)
  }
  rotate(angle: number): void {
    const cos = Math.cos(angle), sin = Math.sin(angle)
    this.transform(cos, sin, -sin, cos, 0, 0)
  }
  getTransform(): DOMMatrix {
    return new DOMMatrix(this.#state.m)
  }

  beginPath(): void {
    this.#check()
    this.#cmd().u8(Sub.BeginPath)
  }
  closePath(): void {
    this.#check()
    this.#cmd().u8(Sub.ClosePath)
  }
  moveTo(x: number, y: number): void {
    this.#path(Sub.MoveTo, finite(x) && finite(y))?.f(x).f(y)
  }
  lineTo(x: number, y: number): void {
    this.#path(Sub.LineTo, finite(x) && finite(y))?.f(x).f(y)
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.#path(Sub.Quadratic, finite(cx) && finite(cy) && finite(x) && finite(y))?.f(cx).f(cy).f(x).f(y)
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.#path(Sub.Bezier, finite(c1x) && finite(c1y) && finite(c2x) && finite(c2y) && finite(x) && finite(y))?.f(c1x).f(c1y).f(c2x).f(c2y).f(x).f(y)
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    if (r < 0) throw new DOMException(`arc radius ${r}`, 'IndexSizeError')
    this.#path(Sub.Arc, finite(x) && finite(y) && finite(r) && finite(a0) && finite(a1))?.f(x).f(y).f(r).f(a0).f(a1).u8(ccw ? 1 : 0)
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (r < 0) throw new DOMException(`arcTo radius ${r}`, 'IndexSizeError')
    this.#path(Sub.ArcTo, finite(x1) && finite(y1) && finite(x2) && finite(y2) && finite(r))?.f(x1).f(y1).f(x2).f(y2).f(r)
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw = false): void {
    if (rx < 0 || ry < 0) throw new DOMException(`ellipse radii ${rx} ${ry}`, 'IndexSizeError')
    this.#path(Sub.Ellipse, finite(x) && finite(y) && finite(rx) && finite(ry) && finite(rotation) && finite(a0) && finite(a1))?.f(x).f(y).f(rx).f(ry).f(rotation).f(a0).f(a1).u8(ccw ? 1 : 0)
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.#path(Sub.Rect, finite(x) && finite(y) && finite(w) && finite(h))?.f(x).f(y).f(w).f(h)
  }
  roundRect(x: number, y: number, w: number, h: number, radii: number | { x?: number } | (number | { x?: number })[] = 0): void {
    const list = (Array.isArray(radii) ? radii : [radii]).map((r) => (typeof r === 'number' ? r : (r?.x ?? 0)))
    const [tl, tr = tl, br = tl, bl = tr] = list.length === 3 ? [list[0]!, list[1]!, list[2]!, list[1]!] : (list as [number, number?, number?, number?])
    this.#path(Sub.RoundRect, finite(x) && finite(y) && finite(w) && finite(h) && finite(tl) && finite(tr) && finite(br) && finite(bl))?.f(x).f(y).f(w).f(h).f(tl!).f(tr!).f(br!).f(bl!)
  }

  fill(rule: unknown = 'nonzero', rule2?: string): void {
    if (rule instanceof Path2D) {
      this.#replay(rule)
      return this.fill(rule2 ?? 'nonzero')
    }
    if (typeof rule !== 'string') return
    this.#check()
    this.#sync(NEEDS_FILL)
    this.#cmd().u8(Sub.Fill).u8(rule === 'evenodd' ? 1 : 0)
  }
  stroke(path?: unknown): void {
    if (path instanceof Path2D) {
      this.#replay(path)
      return this.stroke()
    }
    if (path !== undefined) return
    this.#check()
    this.#sync(NEEDS_STROKE)
    this.#cmd().u8(Sub.Stroke)
  }
  clip(rule: unknown = 'nonzero', rule2?: string): void {
    if (rule instanceof Path2D) {
      this.#replay(rule)
      return this.clip(rule2 ?? 'nonzero')
    }
    if (typeof rule !== 'string') return
    this.#check()
    this.#sync(M)
    this.#cmd().u8(Sub.Clip).u8(rule === 'evenodd' ? 1 : 0)
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.#rects(0, x, y, w, h)
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.#rects(1, x, y, w, h)
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.#rects(2, x, y, w, h)
  }
  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.#text(0, text, x, y, maxWidth)
  }
  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.#text(1, text, x, y, maxWidth)
  }
  measureText(text: string): TextMetrics {
    return this.owner.measure(this.canvas, this.#state.font, String(text))
  }
  drawImage(image: Element, ...a: number[]): void {
    this.#check()
    const tag = (image as Element | null)?.localName
    if (tag !== 'img' && tag !== 'canvas') return
    const id = image[ID]
    const iw = tag === 'canvas' ? (image as unknown as CanvasElement).width : (image as unknown as { naturalWidth: number }).naturalWidth || NaN
    const ih = tag === 'canvas' ? (image as unknown as CanvasElement).height : (image as unknown as { naturalHeight: number }).naturalHeight || NaN
    const [sx, sy, sw, sh, dx, dy, dw, dh] =
      a.length >= 8 ? a : a.length >= 4 ? [0, 0, iw, ih, a[0]!, a[1]!, a[2]!, a[3]!] : [0, 0, iw, ih, a[0]!, a[1]!, iw, ih]
    if (![sx, sy, dx, dy].every(Number.isFinite)) return
    this.#sync(NEEDS_IMAGE)
    this.#cmd().u8(Sub.DrawImage).u8(tag === 'img' ? 0 : 1).u32(id).f32(sx!, sy!, sw!, sh!, dx!, dy!, dw!, dh!)
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    return new CanvasGradient(1, [x0, y0, x1, y1])
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
    return new CanvasGradient(2, [x0, y0, r0, x1, y1, r1])
  }
  createConicGradient(): CanvasGradient {
    return new CanvasGradient(1, [0, 0, 0, 0])
  }
  createPattern(image: Element, repetition: string | null = 'repeat'): CanvasPattern | null {
    const tag = image?.localName
    if (tag !== 'img' && tag !== 'canvas') throw new TypeError('createPattern: an <img> or <canvas>')
    const rep = repetition === null || repetition === '' ? 0 : CanvasPattern.REPEATS.indexOf(String(repetition))
    if (rep < 0) throw new DOMException(`createPattern repetition ${repetition}`, 'SyntaxError')
    if (tag === 'canvas' && (!(image as unknown as CanvasElement).width || !(image as unknown as CanvasElement).height)) throw new DOMException('createPattern of an empty canvas', 'InvalidStateError')
    if (tag === 'img' && !(image as unknown as { complete: boolean }).complete) return null
    return new CanvasPattern(image, rep)
  }
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    if (![sx, sy, sw, sh].every(Number.isFinite)) throw new TypeError('getImageData: non-finite argument')
    if (!sw || !sh) throw new DOMException('getImageData: zero width or height', 'IndexSizeError')
    const width = Math.abs(Math.trunc(sw)), height = Math.abs(Math.trunc(sh))
    const bytes = this.owner.pixels(this.canvas, sx, sy, sw, sh)
    const data = bytes && bytes.length === width * height * 4 ? new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length) : new Uint8ClampedArray(width * height * 4)
    return new ImageData(data, width, height)
  }
  createImageData(w: number | { width: number; height: number }, h?: number): ImageData {
    const [width, height] = typeof w === 'number' ? [w, h ?? 0] : [w.width, w.height]
    return new ImageData(Math.abs(Math.trunc(width)), Math.abs(Math.trunc(height)))
  }
  putImageData(image: { width: number; height: number; data: ArrayLike<number> & { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number } }, dx: number, dy: number, dirtyX = 0, dirtyY = 0, dirtyW?: number, dirtyH?: number): void {
    this.#check()
    const { width, height, data } = image
    if (![dx, dy, dirtyX, dirtyY].every(Number.isFinite) || data.length !== width * height * 4) return
    const raw = data.buffer ? new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length) : Uint8Array.from(data)
    this.#cmd().u8(Sub.PutImageData).f32(dx, dy, dirtyX, dirtyY, dirtyW ?? width, dirtyH ?? height).u32(width).u32(height).bytes(raw)
  }
  isPointInPath(): boolean {
    return false
  }

  #replay(path: Path2D): void {
    this.beginPath()
    for (const command of path.commands) {
      if (command[0] === 'svg') this.#svgPath(command[1] as string, command.slice(2) as number[])
      else (this as unknown as Record<string, (...a: number[]) => void>)[command[0]]!(...(command.slice(1) as number[]))
    }
  }

  #svgPath(d: string, m: number[]): void {
    this.#check()
    if (!m.every(Number.isFinite)) return
    this.#sync(M)
    this.#cmd().u8(Sub.SvgPath).str(d).f32(...m)
  }
  isPointInStroke(): boolean {
    return false
  }
  getContextAttributes(): { alpha: boolean; desynchronized: boolean } {
    return { alpha: true, desynchronized: false }
  }
  drawFocusIfNeeded(): void {}

  #check(): void {
    const { width, height } = this.canvas
    if (width === this.#size[0] && height === this.#size[1]) return
    this.#size = [width, height]
    this.#state = CanvasContext2d.#initial()
    this.#stack = []
    this.#sent = { dirty: ALL, fill: -1, stroke: -1 }
    this.#sentStack = []
    this.#out.take()
  }

  #cmd(): CommandWriter {
    this.owner.writing(this)
    return this.#out
  }

  #path(code: number, ok: boolean): CommandWriter | null {
    this.#check()
    if (!ok) return null
    this.#sync(M)
    return this.#cmd().u8(code)
  }

  #rects(kind: 0 | 1 | 2, x: number, y: number, w: number, h: number): void {
    this.#check()
    if (!(finite(x) && finite(y) && finite(w) && finite(h))) return
    this.#sync(kind === 0 ? NEEDS_FILL : kind === 1 ? NEEDS_STROKE : M)
    this.#cmd().u8(Sub.Rects).u8(kind).f(x).f(y).f(w).f(h)
  }

  #text(kind: 0 | 1, text: string, x: number, y: number, maxWidth?: number): void {
    this.#check()
    if (!(finite(x) && finite(y))) return
    this.#sync((kind ? NEEDS_STROKE : NEEDS_FILL) | FONT | TEXT)
    this.#cmd().u8(Sub.DrawText).u8(kind).str(String(text)).f32(x, y, maxWidth === undefined || !(maxWidth >= 0) ? NaN : maxWidth)
  }

  #sync(need: number): void {
    const s = this.#state, sent = this.#sent
    let send = need & sent.dirty
    if (need & FILL && !(send & FILL) && typeof s.fill !== 'string' && styleVersion(s.fill) !== sent.fill) send |= FILL
    if (need & STROKE && !(send & STROKE) && typeof s.stroke !== 'string' && styleVersion(s.stroke) !== sent.stroke) send |= STROKE
    if (send === 0) return
    sent.dirty &= ~send
    this.owner.writing(this)
    const out = this.#out
    if (send & M) out.u8(Sub.SetTransform).f32(...s.m)
    if (send & FILL) {
      this.#paint(out.u8(Sub.FillStyle), s.fill)
      sent.fill = styleVersion(s.fill)
    }
    if (send & STROKE) {
      this.#paint(out.u8(Sub.StrokeStyle), s.stroke)
      sent.stroke = styleVersion(s.stroke)
    }
    if (send & LINE_WIDTH) out.u8(Sub.LineWidth).f32(s.lineWidth)
    if (send & LINE) out.u8(Sub.Line).u8(CAPS.indexOf(s.cap)).u8(JOINS.indexOf(s.join)).f32(s.miter)
    if (send & DASH) out.u8(Sub.Dash).u32(s.dash.length).f32(...s.dash, s.dashOffset)
    if (send & ALPHA) out.u8(Sub.Alpha).f32(s.alpha)
    if (send & GCO) out.u8(Sub.Composite).u8(COMPOSITES.indexOf(s.gco))
    if (send & FONT) out.u8(Sub.Font).str(s.font)
    if (send & SHADOW) {
      const sh = s.shadow
      out.u8(Sub.Shadow).f32(...sh.rgba, sh.blur, sh.x, sh.y)
    }
    if (send & TEXT) out.u8(Sub.Text).u8(ALIGNS.indexOf(s.align)).u8(BASELINES.indexOf(s.baseline)).u8(DIRECTIONS.indexOf(s.direction))
  }

  #paint(out: CommandWriter, style: Style): void {
    if (style instanceof CanvasPattern) {
      return void out.u8(3).u8(style.source.localName === 'img' ? 0 : 1).u32(style.source[ID]).u8(style.repetition).f32(...style.m)
    }
    if (style instanceof CanvasGradient) {
      out.u8(style.kind).f32(...style.coords).u32(style.stops.length)
      for (const [offset, rgba] of style.stops) out.f32(offset, ...rgba)
      return
    }
    out.u8(0).f32(...((typeof style === 'string' && parseColor(style)) || [0, 0, 0, 0]))
  }
}

class CanvasContexts {
  readonly #contexts = new WeakMap<object, CanvasContext2d>()
  readonly #dirty = new Set<CanvasContext2d>()
  #writer: CanvasContext2d | null = null

  context(canvas: CanvasElement): CanvasContext2d {
    let context = this.#contexts.get(canvas)
    if (!context) this.#contexts.set(canvas, (context = new CanvasContext2d(canvas, this)))
    return context
  }

  has(canvas: CanvasElement): boolean {
    return this.#contexts.has(canvas)
  }

  writing(context: CanvasContext2d): void {
    if (this.#writer !== context) {
      const last = this.#writer
      if (last?.pending) this.#send(last)
      this.#writer = context
    }
    this.#dirty.add(context)
  }

  #send(context: CanvasContext2d): void {
    const bytes = context.take()
    if (bytes.length) dom.canvas(context.canvas[ID], bytes)
  }

  flush(): void {
    if (this.#dirty.size === 0) return
    for (const context of this.#dirty) if (context.pending) this.#send(context)
    this.#dirty.clear()
    this.#writer = null
  }

  pixels(canvas: CanvasElement, sx: number, sy: number, sw: number, sh: number): Uint8Array | null {
    this.flush()
    return dom.getImageData(canvas[ID], sx, sy, sw, sh)
  }

  measure(canvas: CanvasElement, font: string, text: string): TextMetrics {
    return new TextMetrics(dom.measureText(canvas[ID], font, text))
  }

  toDataURL(canvas: CanvasElement, type: string): string {
    this.flush()
    return dom.toDataURL(canvas[ID], type)
  }
}

export const canvases = new CanvasContexts()

type PathCommand = [string, ...number[]] | ['svg', string, ...number[]]

export class Path2D {
  readonly commands: PathCommand[] = []

  constructor(init?: Path2D | string) {
    if (init instanceof Path2D) this.commands.push(...init.commands.map((c) => [...c] as PathCommand))
    else if (typeof init === 'string') this.commands.push(['svg', init, 1, 0, 0, 1, 0, 0])
  }

  addPath(path: Path2D, transform?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }): void {
    if (!transform) {
      this.commands.push(...path.commands)
      return
    }
    const m = DOMMatrix.fromMatrix(transform)
    const p = (x: number, y: number) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]
    for (const command of path.commands) {
      if (command[0] === 'svg') {
        const [, d, a, b, c, dd, e, f] = command as [string, string, number, number, number, number, number, number]
        const t = m.multiply({ a, b, c, d: dd, e, f })
        this.commands.push(['svg', d, t.a, t.b, t.c, t.d, t.e, t.f])
        continue
      }
      const [op, ...a] = command as [string, ...number[]]
      if (op === 'moveTo' || op === 'lineTo') this.commands.push([op, ...p(a[0]!, a[1]!)])
      else if (op === 'quadraticCurveTo') this.commands.push([op, ...p(a[0]!, a[1]!), ...p(a[2]!, a[3]!)])
      else if (op === 'bezierCurveTo') this.commands.push([op, ...p(a[0]!, a[1]!), ...p(a[2]!, a[3]!), ...p(a[4]!, a[5]!)])
      else this.commands.push([op, ...a])
    }
  }

  closePath(): void {
    this.commands.push(['closePath'])
  }
  moveTo(x: number, y: number): void {
    this.commands.push(['moveTo', x, y])
  }
  lineTo(x: number, y: number): void {
    this.commands.push(['lineTo', x, y])
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.commands.push(['quadraticCurveTo', cx, cy, x, y])
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this.commands.push(['bezierCurveTo', a, b, c, d, x, y])
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    this.commands.push(['arc', x, y, r, a0, a1, ccw ? 1 : 0])
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    this.commands.push(['arcTo', x1, y1, x2, y2, r])
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw = false): void {
    this.commands.push(['ellipse', x, y, rx, ry, rotation, a0, a1, ccw ? 1 : 0])
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.commands.push(['rect', x, y, w, h])
  }
  roundRect(x: number, y: number, w: number, h: number, r: number | number[] = 0): void {
    const radii = Array.isArray(r) ? r : [r]
    this.commands.push(['roundRect', x, y, w, h, ...radii])
  }
}
tag(Path2D)
