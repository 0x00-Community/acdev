import { fire, type Event } from '../core/event'
import { DOMException } from '../core/exception'
import { G, host } from '../core/host'
import { NONE, NodeType } from '../native'
import type { Element } from './element'
import { KeyboardEvent, MouseEvent, PointerEvent, WheelEvent } from './events'
import { focus, focusable, focusedElement, setFocus } from './focus'
import { ancestorsOf, dom, documentId, ID, moved, rootElementId, wrap } from './realm'

export interface Modifiers {
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly meta?: boolean
}

interface PointerOptions {
  readonly button?: number
  readonly modifiers?: Modifiers
  readonly target?: number | null
  readonly pointerType?: string
  readonly pointerId?: number
}

interface KeyOptions {
  readonly modifiers?: Modifiers
  readonly repeat?: boolean
  readonly keyCode?: number
  readonly location?: number
  readonly isComposing?: boolean
}

const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]'
const DOUBLE_CLICK_MS = 500
const CLICK_SLOP = 5
const KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27, ' ': 32, PageUp: 33,
  PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  Meta: 91, ContextMenu: 93, F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121,
  F11: 122, F12: 123, ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222,
}

function keyCodeOf(key: string): number {
  return KEY_CODES[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0)
}

function mods(modifiers: Modifiers | undefined) {
  return { shiftKey: !!modifiers?.shift, ctrlKey: !!modifiers?.ctrl, altKey: !!modifiers?.alt, metaKey: !!modifiers?.meta }
}

export class Input {
  #hover: Element | null = null
  #path: Element[] = []
  #pressed: Element | null = null
  #buttons = 0
  #lastDown = { at: 0, x: 0, y: 0, count: 0 }
  #noCompat = false
  #last = { x: 0, y: 0 }
  capture: Element | null = null
  onKeyDefault: (target: Element, key: string, modifiers: Modifiers) => void = () => {}

  elementAt(target: number | null | undefined, x: number, y: number, ignoreCapture = false): Element {
    if (!ignoreCapture && this.capture?.isConnected) return this.capture
    let id = target === undefined ? dom.hitTest(x, y) : (target ?? NONE)
    if (id !== NONE && dom.nodeType(id) === NodeType.Text) id = dom.parent(id)
    const element = id === NONE || dom.nodeType(id) !== NodeType.Element ? null : wrap<Element>(id)
    return element?.isConnected ? element : (wrap<Element>(rootElementId()) ?? (wrap<Element>(documentId) as Element))
  }

  #fire(target: Element, type: string, init: Record<string, unknown>, Kind: new (type: string, init: Record<string, unknown>) => Event = MouseEvent as never): boolean {
    return fire(target, new Kind(type, { bubbles: true, cancelable: true, composed: true, view: G, ...init }))
  }

  #init(x: number, y: number, options: PointerOptions, button = 0) {
    const movementX = x - this.#last.x, movementY = y - this.#last.y
    return { clientX: x, clientY: y, screenX: x, screenY: y, movementX, movementY, button, buttons: this.#buttons, pointerId: options.pointerId ?? 1, pointerType: options.pointerType ?? 'mouse', isPrimary: true, width: 1, height: 1, pressure: this.#buttons ? 0.5 : 0, ...mods(options.modifiers) }
  }

  #pointer(target: Element, type: string, init: Record<string, unknown>, detail = 0): boolean {
    const pointer = this.#fire(target, `pointer${type}`, init, PointerEvent as never)
    if (type === 'down') this.#noCompat = !pointer
    const mouse = this.#noCompat && (type === 'down' || type === 'up' || type === 'move') ? true : this.#fire(target, `mouse${type}`, { ...init, detail })
    if (type === 'up') this.#noCompat = false
    return mouse
  }

  #chain(node: Element | null): number[] {
    if (!node) return []
    const list = [node[ID]]
    const up = ancestorsOf(node[ID])
    for (let i = 0; i < up.length && up[i] !== documentId; i++) list.push(up[i]!)
    return list
  }

  #boundary(id: number, type: string, init: Record<string, unknown>, related: Element | null): void {
    this.#fire(wrap<Element>(id)!, type, { ...init, bubbles: false, cancelable: false, relatedTarget: related }, (type.startsWith('pointer') ? PointerEvent : MouseEvent) as never)
  }

  #hoverTo(target: Element | null, init: Record<string, unknown>): void {
    if (this.#hover === target && (!target || target.isConnected)) return
    const old = this.#hover?.isConnected ? this.#hover : (this.#path.find((e) => e.isConnected) ?? null)
    const was = this.#chain(old), now = this.#chain(target)
    this.#hover = target
    this.#path = now.map((id) => wrap<Element>(id)!)
    if (old === target) return
    const wasSet = new Set(was), nowSet = new Set(now)
    if (old) {
      this.#pointer(old, 'out', { ...init, relatedTarget: target })
      for (const id of was) if (!nowSet.has(id)) for (const type of ['pointerleave', 'mouseleave']) this.#boundary(id, type, init, target)
    }
    if (!target) return
    this.#pointer(target, 'over', { ...init, relatedTarget: old })
    for (let i = now.length - 1; i >= 0; i--) if (!wasSet.has(now[i]!)) for (const type of ['pointerenter', 'mouseenter']) this.#boundary(now[i]!, type, init, old)
  }

  leave(options: PointerOptions = {}): void {
    if (this.capture) return
    this.#hoverTo(null, this.#init(this.#last.x, this.#last.y, options))
  }

  pointer(type: 'pointermove' | 'pointerdown' | 'pointerup', x: number, y: number, options: PointerOptions = {}): void {
    focus.modality = 'pointer'
    moved()
    if (type === 'pointermove') this.#move(x, y, options)
    else if (type === 'pointerdown') this.#down(x, y, options)
    else this.#up(x, y, options)
    this.#last = { x, y }
  }

  #move(x: number, y: number, options: PointerOptions): void {
    const target = this.elementAt(options.target, x, y)
    const init = this.#init(x, y, options)
    this.#hoverTo(this.capture ? this.elementAt(options.target, x, y, true) : target, init)
    this.#pointer(target, 'move', init)
  }

  #down(x: number, y: number, options: PointerOptions): void {
    const target = this.elementAt(options.target, x, y)
    const button = options.button ?? 0
    this.#buttons |= 1 << (button === 1 ? 2 : button === 2 ? 1 : button)
    const init = this.#init(x, y, options, button)
    this.#hoverTo(target, init)
    this.#pressed = target
    dom.setActive(target[ID])
    const now = host.now(), last = this.#lastDown
    const count = button === 0 && now - last.at < DOUBLE_CLICK_MS && Math.hypot(x - last.x, y - last.y) < CLICK_SLOP ? last.count + 1 : 1
    if (button === 0) this.#lastDown = { at: now, x, y, count }
    if (this.#pointer(target, 'down', init, count)) {
      const candidate = target.closest(FOCUSABLE)
      if (candidate && focusable(candidate[ID])) setFocus(candidate)
      else if (focusedElement()) setFocus(null)
    }
    if (button === 2) this.#fire(target, 'contextmenu', init)
  }

  #up(x: number, y: number, options: PointerOptions): void {
    const target = this.elementAt(options.target, x, y)
    const button = options.button ?? 0
    this.#buttons &= ~(1 << (button === 1 ? 2 : button === 2 ? 1 : button))
    const init = this.#init(x, y, options, button)
    this.#pointer(target, 'up', init, button === 0 ? this.#lastDown.count : 1)
    dom.setActive(NONE)
    if (this.capture) {
      const captured = this.capture
      this.capture = null
      this.#fire(captured, 'lostpointercapture', { ...init, bubbles: false, cancelable: false }, PointerEvent as never)
    }
    const pressed = this.#pressed
    this.#pressed = null
    if (!pressed) return
    let common: Element | null = pressed
    while (common && !common.contains(target)) common = common.parentElement
    if (!common) return
    if (button !== 0) {
      if (button === 1) this.#fire(common, 'auxclick', { ...init, detail: 1 }, PointerEvent as never)
      return
    }
    const count = this.#lastDown.count
    this.#fire(common, 'click', { ...init, detail: count }, PointerEvent as never)
    if (count === 2) this.#fire(common, 'dblclick', { ...init, detail: 2 })
  }

  wheel(x: number, y: number, deltaX: number, deltaY: number, options: PointerOptions & { deltaMode?: number } = {}): boolean {
    const target = this.elementAt(options.target, x, y)
    return this.#fire(target, 'wheel', { ...this.#init(x, y, options), deltaX, deltaY, deltaMode: options.deltaMode ?? 0 }, WheelEvent as never)
  }

  key(type: 'keydown' | 'keyup', key: string, code: string, options: KeyOptions = {}): boolean {
    focus.modality = 'keyboard'
    const target = focusedElement() ?? (wrap<Document & Element>(documentId) as unknown as { body: Element | null }).body ?? this.elementAt(null, 0, 0)
    const keyCode = options.keyCode ?? keyCodeOf(key)
    const init = { key, code, keyCode, which: keyCode, repeat: !!options.repeat, location: options.location ?? 0, isComposing: !!options.isComposing, ...mods(options.modifiers) }
    if (!this.#fire(target, type, init, KeyboardEvent as never)) return false
    if (type !== 'keydown') return true
    if (key === 'Tab' && !options.modifiers?.ctrl && !options.modifiers?.alt && !options.modifiers?.meta) {
      this.tab(!!options.modifiers?.shift)
      return true
    }
    const ctrl = !!(options.modifiers?.ctrl || options.modifiers?.meta)
    if (key.length === 1 && !ctrl) {
      const char = key.charCodeAt(0)
      if (!this.#fire(target, 'keypress', { ...init, keyCode: char, charCode: char, which: char }, KeyboardEvent as never)) return false
    }
    this.onKeyDefault(target, key, options.modifiers ?? {})
    return true
  }

  tab(back: boolean): void {
    const candidates = [...dom.querySelectorAll(documentId, FOCUSABLE)].filter((id) => {
      const index = dom.getAttribute(id, 'tabindex')
      return (index === null || parseInt(index, 10) >= 0) && focusable(id)
    })
    if (candidates.length === 0) return
    const order = candidates.map((id, i) => ({ id, i, t: parseInt(dom.getAttribute(id, 'tabindex') ?? '0', 10) || 0 })).sort((a, b) => (a.t > 0 && b.t > 0 ? a.t - b.t || a.i - b.i : a.t > 0 ? -1 : b.t > 0 ? 1 : a.i - b.i)).map((e) => e.id)
    const at = order.indexOf(focus.id)
    const next = order[(at + (back ? -1 : 1) + order.length + (at === -1 && back ? 1 : 0)) % order.length]!
    setFocus(wrap<Element>(next), true)
  }

  setPointerCapture(element: Element, pointerId: number): void {
    if (!element.isConnected) throw new DOMException("Failed to execute 'setPointerCapture' on 'Element': The element is not connected.", 'InvalidStateError')
    if (this.capture === element) return
    this.capture = element
    this.#fire(element, 'gotpointercapture', { pointerId, bubbles: false, cancelable: false }, PointerEvent as never)
  }

  releasePointerCapture(element: Element, pointerId: number): void {
    if (this.capture !== element) return
    this.capture = null
    this.#fire(element, 'lostpointercapture', { pointerId, bubbles: false, cancelable: false }, PointerEvent as never)
  }
}

type Document = object
