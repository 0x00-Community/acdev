import { DOMException } from '../core/exception'
import { tag } from '../core/host'
import { setAttribute, type Element } from './element'
import { computedStyleOf } from './layout'
import { changed, dom, guard, ID, version } from './realm'

type Declarations = Map<string, { value: string; important: boolean }>

const INLINE = Symbol('inlineStyle')

const propertyNames = new Map<string, string>()

export function propertyName(key: string): string {
  let name = propertyNames.get(key)
  if (name !== undefined) return name
  if (key.startsWith('--')) name = key
  else if (key === 'cssFloat') name = 'float'
  else if (key.includes('-')) name = key.toLowerCase()
  else {
    const dashed = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    name = /^(webkit|moz|ms|o)-/.test(dashed) ? `-${dashed}` : dashed
  }
  if (propertyNames.size > 4096) propertyNames.clear()
  propertyNames.set(key, name)
  return name
}

function parseDeclarations(text: string): Declarations {
  const declarations: Declarations = new Map()
  let depth = 0, quote = '', start = 0
  const take = (end: number) => {
    const part = text.slice(start, end)
    start = end + 1
    const colon = part.indexOf(':')
    if (colon < 0) return
    const name = part.slice(0, colon).trim()
    let value = part.slice(colon + 1).trim()
    const important = /!\s*important$/i.test(value)
    if (important) value = value.replace(/!\s*important$/i, '').trim()
    if (name && value) {
      const key = name.startsWith('--') ? name : name.toLowerCase()
      declarations.delete(key)
      declarations.set(key, { value, important })
    }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) take(i)
  }
  take(text.length)
  return declarations
}

const handler: ProxyHandler<CSSStyleDeclaration> = {
  get(target, key) {
    if (typeof key === 'symbol' || key in target) return Reflect.get(target, key)
    if (/^\d+$/.test(key)) return target.item(Number(key))
    return target.getPropertyValue(propertyName(key))
  },
  set(target, key, value) {
    if (typeof key === 'symbol' || key in target) return Reflect.set(target, key, value)
    target.setProperty(propertyName(key), value === null || value === undefined ? '' : String(value))
    return true
  },
}

export class CSSStyleDeclaration {
  readonly _element: Element | null
  readonly _pseudo: string
  readonly _computed: boolean
  _text: string | null = null
  _textVersion = -1
  _parsed: Declarations = new Map()
  _names: string[] | null = null
  _namesVersion = -1

  constructor(element: Element | null = null, computed = false, pseudo = '') {
    this._element = element
    this._computed = computed
    this._pseudo = pseudo
  }

  _declarations(): Declarations {
    if (!this._element || this._textVersion === version) return this._parsed
    const text = dom.getAttribute(this._element[ID], 'style')
    this._textVersion = version
    if (text === this._text) return this._parsed
    this._text = text
    this._parsed = parseDeclarations(text ?? '')
    return this._parsed
  }

  _write(declarations: Declarations): void {
    const text = [...declarations].map(([name, { value, important }]) => `${name}: ${value}${important ? ' !important' : ''};`).join(' ')
    if (!this._element) {
      this._parsed = declarations
      return
    }
    if (text === (this._text ?? '')) return
    this._text = text === '' ? null : text
    this._parsed = declarations
    setAttribute(this._element, 'style', this._text)
    this._textVersion = version
  }

  _readonly(): void {
    if (this._computed) throw new DOMException("Failed to execute 'setProperty' on 'CSSStyleDeclaration': These styles are computed, and therefore read-only.", 'NoModificationAllowedError')
  }

  get cssText(): string {
    if (this._computed) return ''
    return this._element ? (dom.getAttribute(this._element[ID], 'style') ?? '') : [...this._parsed].map(([n, { value, important }]) => `${n}: ${value}${important ? ' !important' : ''};`).join(' ')
  }
  set cssText(text: string) {
    this._readonly()
    if (this._element) setAttribute(this._element, 'style', String(text))
    else this._parsed = parseDeclarations(String(text))
  }

  get length(): number {
    return this._nameList().length
  }

  _nameList(): string[] {
    if (!this._computed) return [...this._declarations().keys()]
    if (this._namesVersion !== version || !this._names) {
      const all = dom.computedStyleAll(this._element![ID], this._pseudo)
      const names: string[] = []
      for (let i = 0; i < all.length; i += 2) names.push(all[i]!)
      this._names = names
      this._namesVersion = version
    }
    return this._names
  }

  item(index: number): string {
    return this._nameList()[index] ?? ''
  }

  getPropertyValue(name: string): string {
    const key = String(name)
    if (this._computed) return computedStyleOf(this._element![ID], this._pseudo, key.startsWith('--') ? key : key.toLowerCase())
    return this._declarations().get(key.startsWith('--') ? key : key.toLowerCase())?.value ?? ''
  }

  getPropertyPriority(name: string): string {
    if (this._computed) return ''
    const key = String(name)
    return this._declarations().get(key.startsWith('--') ? key : key.toLowerCase())?.important ? 'important' : ''
  }

  setProperty(name: string, value: string | null, priority = ''): void {
    this._readonly()
    const raw = String(name)
    const key = raw.startsWith('--') ? raw : raw.toLowerCase()
    const declarations = new Map(this._declarations())
    const text = value === null || value === undefined ? '' : String(value).trim()
    if (text === '') declarations.delete(key)
    else {
      const important = String(priority).toLowerCase() === 'important'
      if (priority && !important) return
      const old = declarations.get(key)
      if (old && old.value === text && old.important === important) return
      declarations.set(key, { value: text, important })
    }
    this._write(declarations)
  }

  removeProperty(name: string): string {
    this._readonly()
    const old = this.getPropertyValue(name)
    this.setProperty(name, '')
    return old
  }

  get cssFloat(): string {
    return this.getPropertyValue('float')
  }
  set cssFloat(value: string) {
    this.setProperty('float', value)
  }

  get parentRule(): null {
    return null
  }

  *[Symbol.iterator](): IterableIterator<string> {
    yield* this._nameList()
  }
}
tag(CSSStyleDeclaration)

export function inlineStyle(element: Element): CSSStyleDeclaration {
  const holder = element as unknown as { [INLINE]?: CSSStyleDeclaration }
  return (holder[INLINE] ??= new Proxy(new CSSStyleDeclaration(element), handler))
}

export function computedStyle(element: Element, pseudo: string): CSSStyleDeclaration {
  return new Proxy(new CSSStyleDeclaration(element, true, pseudo), handler)
}

function freeStyle(text: string): CSSStyleDeclaration {
  const style = new CSSStyleDeclaration(null)
  style._parsed = parseDeclarations(text)
  return new Proxy(style, handler)
}

export class CSSRule {
  static readonly STYLE_RULE = 1
  static readonly IMPORT_RULE = 3
  static readonly MEDIA_RULE = 4
  static readonly FONT_FACE_RULE = 5
  static readonly KEYFRAMES_RULE = 7
  constructor(
    readonly cssText: string,
    readonly parentStyleSheet: CSSStyleSheet | null,
  ) {}
  get type(): number {
    const text = this.cssText.trimStart()
    if (text.startsWith('@media')) return 4
    if (text.startsWith('@font-face')) return 5
    if (text.startsWith('@keyframes')) return 7
    if (text.startsWith('@import')) return 3
    return text.startsWith('@') ? 0 : 1
  }
  get selectorText(): string {
    return this.type === 1 ? this.cssText.slice(0, this.cssText.indexOf('{')).trim() : ''
  }
  get style(): CSSStyleDeclaration {
    const open = this.cssText.indexOf('{')
    return freeStyle(open < 0 ? '' : this.cssText.slice(open + 1, this.cssText.lastIndexOf('}')))
  }
}
tag(CSSRule)
export class CSSStyleRule extends CSSRule {}
tag(CSSStyleRule)

function splitRules(text: string): string[] {
  const rules: string[] = []
  let depth = 0, start = 0, quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        rules.push(text.slice(start, i + 1).trim())
        start = i + 1
      }
    } else if (c === ';' && depth === 0) {
      const rule = text.slice(start, i + 1).trim()
      if (rule) rules.push(rule)
      start = i + 1
    }
  }
  return rules.filter(Boolean)
}

const SHEET = Symbol('sheet')

export class CSSRuleList {
  readonly [SHEET]: CSSStyleSheet

  constructor(sheet: CSSStyleSheet) {
    this[SHEET] = sheet
  }

  get length(): number {
    return this[SHEET]._ruleCount()
  }

  item(index: number): CSSRule | null {
    const i = Number(index) >>> 0
    return i < this[SHEET]._ruleCount() ? this[SHEET]._rule(i) : null
  }

  *[Symbol.iterator](): IterableIterator<CSSRule> {
    const n = this.length
    for (let i = 0; i < n; i++) yield this[SHEET]._rule(i)
  }
}
tag(CSSRuleList)

const ruleIndex: ProxyHandler<CSSRuleList> = {
  get(target, key) {
    if (typeof key === 'string' && key.length > 0 && key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57 && String(Number(key)) === key) return target.item(Number(key)) ?? undefined
    return Reflect.get(target, key)
  },
  has(target, key) {
    if (typeof key === 'string' && key.length > 0 && key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57 && String(Number(key)) === key) return Number(key) < target.length
    return Reflect.has(target, key)
  },
}

function ruleOf(text: string, sheet: CSSStyleSheet): CSSRule {
  return text.startsWith('@') ? new CSSRule(text, sheet) : new CSSStyleRule(text, sheet)
}

export class CSSStyleSheet {
  #rules: string[] = []
  readonly #owner: Element | null
  #list: CSSRuleList | null = null
  disabled = false

  constructor(options?: { media?: string; disabled?: boolean }, owner: Element | null = null) {
    this.#owner = owner
    this.disabled = !!options?.disabled
  }

  get ownerNode(): Element | null {
    return this.#owner
  }
  get type(): string {
    return 'text/css'
  }
  get href(): string | null {
    return null
  }
  get title(): string | null {
    return null
  }
  get media(): { mediaText: string; length: number } {
    return { mediaText: '', length: 0 }
  }
  get parentStyleSheet(): null {
    return null
  }
  get ownerRule(): null {
    return null
  }

  #native(): number {
    return this.#owner ? dom.sheetRuleCount(this.#owner[ID]) : -1
  }

  #text(): string[] {
    if (this.#owner) this.#rules = splitRules(dom.textContent(this.#owner[ID]))
    return this.#rules
  }

  _ruleCount(): number {
    const n = this.#native()
    return n >= 0 ? n : this.#text().length
  }

  _rule(index: number): CSSRule {
    const text = this.#native() >= 0 ? dom.sheetRule(this.#owner![ID], index) : (this.#text()[index] ?? '')
    return ruleOf(text, this)
  }

  get cssRules(): CSSRuleList {
    return (this.#list ??= new Proxy(new CSSRuleList(this), ruleIndex))
  }

  get rules(): CSSRuleList {
    return this.cssRules
  }

  insertRule(rule: string, index = 0): number {
    const text = String(rule)
    const at = Number(index) >>> 0
    if (this.#native() >= 0) {
      const inserted = guard(() => dom.sheetInsertRule(this.#owner![ID], text, at))
      changed()
      return inserted
    }
    const rules = this.#text()
    const trimmed = text.trim()
    if (!trimmed || splitRules(trimmed).length !== 1) throw new DOMException(`Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '${rule}'.`, 'SyntaxError')
    if (at > rules.length) throw new DOMException(`Failed to execute 'insertRule' on 'CSSStyleSheet': The index provided (${index}) is larger than the maximum index (${rules.length}).`, 'IndexSizeError')
    rules.splice(at, 0, trimmed)
    this.#flush()
    return at
  }

  addRule(selector: string, style: string, index?: number): number {
    this.insertRule(`${selector} { ${style} }`, index ?? this._ruleCount())
    return -1
  }

  deleteRule(index: number): void {
    const at = Number(index) >>> 0
    if (this.#native() >= 0) {
      guard(() => dom.sheetDeleteRule(this.#owner![ID], at))
      changed()
      return
    }
    const rules = this.#text()
    if (at >= rules.length) throw new DOMException(`Failed to execute 'deleteRule' on 'CSSStyleSheet': The index provided (${index}) is larger than the maximum index (${rules.length - 1}).`, 'IndexSizeError')
    rules.splice(at, 1)
    this.#flush()
  }

  removeRule(index = 0): void {
    this.deleteRule(index)
  }

  replaceSync(text: string): void {
    this.#rules = splitRules(String(text))
    this.#flush()
  }

  async replace(text: string): Promise<CSSStyleSheet> {
    this.replaceSync(text)
    return this
  }

  #flush(): void {
    if (this.#owner) (this.#owner as unknown as { textContent: string }).textContent = this.#rules.join('\n')
  }
}
tag(CSSStyleSheet)

export class StyleSheetList {
  readonly #sheets: CSSStyleSheet[]
  constructor(sheets: CSSStyleSheet[]) {
    this.#sheets = sheets
    for (let i = 0; i < sheets.length; i++) Object.defineProperty(this, i, { value: sheets[i], enumerable: true })
  }
  get length(): number {
    return this.#sheets.length
  }
  item(index: number): CSSStyleSheet | null {
    return this.#sheets[index] ?? null
  }
  [Symbol.iterator](): IterableIterator<CSSStyleSheet> {
    return this.#sheets[Symbol.iterator]()
  }
}
tag(StyleSheetList)

export const CSS = {
  escape(value: string): string {
    const text = String(value)
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c === 0) out += '�'
      else if ((c >= 1 && c <= 31) || c === 127 || (i === 0 && c >= 48 && c <= 57) || (i === 1 && c >= 48 && c <= 57 && text.charCodeAt(0) === 45)) out += `\\${c.toString(16)} `
      else if (i === 0 && c === 45 && text.length === 1) out += `\\${text[i]}`
      else if (c >= 128 || c === 45 || c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += text[i]
      else out += `\\${text[i]}`
    }
    return out
  },
  supports(property: string, value?: string): boolean {
    void property
    void value
    return true
  },
}
