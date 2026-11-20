import type { InspectAction, InspectArg, InspectMatch, InspectNode, InspectWindow } from '@acde/api'
import { ActError, type Acde, type ActResult, type Shot } from './acde.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { Modifiers, type Modifier } from './input.ts'
import { Poll } from './poll.ts'
import { Screenshots, type Capture, type ScreenshotOptions } from './screenshot.ts'

export type TextMatch = string | RegExp

export interface RoleOptions {
  readonly name?: TextMatch
  readonly exact?: boolean
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly selected?: boolean
  readonly expanded?: boolean
  readonly pressed?: boolean
  readonly focused?: boolean
  readonly level?: number
}

export interface TextOptions {
  readonly exact?: boolean
}

export interface FilterOptions {
  readonly hasText?: TextMatch
  readonly hasNotText?: TextMatch
  readonly has?: Locator
  readonly hasNot?: Locator
}

export interface Timeout {
  readonly timeout?: number
}

export interface Source {
  readonly nodes: readonly InspectNode[]
  children(node: InspectNode): Promise<readonly InspectNode[]>
  query(selector: string, within: InspectNode | null, attributes?: readonly string[]): Promise<readonly InspectMatch[]>
}

export interface Tree {
  readonly window: InspectWindow | null
  readonly source: Source
}

export interface Scope {
  readonly acde: Acde
  tree(): Promise<Tree>
  capture(): Promise<Capture>
  describe(): string
}

export type Query =
  | { readonly kind: 'role'; readonly role: string; readonly options: RoleOptions }
  | { readonly kind: 'text'; readonly text: TextMatch; readonly options: TextOptions }
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'label'; readonly text: TextMatch; readonly options: TextOptions }
  | { readonly kind: 'attr'; readonly name: 'placeholder' | 'title' | 'alt'; readonly text: TextMatch; readonly options: TextOptions }
  | { readonly kind: 'filter'; readonly options: FilterOptions }
  | { readonly kind: 'nth'; readonly index: number }
  | { readonly kind: 'or'; readonly alternatives: readonly (readonly Query[])[] }
  | { readonly kind: 'and'; readonly queries: readonly Query[] }

export interface Resolved {
  readonly window: InspectWindow | null
  readonly nodes: readonly InspectNode[]
  readonly source: Source
}

const STATES = ['checked', 'disabled', 'selected', 'expanded', 'pressed', 'focused'] as const
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitemcheckbox', 'menuitemradio'])
const ATTRIBUTE_TAGS: Readonly<Record<'placeholder' | 'title' | 'alt', string>> = { placeholder: '[placeholder]', title: '[title]', alt: 'img[alt], input[type="image" i][alt], area[alt]' }

export class Locator {
  readonly scope: Scope
  readonly #queries: readonly Query[]

  constructor(scope: Scope, queries: readonly Query[]) {
    this.scope = scope
    this.#queries = queries
  }

  getByRole(role: string, options: RoleOptions = {}): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'role', role, options }])
  }

  getByText(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'text', text, options }])
  }

  locator(selector: string): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'css', selector }])
  }

  getByTestId(id: string): Locator {
    return this.locator(Locator.testId(id))
  }

  getByLabel(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'label', text, options }])
  }

  getByPlaceholder(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'attr', name: 'placeholder', text, options }])
  }

  getByTitle(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'attr', name: 'title', text, options }])
  }

  getByAltText(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'attr', name: 'alt', text, options }])
  }

  filter(options: FilterOptions): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'filter', options }])
  }

  or(other: Locator): Locator {
    return new Locator(this.scope, [{ kind: 'or', alternatives: [this.#queries, other.#queries] }])
  }

  and(other: Locator): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'and', queries: other.#queries }])
  }

  get queries(): readonly Query[] {
    return this.#queries
  }

  nth(index: number): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'nth', index }])
  }

  first(): Locator {
    return this.nth(0)
  }

  last(): Locator {
    return this.nth(-1)
  }

  describe(): string {
    return `${this.scope.describe()}${this.#queries.map((q) => `.${Locator.#describe(q)}`).join('')}`
  }

  toString(): string {
    return this.describe()
  }

  async resolve(): Promise<Resolved> {
    const tree = await this.scope.tree()
    return { window: tree.window, nodes: tree.window === null ? [] : await Locator.match(tree.source, this.#queries), source: tree.source }
  }

  async text(options: Timeout = {}): Promise<string> {
    const { node, source } = await this.#one(options.timeout, () => null)
    return Locator.text(source, node)
  }

  async textContent(options: Timeout = {}): Promise<string> {
    const { node, source } = await this.#one(options.timeout, () => null)
    return Locator.content(source, node)
  }

  static async content(source: Source, node: InspectNode): Promise<string> {
    const parts: string[] = []
    const walk = async (n: InspectNode): Promise<void> => {
      const children = await source.children(n)
      if (children.length === 0) {
        if (n.name) parts.push(n.name)
        return
      }
      for (const child of children) await walk(child)
    }
    await walk(node)
    return Locator.normalize(parts.join(' '))
  }

  static async text(source: Source, node: InspectNode): Promise<string> {
    if (node.name) return node.name
    const parts: string[] = []
    const walk = (list: readonly InspectNode[]) => {
      for (const n of list) {
        if (n.name) parts.push(n.name)
        else walk(n.children ?? [])
      }
    }
    walk(await source.children(node))
    return Locator.normalize(parts.join(' '))
  }

  async count(): Promise<number> {
    return (await this.resolve()).nodes.length
  }

  async isVisible(): Promise<boolean> {
    return (await this.resolve()).nodes.some(Locator.visible)
  }

  static visible(node: InspectNode): boolean {
    return !('visible' in node) || (node as InspectMatch).visible
  }

  async all(): Promise<Locator[]> {
    return Array.from({ length: await this.count() }, (_, i) => this.nth(i))
  }

  async node(options: Timeout = {}): Promise<InspectNode> {
    return (await this.#one(options.timeout, () => null)).node
  }

  async ref(options: Timeout = {}): Promise<string> {
    return (await this.node(options)).ref
  }

  async name(options: Timeout = {}): Promise<string> {
    return (await this.node(options)).name ?? ''
  }

  async value(options: Timeout = {}): Promise<string | null> {
    return (await this.node(options)).value ?? null
  }

  async states(options: Timeout = {}): Promise<readonly string[]> {
    return (await this.node(options)).states ?? []
  }

  async waitFor(options: Timeout & { readonly state?: 'visible' | 'hidden' } = {}): Promise<void> {
    const hidden = options.state === 'hidden'
    let last = 0
    await Poll.until(
      this.#timeout(options.timeout),
      async () => {
        last = (await this.resolve()).nodes.filter(Locator.visible).length
        return (hidden ? last === 0 : last > 0) || null
      },
      () => `${this.describe()}: still ${hidden ? `${last} visible element${last === 1 ? '' : 's'}` : 'no visible element'} after ${this.#timeout(options.timeout)} ms`,
    )
  }

  click(options: Timeout & { readonly button?: 'left' | 'right'; readonly clickCount?: 1 | 2; readonly modifiers?: readonly Modifier[] } = {}): Promise<ActResult> {
    const action = options.button === 'right' ? 'right' : options.clickCount === 2 ? 'double' : 'click'
    return this.#step(`click(${Locator.#args({ button: options.button === 'right' ? 'right' : undefined, clickCount: options.clickCount === 2 ? 2 : undefined, modifiers: options.modifiers })})`, () =>
      this.#act(action, Modifiers.chord(options.modifiers), options.timeout, true),
    )
  }

  dblclick(options: Timeout & { readonly modifiers?: readonly Modifier[] } = {}): Promise<ActResult> {
    return this.#step(`dblclick(${Locator.#args({ modifiers: options.modifiers })})`, () => this.#act('double', Modifiers.chord(options.modifiers), options.timeout, true))
  }

  hover(options: Timeout & { readonly modifiers?: readonly Modifier[] } = {}): Promise<ActResult> {
    return this.#step(`hover(${Locator.#args({ modifiers: options.modifiers })})`, () => this.#act('hover', Modifiers.chord(options.modifiers), options.timeout, false))
  }

  static #args(options: Record<string, unknown>): string {
    const parts = Object.entries(options).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    return parts.length ? `{ ${parts.join(', ')} }` : ''
  }

  fill(text: string, options: Timeout = {}): Promise<ActResult> {
    return this.#step(`fill(${JSON.stringify(text)})`, () => this.#act('settext', text, options.timeout, true))
  }

  clear(options: Timeout = {}): Promise<ActResult> {
    return this.#step('clear()', () => this.#act('settext', '', options.timeout, true))
  }

  type(text: string, options: Timeout = {}): Promise<ActResult> {
    return this.#step(`type(${JSON.stringify(text)})`, () => this.#act('type', text, options.timeout, true))
  }

  press(keys: string, options: Timeout = {}): Promise<ActResult> {
    return this.#step(`press(${JSON.stringify(keys)})`, () => this.#act('key', keys, options.timeout, false))
  }

  focus(options: Timeout = {}): Promise<ActResult> {
    return this.#step('focus()', () => this.#act('focus', null, options.timeout, false))
  }

  scroll(dy = 400, options: Timeout = {}): Promise<ActResult> {
    return this.#step(`scroll(${dy})`, () => this.#act('scroll', dy, options.timeout, false))
  }

  selectOption(values: string | readonly string[], options: Timeout = {}): Promise<ActResult> {
    return this.#step(`selectOption(${JSON.stringify(values)})`, () => this.#act('select', typeof values === 'string' ? values : [...values], options.timeout, true))
  }

  check(options: Timeout = {}): Promise<void> {
    return this.#step('check()', () => this.#setChecked(true, options.timeout))
  }

  uncheck(options: Timeout = {}): Promise<void> {
    return this.#step('uncheck()', () => this.#setChecked(false, options.timeout))
  }

  setChecked(checked: boolean, options: Timeout = {}): Promise<void> {
    return this.#step(`setChecked(${checked})`, () => this.#setChecked(checked, options.timeout))
  }

  static screenPoint({ node, window }: { readonly node: InspectNode; readonly window: InspectWindow }): string {
    const [wx, wy] = window.rect
    const [x, y, w, h] = node.rect ?? [0, 0, 0, 0]
    return `${Math.round(wx + x + w / 2)},${Math.round(wy + y + h / 2)}`
  }

  dragTo(target: Locator, options: Timeout = {}): Promise<ActResult> {
    return this.#step(`dragTo(${target.describe()})`, async () => {
      const ms = this.#timeout(options.timeout)
      const deadline = Date.now() + ms
      for (;;) {
        const left = () => Math.max(0, deadline - Date.now())
        const onto = await target.#one(left(), () => null)
        const usable = (n: InspectNode) =>
          !Locator.visible(n) ? `${Locator.line(n)} is hidden` : n.states?.includes('disabled') ? `${Locator.line(n)} is disabled` : null
        const { node, window } = await this.#one(left(), usable)
        const to = this.scope.acde.guest && onto.window.id !== window.id ? Locator.screenPoint(onto) : onto.node.ref
        const result = await this.scope.acde.act(node.ref, 'drag', to)
        if (result.ok) return result
        if (Date.now() >= deadline) throw new ActError(`${this.describe()}: drag to ${target.describe()}`, result)
        await sleep(Poll.INTERVAL_MS)
      }
    })
  }

  async screenshot(options: ScreenshotOptions & Timeout = {}): Promise<Shot> {
    const { node } = await this.#one(options.timeout, () => null)
    const capture = await this.scope.capture()
    const image = await Screenshots.element(capture, node, options.mask ?? [])
    const png = Screenshots.save(image, options.path)
    return { png, width: image.width, height: image.height, path: options.path ?? null }
  }

  capture(): Promise<Capture> {
    return this.scope.capture()
  }

  async rects(): Promise<readonly (readonly [number, number, number, number])[]> {
    return (await this.resolve()).nodes.flatMap((n) => (n.rect && n.rect[2] > 0 && n.rect[3] > 0 ? [n.rect] : []))
  }

  async #setChecked(checked: boolean, timeout: number | undefined): Promise<void> {
    const ms = this.#timeout(timeout)
    const deadline = Date.now() + ms
    const { node } = await this.#one(ms, (n) => (!Locator.visible(n) ? `${Locator.line(n)} is hidden` : n.states?.includes('disabled') ? `${Locator.line(n)} is disabled` : null))
    if ((node.states ?? []).includes('checked') === checked) return
    await this.#act('click', null, Math.max(0, deadline - Date.now()), true)
    let now = false
    await Poll.until(
      Math.max(Poll.INTERVAL_MS, deadline - Date.now()),
      async () => {
        const nodes = (await this.resolve()).nodes
        now = nodes.length === 1 && (nodes[0]!.states ?? []).includes('checked')
        return now === checked || null
      },
      () => `${this.describe()}: still ${now ? 'checked' : 'not checked'} after a click (waited ${ms} ms)`,
    )
  }

  #step<T>(what: string, run: () => Promise<T>): Promise<T> {
    return this.scope.acde.trace.step(`${this.describe()}.${what}`, run, (value) => (typeof value === 'object' && value !== null && 'text' in value ? String((value as unknown as ActResult).text).split('\n')[0]! : ''))
  }

  static async match(source: Source, queries: readonly Query[]): Promise<InspectNode[]> {
    let set: InspectNode[] | null = null
    for (const query of queries) {
      switch (query.kind) {
        case 'nth': {
          const pool: InspectNode[] = set ?? Locator.#flat(source.nodes)
          const picked = query.index < 0 ? pool[pool.length + query.index] : pool[query.index]
          set = picked ? [picked] : []
          break
        }
        case 'filter': {
          const pool: InspectNode[] = set ?? Locator.#flat(source.nodes)
          const kept: InspectNode[] = []
          const { has, hasNot } = query.options
          for (const n of pool) {
            if (!Locator.#filter(await Locator.#texts(source, n), query.options)) continue
            const inside = has || hasNot ? await Locator.#within(source, n) : null
            if (has && !(await Locator.match(inside!, has.queries)).length) continue
            if (hasNot && (await Locator.match(inside!, hasNot.queries)).length) continue
            kept.push(n)
          }
          set = kept
          break
        }
        case 'or': {
          const found: InspectNode[] = []
          for (const alternative of query.alternatives) found.push(...(await Locator.match(source, alternative)))
          const order = new Map(Locator.#flat(source.nodes).map((n, i) => [n.ref, i]))
          set = Locator.#unique(found).sort((a, b) => (order.get(a.ref) ?? Infinity) - (order.get(b.ref) ?? Infinity))
          break
        }
        case 'and': {
          const both = new Set((await Locator.match(source, query.queries)).map((n) => n.ref))
          set = (set ?? Locator.#flat(source.nodes)).filter((n) => both.has(n.ref))
          break
        }
        case 'css': {
          const found = set === null ? [...(await source.query(query.selector, null))] : (await Promise.all(set.map((n) => source.query(query.selector, n)))).flat()
          set = Locator.#unique(found)
          break
        }
        case 'attr': {
          const selector = ATTRIBUTE_TAGS[query.name]
          const found = set === null ? [...(await source.query(selector, null, [query.name]))] : (await Promise.all(set.map((n) => source.query(selector, n, [query.name])))).flat()
          set = Locator.#unique(found.filter((n) => Locator.matches(n.attributes?.[query.name] ?? undefined, query.text, query.options.exact)))
          break
        }
        default: {
          const roots = set === null ? [source.nodes] : await Promise.all(set.map((n) => source.children(n)))
          set = Locator.#unique(roots.flatMap((list) => Locator.#search(list, query)))
        }
      }
    }
    return set ?? []
  }

  static async #within(source: Source, node: InspectNode): Promise<Source> {
    return {
      nodes: await source.children(node),
      children: (n) => source.children(n),
      query: (selector, within, attributes) => source.query(selector, within ?? node, attributes),
    }
  }

  async evaluate<T = unknown, A = unknown>(fn: string | ((element: any, arg: A) => T | Promise<T>), arg?: A, options: Timeout = {}): Promise<Awaited<T>> {
    return this.#step('evaluate()', async () => {
      const { node, window } = await this.#one(options.timeout, () => null)
      const id = Number(node.ref.split('.')[1])
      if (!Number.isInteger(id)) throw new Error(`${this.describe()}: ${node.ref} is not an element of a page`)
      const web = (await this.scope.acde.webOf(window.id)).name
      return this.scope.acde.evaluateOn<Awaited<T>>(web, id, typeof fn === 'string' ? fn : fn.toString(), arg ?? null)
    })
  }

  static testId(id: string): string {
    return `[data-testid="${id.replace(/["\\]/g, (c) => `\\${c}`)}"]`
  }

  static #search(list: readonly InspectNode[], query: Query): InspectNode[] {
    const out: InspectNode[] = []
    const walk = (nodes: readonly InspectNode[]): boolean => {
      let any = false
      for (const n of nodes) {
        const at = out.length
        const below = walk(n.children ?? [])
        const hit = Locator.#hit(n, query)
        if (hit && !(query.kind === 'text' && below)) out.splice(at, 0, n)
        any ||= below || hit
      }
      return any
    }
    walk(list)
    return out
  }

  static #unique(nodes: readonly InspectNode[]): InspectNode[] {
    const seen = new Set<string>()
    return nodes.filter((n) => !seen.has(n.ref) && !!seen.add(n.ref))
  }

  static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  static matches(actual: string | undefined, expected: TextMatch, exact = false): boolean {
    if (actual === undefined) return false
    if (expected instanceof RegExp) return expected.test(actual)
    const a = Locator.normalize(actual)
    const e = Locator.normalize(expected)
    return exact ? a === e : a.toLowerCase().includes(e.toLowerCase())
  }

  static line(node: InspectNode, hidden = true): string {
    const value = node.value === undefined ? '' : `: ${JSON.stringify(node.value)}`
    const level = node.level ? ` [level=${node.level}]` : ''
    const states = (node.states ?? []).map((s) => ` [${s}]`).join('')
    const mark = hidden && !Locator.visible(node) ? ' [hidden]' : ''
    return `${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${value}${level}${states}${mark} [${node.ref}]`
  }

  async #one(timeout: number | undefined, ready: (node: InspectNode) => string | null): Promise<{ node: InspectNode; window: InspectWindow; source: Source }> {
    const ms = this.#timeout(timeout)
    let why = 'no element matches'
    return Poll.until(
      ms,
      async () => {
        const { window, nodes, source } = await this.resolve()
        if (window === null) {
          why = `${this.scope.describe()} is not open`
          return null
        }
        if (nodes.length === 0) {
          why = 'no element matches'
          return null
        }
        if (nodes.length > 1) {
          why = `${nodes.length} elements match (pick one with .nth(i), .first() or a narrower query):\n${nodes.slice(0, 10).map((n) => `  - ${Locator.line(n)}`).join('\n')}`
          return null
        }
        const not = ready(nodes[0]!)
        if (not !== null) {
          why = not
          return null
        }
        return { node: nodes[0]!, window, source }
      },
      () => `${this.describe()}: ${why} (waited ${ms} ms)`,
    )
  }

  async #act(action: InspectAction, arg: InspectArg, timeout: number | undefined, enabled: boolean): Promise<ActResult> {
    const ms = this.#timeout(timeout)
    const deadline = Date.now() + ms
    for (;;) {
      const { node } = await this.#one(Math.max(0, deadline - Date.now()), (n) => (!Locator.visible(n) ? `${Locator.line(n)} is hidden` : enabled && n.states?.includes('disabled') ? `${Locator.line(n)} is disabled` : null))
      const result = await this.scope.acde.act(node.ref, action, arg)
      if (result.ok) return result
      if (Date.now() >= deadline) throw new ActError(`${this.describe()}: ${action}`, result)
      await sleep(Poll.INTERVAL_MS)
    }
  }

  #timeout(timeout: number | undefined): number {
    return timeout ?? this.scope.acde.timeout
  }

  static #hit(n: InspectNode, query: Query): boolean {
    if (query.kind === 'text') return Locator.matches(n.name, query.text, query.options.exact)
    if (query.kind === 'label') return FIELDS.has(n.role) && Locator.matches(n.name, query.text, query.options.exact)
    if (query.kind !== 'role' || n.role !== query.role) return false
    const o = query.options
    if (o.name !== undefined && !Locator.matches(n.name, o.name, o.exact)) return false
    if (o.level !== undefined && n.level !== o.level) return false
    return STATES.every((s) => o[s] === undefined || (n.states ?? []).includes(s) === o[s])
  }

  static #filter(texts: readonly string[], options: FilterOptions): boolean {
    if (options.hasText !== undefined && !texts.some((t) => Locator.matches(t, options.hasText!))) return false
    if (options.hasNotText !== undefined && texts.some((t) => Locator.matches(t, options.hasNotText!))) return false
    return true
  }

  static async #texts(source: Source, n: InspectNode): Promise<string[]> {
    const all = (list: readonly InspectNode[]): string[] => list.flatMap((c) => [c.name, c.value, ...all(c.children ?? [])]).filter((t): t is string => t !== undefined)
    return [n.name, n.value, ...all(await source.children(n))].filter((t): t is string => t !== undefined)
  }

  static #flat(nodes: readonly InspectNode[]): InspectNode[] {
    const out: InspectNode[] = []
    const walk = (list: readonly InspectNode[]) => {
      for (const n of list) {
        out.push(n)
        walk(n.children ?? [])
      }
    }
    walk(nodes)
    return out
  }

  static #describe(q: Query): string {
    const text = (t: TextMatch) => (t instanceof RegExp ? String(t) : JSON.stringify(t))
    const options = (o: object) => {
      const parts = Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v instanceof RegExp ? String(v) : JSON.stringify(v)}`)
      return parts.length ? `, { ${parts.join(', ')} }` : ''
    }
    switch (q.kind) {
      case 'role':
        return `getByRole(${JSON.stringify(q.role)}${options(q.options)})`
      case 'text':
        return `getByText(${text(q.text)}${options(q.options)})`
      case 'css':
        return `locator(${JSON.stringify(q.selector)})`
      case 'label':
        return `getByLabel(${text(q.text)}${options(q.options)})`
      case 'attr':
        return `${{ placeholder: 'getByPlaceholder', title: 'getByTitle', alt: 'getByAltText' }[q.name]}(${text(q.text)}${options(q.options)})`
      case 'filter': {
        const { has, hasNot, ...text } = q.options
        const plain = options(text)
        const parts = [plain && plain.slice(4, -2), has && `has: ${has.describe()}`, hasNot && `hasNot: ${hasNot.describe()}`].filter(Boolean)
        return `filter({ ${parts.join(', ')} })`
      }
      case 'nth':
        return `nth(${q.index})`
      case 'or':
        return `or(${q.alternatives.map((a) => a.map((x) => Locator.#describe(x)).join('.')).join(' | ')})`
      case 'and':
        return `and(${q.queries.map((x) => Locator.#describe(x)).join('.')})`
    }
  }
}
