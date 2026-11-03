import { DOMException } from '../core/exception'
import { Event, fire, getHandler, setHandler } from '../core/event'
import { G, host, queueTask, tag } from '../core/host'
import { URL } from '../core/url'
import { NONE, NodeType, Ns } from '../native'
import { ACTIVATION, MouseEvent, ToggleEvent } from './events'
import { ATTRIBUTE_CHANGED, dataset, Element, HANDLER_TYPES, handlerOf, handlerSet, LOCAL, NS, pendingElement, setAttribute, tokenList, type DOMStringMap, type DOMTokenList } from './element'
import { resolveUrl } from './env'
import { focus, focusable, setFocus } from './focus'
import { metricsOf } from './layout'
import { CharacterData, Comment, DocumentFragment, DocumentType, mixin, Node, replaceAll, Text, type NodeList } from './node'
import { bool, long, nullable, string, url } from './reflect'
import { classes, construct, constructing, dom, ID, lifecycle, nodeConstructing, wrap } from './realm'
import { CSSStyleSheet, inlineStyle, type CSSStyleDeclaration } from './style'

export const customHooks = {
  nameOf: (_ctor: Function): string | null => null,
  classOf: (_name: string): (new () => HTMLElement) | null => null,
  upgrading: null as HTMLElement | null,
}

export class HTMLOrSVGElementMixin {
  get style(): CSSStyleDeclaration {
    const self = this as unknown as Element
    return inlineStyle(self)
  }
  set style(value: string) {
    const self = this as unknown as Element
    setAttribute(self, 'style', String(value))
  }

  get dataset(): DOMStringMap {
    const self = this as unknown as Element
    return dataset(self)
  }

  declare nonce: string
  declare autofocus: boolean

  get tabIndex(): number {
    const self = this as unknown as Element
    const raw = dom.getAttribute(self[ID], 'tabindex')
    const n = raw === null ? NaN : parseInt(raw, 10)
    if (!Number.isNaN(n)) return n
    return defaultFocusable(self) ? 0 : -1
  }
  set tabIndex(value: number) {
    const self = this as unknown as Element
    setAttribute(self, 'tabindex', String(Math.trunc(Number(value)) || 0))
  }

  focus(this: Element, options?: { preventScroll?: boolean; focusVisible?: boolean }): void {
    if (!this.isConnected || !focusable(this[ID])) return
    setFocus(this, options?.focusVisible)
  }

  blur(this: Element): void {
    if (focus.id === this[ID]) setFocus(null)
  }
}
string(HTMLOrSVGElementMixin.prototype, 'nonce')
bool(HTMLOrSVGElementMixin.prototype, 'autofocus')

function defaultFocusable(element: Element): boolean {
  const local = element[LOCAL]
  if (element[NS] !== Ns.Html) return local === 'a' && dom.hasAttribute(element[ID], 'href')
  if (local === 'a' || local === 'area') return dom.hasAttribute(element[ID], 'href')
  return ['button', 'input', 'select', 'textarea', 'iframe', 'summary', 'object', 'embed'].includes(local) || dom.closest(element[ID], '[contenteditable]:not([contenteditable="false" i])') === element[ID]
}

export class HTMLElement extends Element {
  constructor() {
    const upgrade = customHooks.upgrading
    if (upgrade) {
      customHooks.upgrading = null
      return upgrade
    }
    if (!nodeConstructing()) {
      const name = customHooks.nameOf(new.target)
      if (!name) throw new TypeError('Illegal constructor')
      pendingElement.local = name
      pendingElement.ns = Ns.Html
      constructing(dom.createElement(Ns.Html, name))
    }
    super()
  }

  get hidden(): boolean | string {
    const value = dom.getAttribute(this[ID], 'hidden')
    if (value === null) return false
    return value.toLowerCase() === 'until-found' ? 'until-found' : true
  }
  set hidden(value: boolean | string) {
    if (value === 'until-found') setAttribute(this, 'hidden', 'until-found')
    else if (!!value !== dom.hasAttribute(this[ID], 'hidden')) setAttribute(this, 'hidden', value ? '' : null)
  }

  get draggable(): boolean {
    const value = dom.getAttribute(this[ID], 'draggable')?.toLowerCase()
    if (value === 'true') return true
    if (value === 'false') return false
    return this[LOCAL] === 'img' || (this[LOCAL] === 'a' && dom.hasAttribute(this[ID], 'href'))
  }
  set draggable(value: boolean) {
    setAttribute(this, 'draggable', value ? 'true' : 'false')
  }

  get spellcheck(): boolean {
    for (let id = this[ID]; id !== NONE; id = dom.parent(id)) {
      if (dom.nodeType(id) !== NodeType.Element) break
      const value = dom.getAttribute(id, 'spellcheck')?.toLowerCase()
      if (value === 'true' || value === '') return true
      if (value === 'false') return false
    }
    return true
  }
  set spellcheck(value: boolean) {
    setAttribute(this, 'spellcheck', value ? 'true' : 'false')
  }

  get translate(): boolean {
    const id = dom.closest(this[ID], '[translate]')
    return id === NONE || dom.getAttribute(id, 'translate')?.toLowerCase() !== 'no'
  }
  set translate(value: boolean) {
    setAttribute(this, 'translate', value ? 'yes' : 'no')
  }

  get contentEditable(): string {
    const value = dom.getAttribute(this[ID], 'contenteditable')
    if (value === null) return 'inherit'
    const lower = value.toLowerCase()
    return lower === '' || lower === 'true' ? 'true' : lower === 'false' ? 'false' : lower === 'plaintext-only' ? 'plaintext-only' : 'inherit'
  }
  set contentEditable(value: string) {
    const lower = String(value).toLowerCase()
    if (lower === 'inherit') setAttribute(this, 'contenteditable', null)
    else if (lower === 'true' || lower === 'false' || lower === 'plaintext-only') setAttribute(this, 'contenteditable', lower)
    else throw new DOMException(`Failed to set the 'contentEditable' property on 'HTMLElement': The value provided ('${value}') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.`, 'SyntaxError')
  }

  get isContentEditable(): boolean {
    const id = dom.closest(this[ID], '[contenteditable]')
    if (id === NONE) return false
    const value = dom.getAttribute(id, 'contenteditable')!.toLowerCase()
    if (value === 'false') return false
    if (value === '' || value === 'true' || value === 'plaintext-only') return true
    const parent = dom.parent(id)
    return parent !== NONE && dom.nodeType(parent) === NodeType.Element ? (wrap<HTMLElement>(parent)?.isContentEditable ?? false) : false
  }

  get innerText(): string {
    return dom.innerText(this[ID])
  }
  set innerText(value: string) {
    setInnerText(this, value === null || value === undefined ? '' : String(value))
  }

  get outerText(): string {
    return this.innerText
  }
  set outerText(value: string) {
    const parent = this.parentNode
    if (!parent) throw new DOMException("Failed to set the 'outerText' property on 'HTMLElement': The element has no parent.", 'NoModificationAllowedError')
    const text = new Text(String(value))
    this.replaceWith(text)
  }

  get offsetParent(): Element | null {
    const m = metricsOf(this[ID])
    return m ? wrap<Element>(m.offsetParent) : null
  }
  get offsetTop(): number {
    return metricsOf(this[ID])?.offsetTop ?? 0
  }
  get offsetLeft(): number {
    return metricsOf(this[ID])?.offsetLeft ?? 0
  }
  get offsetWidth(): number {
    return metricsOf(this[ID])?.offsetWidth ?? 0
  }
  get offsetHeight(): number {
    return metricsOf(this[ID])?.offsetHeight ?? 0
  }

  click(): void {
    if (clicking.has(this) || (dom.hasAttribute(this[ID], 'disabled') && /^(button|input|select|textarea|fieldset|option|optgroup)$/.test(this[LOCAL]))) return
    clicking.add(this)
    try {
      this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: G }))
    } finally {
      clicking.delete(this)
    }
  }

  attachInternals(): never {
    throw new DOMException('ElementInternals is not supported', 'NotSupportedError')
  }

  showPopover(): void {}
  hidePopover(): void {}
  togglePopover(): boolean {
    return false
  }
}
mixin(HTMLElement, HTMLOrSVGElementMixin)
string(HTMLElement.prototype, 'title')
string(HTMLElement.prototype, 'lang')
string(HTMLElement.prototype, 'dir')
string(HTMLElement.prototype, 'accessKey', 'accesskey')
string(HTMLElement.prototype, 'autocapitalize')
string(HTMLElement.prototype, 'inputMode', 'inputmode')
string(HTMLElement.prototype, 'enterKeyHint', 'enterkeyhint')
nullable(HTMLElement.prototype, 'popover')
bool(HTMLElement.prototype, 'inert')
tag(HTMLElement)
export interface HTMLElement extends HTMLOrSVGElementMixin {}

const clicking = new WeakSet<Element>()

export function defineElementHandlers(proto: object, types: readonly string[] = HANDLER_TYPES): void {
  for (const type of types) {
    Object.defineProperty(proto, `on${type}`, {
      get(this: Element) {
        return this instanceof Element ? handlerOf(this, type) : getHandler(this, type)
      },
      set(this: Element, value: unknown) {
        if (this instanceof Element) handlerSet(this, type)
        setHandler(this, type, typeof value === 'function' || (value !== null && typeof value === 'object') ? value : null)
      },
      enumerable: true,
      configurable: true,
    })
  }
}
defineElementHandlers(HTMLElement.prototype)

function setInnerText(element: Element, text: string): void {
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  if (parts.length === 1) {
    element.textContent = text
    return
  }
  const fragment = new DocumentFragment()
  parts.forEach((part, i) => {
    if (i > 0) fragment.appendChild(createHtml('br'))
    if (part) fragment.appendChild(new Text(part))
  })
  const id = element[ID]
  replaceAll(element, [fragment], () => dom.replaceChildren(id, Uint32Array.of(fragment[ID])))
}

function simple(name: string, setup?: (proto: object) => void): typeof HTMLElement {
  const cls = { [name]: class extends HTMLElement {} }[name]!
  if (setup) setup(cls.prototype)
  tag(cls, name)
  return cls
}

export const HTMLUnknownElement = simple('HTMLUnknownElement')
export const HTMLDivElement = simple('HTMLDivElement', (p) => string(p, 'align'))
export const HTMLSpanElement = simple('HTMLSpanElement')
export const HTMLParagraphElement = simple('HTMLParagraphElement', (p) => string(p, 'align'))
export const HTMLHeadingElement = simple('HTMLHeadingElement', (p) => string(p, 'align'))
export const HTMLPreElement = simple('HTMLPreElement', (p) => long(p, 'width', 0))
export const HTMLQuoteElement = simple('HTMLQuoteElement', (p) => url(p, 'cite'))
export const HTMLBRElement = simple('HTMLBRElement', (p) => string(p, 'clear'))
export const HTMLHRElement = simple('HTMLHRElement', (p) => {
  string(p, 'align')
  string(p, 'color')
  string(p, 'size')
  string(p, 'width')
  bool(p, 'noShade', 'noshade')
})
export const HTMLUListElement = simple('HTMLUListElement', (p) => {
  bool(p, 'compact')
  string(p, 'type')
})
export const HTMLOListElement = simple('HTMLOListElement', (p) => {
  bool(p, 'reversed')
  long(p, 'start', 1)
  string(p, 'type')
})
export const HTMLLIElement = simple('HTMLLIElement', (p) => {
  long(p, 'value', 0)
  string(p, 'type')
})
export const HTMLDListElement = simple('HTMLDListElement', (p) => bool(p, 'compact'))
export const HTMLModElement = simple('HTMLModElement', (p) => {
  url(p, 'cite')
  string(p, 'dateTime', 'datetime')
})
export const HTMLTimeElement = simple('HTMLTimeElement', (p) => string(p, 'dateTime', 'datetime'))
export const HTMLDataElement = simple('HTMLDataElement', (p) => string(p, 'value'))
export const HTMLMenuElement = simple('HTMLMenuElement', (p) => bool(p, 'compact'))
export const HTMLHeadElement = simple('HTMLHeadElement')
export const HTMLHtmlElement = simple('HTMLHtmlElement', (p) => string(p, 'version'))
export const HTMLBodyElement = simple('HTMLBodyElement', (p) => {
  for (const name of ['text', 'link', 'vLink', 'aLink', 'bgColor', 'background']) string(p, name)
})
export const HTMLMetaElement = simple('HTMLMetaElement', (p) => {
  string(p, 'name')
  string(p, 'content')
  string(p, 'httpEquiv', 'http-equiv')
  string(p, 'media')
  string(p, 'scheme')
})
export const HTMLBaseElement = simple('HTMLBaseElement', (p) => {
  url(p, 'href')
  string(p, 'target')
})
export const HTMLTitleElement = simple('HTMLTitleElement', textAlias)
export const HTMLMapElement = simple('HTMLMapElement', (p) => string(p, 'name'))
export const HTMLEmbedElement = simple('HTMLEmbedElement', (p) => {
  url(p, 'src')
  string(p, 'type')
  string(p, 'width')
  string(p, 'height')
})
export const HTMLObjectElement = simple('HTMLObjectElement', (p) => {
  url(p, 'data')
  string(p, 'type')
  string(p, 'name')
  string(p, 'width')
  string(p, 'height')
  Object.defineProperty(p, 'contentDocument', { get: () => null, enumerable: true, configurable: true })
  Object.defineProperty(p, 'contentWindow', { get: () => null, enumerable: true, configurable: true })
})
export const HTMLParamElement = simple('HTMLParamElement', (p) => {
  string(p, 'name')
  string(p, 'value')
})
export const HTMLPictureElement = simple('HTMLPictureElement')
export const HTMLSourceElement = simple('HTMLSourceElement', (p) => {
  url(p, 'src')
  string(p, 'srcset')
  string(p, 'sizes')
  string(p, 'type')
  string(p, 'media')
  long(p, 'width', 0)
  long(p, 'height', 0)
})
export const HTMLTrackElement = simple('HTMLTrackElement', (p) => {
  url(p, 'src')
  string(p, 'kind')
  string(p, 'srclang')
  string(p, 'label')
  bool(p, 'default')
})
export const HTMLTableCaptionElement = simple('HTMLTableCaptionElement', (p) => string(p, 'align'))
export const HTMLTableColElement = simple('HTMLTableColElement', (p) => long(p, 'span', 1, 'span', 1))
export const HTMLTableCellElement = simple('HTMLTableCellElement', (p) => {
  long(p, 'colSpan', 1, 'colspan', 1)
  long(p, 'rowSpan', 1, 'rowspan', 0)
  string(p, 'headers')
  string(p, 'scope')
  string(p, 'abbr')
  Object.defineProperty(p, 'cellIndex', {
    get(this: Element) {
      const parent = dom.parent(this[ID])
      if (parent === NONE) return -1
      const cells = dom.children(parent)
      let index = 0
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] === this[ID]) return index
        const local = dom.localName(cells[i]!)
        if (local === 'td' || local === 'th') index++
      }
      return -1
    },
    enumerable: true,
    configurable: true,
  })
})
export const HTMLSlotElement = simple('HTMLSlotElement', (p) => {
  string(p, 'name')
  Object.assign(p, { assignedNodes: () => [], assignedElements: () => [], assign: () => {} })
})
export const HTMLDataListElement = simple('HTMLDataListElement', (p) => {
  Object.defineProperty(p, 'options', {
    get(this: Element) {
      return this.getElementsByTagName('option')
    },
    enumerable: true,
    configurable: true,
  })
})

const TABLE_ROWS = ':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'

export class HTMLTableElement extends HTMLElement {
  get caption(): Element | null {
    return this.querySelector(':scope > caption')
  }
  get tHead(): Element | null {
    return this.querySelector(':scope > thead')
  }
  get tFoot(): Element | null {
    return this.querySelector(':scope > tfoot')
  }
  get tBodies(): unknown {
    return this.querySelectorAll(':scope > tbody')
  }
  get rows(): NodeList {
    return this.querySelectorAll(TABLE_ROWS)
  }
  createTBody(): Element {
    const body = createHtml('tbody')
    const bodies = this.querySelectorAll(':scope > tbody')
    const last = bodies.item(bodies.length - 1)
    this.insertBefore(body, last ? last.nextSibling : null)
    return body
  }
  createTHead(): Element {
    return this.tHead ?? this.insertBefore(createHtml('thead'), this.firstChild)
  }
  createTFoot(): Element {
    return this.tFoot ?? this.appendChild(createHtml('tfoot'))
  }
  createCaption(): Element {
    return this.caption ?? this.insertBefore(createHtml('caption'), this.firstChild)
  }
  deleteCaption(): void {
    this.caption?.remove()
  }
  deleteTHead(): void {
    this.tHead?.remove()
  }
  deleteTFoot(): void {
    this.tFoot?.remove()
  }
  insertRow(index = -1): Element {
    const rows = this.rows
    const row = createHtml('tr')
    if (index === -1 || index === rows.length) {
      const body = this.querySelector(':scope > tbody:last-of-type') ?? (rows.length ? rows.item(rows.length - 1)!.parentNode : null) ?? this.createTBody()
      if (body === this || !body) this.appendChild(row)
      else body.appendChild(row)
    } else {
      const ref = rows.item(index)
      if (!ref) throw new DOMException(`The index provided (${index}) is outside the range of rows.`, 'IndexSizeError')
      ref.parentNode!.insertBefore(row, ref)
    }
    return row
  }
  deleteRow(index: number): void {
    const rows = this.rows
    const row = rows.item(index === -1 ? rows.length - 1 : index)
    if (!row) throw new DOMException(`The index provided (${index}) is outside the range of rows.`, 'IndexSizeError')
    ;(row as Element).remove()
  }
}
tag(HTMLTableElement)

export class HTMLTableSectionElement extends HTMLElement {
  get rows(): NodeList {
    return this.querySelectorAll(':scope > tr')
  }
  insertRow(index = -1): Element {
    const row = createHtml('tr')
    const rows = this.rows
    this.insertBefore(row, index === -1 ? null : rows.item(index))
    return row
  }
  deleteRow(index: number): void {
    const rows = this.rows
    ;(rows.item(index === -1 ? rows.length - 1 : index) as Element | null)?.remove()
  }
}
tag(HTMLTableSectionElement)

export class HTMLTableRowElement extends HTMLElement {
  get cells(): NodeList {
    return this.querySelectorAll(':scope > td, :scope > th')
  }
  get rowIndex(): number {
    const table = dom.closest(this[ID], 'table')
    return table === NONE ? -1 : dom.querySelectorAll(table, TABLE_ROWS).indexOf(this[ID])
  }
  get sectionRowIndex(): number {
    const parent = dom.parent(this[ID])
    return parent === NONE ? -1 : dom.children(parent).indexOf(this[ID])
  }
  insertCell(index = -1): Element {
    const cell = createHtml('td')
    const cells = this.cells
    this.insertBefore(cell, index === -1 ? null : cells.item(index))
    return cell
  }
  deleteCell(index: number): void {
    const cells = this.cells
    ;(cells.item(index === -1 ? cells.length - 1 : index) as Element | null)?.remove()
  }
}
tag(HTMLTableRowElement)

export class HTMLDetailsElement extends HTMLElement {
  override [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    super[ATTRIBUTE_CHANGED](name, value)
    if (name !== 'open') return
    const open = value !== null
    queueTask(() => fire(this, new ToggleEvent('toggle', { oldState: open ? 'closed' : 'open', newState: open ? 'open' : 'closed' })))
  }
}
bool(HTMLDetailsElement.prototype, 'open')
string(HTMLDetailsElement.prototype, 'name')
tag(HTMLDetailsElement)

function summaryActivation(this: HTMLElement): { run(): void; cancel(): void } | null {
  const parent = dom.parent(this[ID])
  if (parent === NONE || dom.localName(parent) !== 'details') return null
  const first = dom.querySelector(parent, ':scope > summary')
  if (first !== this[ID]) return null
  return {
    run: () => {
      const details = wrap<HTMLDetailsElement>(parent)!
      ;(details as unknown as { open: boolean }).open = !(details as unknown as { open: boolean }).open
    },
    cancel: () => {},
  }
}

export class HTMLDialogElement extends HTMLElement {
  returnValue = ''

  show(): void {
    if (dom.hasAttribute(this[ID], 'open')) return
    setAttribute(this, 'open', '')
  }

  showModal(): void {
    if (!this.isConnected) throw new DOMException("Failed to execute 'showModal' on 'HTMLDialogElement': The element is not in a Document.", 'InvalidStateError')
    if (dom.hasAttribute(this[ID], 'open')) return
    setAttribute(this, 'open', '')
    const first = this.querySelector('[autofocus]') ?? this.querySelector('button, input, select, textarea, a[href], [tabindex]')
    ;(first as HTMLElement | null)?.focus()
  }

  close(returnValue?: string): void {
    if (!dom.hasAttribute(this[ID], 'open')) return
    setAttribute(this, 'open', null)
    if (returnValue !== undefined) this.returnValue = String(returnValue)
    queueTask(() => fire(this, new Event('close')))
  }

  requestClose(returnValue?: string): void {
    if (fire(this, new Event('cancel', { cancelable: true }))) this.close(returnValue)
  }
}
bool(HTMLDialogElement.prototype, 'open')
tag(HTMLDialogElement)

export class HTMLTemplateElement extends HTMLElement {
  get content(): DocumentFragment {
    return wrap<DocumentFragment>(dom.templateContent(this[ID]))!
  }

  override get innerHTML(): string {
    return dom.innerHTML(this[ID])
  }
  override set innerHTML(html: string) {
    const content = this.content
    const markup = html === null ? '' : String(html)
    const parsed = dom.parseFragment(this[ID], markup)
    const id = content[ID]
    replaceAll(content, [wrap<Node>(parsed)!], () => dom.replaceChildren(id, Uint32Array.of(parsed)))
  }

  get shadowRootMode(): string {
    return dom.getAttribute(this[ID], 'shadowrootmode') ?? ''
  }
}
tag(HTMLTemplateElement)

export class HTMLScriptElement extends HTMLElement {
  declare text: string
  static supports(type: string): boolean {
    return type === 'classic' || type === 'module'
  }
}
textAlias(HTMLScriptElement.prototype)
url(HTMLScriptElement.prototype, 'src')
string(HTMLScriptElement.prototype, 'type')
bool(HTMLScriptElement.prototype, 'noModule', 'nomodule')
bool(HTMLScriptElement.prototype, 'async')
bool(HTMLScriptElement.prototype, 'defer')
nullable(HTMLScriptElement.prototype, 'crossOrigin', 'crossorigin')
string(HTMLScriptElement.prototype, 'integrity')
string(HTMLScriptElement.prototype, 'charset')
string(HTMLScriptElement.prototype, 'referrerPolicy', 'referrerpolicy')
tag(HTMLScriptElement)

export class HTMLStyleElement extends HTMLElement {
  #sheet: unknown = null
  get sheet(): unknown {
    if (!this.isConnected) return null
    if (!this.#sheet) this.#sheet = new CSSStyleSheet(undefined, this)
    return this.#sheet
  }
}
string(HTMLStyleElement.prototype, 'media')
string(HTMLStyleElement.prototype, 'type')
bool(HTMLStyleElement.prototype, 'disabled')
tag(HTMLStyleElement)

const REL_LIST = Symbol('relList')

export class HTMLLinkElement extends HTMLElement {
  get relList(): DOMTokenList {
    return tokenList(this, REL_LIST, 'rel', ['stylesheet', 'preload', 'modulepreload', 'icon', 'alternate', 'prefetch', 'preconnect', 'dns-prefetch', 'manifest', 'next'])
  }
  get sheet(): unknown {
    return null
  }

  override [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    super[ATTRIBUTE_CHANGED](name, value)
    if ((name === 'href' || name === 'rel') && value !== null && this.isConnected) linkLoad(this)
  }
}

function linkLoad(link: HTMLLinkElement): void {
  const id = link[ID]
  const href = dom.getAttribute(id, 'href')
  if (!href || !/(^|\s)stylesheet(\s|$)/i.test(dom.getAttribute(id, 'rel') ?? '')) return
  const url = resolveUrl(href)
  host.setTimer(0, () => {
    if (!link.isConnected || dom.getAttribute(id, 'href') !== href) return
    fire(link, new Event(host.readAsset(url) ? 'load' : 'error'))
  })
}
lifecycle.connected.push((node) => {
  if (node instanceof HTMLLinkElement) linkLoad(node)
})
url(HTMLLinkElement.prototype, 'href')
string(HTMLLinkElement.prototype, 'rel')
string(HTMLLinkElement.prototype, 'as')
string(HTMLLinkElement.prototype, 'media')
string(HTMLLinkElement.prototype, 'type')
string(HTMLLinkElement.prototype, 'hreflang')
string(HTMLLinkElement.prototype, 'sizes')
string(HTMLLinkElement.prototype, 'integrity')
nullable(HTMLLinkElement.prototype, 'crossOrigin', 'crossorigin')
bool(HTMLLinkElement.prototype, 'disabled')
tag(HTMLLinkElement)

export class HTMLAnchorElement extends HTMLElement {
  declare readonly relList: DOMTokenList
  declare text: string

  override toString(): string {
    return (this as unknown as { href: string }).href
  }

  [ACTIVATION](): { run(): void; cancel(): void } | null {
    const href = dom.getAttribute(this[ID], 'href')
    if (href === null) return null
    return { run: () => linkHooks.follow(resolveUrl(href), dom.getAttribute(this[ID], 'target') ?? '', dom.getAttribute(this[ID], 'download')), cancel: () => {} }
  }
}
hyperlink(HTMLAnchorElement.prototype)
textAlias(HTMLAnchorElement.prototype)
for (const name of ['target', 'rel', 'hreflang', 'type', 'ping', 'download', 'name', 'coords', 'shape', 'charset', 'rev']) string(HTMLAnchorElement.prototype, name)
string(HTMLAnchorElement.prototype, 'referrerPolicy', 'referrerpolicy')
tag(HTMLAnchorElement)

export class HTMLAreaElement extends HTMLElement {
  declare readonly relList: DOMTokenList
  [ACTIVATION](): { run(): void; cancel(): void } | null {
    return HTMLAnchorElement.prototype[ACTIVATION].call(this as unknown as HTMLAnchorElement)
  }
}
hyperlink(HTMLAreaElement.prototype)
for (const name of ['target', 'rel', 'download', 'alt', 'coords', 'shape', 'ping']) string(HTMLAreaElement.prototype, name)
tag(HTMLAreaElement)

export const linkHooks = {
  follow: (_url: string, _target: string, _download: string | null) => {},
}

function textAlias(proto: object): void {
  Object.defineProperty(proto, 'text', {
    get(this: Element) {
      return dom.textContent(this[ID])
    },
    set(this: Element, value: string) {
      this.textContent = String(value)
    },
    enumerable: true,
    configurable: true,
  })
}

function hyperlink(proto: object): void {
  const parsed = (el: Element): URL | null => {
    const raw = dom.getAttribute(el[ID], 'href')
    if (raw === null) return null
    try {
      return new URL(raw, resolveUrl('.'))
    } catch {
      return null
    }
  }
  url(proto, 'href')
  Object.defineProperty(proto, 'relList', {
    get(this: Element) {
      return tokenList(this, REL_LIST, 'rel', ['noreferrer', 'noopener', 'opener'])
    },
    enumerable: true,
    configurable: true,
  })
  for (const part of ['origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'] as const) {
    Object.defineProperty(proto, part, {
      get(this: Element) {
        const u = parsed(this)
        return u ? u[part] : ''
      },
      set(this: Element, value: string) {
        if (part === 'origin') return
        const u = parsed(this)
        if (!u) return
        ;(u as unknown as Record<string, string>)[part] = String(value)
        setAttribute(this, 'href', u.href)
      },
      enumerable: true,
      configurable: true,
    })
  }
}

const htmlClasses = new Map<string, new () => Element>()

export function registerHtml(cls: new () => Element, ...names: string[]): void {
  for (const name of names) htmlClasses.set(name, cls)
}

registerHtml(HTMLDivElement, 'div')
registerHtml(HTMLSpanElement, 'span')
registerHtml(HTMLParagraphElement, 'p')
registerHtml(HTMLHeadingElement, 'h1', 'h2', 'h3', 'h4', 'h5', 'h6')
registerHtml(HTMLPreElement, 'pre', 'listing', 'xmp')
registerHtml(HTMLQuoteElement, 'blockquote', 'q')
registerHtml(HTMLBRElement, 'br')
registerHtml(HTMLHRElement, 'hr')
registerHtml(HTMLUListElement, 'ul')
registerHtml(HTMLOListElement, 'ol')
registerHtml(HTMLLIElement, 'li')
registerHtml(HTMLDListElement, 'dl')
registerHtml(HTMLModElement, 'ins', 'del')
registerHtml(HTMLTimeElement, 'time')
registerHtml(HTMLDataElement, 'data')
registerHtml(HTMLMenuElement, 'menu')
registerHtml(HTMLHeadElement, 'head')
registerHtml(HTMLHtmlElement, 'html')
registerHtml(HTMLBodyElement, 'body')
registerHtml(HTMLMetaElement, 'meta')
registerHtml(HTMLBaseElement, 'base')
registerHtml(HTMLTitleElement, 'title')
registerHtml(HTMLMapElement, 'map')
registerHtml(HTMLEmbedElement, 'embed')
registerHtml(HTMLObjectElement, 'object')
registerHtml(HTMLParamElement, 'param')
registerHtml(HTMLPictureElement, 'picture')
registerHtml(HTMLSourceElement, 'source')
registerHtml(HTMLTrackElement, 'track')
registerHtml(HTMLTableElement, 'table')
registerHtml(HTMLTableCaptionElement, 'caption')
registerHtml(HTMLTableColElement, 'col', 'colgroup')
registerHtml(HTMLTableSectionElement, 'thead', 'tbody', 'tfoot')
registerHtml(HTMLTableRowElement, 'tr')
registerHtml(HTMLTableCellElement, 'td', 'th')
registerHtml(HTMLSlotElement, 'slot')
registerHtml(HTMLDataListElement, 'datalist')
registerHtml(HTMLDetailsElement, 'details')
registerHtml(HTMLDialogElement, 'dialog')
registerHtml(HTMLTemplateElement, 'template')
registerHtml(HTMLScriptElement, 'script')
registerHtml(HTMLStyleElement, 'style')
registerHtml(HTMLLinkElement, 'link')
registerHtml(HTMLAnchorElement, 'a')
registerHtml(HTMLAreaElement, 'area')
for (const name of ['abbr', 'acronym', 'address', 'article', 'aside', 'b', 'basefont', 'bdi', 'bdo', 'big', 'center', 'cite', 'code', 'dd', 'dfn', 'dt', 'em', 'figcaption', 'figure', 'footer', 'header', 'hgroup', 'i', 'kbd', 'main', 'mark', 'nav', 'nobr', 'noembed', 'noframes', 'noscript', 'plaintext', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'search', 'section', 'small', 'strike', 'strong', 'sub', 'summary', 'sup', 'tt', 'u', 'var', 'wbr']) {
  htmlClasses.set(name, HTMLElement)
}
Object.defineProperty(HTMLElement.prototype, ACTIVATION, {
  value(this: HTMLElement) {
    return this[LOCAL] === 'summary' ? summaryActivation.call(this) : null
  },
  writable: true,
  configurable: true,
})

export const svgClasses = new Map<string, new () => Element>()
export const svgFallback = { cls: null as unknown as new () => Element }

function htmlClass(local: string): new () => Element {
  const known = htmlClasses.get(local)
  if (known) return known
  const custom = local.includes('-') ? customHooks.classOf(local) : null
  if (custom) return custom
  return local.includes('-') ? HTMLElement : HTMLUnknownElement
}

classes.of = (type, ns, local) => {
  switch (type) {
    case NodeType.Element: {
      pendingElement.local = local
      pendingElement.ns = ns
      if (ns === Ns.Html) return htmlClass(local)
      if (ns === Ns.Svg) return svgClasses.get(local) ?? svgFallback.cls
      return Element
    }
    case NodeType.Text: return Text as never
    case NodeType.Comment: return Comment as never
    case NodeType.DocumentFragment: return DocumentFragment as never
    case NodeType.DocumentType: return DocumentType as never
    case NodeType.Document: return documentClass.cls as never
    default: return CharacterData as never
  }
}

export const documentClass = { cls: null as unknown as new () => Node }

export function createHtml(local: string): HTMLElement {
  const id = dom.createElement(Ns.Html, local)
  pendingElement.local = local
  pendingElement.ns = Ns.Html
  return construct(htmlClass(local), id) as HTMLElement
}
