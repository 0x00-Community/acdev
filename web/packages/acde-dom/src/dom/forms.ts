import { DOMException } from '../core/exception'
import { Event, fire } from '../core/event'
import { host, queueTask, tag } from '../core/host'
import { File } from '../core/blob'
import { NONE } from '../native'
import { ACTIVATION, FileList, SubmitEvent } from './events'
import { ATTRIBUTE_CHANGED, LOCAL, setAttribute, tokenList, type Element, type DOMTokenList } from './element'
import { env, resolveUrl } from './env'
import { focusable, setFocus } from './focus'
import { HTMLElement, registerHtml } from './html'
import { acceptFilters, readPicked } from './picker'
import { cssString, HTMLCollection, liveCollection, mixin, staticNodeList, type Node, type NodeList } from './node'
import { bool, long, string, url } from './reflect'
import { documentId, dom, ID, wrap } from './realm'

const SELECTION = Symbol('selection')
const SELECTED = Symbol('selected')
const CUSTOM_VALIDITY = Symbol('customValidity')
const INDETERMINATE = Symbol('indeterminate')

type Selection = { start: number; end: number; direction: 'forward' | 'backward' | 'none' }
type Field = HTMLInputElement | HTMLTextAreaElement

const VALUE_MODE = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'range', 'color', 'date', 'month', 'week', 'time', 'datetime-local'])
const DEFAULT_MODE = new Set(['hidden', 'submit', 'image', 'reset', 'button'])
const SELECTABLE = new Set(['text', 'search', 'url', 'tel', 'password'])
const TYPES = ['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button']

function formOwner(element: Element): HTMLFormElement | null {
  const id = element[ID]
  const attr = dom.getAttribute(id, 'form')
  if (attr !== null) {
    const found = dom.getElementById(attr)
    return found !== NONE && dom.localName(found) === 'form' ? wrap<HTMLFormElement>(found) : null
  }
  const parent = dom.parent(id)
  if (parent === NONE) return null
  return wrap<HTMLFormElement>(dom.closest(parent, 'form'))
}

function labelsOf(element: Element): NodeList {
  const id = element[ID]
  const list: Node[] = []
  const root = dom.ancestors(id).at(-1) ?? id
  for (const label of dom.querySelectorAll(root, 'label')) {
    const control = wrap<HTMLLabelElement>(label)!.control
    if (control === element) list.push(wrap<Node>(label)!)
  }
  return staticNodeList(list)
}

function disabledControl(element: Element): boolean {
  const id = element[ID]
  return dom.hasAttribute(id, 'disabled') || dom.closest(id, 'fieldset[disabled] *') !== NONE
}

const VALIDITY = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooShort', 'rangeUnderflow', 'rangeOverflow'] as const

export class ValidityState {
  declare readonly valueMissing: boolean
  declare readonly typeMismatch: boolean
  declare readonly patternMismatch: boolean
  declare readonly tooShort: boolean
  declare readonly rangeUnderflow: boolean
  declare readonly rangeOverflow: boolean
  constructor(readonly owner: Element) {}
  get tooLong(): boolean {
    return false
  }
  get stepMismatch(): boolean {
    return false
  }
  get badInput(): boolean {
    return false
  }
  get customError(): boolean {
    return !!(this.owner as unknown as { [CUSTOM_VALIDITY]?: string })[CUSTOM_VALIDITY]
  }
  get valid(): boolean {
    const v = validity(this.owner)
    return !(VALIDITY.some((key) => v[key]) || this.customError)
  }
}
for (const key of VALIDITY) {
  Object.defineProperty(ValidityState.prototype, key, {
    get(this: ValidityState) {
      return validity(this.owner)[key]
    },
    configurable: true,
  })
}
tag(ValidityState)

function validity(element: Element): Record<(typeof VALIDITY)[number], boolean> {
  const result = { valueMissing: false, typeMismatch: false, patternMismatch: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false }
  const id = element[ID]
  if (!willValidate(element)) return result
  const required = dom.hasAttribute(id, 'required')
  const local = element[LOCAL]
  if (local === 'select') {
    result.valueMissing = required && (element as unknown as HTMLSelectElement).value === ''
    return result
  }
  const value = (element as unknown as { value: string }).value
  if (local === 'input') {
    const type = (element as unknown as HTMLInputElement).type
    if (type === 'checkbox') result.valueMissing = required && !dom.checked(id)
    else if (type === 'radio') {
      const name = dom.getAttribute(id, 'name')
      result.valueMissing = required && !(name ? radioGroup(element as unknown as HTMLInputElement).some((r) => dom.checked(r)) : dom.checked(id))
    } else result.valueMissing = required && value === ''
    if (value !== '') {
      if (type === 'email') result.typeMismatch = !value.split(dom.hasAttribute(id, 'multiple') ? ',' : /(?!)/).every((v) => /^[^\s@]+@[^\s@]+$/.test(v.trim()))
      if (type === 'url') result.typeMismatch = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/.test(value)
      const pattern = dom.getAttribute(id, 'pattern')
      if (pattern !== null) {
        try {
          result.patternMismatch = !new RegExp(`^(?:${pattern})$`, 'v').test(value)
        } catch {
        }
      }
      const min = parseInt(dom.getAttribute(id, 'minlength') ?? '', 10)
      if (!Number.isNaN(min)) result.tooShort = value.length < min
      if (type === 'number' || type === 'range') {
        const n = parseFloat(value), lo = parseFloat(dom.getAttribute(id, 'min') ?? ''), hi = parseFloat(dom.getAttribute(id, 'max') ?? '')
        result.rangeUnderflow = !Number.isNaN(lo) && n < lo
        result.rangeOverflow = !Number.isNaN(hi) && n > hi
      }
    }
  } else if (local === 'textarea') {
    result.valueMissing = required && value === ''
    const min = parseInt(dom.getAttribute(id, 'minlength') ?? '', 10)
    if (!Number.isNaN(min) && value !== '') result.tooShort = value.length < min
  }
  return result
}

function willValidate(element: Element): boolean {
  const id = element[ID]
  if (disabledControl(element) || dom.closest(id, 'datalist') !== NONE) return false
  const local = element[LOCAL]
  if (local === 'input') {
    const type = (element as unknown as HTMLInputElement).type
    return type !== 'hidden' && type !== 'reset' && type !== 'button' && !dom.hasAttribute(id, 'readonly')
  }
  if (local === 'button') return (element as unknown as HTMLButtonElement).type === 'submit'
  if (local === 'textarea') return !dom.hasAttribute(id, 'readonly')
  return local === 'select'
}

class ConstraintValidation {
  get validity(): ValidityState {
    const self = this as unknown as Element
    return new ValidityState(self)
  }
  get willValidate(): boolean {
    const self = this as unknown as Element
    return willValidate(self)
  }
  get validationMessage(): string {
    const self = this as unknown as Element
    const custom = (self as unknown as { [CUSTOM_VALIDITY]?: string })[CUSTOM_VALIDITY]
    if (custom) return custom
    const v = validity(self)
    return v.valueMissing ? 'Please fill out this field.' : v.typeMismatch ? 'Please enter a valid value.' : v.patternMismatch ? 'Please match the requested format.' : v.tooShort ? 'Please lengthen this text.' : v.rangeUnderflow || v.rangeOverflow ? 'Value out of range.' : ''
  }
  setCustomValidity(this: Element, message: string): void {
    ;(this as unknown as { [CUSTOM_VALIDITY]?: string })[CUSTOM_VALIDITY] = String(message)
  }
  checkValidity(this: Element): boolean {
    if (!willValidate(this) || new ValidityState(this).valid) return true
    fire(this, new Event('invalid', { cancelable: true }))
    return false
  }
  reportValidity(this: Element): boolean {
    return (this as unknown as ConstraintValidation).checkValidity.call(this)
  }
  get form(): HTMLFormElement | null {
    const self = this as unknown as Element
    return formOwner(self)
  }
  get labels(): NodeList {
    const self = this as unknown as Element
    return labelsOf(self)
  }
}

export function fieldSelection(field: Field): Selection {
  const holder = field as unknown as { [SELECTION]?: Selection }
  const length = field.value.length
  let s = holder[SELECTION]
  if (!s) s = holder[SELECTION] = { start: length, end: length, direction: 'none' }
  if (s.end > length) s.end = length
  if (s.start > s.end) s.start = s.end
  return s
}

function setSelection(field: Field, start: number, end: number, direction: string | undefined): void {
  const length = field.value.length
  const e = Math.min(Math.max(0, Math.trunc(end) || 0), length)
  let s = Math.min(Math.max(0, Math.trunc(start) || 0), length)
  if (s > e) s = e
  ;(field as unknown as { [SELECTION]?: Selection })[SELECTION] = { start: s, end: e, direction: direction === 'forward' || direction === 'backward' ? direction : 'none' }
  dom.setSelectionRange(field[ID], s, e)
}

export type TextField = Field

export function setFieldSelection(field: Field, start: number, end: number): void {
  setSelection(field, start, end, 'none')
}

export function replaceFieldText(field: Field, from: number, to: number, text: string): void {
  const value = field.value
  const insert = field[LOCAL] === 'textarea' ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]/g, '')
  const proto = field[LOCAL] === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value.slice(0, from) + insert + value.slice(to))
  setSelection(field, from + insert.length, from + insert.length, 'none')
}

function valueChanged(field: Field): void {
  const length = field.value.length
  ;(field as unknown as { [SELECTION]?: Selection })[SELECTION] = { start: length, end: length, direction: 'none' }
}

class TextSelection {
  get selectionStart(): number | null {
    const self = this as unknown as Field
    if (!selectable(self)) return null
    return fieldSelection(self).start
  }
  set selectionStart(value: number) {
    const self = this as unknown as Field
    if (!selectable(self)) throw new DOMException(`The input element's type ('${(self as HTMLInputElement).type}') does not support selection.`, 'InvalidStateError')
    const s = fieldSelection(self)
    setSelection(self, value, Math.max(value, s.end), s.direction)
  }
  get selectionEnd(): number | null {
    const self = this as unknown as Field
    if (!selectable(self)) return null
    return fieldSelection(self).end
  }
  set selectionEnd(value: number) {
    const self = this as unknown as Field
    if (!selectable(self)) throw new DOMException(`The input element's type ('${(self as HTMLInputElement).type}') does not support selection.`, 'InvalidStateError')
    const s = fieldSelection(self)
    setSelection(self, Math.min(s.start, value), value, s.direction)
  }
  get selectionDirection(): string | null {
    const self = this as unknown as Field
    if (!selectable(self)) return null
    return fieldSelection(self).direction
  }
  set selectionDirection(value: string) {
    const self = this as unknown as Field
    const s = fieldSelection(self)
    setSelection(self, s.start, s.end, value)
  }
  setSelectionRange(this: Field, start: number, end: number, direction?: string): void {
    if (!selectable(this)) throw new DOMException(`Failed to execute 'setSelectionRange' on 'HTMLInputElement': The input element's type ('${(this as HTMLInputElement).type}') does not support selection.`, 'InvalidStateError')
    setSelection(this, Number(start), Number(end), direction)
  }
  select(this: Field): void {
    if (!selectable(this)) return
    setSelection(this, 0, this.value.length, 'none')
    queueTask(() => fire(this, new Event('select', { bubbles: true })))
  }
  setRangeText(this: Field, replacement: string, start?: number, end?: number, mode = 'preserve'): void {
    if (!selectable(this)) throw new DOMException("Failed to execute 'setRangeText': The input element's type does not support selection.", 'InvalidStateError')
    const s = fieldSelection(this)
    const value = this.value
    const from = Math.min(start ?? s.start, value.length), to = Math.min(end ?? s.end, value.length)
    if (from > to) throw new DOMException("Failed to execute 'setRangeText': The provided start value is larger than the end value.", 'IndexSizeError')
    const text = String(replacement)
    const oldStart = s.start, oldEnd = s.end
    dom.setValue(this[ID], value.slice(0, from) + text + value.slice(to))
    const newEnd = from + text.length
    if (mode === 'select') setSelection(this, from, newEnd, 'none')
    else if (mode === 'start') setSelection(this, from, from, 'none')
    else if (mode === 'end') setSelection(this, newEnd, newEnd, 'none')
    else {
      const delta = text.length - (to - from)
      const shift = (p: number) => (p > to ? p + delta : p > from ? from : p)
      setSelection(this, shift(oldStart), oldEnd > to ? oldEnd + delta : oldEnd > from ? newEnd : oldEnd, s.direction)
    }
  }
}

function selectable(field: Field): boolean {
  return field[LOCAL] === 'textarea' || SELECTABLE.has((field as HTMLInputElement).type)
}

function inputType(id: number): string {
  const raw = dom.getAttribute(id, 'type')
  if (raw === null) return 'text'
  const lower = raw.toLowerCase()
  return TYPES.includes(lower) ? lower : 'text'
}

function sanitize(type: string, value: string): string {
  switch (type) {
    case 'text':
    case 'search':
    case 'tel':
    case 'password': return value.replace(/[\r\n]/g, '')
    case 'url':
    case 'email': return value.replace(/[\r\n]/g, '').trim()
    case 'number': return value === '' || Number.isFinite(Number(value)) ? value : ''
    case 'color': return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#000000'
    default: return value
  }
}

function radioGroup(input: HTMLInputElement): number[] {
  const id = input[ID]
  const name = dom.getAttribute(id, 'name')
  if (!name) return [id]
  const form = formOwner(input)
  const root = form ? form[ID] : (dom.ancestors(id).at(-1) ?? id)
  const all = dom.querySelectorAll(root, `input[name=${cssString(name)}]`)
  const out: number[] = []
  for (const other of all) {
    if (inputType(other) !== 'radio') continue
    if (!form && dom.closest(other, 'form') !== NONE) continue
    if (form && formOwner(wrap<Element>(other)!) !== form) continue
    out.push(other)
  }
  if (!out.includes(id)) out.push(id)
  return out
}

function setChecked(input: HTMLInputElement, checked: boolean): void {
  const id = input[ID]
  if (checked && input.type === 'radio') for (const other of radioGroup(input)) if (other !== id && dom.checked(other)) dom.setChecked(other, false)
  dom.setChecked(id, checked)
}

const FILES = Symbol('files')

function filesOf(input: HTMLInputElement): File[] {
  return (input as unknown as { [FILES]?: { files: File[] } })[FILES]?.files ?? []
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  ;(input as unknown as { [FILES]?: { files: File[]; list: unknown } })[FILES] = { files, list: null }
}

const picking = new WeakSet<object>()

function pickFiles(input: HTMLInputElement): void {
  if (picking.has(input)) return
  const chooser = env.files
  const cancel = () => fire(input, new Event('cancel', { bubbles: true }))
  if (!chooser) return void host.setTimer(0, cancel)
  picking.add(input)
  const accept = dom.getAttribute(input[ID], 'accept') ?? ''
  void chooser
    .open({ multiple: dom.hasAttribute(input[ID], 'multiple'), directory: false, filters: acceptFilters(accept) })
    .then(async (picked) => {
      if (!picked || picked.length === 0) return cancel()
      setFiles(input, await Promise.all(picked.map(readPicked)))
      fire(input, new Event('input', { bubbles: true, composed: true }))
      fire(input, new Event('change', { bubbles: true }))
    })
    .catch((error: unknown) => {
      host.print(1, `acde-dom: file chooser: ${(error as Error)?.message ?? String(error)}`)
      cancel()
    })
    .finally(() => picking.delete(input))
}

export class HTMLInputElement extends HTMLElement {
  get type(): string {
    return inputType(this[ID])
  }
  set type(value: string) {
    setAttribute(this, 'type', String(value))
  }

  get value(): string {
    const type = this.type
    if (VALUE_MODE.has(type)) return dom.value(this[ID])
    if (DEFAULT_MODE.has(type)) return dom.getAttribute(this[ID], 'value') ?? ''
    if (type === 'checkbox' || type === 'radio') return dom.getAttribute(this[ID], 'value') ?? 'on'
    const first = type === 'file' ? filesOf(this)[0] : undefined
    return first ? `C:\\fakepath\\${first.name}` : ''
  }
  set value(value: string) {
    const type = this.type
    const text = value === null ? '' : String(value)
    if (VALUE_MODE.has(type)) {
      const next = sanitize(type, text)
      if (next === dom.value(this[ID])) {
        dom.setValue(this[ID], next)
        return
      }
      dom.setValue(this[ID], next)
      valueChanged(this)
    } else if (type === 'file') {
      if (text !== '') throw new DOMException("Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename, which may only be programmatically set to the empty string.", 'InvalidStateError')
      setFiles(this, [])
    } else setAttribute(this, 'value', text)
  }

  get defaultValue(): string {
    return dom.getAttribute(this[ID], 'value') ?? ''
  }
  set defaultValue(value: string) {
    setAttribute(this, 'value', String(value))
  }

  get checked(): boolean {
    return dom.checked(this[ID])
  }
  set checked(value: boolean) {
    setChecked(this, !!value)
  }

  get defaultChecked(): boolean {
    return dom.hasAttribute(this[ID], 'checked')
  }
  set defaultChecked(value: boolean) {
    setAttribute(this, 'checked', value ? '' : null)
  }

  get indeterminate(): boolean {
    return !!(this as unknown as { [INDETERMINATE]?: boolean })[INDETERMINATE]
  }
  set indeterminate(value: boolean) {
    ;(this as unknown as { [INDETERMINATE]?: boolean })[INDETERMINATE] = !!value
  }

  get valueAsNumber(): number {
    const type = this.type
    const value = this.value
    if (type === 'number' || type === 'range') return value === '' ? NaN : Number(value)
    if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'week') return value ? Date.parse(value) : NaN
    if (type === 'time') {
      const m = /^(\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?$/.exec(value)
      return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) * 1000 : NaN
    }
    return NaN
  }
  set valueAsNumber(value: number) {
    if (this.type === 'number' || this.type === 'range') this.value = Number.isFinite(value) ? String(value) : ''
    else throw new DOMException("Failed to set the 'valueAsNumber' property on 'HTMLInputElement': This input element does not support Number values.", 'InvalidStateError')
  }

  get valueAsDate(): Date | null {
    const n = this.valueAsNumber
    return (this.type === 'date' || this.type === 'datetime-local') && Number.isFinite(n) ? new Date(n) : null
  }
  set valueAsDate(value: Date | null) {
    this.value = value ? value.toISOString().slice(0, this.type === 'date' ? 10 : 16) : ''
  }

  get files(): unknown {
    if (this.type !== 'file') return null
    const holder = this as unknown as { [FILES]?: { files: File[]; list: unknown } }
    const held = (holder[FILES] ??= { files: [], list: null })
    return (held.list ??= new FileList(held.files.slice()))
  }
  set files(value: unknown) {
    if (this.type !== 'file' || !(value instanceof FileList)) return
    const files: File[] = []
    for (let i = 0; i < value.length; i++) files.push(value.item(i)!)
    setFiles(this, files)
  }

  get list(): Element | null {
    const attr = dom.getAttribute(this[ID], 'list')
    if (!attr) return null
    const found = dom.getElementById(attr)
    return found !== NONE && dom.localName(found) === 'datalist' ? wrap<Element>(found) : null
  }

  stepUp(n = 1): void {
    this.#step(n)
  }
  stepDown(n = 1): void {
    this.#step(-n)
  }
  #step(n: number): void {
    if (this.type !== 'number' && this.type !== 'range') throw new DOMException("Failed to execute 'stepUp' on 'HTMLInputElement': This form element is not steppable.", 'InvalidStateError')
    const step = parseFloat(dom.getAttribute(this[ID], 'step') ?? '1') || 1
    let next = (Number(this.value) || 0) + n * step
    const min = parseFloat(dom.getAttribute(this[ID], 'min') ?? ''), max = parseFloat(dom.getAttribute(this[ID], 'max') ?? '')
    if (!Number.isNaN(min)) next = Math.max(min, next)
    if (!Number.isNaN(max)) next = Math.min(max, next)
    this.value = String(next)
  }

  showPicker(): void {
    if (disabledControl(this) || dom.hasAttribute(this[ID], 'readonly')) throw new DOMException("Failed to execute 'showPicker' on 'HTMLInputElement': HTMLInputElement::showPicker() cannot be used on immutable controls.", 'InvalidStateError')
    if (this.type === 'file') pickFiles(this)
  }

  [ACTIVATION](): { run(): void; cancel(): void } | null {
    if (disabledControl(this)) return null
    const type = this.type
    if (type === 'file') return { run: () => pickFiles(this), cancel: () => {} }
    if (type === 'checkbox') {
      const was = this.checked, wasIndeterminate = this.indeterminate
      setChecked(this, !was)
      this.indeterminate = false
      return {
        run: () => {
          if (!this.isConnected) return
          fire(this, new Event('input', { bubbles: true, composed: true }))
          fire(this, new Event('change', { bubbles: true }))
        },
        cancel: () => {
          setChecked(this, was)
          this.indeterminate = wasIndeterminate
        },
      }
    }
    if (type === 'radio') {
      const was = this.checked
      const previous = was ? NONE : (radioGroup(this).find((id) => id !== this[ID] && dom.checked(id)) ?? NONE)
      setChecked(this, true)
      return {
        run: () => {
          if (was || !this.isConnected) return
          fire(this, new Event('input', { bubbles: true, composed: true }))
          fire(this, new Event('change', { bubbles: true }))
        },
        cancel: () => {
          if (was) return
          setChecked(this, false)
          if (previous !== NONE) dom.setChecked(previous, true)
        },
      }
    }
    if (type === 'submit' || type === 'image') return { run: () => this.form?.requestSubmit(this), cancel: () => {} }
    if (type === 'reset') return { run: () => this.form?.reset(), cancel: () => {} }
    return null
  }

  override [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    super[ATTRIBUTE_CHANGED](name, value)
    if (name === 'type') {
      const holder = this as unknown as { [SELECTION]?: Selection }
      holder[SELECTION] = undefined
    }
  }
}
for (const name of ['name', 'placeholder', 'min', 'max', 'step', 'pattern', 'autocomplete', 'accept', 'alt', 'dirName', 'formAction', 'formEnctype', 'formMethod', 'formTarget', 'useMap', 'align']) string(HTMLInputElement.prototype, name, name === 'dirName' ? 'dirname' : name.toLowerCase())
for (const name of ['disabled', 'required', 'readOnly', 'multiple', 'formNoValidate', 'webkitdirectory']) bool(HTMLInputElement.prototype, name, name.toLowerCase())
long(HTMLInputElement.prototype, 'maxLength', -1, 'maxlength', 0)
long(HTMLInputElement.prototype, 'minLength', -1, 'minlength', 0)
long(HTMLInputElement.prototype, 'size', 20, 'size', 1)
long(HTMLInputElement.prototype, 'width', 0)
long(HTMLInputElement.prototype, 'height', 0)
url(HTMLInputElement.prototype, 'src')
mixin(HTMLInputElement, ConstraintValidation)
mixin(HTMLInputElement, TextSelection)
tag(HTMLInputElement)
export interface HTMLInputElement extends ConstraintValidation, TextSelection {}

export class HTMLTextAreaElement extends HTMLElement {
  get type(): string {
    return 'textarea'
  }
  get value(): string {
    return dom.value(this[ID])
  }
  set value(value: string) {
    const text = (value === null ? '' : String(value)).replace(/\r\n?/g, '\n')
    if (text === dom.value(this[ID])) return
    dom.setValue(this[ID], text)
    valueChanged(this)
  }
  get defaultValue(): string {
    return dom.textContent(this[ID])
  }
  set defaultValue(value: string) {
    this.textContent = String(value)
  }
  get textLength(): number {
    return this.value.length
  }
}
for (const name of ['name', 'placeholder', 'autocomplete', 'wrap', 'dirName']) string(HTMLTextAreaElement.prototype, name, name.toLowerCase())
for (const name of ['disabled', 'required', 'readOnly']) bool(HTMLTextAreaElement.prototype, name, name.toLowerCase())
long(HTMLTextAreaElement.prototype, 'maxLength', -1, 'maxlength', 0)
long(HTMLTextAreaElement.prototype, 'minLength', -1, 'minlength', 0)
long(HTMLTextAreaElement.prototype, 'rows', 2, 'rows', 1)
long(HTMLTextAreaElement.prototype, 'cols', 20, 'cols', 1)
mixin(HTMLTextAreaElement, ConstraintValidation)
mixin(HTMLTextAreaElement, TextSelection)
tag(HTMLTextAreaElement)
export interface HTMLTextAreaElement extends ConstraintValidation, TextSelection {}

export class HTMLOptionsCollection extends HTMLCollection {
  select: HTMLSelectElement | null = null

  get selectedIndex(): number {
    return this.select ? this.select.selectedIndex : -1
  }
  set selectedIndex(value: number) {
    if (this.select) this.select.selectedIndex = value
  }

  add(element: Element, before?: Element | number | null): void {
    this.select?.add(element, before)
  }

  remove(index: number): void {
    this.select?.remove(index)
  }
}
tag(HTMLOptionsCollection)

const OPTIONS = Symbol('options')

function optionIds(select: number): Uint32Array {
  return dom.querySelectorAll(select, 'option')
}

export class HTMLSelectElement extends HTMLElement {
  get type(): string {
    return dom.hasAttribute(this[ID], 'multiple') ? 'select-multiple' : 'select-one'
  }

  get options(): HTMLOptionsCollection {
    const holder = this as unknown as { [OPTIONS]?: HTMLOptionsCollection }
    if (!holder[OPTIONS]) {
      const id = this[ID]
      const list = liveCollection(() => optionIds(id), HTMLOptionsCollection)
      list.select = this
      holder[OPTIONS] = list
    }
    return holder[OPTIONS]
  }

  get length(): number {
    return optionIds(this[ID]).length
  }

  item(index: number): Element | null {
    return wrap<Element>(optionIds(this[ID])[index] ?? NONE)
  }

  namedItem(name: string): Element | null {
    return this.options.namedItem(name)
  }

  get selectedIndex(): number {
    if (this.type === 'select-multiple') {
      const ids = optionIds(this[ID])
      for (let i = 0; i < ids.length; i++) if (wrap<HTMLOptionElement>(ids[i]!)!.selected) return i
      return -1
    }
    return dom.selectedIndex(this[ID])
  }
  set selectedIndex(value: number) {
    const index = Math.trunc(Number(value))
    if (this.type === 'select-multiple') {
      const ids = optionIds(this[ID])
      ids.forEach((id, i) => ((wrap<HTMLOptionElement>(id)! as unknown as { [SELECTED]: boolean })[SELECTED] = i === index))
    }
    dom.setSelectedIndex(this[ID], index >= 0 && index < this.length ? index : -1)
  }

  get value(): string {
    const index = this.selectedIndex
    if (index < 0) return ''
    return (this.item(index) as HTMLOptionElement | null)?.value ?? ''
  }
  set value(value: string) {
    const text = String(value)
    const ids = optionIds(this[ID])
    let found = -1
    for (let i = 0; i < ids.length; i++) {
      if (wrap<HTMLOptionElement>(ids[i]!)!.value === text) {
        found = i
        break
      }
    }
    this.selectedIndex = found
  }

  get selectedOptions(): HTMLCollection {
    const id = this[ID]
    return liveCollection(() => Uint32Array.from([...optionIds(id)].filter((o) => wrap<HTMLOptionElement>(o)!.selected)))
  }

  add(element: Element, before?: Element | number | null): void {
    const ref = typeof before === 'number' ? this.item(before) : (before ?? null)
    const parent = ref ? ref.parentNode! : this
    parent.insertBefore(element, ref)
  }

  override remove(index?: number): void {
    if (index === undefined) return super.remove()
    ;(this.item(index) as Element | null)?.remove()
  }

  showPicker(): void {}
}
for (const name of ['name', 'autocomplete']) string(HTMLSelectElement.prototype, name)
for (const name of ['disabled', 'required', 'multiple']) bool(HTMLSelectElement.prototype, name)
long(HTMLSelectElement.prototype, 'size', 0, 'size', 0)
mixin(HTMLSelectElement, ConstraintValidation)
tag(HTMLSelectElement)
export interface HTMLSelectElement extends ConstraintValidation {}

function ownerSelect(option: number): number {
  const parent = dom.parent(option)
  if (parent === NONE) return NONE
  if (dom.localName(parent) === 'select') return parent
  if (dom.localName(parent) === 'optgroup') {
    const grand = dom.parent(parent)
    return grand !== NONE && dom.localName(grand) === 'select' ? grand : NONE
  }
  return NONE
}

export class HTMLOptionElement extends HTMLElement {
  [SELECTED]: boolean | null = null

  get value(): string {
    return dom.getAttribute(this[ID], 'value') ?? this.text
  }
  set value(value: string) {
    setAttribute(this, 'value', String(value))
  }

  get text(): string {
    return dom.textContent(this[ID]).replace(/[\t\n\f\r ]+/g, ' ').trim()
  }
  set text(value: string) {
    this.textContent = String(value)
  }

  get label(): string {
    return dom.getAttribute(this[ID], 'label') ?? this.text
  }
  set label(value: string) {
    setAttribute(this, 'label', String(value))
  }

  get index(): number {
    const select = ownerSelect(this[ID])
    if (select === NONE) return 0
    return optionIds(select).indexOf(this[ID])
  }

  get selected(): boolean {
    const select = ownerSelect(this[ID])
    if (select === NONE || dom.hasAttribute(select, 'multiple')) return this[SELECTED] ?? dom.hasAttribute(this[ID], 'selected')
    return dom.selectedIndex(select) === optionIds(select).indexOf(this[ID])
  }
  set selected(value: boolean) {
    const select = ownerSelect(this[ID])
    if (select === NONE || dom.hasAttribute(select, 'multiple')) {
      this[SELECTED] = !!value
      return
    }
    const index = optionIds(select).indexOf(this[ID])
    if (value) dom.setSelectedIndex(select, index)
    else if (dom.selectedIndex(select) === index) dom.setSelectedIndex(select, -1)
  }

  get defaultSelected(): boolean {
    return dom.hasAttribute(this[ID], 'selected')
  }
  set defaultSelected(value: boolean) {
    setAttribute(this, 'selected', value ? '' : null)
  }

  get form(): HTMLFormElement | null {
    const select = ownerSelect(this[ID])
    return select === NONE ? null : formOwner(wrap<Element>(select)!)
  }
}
bool(HTMLOptionElement.prototype, 'disabled')
tag(HTMLOptionElement)

export class HTMLOptGroupElement extends HTMLElement {}
bool(HTMLOptGroupElement.prototype, 'disabled')
string(HTMLOptGroupElement.prototype, 'label')
tag(HTMLOptGroupElement)

export class HTMLButtonElement extends HTMLElement {
  get type(): string {
    const raw = dom.getAttribute(this[ID], 'type')?.toLowerCase()
    return raw === 'button' || raw === 'reset' ? raw : 'submit'
  }
  set type(value: string) {
    setAttribute(this, 'type', String(value))
  }

  [ACTIVATION](): { run(): void; cancel(): void } | null {
    if (disabledControl(this)) return null
    const type = this.type
    if (type === 'submit') return { run: () => this.form?.requestSubmit(this), cancel: () => {} }
    if (type === 'reset') return { run: () => this.form?.reset(), cancel: () => {} }
    return { run: () => {}, cancel: () => {} }
  }
}
for (const name of ['name', 'value', 'formAction', 'formEnctype', 'formMethod', 'formTarget', 'popoverTargetAction', 'command']) string(HTMLButtonElement.prototype, name, name.toLowerCase())
for (const name of ['disabled', 'formNoValidate']) bool(HTMLButtonElement.prototype, name, name.toLowerCase())
mixin(HTMLButtonElement, ConstraintValidation)
tag(HTMLButtonElement)
export interface HTMLButtonElement extends ConstraintValidation {}

const LISTED = 'button, fieldset, input, object, output, select, textarea'

export class RadioNodeList {
  readonly #nodes: Element[]
  constructor(nodes: Element[]) {
    this.#nodes = nodes
    nodes.forEach((n, i) => Object.defineProperty(this, i, { value: n, enumerable: true }))
  }
  get length(): number {
    return this.#nodes.length
  }
  item(index: number): Element | null {
    return this.#nodes[index] ?? null
  }
  get value(): string {
    const checked = this.#nodes.find((n) => n[LOCAL] === 'input' && (n as unknown as HTMLInputElement).type === 'radio' && (n as unknown as HTMLInputElement).checked)
    return checked ? (checked as unknown as HTMLInputElement).value : ''
  }
  set value(value: string) {
    const radio = this.#nodes.find((n) => n[LOCAL] === 'input' && (n as unknown as HTMLInputElement).type === 'radio' && (n as unknown as HTMLInputElement).value === String(value))
    if (radio) (radio as unknown as HTMLInputElement).checked = true
  }
  [Symbol.iterator](): IterableIterator<Element> {
    return this.#nodes[Symbol.iterator]()
  }
}
tag(RadioNodeList)

export class HTMLFormControlsCollection extends HTMLCollection {
  override namedItem(name: string): Element | null {
    const key = String(name)
    if (!key) return null
    const matches: Element[] = []
    const ids = this.ids()
    for (let i = 0; i < ids.length; i++) if (dom.id(ids[i]!) === key || dom.getAttribute(ids[i]!, 'name') === key) matches.push(wrap<Element>(ids[i]!)!)
    if (matches.length === 0) return null
    return matches.length === 1 ? matches[0]! : (new RadioNodeList(matches) as unknown as Element)
  }
}
tag(HTMLFormControlsCollection)

const ELEMENTS = Symbol('elements')

function formControls(form: number): Uint32Array {
  const inside = dom.querySelectorAll(form, LISTED)
  const own = dom.getAttribute(form, 'id')
  const result: number[] = []
  for (const id of inside) if (!dom.hasAttribute(id, 'form') || dom.getAttribute(id, 'form') === own) result.push(id)
  if (own) {
    for (const id of dom.querySelectorAll(documentId, `[form=${cssString(own)}]`)) if (!result.includes(id) && dom.matches(id, LISTED)) result.push(id)
    result.sort((a, b) => (a === b ? 0 : dom.compareDocumentPosition(a, b) & 4 ? -1 : 1))
  }
  return Uint32Array.from(result)
}

export class HTMLFormElement extends HTMLElement {
  get elements(): HTMLFormControlsCollection {
    const holder = this as unknown as { [ELEMENTS]?: HTMLFormControlsCollection }
    const id = this[ID]
    return (holder[ELEMENTS] ??= liveCollection(() => formControls(id), HTMLFormControlsCollection))
  }

  get length(): number {
    return formControls(this[ID]).length
  }

  item(index: number): Element | null {
    return this.elements.item(index)
  }

  namedItem(name: string): Element | null {
    return this.elements.namedItem(name)
  }

  get relList(): DOMTokenList {
    return tokenList(this, Symbol.for('acde.relList'), 'rel', ['noreferrer', 'noopener', 'opener'])
  }

  get action(): string {
    const raw = dom.getAttribute(this[ID], 'action')
    return raw === null || raw === '' ? resolveUrl('') : resolveUrl(raw)
  }
  set action(value: string) {
    setAttribute(this, 'action', String(value))
  }

  get method(): string {
    const raw = dom.getAttribute(this[ID], 'method')?.toLowerCase()
    return raw === 'post' || raw === 'dialog' ? raw : 'get'
  }
  set method(value: string) {
    setAttribute(this, 'method', String(value))
  }

  submit(): void {}

  requestSubmit(submitter?: Element | null): void {
    if (submitter && formOwner(submitter) !== this) throw new DOMException("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not owned by this form element.", 'NotFoundError')
    const noValidate = dom.hasAttribute(this[ID], 'novalidate') || (submitter ? dom.hasAttribute(submitter[ID], 'formnovalidate') : false)
    if (!noValidate && !this.reportValidity()) return
    const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter ?? null })
    if (!fire(this, event)) return
    if (this.method === 'dialog') {
      const dialog = dom.closest(this[ID], 'dialog')
      if (dialog !== NONE) (wrap<HTMLElement>(dialog) as unknown as { close(v?: string): void }).close(submitter ? ((submitter as unknown as { value?: string }).value ?? undefined) : undefined)
    }
  }

  reset(): void {
    if (!fire(this, new Event('reset', { bubbles: true, cancelable: true }))) return
    for (const id of formControls(this[ID])) {
      const control = wrap<Element>(id)!
      const local = control[LOCAL]
      if (local === 'input') {
        const input = control as unknown as HTMLInputElement
        dom.setValue(id, dom.getAttribute(id, 'value') ?? '')
        dom.setChecked(id, dom.hasAttribute(id, 'checked'))
        input.indeterminate = false
      } else if (local === 'textarea') dom.setValue(id, dom.textContent(id))
      else if (local === 'select') {
        const options = optionIds(id)
        let index = -1
        for (let i = 0; i < options.length; i++) if (dom.hasAttribute(options[i]!, 'selected')) index = i
        dom.setSelectedIndex(id, index < 0 && !dom.hasAttribute(id, 'multiple') && options.length ? 0 : index)
        options.forEach((o) => ((wrap<HTMLOptionElement>(o)! as unknown as { [SELECTED]: boolean | null })[SELECTED] = null))
      }
    }
  }

  checkValidity(): boolean {
    let valid = true
    for (const id of formControls(this[ID])) {
      const control = wrap<Element>(id)! as unknown as ConstraintValidation & Element
      if (typeof control.checkValidity === 'function' && !control.checkValidity.call(control)) valid = false
    }
    return valid
  }

  reportValidity(): boolean {
    return this.checkValidity()
  }
}
for (const name of ['name', 'target', 'acceptCharset', 'autocomplete', 'rel']) string(HTMLFormElement.prototype, name, name === 'acceptCharset' ? 'accept-charset' : name.toLowerCase())
for (const name of ['enctype', 'encoding']) string(HTMLFormElement.prototype, name, 'enctype')
bool(HTMLFormElement.prototype, 'noValidate', 'novalidate')
tag(HTMLFormElement)

const LABELABLE = 'button, input:not([type="hidden" i]), meter, output, progress, select, textarea'

export class HTMLLabelElement extends HTMLElement {
  get htmlFor(): string {
    return dom.getAttribute(this[ID], 'for') ?? ''
  }
  set htmlFor(value: string) {
    setAttribute(this, 'for', String(value))
  }

  get control(): HTMLElement | null {
    const target = dom.getAttribute(this[ID], 'for')
    if (target !== null) {
      const id = dom.getElementById(target)
      return id !== NONE && dom.matches(id, LABELABLE) && dom.ancestors(id).at(-1) === dom.ancestors(this[ID]).at(-1) ? wrap<HTMLElement>(id) : null
    }
    return wrap<HTMLElement>(dom.querySelector(this[ID], LABELABLE))
  }

  get form(): HTMLFormElement | null {
    const control = this.control
    return control ? formOwner(control) : null
  }

  [ACTIVATION](event: Event): { run(): void; cancel(): void } | null {
    const control = this.control
    const target = event.target as Node | null
    if (!control || (target && control.contains(target))) return null
    if (target && target !== this && (target as unknown as Element)[ID] !== undefined && dom.closest((target as unknown as Element)[ID], 'a[href], button, input, select, textarea, label') !== this[ID]) return null
    return {
      run: () => {
        if (focusable(control[ID])) setFocus(control)
        if (control[LOCAL] !== 'textarea' && !(control[LOCAL] === 'input' && SELECTABLE.has((control as unknown as HTMLInputElement).type))) control.click()
      },
      cancel: () => {},
    }
  }
}
tag(HTMLLabelElement)

export class HTMLFieldSetElement extends HTMLElement {
  get type(): string {
    return 'fieldset'
  }
  get elements(): HTMLCollection {
    const id = this[ID]
    return liveCollection(() => dom.querySelectorAll(id, LISTED), HTMLFormControlsCollection)
  }
}
bool(HTMLFieldSetElement.prototype, 'disabled')
string(HTMLFieldSetElement.prototype, 'name')
mixin(HTMLFieldSetElement, ConstraintValidation)
tag(HTMLFieldSetElement)

export class HTMLLegendElement extends HTMLElement {
  get form(): HTMLFormElement | null {
    const fieldset = dom.parent(this[ID])
    return fieldset !== NONE && dom.localName(fieldset) === 'fieldset' ? formOwner(wrap<Element>(fieldset)!) : null
  }
}
string(HTMLLegendElement.prototype, 'align')
tag(HTMLLegendElement)

export class HTMLOutputElement extends HTMLElement {
  #default: string | null = null
  get type(): string {
    return 'output'
  }
  get value(): string {
    return dom.textContent(this[ID])
  }
  set value(value: string) {
    this.#default ??= dom.textContent(this[ID])
    this.textContent = String(value)
  }
  get defaultValue(): string {
    return this.#default ?? dom.textContent(this[ID])
  }
  set defaultValue(value: string) {
    if (this.#default === null) this.textContent = String(value)
    else this.#default = String(value)
  }
  get htmlFor(): DOMTokenList {
    return tokenList(this, Symbol.for('acde.htmlFor'), 'for')
  }
}
string(HTMLOutputElement.prototype, 'name')
mixin(HTMLOutputElement, ConstraintValidation)
tag(HTMLOutputElement)

export class HTMLProgressElement extends HTMLElement {
  get value(): number {
    const v = parseFloat(dom.getAttribute(this[ID], 'value') ?? '')
    return Number.isFinite(v) && v > 0 ? Math.min(v, this.max) : 0
  }
  set value(value: number) {
    setAttribute(this, 'value', String(Number(value)))
  }
  get max(): number {
    const v = parseFloat(dom.getAttribute(this[ID], 'max') ?? '')
    return Number.isFinite(v) && v > 0 ? v : 1
  }
  set max(value: number) {
    setAttribute(this, 'max', String(Number(value)))
  }
  get position(): number {
    return dom.hasAttribute(this[ID], 'value') ? this.value / this.max : -1
  }
  get labels(): NodeList {
    return labelsOf(this)
  }
}
tag(HTMLProgressElement)

export class HTMLMeterElement extends HTMLElement {
  #num(name: string, fallback: number): number {
    const v = parseFloat(dom.getAttribute(this[ID], name) ?? '')
    return Number.isFinite(v) ? v : fallback
  }
  get min(): number {
    return this.#num('min', 0)
  }
  set min(v: number) {
    setAttribute(this, 'min', String(Number(v)))
  }
  get max(): number {
    return Math.max(this.min, this.#num('max', 1))
  }
  set max(v: number) {
    setAttribute(this, 'max', String(Number(v)))
  }
  get value(): number {
    return Math.min(Math.max(this.#num('value', 0), this.min), this.max)
  }
  set value(v: number) {
    setAttribute(this, 'value', String(Number(v)))
  }
  get low(): number {
    return Math.min(Math.max(this.#num('low', this.min), this.min), this.max)
  }
  set low(v: number) {
    setAttribute(this, 'low', String(Number(v)))
  }
  get high(): number {
    return Math.min(Math.max(this.#num('high', this.max), this.low), this.max)
  }
  set high(v: number) {
    setAttribute(this, 'high', String(Number(v)))
  }
  get optimum(): number {
    return Math.min(Math.max(this.#num('optimum', (this.min + this.max) / 2), this.min), this.max)
  }
  set optimum(v: number) {
    setAttribute(this, 'optimum', String(Number(v)))
  }
  get labels(): NodeList {
    return labelsOf(this)
  }
}
tag(HTMLMeterElement)

registerHtml(HTMLInputElement, 'input')
registerHtml(HTMLTextAreaElement, 'textarea')
registerHtml(HTMLSelectElement, 'select')
registerHtml(HTMLOptionElement, 'option')
registerHtml(HTMLOptGroupElement, 'optgroup')
registerHtml(HTMLButtonElement, 'button')
registerHtml(HTMLFormElement, 'form')
registerHtml(HTMLLabelElement, 'label')
registerHtml(HTMLFieldSetElement, 'fieldset')
registerHtml(HTMLLegendElement, 'legend')
registerHtml(HTMLOutputElement, 'output')
registerHtml(HTMLProgressElement, 'progress')
registerHtml(HTMLMeterElement, 'meter')

type Entry = [string, string | File]

export class FormData {
  #entries: Entry[] = []

  constructor(form?: HTMLFormElement, submitter?: Element | null) {
    if (form === undefined) return
    if (!(form instanceof HTMLFormElement)) throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.")
    for (const id of formControls(form[ID])) {
      const control = wrap<Element>(id)!
      if (disabledControl(control) || dom.closest(id, 'datalist') !== NONE) continue
      const name = dom.getAttribute(id, 'name')
      const local = control[LOCAL]
      if (local === 'button') {
        if (control === submitter && name) this.#entries.push([name, (control as unknown as { value: string }).value])
        continue
      }
      if (local === 'input') {
        const input = control as unknown as HTMLInputElement
        const type = input.type
        if ((type === 'submit' || type === 'image') && control !== submitter) continue
        if (type === 'reset' || type === 'button') continue
        if ((type === 'checkbox' || type === 'radio') && !input.checked) continue
        if (!name) continue
        if (type === 'file') {
          const files = filesOf(input)
          if (files.length === 0) this.#entries.push([name, new File([], '', { type: 'application/octet-stream' })])
          for (const file of files) this.#entries.push([name, file])
          continue
        }
        this.#entries.push([name, input.value])
      } else if (local === 'select') {
        if (!name) continue
        for (const option of optionIds(id)) {
          const o = wrap<HTMLOptionElement>(option)!
          if (o.selected && !dom.hasAttribute(option, 'disabled')) this.#entries.push([name, o.value])
        }
      } else if (local === 'textarea') {
        if (name) this.#entries.push([name, (control as unknown as HTMLTextAreaElement).value.replace(/\r?\n/g, '\r\n')])
      }
    }
  }

  static #value(value: unknown, filename?: string): string | File {
    if (value instanceof File) return filename === undefined ? value : new File([value], filename, { type: value.type, lastModified: value.lastModified })
    if (value !== null && typeof value === 'object' && 'arrayBuffer' in (value as object) && 'size' in (value as object)) return new File([value as never], filename ?? 'blob', { type: (value as { type?: string }).type })
    return String(value)
  }

  append(name: string, value: unknown, filename?: string): void {
    this.#entries.push([String(name), FormData.#value(value, filename)])
  }

  delete(name: string): void {
    const n = String(name)
    this.#entries = this.#entries.filter(([k]) => k !== n)
  }

  get(name: string): string | File | null {
    const n = String(name)
    return this.#entries.find(([k]) => k === n)?.[1] ?? null
  }

  getAll(name: string): (string | File)[] {
    const n = String(name)
    return this.#entries.filter(([k]) => k === n).map(([, v]) => v)
  }

  has(name: string): boolean {
    const n = String(name)
    return this.#entries.some(([k]) => k === n)
  }

  set(name: string, value: unknown, filename?: string): void {
    const n = String(name)
    const v = FormData.#value(value, filename)
    const at = this.#entries.findIndex(([k]) => k === n)
    if (at < 0) this.#entries.push([n, v])
    else {
      this.#entries[at] = [n, v]
      this.#entries = this.#entries.filter(([k], i) => k !== n || i === at)
    }
  }

  forEach(callback: (value: string | File, key: string, parent: FormData) => void, thisArg?: unknown): void {
    for (const [k, v] of this.#entries.slice()) callback.call(thisArg, v, k, this)
  }

  *entries(): IterableIterator<[string, string | File]> {
    for (const [k, v] of this.#entries) yield [k, v]
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.#entries) yield k
  }

  *values(): IterableIterator<string | File> {
    for (const [, v] of this.#entries) yield v
  }

  [Symbol.iterator](): IterableIterator<[string, string | File]> {
    return this.entries()
  }
}
tag(FormData)
