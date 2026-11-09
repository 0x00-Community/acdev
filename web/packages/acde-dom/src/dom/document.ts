import { CustomEvent, defineHandlers, Event, EventTarget } from '../core/event'
import { URL } from '../core/url'
import { cookies } from '../core/backend'
import { DOMException, guard } from '../core/exception'
import { G, getters, tag } from '../core/host'
import { NONE, NodeType, Ns } from '../native'
import { animationsOf, documentTimeline, type Animation } from './animation'
import { Attr, attrDocument, createAttr, Element, HANDLER_TYPES, noteMarkup, setAttribute } from './element'
import { env } from './env'
import { ClipboardEvent, CompositionEvent, DragEvent, FocusEvent, InputEvent, KeyboardEvent, MouseEvent, PointerEvent, UIEvent, WheelEvent } from './events'
import * as editing from './editing'
import { focus, focusedElement } from './focus'
import { createHtml, documentClass, type HTMLElement } from './html'
import { CDATASection, Comment, cssString, DocumentFragment, elementById, DocumentType, Node, ParentNodeMixin, ProcessingInstruction, baseHooks, HTMLCollection, liveCollection, mixin, type NodeList, staticNodeListOfIds, Text, cloneOf, remove } from './node'
import { HTML_NS, KNOWN, SVG_NS, validateAndExtract, validElementLocalName, documents } from './namespaces'
import { CaretPosition, getSelection, Range, type Selection } from './range'
import { bodyId, classes, construct, constructing, documentElementOf, documentId, dom, headId, ID, nodeConstructing, rootElementId, wrap } from './realm'
import { CSSStyleSheet, StyleSheetList } from './style'
import { NodeIterator, TreeWalker } from './traversal'

export const documentState = {
  readyState: 'loading' as 'loading' | 'interactive' | 'complete',
  hidden: false,
  currentScript: null as Element | null,
}

function createElementNamed(namespace: string | null, prefix: string | null, local: string): Element {
  const ns = namespace === null ? Ns.Other : (KNOWN[namespace] ?? Ns.Other)
  if (ns === Ns.Html && prefix === null) return createHtml(local)
  const id = guard(() => dom.createElementNS(namespace ?? '', prefix ?? '', local))
  return construct(classes.of(NodeType.Element, ns, local), id) as Element
}

const XML_NAME = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/u

export class Document extends Node {
  #kind: string[] | null = null

  constructor() {
    if (!nodeConstructing()) {
      documents.others = documents.xml = true
      constructing(dom.createDocument('document', 'application/xml', 'about:blank'))
    }
    super()
  }

  get #info(): string[] {
    if (this.#live) return ['html', 'text/html', env.url]
    return (this.#kind ??= dom.documentInfo(this[ID]))
  }

  get #html(): boolean {
    return this.#info[0] === 'html'
  }

  get contentType(): string {
    return this.#info[1]!
  }

  #own<T extends Node | Element>(node: T): T {
    if (!this.#live) dom.adopt(node[ID], this[ID])
    return node
  }

  #htmlElement(): Element | null {
    const html = this.documentElement
    return html && html.namespaceURI === HTML_NS && html.localName === 'html' ? html : null
  }

  override get nodeType(): number {
    return NodeType.Document
  }
  override get nodeName(): string {
    return '#document'
  }
  override get textContent(): null {
    return null
  }
  override set textContent(_value: string | null) {}
  override get ownerDocument(): null {
    return null
  }
  override get parentNode(): null {
    return null
  }

  get #live(): boolean {
    return this[ID] === documentId
  }

  get documentElement(): Element | null {
    return wrap<Element>(this.#live ? rootElementId() : documentElementOf(this[ID]))
  }

  get head(): HTMLElement | null {
    if (this.#live) return wrap<HTMLElement>(headId())
    const html = this.#htmlElement()
    if (!html) return null
    for (const child of html.children) if (child.localName === 'head' && child.namespaceURI === HTML_NS) return child as HTMLElement
    return null
  }

  get body(): HTMLElement | null {
    if (this.#live) return wrap<HTMLElement>(bodyId())
    const html = this.#htmlElement()
    if (!html) return null
    for (const child of html.children) if ((child.localName === 'body' || child.localName === 'frameset') && child.namespaceURI === HTML_NS) return child as HTMLElement
    return null
  }
  set body(element: HTMLElement | null) {
    const html = this.documentElement
    if (!element || !html) throw new DOMException("Failed to set the 'body' property on 'Document': The new body element is of type 'null'.", 'HierarchyRequestError')
    const old = this.body
    if (old === element) return
    if (old) old.replaceWith(element)
    else html.appendChild(element)
  }

  get doctype(): DocumentType | null {
    let id = dom.firstChild(this[ID])
    while (id !== NONE && dom.nodeType(id) !== NodeType.DocumentType) id = dom.nextSibling(id)
    return wrap<DocumentType>(id)
  }

  #titleElement(): number {
    const root = this.documentElement
    if (!root) return NONE
    if (root.namespaceURI === SVG_NS && root.localName === 'svg') {
      for (const child of root.children) if (child.localName === 'title' && child.namespaceURI === SVG_NS) return child[ID]
      return NONE
    }
    const all = dom.getElementsByTagNameNS(this[ID], HTML_NS, 'title')
    return all.length ? all[0]! : NONE
  }

  get title(): string {
    const title = this.#titleElement()
    return title === NONE ? '' : dom.textContent(title).replace(/[\t\n\f\r ]+/g, ' ').trim()
  }
  set title(value: string) {
    const html = this.documentElement
    if (!html) return
    let title = wrap<Element>(this.#titleElement())
    if (!title) {
      const head = this.head
      if (!head) return
      title = head.appendChild(this.#own(createHtml('title')))
    }
    title.textContent = String(value)
  }

  get URL(): string {
    return this.#live ? env.url : this.#info[2] || 'about:blank'
  }
  get documentURI(): string {
    return this.URL
  }
  override get baseURI(): string {
    const base = this.documentElement ? dom.querySelector(this.documentElement[ID], 'base[href]') : NONE
    if (base === NONE) return this.URL
    return URL.canParse(dom.getAttribute(base, 'href') ?? '', this.URL) ? new URL(dom.getAttribute(base, 'href')!, this.URL).href : this.URL
  }
  get domain(): string {
    return new URL(env.url).hostname
  }
  get origin(): string {
    return new URL(env.url).origin
  }
  get lastModified(): string {
    const d = new Date()
    const two = (n: number) => String(n).padStart(2, '0')
    return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  }
  get compatMode(): string {
    return this.doctype ? 'CSS1Compat' : 'BackCompat'
  }
  get readyState(): string {
    return this.#live ? documentState.readyState : 'complete'
  }
  get defaultView(): unknown {
    return this.#live ? G : null
  }
  get location(): unknown {
    return this.#live ? G['location'] : null
  }
  set location(url: string) {
    if (this.#live) G['location'].href = url
  }
  get hidden(): boolean {
    return documentState.hidden
  }
  get visibilityState(): string {
    return documentState.hidden ? 'hidden' : 'visible'
  }
  get activeElement(): Element | null {
    if (!this.#live) return null
    const focused = focusedElement()
    if (focused?.isConnected) return focused
    return this.body ?? this.documentElement
  }
  get scrollingElement(): Element | null {
    return this.documentElement
  }
  get currentScript(): Element | null {
    return this.#live ? documentState.currentScript : null
  }
  get designMode(): string {
    return 'off'
  }
  set designMode(_value: string) {}
  get dir(): string {
    return this.documentElement?.getAttribute('dir') ?? ''
  }
  set dir(value: string) {
    if (this.documentElement) setAttribute(this.documentElement, 'dir', String(value))
  }
  get cookie(): string {
    return cookies.header(new URL(env.url).pathname, true)
  }
  set cookie(value: string) {
    cookies.store(String(value), '/', true)
  }
  get timeline(): unknown {
    return documentTimeline
  }
  get fonts(): FontFaceSet {
    return fontFaces
  }
  get implementation(): DOMImplementation {
    return (this.#implementation ??= new DOMImplementation(this))
  }
  #implementation: DOMImplementation | null = null

  get styleSheets(): StyleSheetList {
    const html = this.documentElement
    if (!html) return new StyleSheetList([])
    const sheets: CSSStyleSheet[] = []
    for (const id of dom.querySelectorAll(html[ID], 'style, link[rel~="stylesheet" i]')) {
      const element = wrap<Element & { sheet: unknown }>(id)!
      const sheet = element.sheet
      if (sheet) sheets.push(sheet as CSSStyleSheet)
    }
    return new StyleSheetList(sheets)
  }

  #collection(selector: string, tree = true): HTMLCollection {
    const id = this[ID]
    return liveCollection(() => dom.querySelectorAll(id, selector), HTMLCollection, tree)
  }
  get images(): HTMLCollection {
    return this.#collection('img')
  }
  get links(): HTMLCollection {
    return this.#collection('a[href], area[href]', false)
  }
  get forms(): HTMLCollection {
    return this.#collection('form')
  }
  get scripts(): HTMLCollection {
    return this.#collection('script')
  }
  get embeds(): HTMLCollection {
    return this.#collection('embed')
  }
  get plugins(): HTMLCollection {
    return this.#collection('embed')
  }
  get anchors(): HTMLCollection {
    return this.#collection('a[name]', false)
  }
  get all(): HTMLCollection {
    return this.#collection('*')
  }

  createElement(name: string, _options?: unknown): Element {
    const local = String(name)
    if (!validElementLocalName(local)) throw new DOMException(`Failed to execute 'createElement' on 'Document': The tag name provided ('${local}') is not a valid name.`, 'InvalidCharacterError')
    if (this.#html) return this.#own(createHtml(local.toLowerCase()))
    const namespace = this.contentType === 'application/xhtml+xml' ? HTML_NS : null
    return this.#own(namespace === HTML_NS ? createElementNamed(HTML_NS, '', local) : createElementNamed(null, null, local))
  }

  createElementNS(namespace: string | null, qualified: string, _options?: unknown): Element {
    const { namespace: ns, prefix, local } = validateAndExtract(namespace, String(qualified), 'element', "createElementNS' on 'Document")
    return this.#own(ns === HTML_NS && prefix === null && local === local.toLowerCase() ? createHtml(local) : createElementNamed(ns, prefix ?? '', local))
  }

  createTextNode(data: string): Text {
    return this.#own(new Text(String(data)))
  }

  createComment(data: string): Comment {
    return this.#own(new Comment(String(data)))
  }

  createDocumentFragment(): DocumentFragment {
    return this.#own(new DocumentFragment())
  }

  createCDATASection(data: string): CDATASection {
    if (this.#html) throw new DOMException("Failed to execute 'createCDATASection' on 'Document': This operation is not supported for HTML documents.", 'NotSupportedError')
    const text = String(data)
    if (text.includes(']]>')) throw new DOMException("Failed to execute 'createCDATASection' on 'Document': String cannot contain ']]>' since that is the end delimiter of a CData section.", 'InvalidCharacterError')
    return this.#own(wrap<CDATASection>(dom.createCDATASection(text))!)
  }

  createProcessingInstruction(target: string, data: string): ProcessingInstruction {
    const t = String(target), d = String(data)
    if (!XML_NAME.test(t)) throw new DOMException(`Failed to execute 'createProcessingInstruction' on 'Document': The target provided ('${t}') is not a valid name.`, 'InvalidCharacterError')
    if (d.includes('?>')) throw new DOMException(`Failed to execute 'createProcessingInstruction' on 'Document': The data provided ('${d}') contains '?>'.`, 'InvalidCharacterError')
    return this.#own(wrap<ProcessingInstruction>(dom.createProcessingInstruction(t, d))!)
  }

  createAttribute(name: string): Attr {
    const local = String(name)
    const attr = createAttr(null, null, this.#html ? local.toLowerCase() : local)
    attrDocument.set(attr, this)
    return attr
  }

  createAttributeNS(namespace: string | null, name: string): Attr {
    const { namespace: ns, prefix, local } = validateAndExtract(namespace, String(name), 'attribute', "createAttributeNS' on 'Document")
    const attr = createAttr(ns, prefix, local)
    attrDocument.set(attr, this)
    return attr
  }

  createRange(): Range {
    return new Range()
  }

  createTreeWalker(root: Node, whatToShow = 0xffffffff, filter: unknown = null): TreeWalker {
    if (!(root instanceof Node)) throw new TypeError("Failed to execute 'createTreeWalker' on 'Document': parameter 1 is not of type 'Node'.")
    return new TreeWalker(root, whatToShow, filter as never)
  }

  createNodeIterator(root: Node, whatToShow = 0xffffffff, filter: unknown = null): NodeIterator {
    if (!(root instanceof Node)) throw new TypeError("Failed to execute 'createNodeIterator' on 'Document': parameter 1 is not of type 'Node'.")
    return new NodeIterator(root, whatToShow, filter as never)
  }

  createEvent(name: string): Event {
    const classes: Record<string, new (type: string) => Event> = {
      event: Event, events: Event, htmlevents: Event, customevent: CustomEvent, uievent: UIEvent, uievents: UIEvent,
      mouseevent: MouseEvent, mouseevents: MouseEvent, keyboardevent: KeyboardEvent, focusevent: FocusEvent,
      pointerevent: PointerEvent, wheelevent: WheelEvent, inputevent: InputEvent, compositionevent: CompositionEvent,
      dragevent: DragEvent, clipboardevent: ClipboardEvent,
    }
    const cls = classes[String(name).toLowerCase()]
    if (!cls) throw new DOMException(`Failed to execute 'createEvent' on 'Document': The provided event type ('${name}') is invalid.`, 'NotSupportedError')
    return new cls('')
  }

  importNode<T extends Node>(node: T, deep = false): T {
    if (node instanceof Document) throw new DOMException("Failed to execute 'importNode' on 'Document': The node provided is a document, which may not be imported.", 'NotSupportedError')
    const copy = cloneOf(node, typeof deep === 'object' ? false : !!deep) as T
    dom.adopt(copy[ID], this[ID])
    return copy
  }

  adoptNode<T extends Node>(node: T): T {
    if (node instanceof Document) throw new DOMException("Failed to execute 'adoptNode' on 'Document': The node provided is a document, which may not be adopted.", 'NotSupportedError')
    if (node.parentNode) remove(node)
    dom.adopt(node[ID], this[ID])
    return node
  }

  getElementById(id: string): Element | null {
    const key = String(id)
    if (this.#live) return wrap<Element>(dom.getElementById(key))
    if (!key) return null
    return elementById(this[ID], key)
  }

  getElementsByName(name: string): NodeList {
    return staticNodeListOfIds(dom.querySelectorAll(this[ID], `[name=${cssString(String(name))}]`))
  }

  elementFromPoint(x: number, y: number): Element | null {
    const hit = dom.hitTest(Number(x), Number(y))
    if (hit === NONE) return null
    return wrap<Element>(hit)
  }

  elementsFromPoint(x: number, y: number): Element[] {
    return [...dom.hitTestAll(Number(x), Number(y))].map((id) => wrap<Element>(id)!)
  }

  caretPositionFromPoint(x: number, y: number): CaretPosition | null {
    const at = dom.caretFromPoint(Number(x), Number(y))
    return at ? new CaretPosition(wrap<Node>(at.node)!, at.offset) : null
  }

  caretRangeFromPoint(x: number, y: number): Range | null {
    const at = dom.caretFromPoint(Number(x), Number(y))
    if (!at) return null
    const range = new Range()
    range.setStart(wrap<Node>(at.node)!, at.offset)
    return range
  }

  getSelection(): Selection | null {
    return this.#live ? getSelection() : null
  }

  hasFocus(): boolean {
    return this.#live && focus.windowActive && !documentState.hidden
  }

  getAnimations(): Animation[] {
    return animationsOf(null)
  }

  open(): this {
    return this
  }
  close(): void {}
  write(...markup: string[]): void {
    const body = this.body ?? this.documentElement
    if (!body) return
    body.insertAdjacentHTML('beforeend', markup.join(''))
  }
  writeln(...markup: string[]): void {
    this.write(...markup, '\n')
  }

  execCommand(command: string, _showUI = false, value: string | null = null): boolean {
    return execCommand(String(command).toLowerCase(), value === null || value === undefined ? '' : String(value))
  }
  queryCommandSupported(command: string): boolean {
    return ['inserttext', 'delete', 'forwarddelete', 'selectall', 'inserthtml', 'insertlinebreak', 'insertparagraph'].includes(String(command).toLowerCase())
  }
  queryCommandEnabled(command: string): boolean {
    return this.queryCommandSupported(command)
  }
  queryCommandState(): boolean {
    return false
  }
  queryCommandValue(): string {
    return ''
  }

  exitFullscreen(): Promise<void> {
    return Promise.resolve()
  }
  exitPointerLock(): void {}

  startViewTransition(update?: (() => unknown) | { update?: () => unknown }): object {
    const callback = typeof update === 'function' ? update : update?.update
    const done = Promise.resolve().then(() => callback?.())
    const finished = done.then(() => undefined)
    return { updateCallbackDone: finished, ready: finished.then(() => Promise.reject(new DOMException('Transition was skipped', 'AbortError'))).catch(() => undefined), finished, skipTransition: () => {}, types: new Set() }
  }
}
getters(Document.prototype, { referrer: '', characterSet: 'UTF-8', charset: 'UTF-8', inputEncoding: 'UTF-8', fullscreenElement: null, fullscreenEnabled: false, fullscreen: false, pointerLockElement: null, pictureInPictureElement: null, pictureInPictureEnabled: false })
mixin(Document, ParentNodeMixin)
defineHandlers(Document.prototype, [...HANDLER_TYPES, 'readystatechange', 'visibilitychange', 'fullscreenchange', 'fullscreenerror', 'pointerlockchange', 'pointerlockerror', 'freeze', 'resume'])
tag(Document)
export interface Document extends ParentNodeMixin {}
documentClass.cls = Document as never

export class HTMLDocument extends Document {}
tag(HTMLDocument)
export class XMLDocument extends Document {}
tag(XMLDocument)
documentClass.html = HTMLDocument as never
documentClass.xml = XMLDocument as never

function htmlDocument(title: string | null): Document {
  documents.others = true
  const doc = construct(HTMLDocument, dom.createDocument('html', 'text/html', 'about:blank'))
  doc.appendChild(wrap<DocumentType>(dom.createDocumentType('html', '', ''))!)
  const html = doc.appendChild(doc.createElement('html'))
  const head = html.appendChild(doc.createElement('head'))
  if (title !== null) head.appendChild(doc.createElement('title')).appendChild(doc.createTextNode(title))
  html.appendChild(doc.createElement('body'))
  return doc
}

function xmlDocument(contentType: string): XMLDocument {
  documents.others = documents.xml = true
  return construct(XMLDocument, dom.createDocument('xml', contentType, 'about:blank'))
}

export class DOMImplementation {
  constructor(readonly owner: Document) {}

  createHTMLDocument(title?: string): Document {
    return htmlDocument(title === undefined ? null : String(title))
  }

  createDocument(namespace: string | null, qualified: string | null, doctype: DocumentType | null = null): XMLDocument {
    const ns = namespace === null || namespace === undefined ? null : String(namespace)
    const doc = xmlDocument(ns === HTML_NS ? 'application/xhtml+xml' : ns === SVG_NS ? 'image/svg+xml' : 'application/xml')
    const element = qualified === null || qualified === undefined || String(qualified) === '' ? null : doc.createElementNS(ns, String(qualified))
    if (doctype) doc.appendChild(doctype)
    if (element) doc.appendChild(element)
    return doc
  }

  createDocumentType(name: string, publicId: string, systemId: string): DocumentType {
    return wrap<DocumentType>(dom.createDocumentType(String(name), String(publicId), String(systemId)))!
  }

  hasFeature(): boolean {
    return true
  }
}
tag(DOMImplementation)

export class DOMParser {
  parseFromString(markup: string, type: string): Document {
    const text = String(markup)
    const kind = String(type)
    if (kind === 'text/html') {
      noteMarkup(text)
      documents.others = true
      return construct(HTMLDocument, guard(() => dom.parseInert(text, env.url)))
    }
    if (kind === 'image/svg+xml' || kind === 'application/xml' || kind === 'text/xml' || kind === 'application/xhtml+xml') {
      documents.others = documents.xml = true
      return construct(Document, guard(() => dom.parseXml(text, kind, env.url)))
    }
    throw new TypeError(`Failed to execute 'parseFromString' on 'DOMParser': The provided value '${kind}' is not a valid enum value of type DOMParserSupportedType.`)
  }
}
tag(DOMParser)

export class XMLSerializer {
  serializeToString(node: Node): string {
    if (node instanceof Attr) return ''
    if (!(node instanceof Node)) throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.")
    return guard(() => dom.serializeXml(node[ID]))
  }
}
tag(XMLSerializer)

export class FontFace {
  readonly family: string
  status = 'loaded'
  style = 'normal'
  weight = 'normal'
  stretch = 'normal'
  unicodeRange = 'U+0-10FFFF'
  display = 'auto'
  readonly loaded: Promise<FontFace>

  constructor(family: string, _source: unknown, descriptors?: Record<string, string>) {
    this.family = String(family)
    Object.assign(this, descriptors ?? {})
    this.loaded = Promise.resolve(this)
  }

  load(): Promise<FontFace> {
    return this.loaded
  }
}
tag(FontFace)

export class FontFaceSet extends EventTarget {
  readonly #faces = new Set<FontFace>()
  readonly ready: Promise<FontFaceSet>

  constructor() {
    super()
    this.ready = Promise.resolve(this)
  }

  get size(): number {
    return this.#faces.size
  }
  add(face: FontFace): this {
    this.#faces.add(face)
    return this
  }
  delete(face: FontFace): boolean {
    return this.#faces.delete(face)
  }
  has(face: FontFace): boolean {
    return this.#faces.has(face)
  }
  clear(): void {
    this.#faces.clear()
  }
  check(_font: string, _text?: string): boolean {
    return true
  }
  load(_font: string, _text?: string): Promise<FontFace[]> {
    return Promise.resolve([])
  }
  forEach(callback: (face: FontFace, key: FontFace, set: FontFaceSet) => void, thisArg?: unknown): void {
    for (const face of this.#faces) callback.call(thisArg, face, face, this)
  }
  [Symbol.iterator](): IterableIterator<FontFace> {
    return this.#faces.values()
  }
}
getters(FontFaceSet.prototype, { status: 'loaded' })
tag(FontFaceSet)

const fontFaces = new FontFaceSet()

function execCommand(command: string, value: string): boolean {
  const target = focusedElement()
  if (!target) return false
  switch (command) {
    case 'inserttext':
      return editing.insertText(target, value, 'insertText', false)
    case 'insertlinebreak':
      return editing.insertText(target, '\n', 'insertLineBreak', false)
    case 'insertparagraph':
      return editing.insertText(target, '\n', 'insertParagraph', false)
    case 'inserthtml':
      return editing.insertHTML(target, value, false)
    case 'delete':
      return editing.deleteText(target, false, false)
    case 'forwarddelete':
      return editing.deleteText(target, true, false)
    case 'selectall':
      return editing.selectAll(target)
    default:
      return false
  }
}

baseHooks.url = () => (wrap<Document>(documentId)?.baseURI ?? env.url)
