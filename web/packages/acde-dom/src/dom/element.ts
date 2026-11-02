import { DOMException } from '../core/exception'
import { getHandler, setHandler } from '../core/event'
import { tag } from '../core/host'
import { NONE, NodeType, Ns } from '../native'
import { DOMRect, rectList, type DOMRectList } from './geometry'
import { computedStyleOf, metricsOf, rectOf } from './layout'
import { attributeObservers, observing, recordAttribute } from './mutation'
import { ChildNodeMixin, insert, mixin, Node, ParentNodeMixin, remove, replaceAll, Text, type DocumentFragment, type NodeList } from './node'
import { ancestorsOf, bodyId, changed, CONNECTED as CONNECTED_KEY, dom, guard, ID, moved, wrap } from './realm'

export const LOCAL = Symbol('localName')
export const NS = Symbol('namespace')
export const ATTRIBUTE_CHANGED = Symbol('attributeChanged')
const CLASS_LIST = Symbol('classList')
const DATASET = Symbol('dataset')
const ATTRIBUTE_MAP = Symbol('attributes')

const NAMESPACES = ['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML'] as const

export const pendingElement = { local: null as string | null, ns: Ns.Html as Ns }

export const flags = {
  inlineHandlers: false,
}

export const HANDLER_TYPES = [
  'abort', 'animationcancel', 'animationend', 'animationiteration', 'animationstart', 'auxclick', 'beforeinput', 'beforematch', 'beforetoggle',
  'blur', 'cancel', 'canplay', 'canplaythrough', 'change', 'click', 'close', 'contextlost', 'contextmenu', 'contextrestored', 'copy',
  'cuechange', 'cut', 'dblclick', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'durationchange', 'emptied',
  'ended', 'error', 'focus', 'focusin', 'focusout', 'formdata', 'gotpointercapture', 'input', 'invalid', 'keydown', 'keypress', 'keyup', 'load',
  'loadeddata', 'loadedmetadata', 'loadstart', 'lostpointercapture', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout',
  'mouseover', 'mouseup', 'paste', 'pause', 'play', 'playing', 'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave',
  'pointermove', 'pointerout', 'pointerover', 'pointerrawupdate', 'pointerup', 'progress', 'ratechange', 'reset', 'resize', 'scroll',
  'scrollend', 'securitypolicyviolation', 'seeked', 'seeking', 'select', 'selectionchange', 'selectstart', 'slotchange', 'stalled',
  'submit', 'suspend', 'timeupdate', 'toggle', 'transitioncancel', 'transitionend', 'transitionrun', 'transitionstart', 'volumechange',
  'waiting', 'webkitanimationend', 'webkitanimationiteration', 'webkitanimationstart', 'webkittransitionend', 'wheel',
] as const
const HANDLER_SET = new Set<string>(HANDLER_TYPES)
const HANDLER_ATTRIBUTE = /\son[a-z]+\s*=/i

export function noteMarkup(html: string): void {
  if (!flags.inlineHandlers && HANDLER_ATTRIBUTE.test(html)) flags.inlineHandlers = true
}

export const customAttributes = {
  before: null as null | ((element: Element, name: string) => string | null | undefined),
  after: null as null | ((element: Element, name: string, old: string | null, value: string | null) => void),
}

export function setAttribute(element: Element, name: string, value: string | null): void {
  const id = element[ID]
  const key = element[NS] === Ns.Html ? name.toLowerCase() : name
  const interest = observing() ? attributeObservers(id, key) : null
  let old: string | null = null
  if (interest && (interest.oldValue || value === null)) {
    old = dom.getAttribute(id, key)
    if (value === null && old === null) return
  }
  const custom = customAttributes.before?.(element, key)
  if (value === null ? dom.removeAttribute(id, key) : guard(() => dom.setAttribute(id, key, value))) changed()
  element[ATTRIBUTE_CHANGED](key, value)
  if (interest) recordAttribute(element, interest, key, old)
  if (custom !== undefined) customAttributes.after!(element, key, custom, value)
}

export class Element extends Node {
  [LOCAL]: string;
  [NS]: Ns;
  [CLASS_LIST]: DOMTokenList | null = null;
  [DATASET]: object | null = null;
  [ATTRIBUTE_MAP]: NamedNodeMap | null = null

  constructor() {
    super()
    const local = pendingElement.local
    pendingElement.local = null
    this[LOCAL] = local ?? dom.localName(this[ID])
    this[NS] = local !== null ? pendingElement.ns : dom.namespace(this[ID])
  }

  override get nodeType(): number {
    return NodeType.Element
  }

  override get nodeName(): string {
    return this.tagName
  }

  get localName(): string {
    return this[LOCAL]
  }

  get tagName(): string {
    return this[NS] === Ns.Html ? this[LOCAL].toUpperCase() : this[LOCAL]
  }

  get namespaceURI(): string | null {
    return NAMESPACES[this[NS]] ?? null
  }

  get prefix(): string | null {
    return null
  }

  [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    if (name.length > 2 && name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110 && HANDLER_SET.has(name.slice(2))) {
      flags.inlineHandlers = true
      handlerSet(this, name.slice(2))
      setHandler(this, name.slice(2), value)
    }
  }

  get id(): string {
    return dom.id(this[ID])
  }
  set id(value: string) {
    setAttribute(this, 'id', String(value))
  }

  get className(): string {
    return dom.className(this[ID])
  }
  set className(value: string) {
    setAttribute(this, 'class', String(value))
  }

  get classList(): DOMTokenList {
    return (this[CLASS_LIST] ??= new DOMTokenList(this, 'class'))
  }
  set classList(value: string) {
    setAttribute(this, 'class', String(value))
  }

  get slot(): string {
    return dom.getAttribute(this[ID], 'slot') ?? ''
  }
  set slot(value: string) {
    setAttribute(this, 'slot', String(value))
  }

  get attributes(): NamedNodeMap {
    const map = (this[ATTRIBUTE_MAP] ??= new NamedNodeMap(this))
    map.refresh()
    return map
  }

  getAttribute(name: string): string | null {
    return dom.getAttribute(this[ID], String(name))
  }

  getAttributeNS(namespace: string | null, name: string): string | null {
    return dom.getAttribute(this[ID], qualified(namespace, String(name)))
  }

  setAttribute(name: string, value: string): void {
    setAttribute(this, String(name), String(value))
  }

  setAttributeNS(_namespace: string | null, name: string, value: string): void {
    setAttribute(this, String(name), String(value))
  }

  removeAttribute(name: string): void {
    setAttribute(this, String(name), null)
  }

  removeAttributeNS(namespace: string | null, name: string): void {
    setAttribute(this, qualified(namespace, String(name)), null)
  }

  hasAttribute(name: string): boolean {
    return dom.hasAttribute(this[ID], String(name))
  }

  hasAttributeNS(namespace: string | null, name: string): boolean {
    return dom.hasAttribute(this[ID], qualified(namespace, String(name)))
  }

  hasAttributes(): boolean {
    return dom.attributes(this[ID]).length > 0
  }

  getAttributeNames(): string[] {
    const list = dom.attributes(this[ID])
    const names: string[] = []
    for (let i = 0; i < list.length; i += 2) names.push(list[i]!)
    return names
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const n = String(name)
    const has = dom.hasAttribute(this[ID], n)
    if (has && force !== true) {
      setAttribute(this, n, null)
      return false
    }
    if (!has && force !== false) {
      setAttribute(this, n, '')
      return true
    }
    return has
  }

  getAttributeNode(name: string): Attr | null {
    const value = this.getAttribute(name)
    return value === null ? null : new Attr(this, this[NS] === Ns.Html ? String(name).toLowerCase() : String(name))
  }

  getAttributeNodeNS(namespace: string | null, name: string): Attr | null {
    return this.getAttributeNode(qualified(namespace, String(name)))
  }

  setAttributeNode(attr: Attr): Attr | null {
    const old = this.getAttributeNode(attr.name)
    setAttribute(this, attr.name, attr.value)
    return old
  }

  removeAttributeNode(attr: Attr): Attr {
    setAttribute(this, attr.name, null)
    return attr
  }

  get innerHTML(): string {
    return dom.innerHTML(this[ID])
  }
  set innerHTML(html: string) {
    setInnerHTML(this, html === null ? '' : String(html))
  }

  get outerHTML(): string {
    return dom.outerHTML(this[ID])
  }
  set outerHTML(html: string) {
    const parent = this.parentNode
    if (!parent) return
    if (parent.nodeType === NodeType.Document) throw new DOMException("Failed to set the 'outerHTML' property on 'Element': This element's parent is of type '#document', which is not an element node.", 'NoModificationAllowedError')
    const context = parent.nodeType === NodeType.Element ? parent[ID] : bodyId() === NONE ? this[ID] : bodyId()
    const markup = html === null ? '' : String(html)
    noteMarkup(markup)
    const fragment = wrap<DocumentFragment>(guard(() => dom.parseFragment(context, markup)))!
    insert(parent, fragment, this)
    remove(this)
    parsed(parent)
  }

  insertAdjacentHTML(position: string, html: string): void {
    const where = String(position).toLowerCase()
    const outside = where === 'beforebegin' || where === 'afterend'
    if (!outside && where !== 'afterbegin' && where !== 'beforeend') throw new DOMException(`Failed to execute 'insertAdjacentHTML' on 'Element': The value provided ('${position}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`, 'SyntaxError')
    const parent = this.parentNode
    if (outside && (!parent || parent.nodeType === NodeType.Document)) throw new DOMException("Failed to execute 'insertAdjacentHTML' on 'Element': The element has no parent.", 'NoModificationAllowedError')
    const markup = String(html)
    noteMarkup(markup)
    const context = outside ? parent![ID] : this[ID]
    const fragment = wrap<DocumentFragment>(guard(() => dom.parseFragment(context, markup)))!
    adjacent(this, where, fragment)
    parsed(outside ? parent! : this)
  }

  insertAdjacentElement(position: string, element: Element): Element | null {
    return adjacent(this, String(position).toLowerCase(), element) ? element : null
  }

  insertAdjacentText(position: string, text: string): void {
    adjacent(this, String(position).toLowerCase(), new Text(String(text)))
  }

  matches(selectors: string): boolean {
    return guard(() => dom.matches(this[ID], String(selectors)))
  }

  webkitMatchesSelector(selectors: string): boolean {
    return this.matches(selectors)
  }

  closest(selectors: string): Element | null {
    return wrap<Element>(guard(() => dom.closest(this[ID], String(selectors))))
  }

  getBoundingClientRect(): DOMRect {
    const r = rectOf(this[ID])
    return new DOMRect(r[0], r[1], r[2], r[3])
  }

  getClientRects(): DOMRectList {
    return rectList(dom.clientRects(this[ID]))
  }

  get clientTop(): number {
    return metricsOf(this[ID])?.clientTop ?? 0
  }
  get clientLeft(): number {
    return metricsOf(this[ID])?.clientLeft ?? 0
  }
  get clientWidth(): number {
    return metricsOf(this[ID])?.clientWidth ?? 0
  }
  get clientHeight(): number {
    return metricsOf(this[ID])?.clientHeight ?? 0
  }
  get scrollWidth(): number {
    return metricsOf(this[ID])?.scrollWidth ?? 0
  }
  get scrollHeight(): number {
    return metricsOf(this[ID])?.scrollHeight ?? 0
  }

  get scrollTop(): number {
    return metricsOf(this[ID])?.scrollTop ?? 0
  }
  set scrollTop(value: number) {
    scrollElement(this, null, Number(value), false)
  }

  get scrollLeft(): number {
    return metricsOf(this[ID])?.scrollLeft ?? 0
  }
  set scrollLeft(value: number) {
    scrollElement(this, Number(value), null, false)
  }

  scrollTo(x?: number | ScrollToOptions, y?: number): void {
    if (typeof x === 'object' && x !== null) scrollElement(this, x.left ?? null, x.top ?? null, x.behavior === 'smooth')
    else scrollElement(this, Number(x ?? 0), Number(y ?? 0), false)
  }

  scroll(x?: number | ScrollToOptions, y?: number): void {
    this.scrollTo(x, y)
  }

  scrollBy(x?: number | ScrollToOptions, y?: number): void {
    const m = metricsOf(this[ID])
    if (!m) return
    if (typeof x === 'object' && x !== null) scrollElement(this, m.scrollLeft + (x.left ?? 0), m.scrollTop + (x.top ?? 0), x.behavior === 'smooth')
    else scrollElement(this, m.scrollLeft + Number(x ?? 0), m.scrollTop + Number(y ?? 0), false)
  }

  scrollIntoView(arg?: boolean | ScrollIntoViewOptions): void {
    const options: ScrollIntoViewOptions = typeof arg === 'object' && arg !== null ? arg : { block: arg === false ? 'end' : 'start', inline: 'nearest' }
    scrollIntoView(this, options.block ?? 'start', options.inline ?? 'nearest', options.behavior === 'smooth')
  }

  scrollIntoViewIfNeeded(center = true): void {
    scrollIntoView(this, center ? 'center' : 'nearest', 'nearest', false)
  }

  checkVisibility(options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean; visibilityProperty?: boolean; opacityProperty?: boolean }): boolean {
    if (metricsOf(this[ID]) === null && this[LOCAL] !== 'body' && this[LOCAL] !== 'html') return false
    if ((options?.checkVisibilityCSS || options?.visibilityProperty) && computedStyleOf(this[ID], '', 'visibility') !== 'visible') return false
    if ((options?.checkOpacity || options?.opacityProperty) && parseFloat(computedStyleOf(this[ID], '', 'opacity')) === 0) return false
    return true
  }

  requestFullscreen(): Promise<void> {
    return Promise.reject(new DOMException('Fullscreen is not supported', 'NotSupportedError'))
  }

  requestPointerLock(): Promise<void> {
    return Promise.reject(new DOMException('Pointer lock is not supported', 'NotSupportedError'))
  }

  get assignedSlot(): null {
    return null
  }
}
mixin(Element, ParentNodeMixin)
mixin(Element, ChildNodeMixin)
tag(Element)
export interface Element extends ParentNodeMixin, ChildNodeMixin {}

interface ScrollToOptions {
  left?: number
  top?: number
  behavior?: string
}

interface ScrollIntoViewOptions {
  block?: string
  inline?: string
  behavior?: string
}

function qualified(namespace: string | null, name: string): string {
  if (namespace === 'http://www.w3.org/1999/xlink' && !name.includes(':')) return `xlink:${name}`
  if (namespace === 'http://www.w3.org/XML/1998/namespace' && !name.includes(':')) return `xml:${name}`
  return name
}

export const parsedHooks: ((container: Node) => void)[] = []
function parsed(container: Node): void {
  for (const hook of parsedHooks) hook(container)
}

function setInnerHTML(element: Element, html: string): void {
  noteMarkup(html)
  const id = element[ID]
  const fragment = guard(() => dom.parseFragment(id, html))
  const stand = { [ID]: fragment, [CONNECTED_KEY]: false, nodeType: NodeType.DocumentFragment } as unknown as Node
  replaceAll(element, [stand], () => dom.replaceChildren(id, Uint32Array.of(fragment)))
  parsed(element)
}

function adjacent(element: Element, where: string, node: Node): boolean {
  switch (where) {
    case 'beforebegin': {
      const parent = element.parentNode
      if (!parent) return false
      insert(parent, node, element)
      return true
    }
    case 'afterbegin':
      insert(element, node, element.firstChild)
      return true
    case 'beforeend':
      insert(element, node, null)
      return true
    case 'afterend': {
      const parent = element.parentNode
      if (!parent) return false
      insert(parent, node, element.nextSibling)
      return true
    }
    default:
      throw new DOMException(`The value provided ('${where}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`, 'SyntaxError')
  }
}

export function scrollElement(element: Element, left: number | null, top: number | null, smooth: boolean): void {
  const id = element[ID]
  const m = metricsOf(id)
  if (!m) return
  const x = left === null || !Number.isFinite(left) ? m.scrollLeft : left
  const y = top === null || !Number.isFinite(top) ? m.scrollTop : top
  if (x === m.scrollLeft && y === m.scrollTop) return
  dom.scrollTo(id, x, y, smooth)
  moved()
}

function scrollIntoView(element: Element, block: string, inline: string, smooth: boolean): void {
  const ancestors = ancestorsOf(element[ID])
  let target = rectOf(element[ID])
  for (let i = 0; i < ancestors.length; i++) {
    const id = ancestors[i]!
    if (dom.nodeType(id) !== NodeType.Element) continue
    const m = metricsOf(id)
    if (!m) continue
    const isRoot = dom.localName(id) === 'html'
    const scrollsY = m.scrollHeight > m.clientHeight, scrollsX = m.scrollWidth > m.clientWidth
    if (!scrollsY && !scrollsX) continue
    if (!isRoot) {
      const overflow = computedStyleOf(id, '', 'overflow-y') + ' ' + computedStyleOf(id, '', 'overflow-x')
      if (!/auto|scroll|hidden/.test(overflow)) continue
    }
    const box = isRoot ? Float64Array.of(0, 0, m.clientWidth, m.clientHeight) : rectOf(id)
    const top = box[1]! + m.clientTop, left = box[0]! + m.clientLeft
    const height = m.clientHeight, width = m.clientWidth
    const dy = delta(block, target[1]! - top, target[3]!, height)
    const dx = delta(inline, target[0]! - left, target[2]!, width)
    if (dy || dx) {
      dom.scrollTo(id, m.scrollLeft + dx, m.scrollTop + dy, smooth)
      moved()
      target = rectOf(element[ID])
    }
  }
}

function delta(where: string, offset: number, size: number, view: number): number {
  switch (where) {
    case 'start': return offset
    case 'end': return offset + size - view
    case 'center': return offset + size / 2 - view / 2
    default:
      if (offset < 0 && offset + size < view) return size > view ? offset + size - view : offset
      if (offset + size > view && offset > 0) return size > view ? offset : offset + size - view
      return 0
  }
}

export class Attr {
  readonly #element: Element | null
  readonly #name: string
  #value: string

  constructor(element: Element | null, name: string, value?: string) {
    this.#element = element
    this.#name = name
    this.#value = value ?? ''
  }

  get nodeType(): number {
    return 2
  }
  get nodeName(): string {
    return this.#name
  }
  get name(): string {
    return this.#name
  }
  get localName(): string {
    const colon = this.#name.indexOf(':')
    return colon < 0 ? this.#name : this.#name.slice(colon + 1)
  }
  get prefix(): string | null {
    const colon = this.#name.indexOf(':')
    return colon < 0 ? null : this.#name.slice(0, colon)
  }
  get namespaceURI(): string | null {
    const prefix = this.prefix
    return prefix === 'xlink' ? 'http://www.w3.org/1999/xlink' : prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : prefix === 'xmlns' ? 'http://www.w3.org/2000/xmlns/' : null
  }
  get value(): string {
    return this.#element ? (this.#element.getAttribute(this.#name) ?? this.#value) : this.#value
  }
  set value(value: string) {
    this.#value = String(value)
    if (this.#element) setAttribute(this.#element, this.#name, this.#value)
  }
  get nodeValue(): string {
    return this.value
  }
  get textContent(): string {
    return this.value
  }
  get ownerElement(): Element | null {
    return this.#element
  }
  get specified(): boolean {
    return true
  }
}
tag(Attr)

export class NamedNodeMap {
  readonly #element: Element
  #names: string[] = []
  #attrs = new Map<string, Attr>()

  constructor(element: Element) {
    this.#element = element
  }

  refresh(): void {
    const list = dom.attributes(this.#element[ID])
    const names: string[] = []
    for (let i = 0; i < list.length; i += 2) names.push(list[i]!)
    for (let i = names.length; i < this.#names.length; i++) delete (this as unknown as Record<number, Attr>)[i]
    this.#names = names
    for (let i = 0; i < names.length; i++) {
      let attr = this.#attrs.get(names[i]!)
      if (!attr) this.#attrs.set(names[i]!, (attr = new Attr(this.#element, names[i]!)))
      Object.defineProperty(this, i, { value: attr, enumerable: true, configurable: true })
    }
  }

  get length(): number {
    return this.#names.length
  }

  item(index: number): Attr | null {
    return (this as unknown as Record<number, Attr>)[index] ?? null
  }

  getNamedItem(name: string): Attr | null {
    return this.#element.getAttributeNode(name)
  }

  getNamedItemNS(namespace: string | null, name: string): Attr | null {
    return this.#element.getAttributeNodeNS(namespace, name)
  }

  setNamedItem(attr: Attr): Attr | null {
    return this.#element.setAttributeNode(attr)
  }

  setNamedItemNS(attr: Attr): Attr | null {
    return this.#element.setAttributeNode(attr)
  }

  removeNamedItem(name: string): Attr {
    const attr = this.#element.getAttributeNode(name)
    if (!attr) throw new DOMException(`Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '${name}' was found.`, 'NotFoundError')
    this.#element.removeAttribute(name)
    return attr
  }

  removeNamedItemNS(namespace: string | null, name: string): Attr {
    const attr = this.getNamedItemNS(namespace, name)
    if (!attr) throw new DOMException(`Failed to execute 'removeNamedItemNS' on 'NamedNodeMap': No item with name '${name}' was found.`, 'NotFoundError')
    this.#element.removeAttribute(attr.name)
    return attr
  }

  *[Symbol.iterator](): IterableIterator<Attr> {
    for (let i = 0; i < this.#names.length; i++) yield this.item(i)!
  }
}
tag(NamedNodeMap)

const WHITESPACE = /[\t\n\f\r ]+/

export class DOMTokenList {
  readonly #element: Element
  readonly #attribute: string
  #text: string | null = null
  #tokens: string[] = []
  readonly #supported: readonly string[] | null

  constructor(element: Element, attribute: string, supported: readonly string[] | null = null) {
    this.#element = element
    this.#attribute = attribute
    this.#supported = supported
  }

  #read(): string[] {
    const id = this.#element[ID]
    const text = this.#attribute === 'class' ? dom.className(id) : (dom.getAttribute(id, this.#attribute) ?? '')
    if (text !== this.#text) {
      this.#text = text
      const tokens: string[] = []
      for (const token of text.split(WHITESPACE)) if (token && !tokens.includes(token)) tokens.push(token)
      this.#tokens = tokens
    }
    return this.#tokens
  }

  #write(tokens: string[]): void {
    if (tokens.length === 0 && !this.#element.hasAttribute(this.#attribute)) return
    setAttribute(this.#element, this.#attribute, tokens.join(' '))
  }

  static #check(token: string, method: string): string {
    const t = String(token)
    if (t === '') throw new DOMException(`Failed to execute '${method}' on 'DOMTokenList': The token provided must not be empty.`, 'SyntaxError')
    if (/[\t\n\f\r ]/.test(t)) throw new DOMException(`Failed to execute '${method}' on 'DOMTokenList': The token provided ('${t}') contains HTML space characters, which are not valid in tokens.`, 'InvalidCharacterError')
    return t
  }

  get length(): number {
    return this.#read().length
  }

  get value(): string {
    return this.#attribute === 'class' ? dom.className(this.#element[ID]) : (dom.getAttribute(this.#element[ID], this.#attribute) ?? '')
  }
  set value(value: string) {
    setAttribute(this.#element, this.#attribute, String(value))
  }

  item(index: number): string | null {
    return this.#read()[index] ?? null
  }

  contains(token: string): boolean {
    return this.#read().includes(String(token))
  }

  add(...tokens: string[]): void {
    const list = this.#read().slice()
    for (const token of tokens) {
      const t = DOMTokenList.#check(token, 'add')
      if (!list.includes(t)) list.push(t)
    }
    this.#write(list)
  }

  remove(...tokens: string[]): void {
    const checked = tokens.map((t) => DOMTokenList.#check(t, 'remove'))
    this.#write(this.#read().filter((t) => !checked.includes(t)))
  }

  toggle(token: string, force?: boolean): boolean {
    const t = DOMTokenList.#check(token, 'toggle')
    const list = this.#read()
    const has = list.includes(t)
    if (has) {
      if (force === true) return true
      this.#write(list.filter((x) => x !== t))
      return false
    }
    if (force === false) return false
    this.#write([...list, t])
    return true
  }

  replace(token: string, replacement: string): boolean {
    const t = DOMTokenList.#check(token, 'replace'), r = DOMTokenList.#check(replacement, 'replace')
    const list = this.#read()
    const at = list.indexOf(t)
    if (at < 0) return false
    const next = list.slice()
    if (next.includes(r)) next.splice(at, 1)
    else next[at] = r
    this.#write(next)
    return true
  }

  supports(token: string): boolean {
    if (!this.#supported) throw new TypeError(`Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.`)
    return this.#supported.includes(String(token).toLowerCase())
  }

  forEach(callback: (value: string, index: number, list: DOMTokenList) => void, thisArg?: unknown): void {
    this.#read().slice().forEach((v, i) => callback.call(thisArg, v, i, this))
  }

  keys(): IterableIterator<number> {
    return this.#read().slice().keys()
  }

  values(): IterableIterator<string> {
    return this.#read().slice().values()
  }

  entries(): IterableIterator<[number, string]> {
    return this.#read().slice().entries()
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.values()
  }

  toString(): string {
    return this.value
  }
}
tag(DOMTokenList)

export function tokenList(element: Element, key: symbol, attribute: string, supported: readonly string[] | null = null): DOMTokenList {
  const holder = element as unknown as Record<symbol, DOMTokenList | undefined>
  return (holder[key] ??= new DOMTokenList(element, attribute, supported))
}

export class DOMStringMap {}
tag(DOMStringMap)

function dataName(key: string): string | null {
  if (/-[a-z]/.test(key)) return null
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

function dataKey(attribute: string): string | null {
  if (!attribute.startsWith('data-')) return null
  return attribute.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function dataset(element: Element): DOMStringMap {
  const holder = element as unknown as { [DATASET]: object | null }
  if (holder[DATASET]) return holder[DATASET] as DOMStringMap
  const map = new Proxy(new DOMStringMap(), {
    get(target, key) {
      if (typeof key !== 'string') return Reflect.get(target, key)
      const name = dataName(key)
      return name === null ? undefined : (dom.getAttribute(element[ID], name) ?? undefined)
    },
    set(target, key, value) {
      if (typeof key !== 'string') return Reflect.set(target, key, value)
      const name = dataName(key)
      if (name === null) throw new DOMException(`Failed to set a named property on 'DOMStringMap': '${key}' is not a valid property name.`, 'SyntaxError')
      setAttribute(element, name, String(value))
      return true
    },
    deleteProperty(_target, key) {
      if (typeof key !== 'string') return true
      const name = dataName(key)
      if (name !== null) setAttribute(element, name, null)
      return true
    },
    has(target, key) {
      if (typeof key !== 'string') return Reflect.has(target, key)
      const name = dataName(key)
      return name !== null && dom.hasAttribute(element[ID], name)
    },
    ownKeys() {
      const list = dom.attributes(element[ID])
      const keys: string[] = []
      for (let i = 0; i < list.length; i += 2) {
        const key = dataKey(list[i]!)
        if (key !== null) keys.push(key)
      }
      return keys
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string') return undefined
      const name = dataName(key)
      const value = name === null ? null : dom.getAttribute(element[ID], name)
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true }
    },
  })
  holder[DATASET] = map
  return map
}

const SEEN = Symbol('handlersSeen')

export function handlerOf(element: Element, type: string): unknown {
  if (!flags.inlineHandlers) return getHandler(element, type)
  const holder = element as unknown as { [SEEN]?: Set<string> }
  const seen = (holder[SEEN] ??= new Set())
  if (!seen.has(type)) {
    seen.add(type)
    const source = dom.getAttribute(element[ID], `on${type}`)
    if (source !== null && getHandler(element, type) === null) setHandler(element, type, source)
  }
  return getHandler(element, type)
}

export function handlerSet(element: Element, type: string): void {
  ;((element as unknown as { [SEEN]?: Set<string> })[SEEN] ??= new Set()).add(type)
}

export type { NodeList }
