import { File } from '../core/blob'
import { eventPath, hooks, type Event, Event as BaseEvent, type EventInit, type EventTarget } from '../core/event'
import { G, queueTask, tag } from '../core/host'
import { NodeType } from '../native'
import { flags, handlerOf, type Element } from './element'
import { metricsOf, rectOf } from './layout'
import { pathHooks, type Node } from './node'
import { ancestorsOf, documentId, dom, existing, ID, rootElementId, wrap, type Wrapper } from './realm'

export const SHADOW_ROOT = Symbol('shadowRoot')
export const ACTIVATION = Symbol('activation')

type Activatable = { [ACTIVATION]?: (event: Event) => { run(): void; cancel(): void } | null }

function isClick(event: Event): boolean {
  return event.type === 'click' && event instanceof MouseEvent
}

pathHooks.build = (node: Node, event: Event, path: EventTarget[]) => {
  const type = event.type
  const full = isClick(event)
  const inline = flags.inlineHandlers
  if (inline && node.nodeType === NodeType.Element) handlerOf(node as unknown as Element, type)
  const ancestors = ancestorsOf(node[ID])
  let previous: Wrapper = node
  const last = ancestors.length - 1
  for (let i = 0; i < ancestors.length; i++) {
    const id = ancestors[i]!
    let w = existing(id) as (Wrapper & { [SHADOW_ROOT]?: EventTarget }) | undefined
    if (!w) {
      if (full) w = wrap(id)!
      else if (inline && (i < last || dom.nodeType(id) === NodeType.Element) && dom.hasAttribute(id, `on${type}`)) w = wrap(id)!
      else continue
    }
    if (inline && (w as unknown as Node).nodeType === NodeType.Element) handlerOf(w as unknown as Element, type)
    const shadow = w[SHADOW_ROOT]
    if (shadow && previous !== w) path.push(shadow)
    path.push(w as unknown as EventTarget)
    previous = w
  }
  const root = ancestors.length ? ancestors[ancestors.length - 1]! : node[ID]
  if (root === documentId && type !== 'load') path.push(G as unknown as EventTarget)
  if (!full) {
    eventPath(event, () => {
      const list: EventTarget[] = [node]
      for (let i = 0; i < ancestors.length; i++) {
        const w = wrap(ancestors[i]!)! as Wrapper & { [SHADOW_ROOT]?: EventTarget }
        if (w[SHADOW_ROOT]) list.push(w[SHADOW_ROOT])
        list.push(w as unknown as EventTarget)
      }
      if (root === documentId && type !== 'load') list.push(G as unknown as EventTarget)
      return list
    })
  }
}

hooks.activation = (event, path) => {
  if (!(event instanceof MouseEvent)) return null
  for (const target of path) {
    const steps = (target as Activatable)[ACTIVATION]?.(event)
    if (steps) return steps
  }
  return null
}

hooks.compile = (target, _type, source) => {
  try {
    return new Function('event', source).bind(target) as (event: Event) => unknown
  } catch (error) {
    void error
    return null
  }
}

hooks.passiveDefault = (target, type) => {
  if (type !== 'wheel' && type !== 'mousewheel' && type !== 'touchstart' && type !== 'touchmove') return false
  if (target === (G as unknown as EventTarget)) return true
  const id = (target as unknown as Wrapper)[ID]
  if (id === documentId) return true
  if (id === undefined) return false
  const local = dom.nodeType(id) === NodeType.Element ? dom.localName(id) : ''
  if (local !== 'html' && local !== 'body') return false
  const parent = dom.parent(id)
  return parent === documentId || (parent >= 0 && dom.nodeType(parent) === NodeType.Element && dom.localName(parent) === 'html' && dom.parent(parent) === documentId)
}

interface UIEventInit extends EventInit {
  view?: unknown
  detail?: number
  which?: number
}

export class UIEvent extends BaseEvent {
  readonly #view: unknown
  readonly #detail: number
  readonly #which: number

  constructor(type: string, init?: UIEventInit | null) {
    super(type, init)
    this.#view = init?.view ?? null
    this.#detail = Number(init?.detail ?? 0)
    this.#which = Number(init?.which ?? 0)
  }

  get view(): unknown {
    return this.#view
  }
  get detail(): number {
    return this.#detail
  }
  get which(): number {
    return this.#which
  }
  initUIEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
    this.initEvent(type, bubbles, cancelable)
  }
}
tag(UIEvent)

interface FocusEventInit extends UIEventInit {
  relatedTarget?: EventTarget | null
}

export class FocusEvent extends UIEvent {
  readonly #related: EventTarget | null
  constructor(type: string, init?: FocusEventInit | null) {
    super(type, init)
    this.#related = init?.relatedTarget ?? null
  }
  get relatedTarget(): EventTarget | null {
    return this.#related
  }
}
tag(FocusEvent)

interface ModifierInit {
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  modifierAltGraph?: boolean
  modifierCapsLock?: boolean
}

interface MouseEventInit extends UIEventInit, ModifierInit {
  screenX?: number
  screenY?: number
  clientX?: number
  clientY?: number
  button?: number
  buttons?: number
  relatedTarget?: EventTarget | null
  movementX?: number
  movementY?: number
}

function modifier(init: ModifierInit | null | undefined, key: string): boolean {
  switch (key) {
    case 'Control': return !!init?.ctrlKey
    case 'Shift': return !!init?.shiftKey
    case 'Alt': return !!init?.altKey
    case 'Meta': return !!init?.metaKey
    case 'AltGraph': return !!init?.modifierAltGraph
    case 'CapsLock': return !!init?.modifierCapsLock
    default: return false
  }
}

export class MouseEvent extends UIEvent {
  readonly #init: MouseEventInit

  constructor(type: string, init?: MouseEventInit | null) {
    super(type, init)
    this.#init = init ?? {}
  }

  get screenX(): number {
    return Number(this.#init.screenX ?? 0)
  }
  get screenY(): number {
    return Number(this.#init.screenY ?? 0)
  }
  get clientX(): number {
    return Number(this.#init.clientX ?? 0)
  }
  get clientY(): number {
    return Number(this.#init.clientY ?? 0)
  }
  get x(): number {
    return this.clientX
  }
  get y(): number {
    return this.clientY
  }
  get pageX(): number {
    return this.clientX + scrollOffset(0)
  }
  get pageY(): number {
    return this.clientY + scrollOffset(1)
  }
  get offsetX(): number {
    return this.clientX - targetOrigin(this.target, 0)
  }
  get offsetY(): number {
    return this.clientY - targetOrigin(this.target, 1)
  }
  get layerX(): number {
    return this.offsetX
  }
  get layerY(): number {
    return this.offsetY
  }
  get movementX(): number {
    return Number(this.#init.movementX ?? 0)
  }
  get movementY(): number {
    return Number(this.#init.movementY ?? 0)
  }
  get ctrlKey(): boolean {
    return !!this.#init.ctrlKey
  }
  get shiftKey(): boolean {
    return !!this.#init.shiftKey
  }
  get altKey(): boolean {
    return !!this.#init.altKey
  }
  get metaKey(): boolean {
    return !!this.#init.metaKey
  }
  get button(): number {
    return Number(this.#init.button ?? 0)
  }
  get buttons(): number {
    return Number(this.#init.buttons ?? 0)
  }
  get relatedTarget(): EventTarget | null {
    return this.#init.relatedTarget ?? null
  }
  get fromElement(): EventTarget | null {
    return this.type === 'mouseover' ? this.relatedTarget : this.type === 'mouseout' ? this.target : null
  }
  get toElement(): EventTarget | null {
    return this.type === 'mouseout' ? this.relatedTarget : this.type === 'mouseover' ? this.target : null
  }
  override get which(): number {
    return this.button + 1
  }
  getModifierState(key: string): boolean {
    return modifier(this.#init, key)
  }
  initMouseEvent(type: string, bubbles?: boolean, cancelable?: boolean, _view?: unknown, detail?: number, screenX?: number, screenY?: number, clientX?: number, clientY?: number, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean, button?: number, relatedTarget?: EventTarget | null): void {
    this.initEvent(type, bubbles, cancelable)
    Object.assign(this.#init, { detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget })
  }
}
tag(MouseEvent)

function scrollOffset(axis: 0 | 1): number {
  const html = rootElementId()
  if (html < 0) return 0
  const m = metricsOf(html)
  return m ? (axis === 0 ? m.scrollLeft : m.scrollTop) : 0
}

function targetOrigin(target: EventTarget | null, axis: 0 | 1): number {
  const id = (target as unknown as Wrapper | null)?.[ID]
  if (id === undefined || dom.nodeType(id) !== NodeType.Element) return 0
  const r = rectOf(id)
  const m = metricsOf(id)
  return r[axis]! + (m ? (axis === 0 ? m.clientLeft : m.clientTop) : 0)
}

interface PointerEventInit extends MouseEventInit {
  pointerId?: number
  width?: number
  height?: number
  pressure?: number
  tangentialPressure?: number
  tiltX?: number
  tiltY?: number
  twist?: number
  pointerType?: string
  isPrimary?: boolean
}

export class PointerEvent extends MouseEvent {
  readonly #p: PointerEventInit
  constructor(type: string, init?: PointerEventInit | null) {
    super(type, init)
    this.#p = init ?? {}
  }
  get pointerId(): number {
    return Number(this.#p.pointerId ?? 0)
  }
  get width(): number {
    return Number(this.#p.width ?? 1)
  }
  get height(): number {
    return Number(this.#p.height ?? 1)
  }
  get pressure(): number {
    return Number(this.#p.pressure ?? 0)
  }
  get tangentialPressure(): number {
    return Number(this.#p.tangentialPressure ?? 0)
  }
  get tiltX(): number {
    return Number(this.#p.tiltX ?? 0)
  }
  get tiltY(): number {
    return Number(this.#p.tiltY ?? 0)
  }
  get twist(): number {
    return Number(this.#p.twist ?? 0)
  }
  get pointerType(): string {
    return String(this.#p.pointerType ?? '')
  }
  get isPrimary(): boolean {
    return !!this.#p.isPrimary
  }
  getCoalescedEvents(): PointerEvent[] {
    return [this]
  }
  getPredictedEvents(): PointerEvent[] {
    return []
  }
}
tag(PointerEvent)

interface WheelEventInit extends MouseEventInit {
  deltaX?: number
  deltaY?: number
  deltaZ?: number
  deltaMode?: number
}

export class WheelEvent extends MouseEvent {
  static readonly DOM_DELTA_PIXEL = 0
  static readonly DOM_DELTA_LINE = 1
  static readonly DOM_DELTA_PAGE = 2
  readonly #w: WheelEventInit
  constructor(type: string, init?: WheelEventInit | null) {
    super(type, init)
    this.#w = init ?? {}
  }
  get deltaX(): number {
    return Number(this.#w.deltaX ?? 0)
  }
  get deltaY(): number {
    return Number(this.#w.deltaY ?? 0)
  }
  get deltaZ(): number {
    return Number(this.#w.deltaZ ?? 0)
  }
  get deltaMode(): number {
    return Number(this.#w.deltaMode ?? 0)
  }
  get wheelDeltaX(): number {
    return Math.round(-this.deltaX * 1.2)
  }
  get wheelDeltaY(): number {
    return Math.round(-this.deltaY * 1.2)
  }
  get wheelDelta(): number {
    return this.wheelDeltaY
  }
}
tag(WheelEvent)

interface KeyboardEventInit extends UIEventInit, ModifierInit {
  key?: string
  code?: string
  location?: number
  repeat?: boolean
  isComposing?: boolean
  charCode?: number
  keyCode?: number
}

export class KeyboardEvent extends UIEvent {
  static readonly DOM_KEY_LOCATION_STANDARD = 0
  static readonly DOM_KEY_LOCATION_LEFT = 1
  static readonly DOM_KEY_LOCATION_RIGHT = 2
  static readonly DOM_KEY_LOCATION_NUMPAD = 3
  readonly #k: KeyboardEventInit
  constructor(type: string, init?: KeyboardEventInit | null) {
    super(type, init)
    this.#k = init ?? {}
  }
  get key(): string {
    return String(this.#k.key ?? '')
  }
  get code(): string {
    return String(this.#k.code ?? '')
  }
  get location(): number {
    return Number(this.#k.location ?? 0)
  }
  get repeat(): boolean {
    return !!this.#k.repeat
  }
  get isComposing(): boolean {
    return !!this.#k.isComposing
  }
  get ctrlKey(): boolean {
    return !!this.#k.ctrlKey
  }
  get shiftKey(): boolean {
    return !!this.#k.shiftKey
  }
  get altKey(): boolean {
    return !!this.#k.altKey
  }
  get metaKey(): boolean {
    return !!this.#k.metaKey
  }
  get charCode(): number {
    return Number(this.#k.charCode ?? 0)
  }
  get keyCode(): number {
    return Number(this.#k.keyCode ?? 0)
  }
  override get which(): number {
    return Number(this.#k.which ?? this.#k.keyCode ?? this.#k.charCode ?? 0)
  }
  getModifierState(key: string): boolean {
    return modifier(this.#k, key)
  }
  initKeyboardEvent(type: string, bubbles?: boolean, cancelable?: boolean, _view?: unknown, key?: string, location?: number, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean): void {
    this.initEvent(type, bubbles, cancelable)
    Object.assign(this.#k, { key, location, ctrlKey, altKey, shiftKey, metaKey })
  }
}
for (const [name, value] of Object.entries(KeyboardEvent)) {
  Object.defineProperty(KeyboardEvent.prototype, name, { value, enumerable: true })
}
tag(KeyboardEvent)

export class CompositionEvent extends UIEvent {
  readonly #data: string
  constructor(type: string, init?: UIEventInit & { data?: string } | null) {
    super(type, init)
    this.#data = String(init?.data ?? '')
  }
  get data(): string {
    return this.#data
  }
}
tag(CompositionEvent)

export class InputEvent extends UIEvent {
  readonly #i: { data?: string | null; inputType?: string; isComposing?: boolean; dataTransfer?: DataTransfer | null; targetRanges?: unknown[] }
  constructor(type: string, init?: UIEventInit & { data?: string | null; inputType?: string; isComposing?: boolean; dataTransfer?: DataTransfer | null; targetRanges?: unknown[] } | null) {
    super(type, init)
    this.#i = init ?? {}
  }
  get data(): string | null {
    return this.#i.data ?? null
  }
  get inputType(): string {
    return String(this.#i.inputType ?? '')
  }
  get isComposing(): boolean {
    return !!this.#i.isComposing
  }
  get dataTransfer(): DataTransfer | null {
    return this.#i.dataTransfer ?? null
  }
  getTargetRanges(): unknown[] {
    return [...(this.#i.targetRanges ?? [])]
  }
}
tag(InputEvent)

export class DragEvent extends MouseEvent {
  readonly #transfer: DataTransfer | null
  constructor(type: string, init?: MouseEventInit & { dataTransfer?: DataTransfer | null } | null) {
    super(type, init)
    this.#transfer = init?.dataTransfer ?? null
  }
  get dataTransfer(): DataTransfer | null {
    return this.#transfer
  }
}
tag(DragEvent)

export class ClipboardEvent extends BaseEvent {
  readonly #data: DataTransfer | null
  constructor(type: string, init?: EventInit & { clipboardData?: DataTransfer | null } | null) {
    super(type, init)
    this.#data = init?.clipboardData ?? null
  }
  get clipboardData(): DataTransfer | null {
    return this.#data
  }
}
tag(ClipboardEvent)

function simpleEvent<T extends Record<string, unknown>>(name: string, defaults: T): new (type: string, init?: EventInit & Partial<T>) => BaseEvent & Readonly<T> {
  const cls = class extends BaseEvent {
    constructor(type: string, init?: EventInit & Partial<T>) {
      super(type, init)
      for (const key of Object.keys(defaults)) {
        const value = init?.[key as keyof typeof init] ?? defaults[key]
        Object.defineProperty(this, key, { value, enumerable: true })
      }
    }
  }
  Object.defineProperty(cls, 'name', { value: name })
  tag(cls, name)
  return cls as never
}

export const HashChangeEvent = simpleEvent('HashChangeEvent', { oldURL: '', newURL: '' })
export const PopStateEvent = simpleEvent('PopStateEvent', { state: null as unknown, hasUAVisualTransition: false })
export const PageTransitionEvent = simpleEvent('PageTransitionEvent', { persisted: false })
export const StorageEvent = simpleEvent('StorageEvent', { key: null as string | null, oldValue: null as string | null, newValue: null as string | null, url: '', storageArea: null as unknown })
export const TransitionEvent = simpleEvent('TransitionEvent', { propertyName: '', elapsedTime: 0, pseudoElement: '' })
export const AnimationEvent = simpleEvent('AnimationEvent', { animationName: '', elapsedTime: 0, pseudoElement: '' })
export const SubmitEvent = simpleEvent('SubmitEvent', { submitter: null as unknown })
export const ToggleEvent = simpleEvent('ToggleEvent', { oldState: '', newState: '' })
export const FormDataEvent = simpleEvent('FormDataEvent', { formData: null as unknown })
export class BeforeUnloadEvent extends BaseEvent {}
{
  const values = new WeakMap<object, string>()
  Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', {
    get(this: BaseEvent) {
      return values.get(this) ?? ''
    },
    set(this: BaseEvent, value: unknown) {
      const text = String(value ?? '')
      values.set(this, text)
      if (text) this.preventDefault()
    },
    enumerable: true,
    configurable: true,
  })
}
tag(BeforeUnloadEvent)
export const MediaQueryListEvent = simpleEvent('MediaQueryListEvent', { media: '', matches: false })
export const SecurityPolicyViolationEvent = simpleEvent('SecurityPolicyViolationEvent', {})

export class FileList {
  readonly #files: File[]
  constructor(files: File[] = []) {
    this.#files = files
    for (let i = 0; i < files.length; i++) Object.defineProperty(this, i, { value: files[i], enumerable: true })
  }
  get length(): number {
    return this.#files.length
  }
  item(index: number): File | null {
    return this.#files[index] ?? null
  }
  [Symbol.iterator](): IterableIterator<File> {
    return this.#files[Symbol.iterator]()
  }
}
tag(FileList)

export class DataTransferItem {
  constructor(
    readonly kind: 'string' | 'file',
    readonly type: string,
    private readonly value: string | File,
  ) {}
  getAsString(callback: ((data: string) => void) | null): void {
    if (this.kind !== 'string' || typeof callback !== 'function') return
    const value = this.value as string
    queueTask(() => callback(value))
  }
  getAsFile(): File | null {
    return this.kind === 'file' ? (this.value as File) : null
  }
  webkitGetAsEntry(): null {
    return null
  }
}
tag(DataTransferItem)

export class DataTransferItemList {
  readonly #owner: DataTransfer
  constructor(owner: DataTransfer) {
    this.#owner = owner
  }
  get length(): number {
    return this.#owner.itemsList().length
  }
  add(data: string | File, type?: string): DataTransferItem | null {
    if (typeof data === 'string') {
      this.#owner.setData(String(type), data)
      return this.#owner.itemsList().find((item) => item.kind === 'string' && item.type === String(type).toLowerCase()) ?? null
    }
    this.#owner.addFile(data)
    return this.#owner.itemsList().at(-1) ?? null
  }
  remove(index: number): void {
    this.#owner.removeItem(index)
  }
  clear(): void {
    this.#owner.clearData()
  }
  [Symbol.iterator](): IterableIterator<DataTransferItem> {
    return this.#owner.itemsList()[Symbol.iterator]()
  }
}
tag(DataTransferItemList)

export class DataTransfer {
  #data = new Map<string, string>()
  #files: File[] = []
  #items: DataTransferItemList | null = null
  #types: string[] | null = null
  dropEffect = 'none'
  effectAllowed = 'uninitialized'
  dragImage: { element: unknown; x: number; y: number } | null = null

  get types(): readonly string[] {
    if (this.#types) return Object.freeze(this.#types.slice())
    const types = [...this.#data.keys()]
    if (this.#files.length) types.push('Files')
    return Object.freeze(types)
  }

  setTypes(types: readonly string[] | null): void {
    this.#types = types ? [...types] : null
  }

  get files(): FileList {
    return new FileList(this.#files.slice())
  }

  get items(): DataTransferItemList {
    return (this.#items ??= new DataTransferItemList(this))
  }

  itemsList(): DataTransferItem[] {
    const items: DataTransferItem[] = []
    for (const [type, value] of this.#data) items.push(new DataTransferItem('string', type, value))
    for (const file of this.#files) items.push(new DataTransferItem('file', file.type, file))
    return items
  }

  addFile(file: File): void {
    this.#files.push(file)
  }

  removeItem(index: number): void {
    const keys = [...this.#data.keys()]
    if (index < keys.length) this.#data.delete(keys[index]!)
    else this.#files.splice(index - keys.length, 1)
  }

  static #normalize(format: string): string {
    const f = String(format).toLowerCase()
    return f === 'text' ? 'text/plain' : f === 'url' ? 'text/uri-list' : f
  }

  setData(format: string, data: string): void {
    this.#data.set(DataTransfer.#normalize(format), String(data))
  }

  getData(format: string): string {
    const key = DataTransfer.#normalize(format)
    const value = this.#data.get(key) ?? ''
    return String(format).toLowerCase() === 'url' ? (value.split(/\r?\n/).find((line) => line && !line.startsWith('#')) ?? '') : value
  }

  clearData(format?: string): void {
    if (format === undefined) this.#data.clear()
    else this.#data.delete(DataTransfer.#normalize(format))
  }

  setDragImage(element: unknown, x: number, y: number): void {
    this.dragImage = { element, x, y }
  }
}
tag(DataTransfer)
