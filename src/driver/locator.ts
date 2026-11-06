import type { InspectAction, InspectNode, InspectWindow } from '@dopame/acde-api'
import { ActError, type Acde, type ActResult } from './acde.ts'
import { Poll } from './poll.ts'

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
}

export interface Timeout {
  readonly timeout?: number
}

export interface Tree {
  readonly window: InspectWindow | null
  readonly nodes: readonly InspectNode[]
}

export interface Scope {
  readonly acde: Acde
  tree(): Promise<Tree>
  describe(): string
}

type Query =
  | { readonly kind: 'role'; readonly role: string; readonly options: RoleOptions }
  | { readonly kind: 'text'; readonly text: TextMatch; readonly options: TextOptions }
  | { readonly kind: 'filter'; readonly options: FilterOptions }
  | { readonly kind: 'nth'; readonly index: number }

export interface Resolved {
  readonly window: InspectWindow | null
  readonly nodes: readonly InspectNode[]
}

const STATES = ['checked', 'disabled', 'selected', 'expanded', 'pressed', 'focused'] as const

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

  filter(options: FilterOptions): Locator {
    return new Locator(this.scope, [...this.#queries, { kind: 'filter', options }])
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
    return { window: tree.window, nodes: Locator.match(tree.nodes, this.#queries) }
  }

  async count(): Promise<number> {
    return (await this.resolve()).nodes.length
  }

  async isVisible(): Promise<boolean> {
    return (await this.count()) > 0
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
        last = await this.count()
        return (hidden ? last === 0 : last > 0) || null
      },
      () => `${this.describe()}: still ${hidden ? `${last} element${last === 1 ? '' : 's'}` : 'no element'} after ${this.#timeout(options.timeout)} ms`,
    )
  }

  click(options: Timeout & { readonly button?: 'left' | 'right'; readonly clickCount?: 1 | 2 } = {}): Promise<ActResult> {
    return this.#act(options.button === 'right' ? 'right' : options.clickCount === 2 ? 'double' : 'click', null, options.timeout, true)
  }

  dblclick(options: Timeout = {}): Promise<ActResult> {
    return this.#act('double', null, options.timeout, true)
  }

  hover(options: Timeout = {}): Promise<ActResult> {
    return this.#act('hover', null, options.timeout, false)
  }

  fill(text: string, options: Timeout = {}): Promise<ActResult> {
    return this.#act('settext', text, options.timeout, true)
  }

  type(text: string, options: Timeout = {}): Promise<ActResult> {
    return this.#act('type', text, options.timeout, true)
  }

  press(keys: string, options: Timeout = {}): Promise<ActResult> {
    return this.#act('key', keys, options.timeout, false)
  }

  focus(options: Timeout = {}): Promise<ActResult> {
    return this.#act('focus', null, options.timeout, false)
  }

  scroll(dy = 400, options: Timeout = {}): Promise<ActResult> {
    return this.#act('scroll', dy, options.timeout, false)
  }

  static match(nodes: readonly InspectNode[], queries: readonly Query[]): InspectNode[] {
    let set: InspectNode[] | null = null
    for (const query of queries) {
      if (query.kind === 'nth') {
        const pool: InspectNode[] = set ?? Locator.#flat(nodes)
        const picked = query.index < 0 ? pool[pool.length + query.index] : pool[query.index]
        set = picked ? [picked] : []
        continue
      }
      if (query.kind === 'filter') {
        set = (set ?? Locator.#flat(nodes)).filter((n) => Locator.#filter(n, query.options))
        continue
      }
      const hit = (n: InspectNode) => Locator.#hit(n, query)
      const within = set === null ? nodes : set.flatMap((n) => n.children ?? [])
      const found = new Set<string>()
      const walk = (list: readonly InspectNode[]): boolean => {
        let any = false
        for (const n of list) {
          const below = walk(n.children ?? [])
          if (hit(n) && !(query.kind === 'text' && below)) found.add(n.ref)
          any ||= below || hit(n)
        }
        return any
      }
      walk(within)
      set = Locator.#flat(nodes).filter((n) => found.has(n.ref))
    }
    return set ?? []
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

  static line(node: InspectNode): string {
    const value = node.value === undefined ? '' : `: ${JSON.stringify(node.value)}`
    return `${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${value}${(node.states ?? []).map((s) => ` [${s}]`).join('')} [${node.ref}]`
  }

  async #one(timeout: number | undefined, ready: (node: InspectNode) => string | null): Promise<{ node: InspectNode; window: InspectWindow }> {
    const ms = this.#timeout(timeout)
    let why = 'no element matches'
    return Poll.until(
      ms,
      async () => {
        const { window, nodes } = await this.resolve()
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
        return { node: nodes[0]!, window }
      },
      () => `${this.describe()}: ${why} (waited ${ms} ms)`,
    )
  }

  async #act(action: InspectAction, arg: string | number | null, timeout: number | undefined, enabled: boolean): Promise<ActResult> {
    const ms = this.#timeout(timeout)
    const deadline = Date.now() + ms
    for (;;) {
      const { node } = await this.#one(Math.max(0, deadline - Date.now()), (n) => (enabled && n.states?.includes('disabled') ? `${Locator.line(n)} is disabled` : null))
      const result = await this.scope.acde.act(node.ref, action, arg)
      if (result.ok) return result
      if (Date.now() >= deadline) throw new ActError(`${this.describe()}: ${action}`, result)
      await Bun.sleep(Poll.INTERVAL_MS)
    }
  }

  #timeout(timeout: number | undefined): number {
    return timeout ?? this.scope.acde.timeout
  }

  static #hit(n: InspectNode, query: Query): boolean {
    if (query.kind === 'text') return Locator.matches(n.name, query.text, query.options.exact)
    if (query.kind !== 'role' || n.role !== query.role) return false
    const o = query.options
    if (o.name !== undefined && !Locator.matches(n.name, o.name, o.exact)) return false
    if (o.level !== undefined && n.level !== o.level) return false
    return STATES.every((s) => o[s] === undefined || (n.states ?? []).includes(s) === o[s])
  }

  static #filter(n: InspectNode, options: FilterOptions): boolean {
    const texts = Locator.#texts(n)
    if (options.hasText !== undefined && !texts.some((t) => Locator.matches(t, options.hasText!))) return false
    if (options.hasNotText !== undefined && texts.some((t) => Locator.matches(t, options.hasNotText!))) return false
    return true
  }

  static #texts(n: InspectNode): string[] {
    return [n.name, n.value, ...(n.children ?? []).flatMap((c) => Locator.#texts(c))].filter((t): t is string => t !== undefined)
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
      case 'filter':
        return `filter(${options(q.options).slice(2)})`
      case 'nth':
        return `nth(${q.index})`
    }
  }
}
