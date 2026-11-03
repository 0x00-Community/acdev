import { tag } from '../core/host'
import { NONE, NodeType } from '../native'
import { Element, setAttribute } from './element'
import { DOMMatrix, DOMPoint, DOMRect, svgTransform } from './geometry'
import { defineElementHandlers, HTMLOrSVGElementMixin, svgClasses, svgFallback } from './html'
import { metricsOf, rectOf } from './layout'
import { elementById, mixin } from './node'
import { dom, ID, wrap } from './realm'

export class SVGAnimatedString {
  constructor(
    readonly element: Element,
    readonly attribute: string,
  ) {}
  get baseVal(): string {
    return dom.getAttribute(this.element[ID], this.attribute) ?? ''
  }
  set baseVal(value: string) {
    setAttribute(this.element, this.attribute, String(value))
  }
  get animVal(): string {
    return this.baseVal
  }
}
tag(SVGAnimatedString)

export class SVGElement extends Element {
  get ownerSVGElement(): SVGSVGElement | null {
    const parent = dom.parent(this[ID])
    if (parent === NONE || dom.nodeType(parent) !== NodeType.Element) return null
    return wrap<SVGSVGElement>(dom.closest(parent, 'svg'))
  }

  get viewportElement(): SVGElement | null {
    return this.ownerSVGElement
  }
}
mixin(SVGElement, HTMLOrSVGElementMixin)
defineElementHandlers(SVGElement.prototype)
tag(SVGElement)
export interface SVGElement extends HTMLOrSVGElementMixin {}
Object.defineProperty(SVGElement.prototype, 'className', {
  get(this: Element) {
    return new SVGAnimatedString(this, 'class')
  },
  set(this: Element, value: unknown) {
    setAttribute(this, 'class', String(value))
  },
  enumerable: true,
  configurable: true,
})

export class SVGTransform {
  static readonly SVG_TRANSFORM_UNKNOWN = 0
  static readonly SVG_TRANSFORM_MATRIX = 1
  constructor(readonly matrix: DOMMatrix) {}
  get type(): number {
    return 1
  }
  get angle(): number {
    return 0
  }
  setMatrix(matrix: DOMMatrix): void {
    ;(this as { matrix: DOMMatrix }).matrix = DOMMatrix.fromMatrix(matrix)
  }
}
tag(SVGTransform)

export class SVGTransformList {
  constructor(readonly element: Element) {}

  #items(): SVGTransform[] {
    const text = dom.getAttribute(this.element[ID], 'transform') ?? ''
    const items: SVGTransform[] = []
    for (const m of text.matchAll(/[a-zA-Z]+\s*\([^)]*\)/g)) {
      const matrix = transformMatrix(m[0])
      if (matrix) items.push(new SVGTransform(matrix))
    }
    return items
  }

  get numberOfItems(): number {
    return this.#items().length
  }
  get length(): number {
    return this.numberOfItems
  }
  getItem(index: number): SVGTransform {
    const item = this.#items()[index]
    if (!item) throw new RangeError('index out of range')
    return item
  }
  consolidate(): SVGTransform | null {
    const items = this.#items()
    if (items.length === 0) return null
    const m = new DOMMatrix()
    for (const item of items) m.multiplySelf(item.matrix)
    setAttribute(this.element, 'transform', m.toString().replace(/,/g, ''))
    return new SVGTransform(m)
  }
  clear(): void {
    setAttribute(this.element, 'transform', null)
  }
  appendItem(item: SVGTransform): SVGTransform {
    const now = dom.getAttribute(this.element[ID], 'transform') ?? ''
    setAttribute(this.element, 'transform', `${now} ${item.matrix.toString().replace(/,/g, '')}`.trim())
    return item
  }
  createSVGTransformFromMatrix(matrix: DOMMatrix): SVGTransform {
    return new SVGTransform(DOMMatrix.fromMatrix(matrix))
  }
}
tag(SVGTransformList)

export class SVGAnimatedTransformList {
  constructor(readonly element: Element) {}
  get baseVal(): SVGTransformList {
    return new SVGTransformList(this.element)
  }
  get animVal(): SVGTransformList {
    return this.baseVal
  }
}
tag(SVGAnimatedTransformList)

function transformMatrix(text: string): DOMMatrix | null {
  try {
    return svgTransform(text)
  } catch {
    return null
  }
}

function ownTransform(id: number): DOMMatrix {
  const text = dom.getAttribute(id, 'transform')
  return (text && transformMatrix(text)) || new DOMMatrix()
}

function viewportMatrix(svg: number): DOMMatrix {
  const r = rectOf(svg)
  const metrics = metricsOf(svg)
  const x = r[0]! + (metrics?.clientLeft ?? 0), y = r[1]! + (metrics?.clientTop ?? 0)
  const width = metrics?.clientWidth ?? r[2]!, height = metrics?.clientHeight ?? r[3]!
  const m = new DOMMatrix().translateSelf(x, y)
  const box = (dom.getAttribute(svg, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v)) || !(box[2]! > 0) || !(box[3]! > 0)) return m
  const [vx, vy, vw, vh] = box as [number, number, number, number]
  let sx = width / vw, sy = height / vh
  let tx = 0, ty = 0
  const aspect = (dom.getAttribute(svg, 'preserveAspectRatio') ?? 'xMidYMid meet').trim()
  if (!aspect.startsWith('none')) {
    const s = aspect.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy)
    const align = aspect.split(/\s+/)[0]!
    const free = (size: number, content: number, part: string) => (part === 'Min' ? 0 : part === 'Max' ? size - content : (size - content) / 2)
    tx = free(width, vw * s, /xMin/.test(align) ? 'Min' : /xMax/.test(align) ? 'Max' : 'Mid')
    ty = free(height, vh * s, /YMin/.test(align) ? 'Min' : /YMax/.test(align) ? 'Max' : 'Mid')
    sx = sy = s
  }
  return m.translateSelf(tx, ty).scaleSelf(sx, sy).translateSelf(-vx, -vy)
}

function screenCTM(id: number): DOMMatrix {
  const chain: number[] = [id]
  let svg = NONE
  const ancestors = dom.ancestors(id)
  if (dom.localName(id) === 'svg') svg = id
  else {
    for (const a of ancestors) {
      if (dom.nodeType(a) !== NodeType.Element) break
      if (dom.localName(a) === 'svg') {
        svg = a
        break
      }
      chain.push(a)
    }
  }
  if (svg === NONE) return new DOMMatrix()
  const m = viewportMatrix(svg)
  if (svg === id) return m
  for (let i = chain.length - 1; i >= 0; i--) m.multiplySelf(ownTransform(chain[i]!))
  return m
}

export class SVGGraphicsElement extends SVGElement {
  get transform(): SVGAnimatedTransformList {
    return new SVGAnimatedTransformList(this)
  }

  getScreenCTM(): DOMMatrix | null {
    return screenCTM(this[ID])
  }

  getCTM(): DOMMatrix | null {
    const owner = this.ownerSVGElement
    const screen = screenCTM(this[ID])
    if (!owner) return screen
    return viewportMatrix(owner[ID]).inverse().multiply(screen)
  }

  getBBox(): DOMRect {
    const r = rectOf(this[ID])
    if (!r[2] && !r[3]) return new DOMRect()
    const inverse = screenCTM(this[ID]).inverse()
    const corners = [[r[0]!, r[1]!], [r[0]! + r[2]!, r[1]!], [r[0]!, r[1]! + r[3]!], [r[0]! + r[2]!, r[1]! + r[3]!]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(inverse))
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y)
    const x = Math.min(...xs), y = Math.min(...ys)
    return new DOMRect(x, y, Math.max(...xs) - x, Math.max(...ys) - y)
  }

  get farthestViewportElement(): SVGElement | null {
    let found: SVGElement | null = null
    for (const a of dom.ancestors(this[ID])) if (dom.nodeType(a) === NodeType.Element && dom.localName(a) === 'svg') found = wrap<SVGElement>(a)
    return found
  }

  get nearestViewportElement(): SVGElement | null {
    return this.ownerSVGElement
  }
}
tag(SVGGraphicsElement)

export class SVGGeometryElement extends SVGGraphicsElement {
  get pathLength(): { baseVal: number; animVal: number } {
    const v = parseFloat(dom.getAttribute(this[ID], 'pathLength') ?? '')
    return { baseVal: Number.isFinite(v) ? v : 0, animVal: Number.isFinite(v) ? v : 0 }
  }
  getTotalLength(): number {
    const b = this.getBBox()
    return 2 * (b.width + b.height)
  }
  getPointAtLength(_distance: number): DOMPoint {
    const b = this.getBBox()
    return new DOMPoint(b.x, b.y)
  }
  isPointInFill(): boolean {
    return false
  }
  isPointInStroke(): boolean {
    return false
  }
}
tag(SVGGeometryElement)

class SVGNumber {
  constructor(public value: number) {}
}

export class SVGSVGElement extends SVGGraphicsElement {
  createSVGPoint(): DOMPoint {
    return new DOMPoint()
  }
  createSVGMatrix(): DOMMatrix {
    return new DOMMatrix()
  }
  createSVGRect(): DOMRect {
    return new DOMRect()
  }
  createSVGNumber(): SVGNumber {
    return new SVGNumber(0)
  }
  createSVGTransform(): SVGTransform {
    return new SVGTransform(new DOMMatrix())
  }
  createSVGTransformFromMatrix(matrix: DOMMatrix): SVGTransform {
    return new SVGTransform(DOMMatrix.fromMatrix(matrix))
  }
  getElementById(id: string): Element | null {
    return elementById(this[ID], String(id))
  }
  get viewBox(): { baseVal: DOMRect | null; animVal: DOMRect | null } {
    const box = (dom.getAttribute(this[ID], 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    const rect = box.length === 4 && box.every(Number.isFinite) ? new DOMRect(box[0], box[1], box[2], box[3]) : null
    return { baseVal: rect, animVal: rect }
  }
  get width(): { baseVal: { value: number }; animVal: { value: number } } {
    const v = { value: metricsOf(this[ID])?.clientWidth ?? 0 }
    return { baseVal: v, animVal: v }
  }
  get height(): { baseVal: { value: number }; animVal: { value: number } } {
    const v = { value: metricsOf(this[ID])?.clientHeight ?? 0 }
    return { baseVal: v, animVal: v }
  }
  get currentScale(): number {
    return 1
  }
  get currentTranslate(): DOMPoint {
    return new DOMPoint()
  }
  suspendRedraw(): number {
    return 0
  }
  unsuspendRedraw(): void {}
  unsuspendRedrawAll(): void {}
  forceRedraw(): void {}
  pauseAnimations(): void {}
  unpauseAnimations(): void {}
  animationsPaused(): boolean {
    return false
  }
  getCurrentTime(): number {
    return 0
  }
  setCurrentTime(): void {}
}
tag(SVGSVGElement)

function svgClass(name: string, base: typeof SVGElement, ...locals: string[]): typeof SVGElement {
  const cls = { [name]: class extends base {} }[name]!
  tag(cls, name)
  for (const local of locals) svgClasses.set(local, cls)
  return cls
}

svgClasses.set('svg', SVGSVGElement)
export const SVGGElement = svgClass('SVGGElement', SVGGraphicsElement, 'g')
export const SVGDefsElement = svgClass('SVGDefsElement', SVGGraphicsElement, 'defs')
export const SVGUseElement = svgClass('SVGUseElement', SVGGraphicsElement, 'use')
export const SVGSymbolElement = svgClass('SVGSymbolElement', SVGElement, 'symbol')
export const SVGImageElement = svgClass('SVGImageElement', SVGGraphicsElement, 'image')
export const SVGForeignObjectElement = svgClass('SVGForeignObjectElement', SVGGraphicsElement, 'foreignObject')
export const SVGSwitchElement = svgClass('SVGSwitchElement', SVGGraphicsElement, 'switch')
export const SVGAElement = svgClass('SVGAElement', SVGGraphicsElement, 'a')
export const SVGTextContentElement = svgClass('SVGTextContentElement', SVGGraphicsElement)
export const SVGTextElement = svgClass('SVGTextElement', SVGTextContentElement, 'text')
export const SVGTSpanElement = svgClass('SVGTSpanElement', SVGTextContentElement, 'tspan')
export const SVGTextPathElement = svgClass('SVGTextPathElement', SVGTextContentElement, 'textPath')
export const SVGPathElement = svgClass('SVGPathElement', SVGGeometryElement, 'path')
export const SVGRectElement = svgClass('SVGRectElement', SVGGeometryElement, 'rect')
export const SVGCircleElement = svgClass('SVGCircleElement', SVGGeometryElement, 'circle')
export const SVGEllipseElement = svgClass('SVGEllipseElement', SVGGeometryElement, 'ellipse')
export const SVGLineElement = svgClass('SVGLineElement', SVGGeometryElement, 'line')
export const SVGPolylineElement = svgClass('SVGPolylineElement', SVGGeometryElement, 'polyline')
export const SVGPolygonElement = svgClass('SVGPolygonElement', SVGGeometryElement, 'polygon')
export const SVGGradientElement = svgClass('SVGGradientElement', SVGElement)
export const SVGLinearGradientElement = svgClass('SVGLinearGradientElement', SVGGradientElement, 'linearGradient')
export const SVGRadialGradientElement = svgClass('SVGRadialGradientElement', SVGGradientElement, 'radialGradient')
export const SVGStopElement = svgClass('SVGStopElement', SVGElement, 'stop')
export const SVGClipPathElement = svgClass('SVGClipPathElement', SVGElement, 'clipPath')
export const SVGMaskElement = svgClass('SVGMaskElement', SVGElement, 'mask')
export const SVGPatternElement = svgClass('SVGPatternElement', SVGElement, 'pattern')
export const SVGMarkerElement = svgClass('SVGMarkerElement', SVGElement, 'marker')
export const SVGFilterElement = svgClass('SVGFilterElement', SVGElement, 'filter')
export const SVGTitleElement = svgClass('SVGTitleElement', SVGElement, 'title')
export const SVGDescElement = svgClass('SVGDescElement', SVGElement, 'desc')
export const SVGMetadataElement = svgClass('SVGMetadataElement', SVGElement, 'metadata')
export const SVGStyleElement = svgClass('SVGStyleElement', SVGElement, 'style')
export const SVGScriptElement = svgClass('SVGScriptElement', SVGElement, 'script')
export const SVGViewElement = svgClass('SVGViewElement', SVGElement, 'view')
export const SVGAnimationElement = svgClass('SVGAnimationElement', SVGElement, 'animate', 'animateMotion', 'animateTransform', 'set')
for (const fe of ['feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence']) {
  svgClass(`SVG${fe[0]!.toUpperCase()}${fe.slice(1)}Element`, SVGElement, fe)
}
svgFallback.cls = SVGElement
