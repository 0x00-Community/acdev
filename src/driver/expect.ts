import type { InspectNode } from '@dopame/acde-api'
import { Locator, type Source, type TextMatch, type Timeout } from './locator.ts'
import { Poll } from './poll.ts'
import type { AppWindow } from './window.ts'

interface Check {
  readonly pass: boolean | null
  readonly saw: string
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

export class LocatorAssertions {
  readonly #locator: Locator
  readonly #negated: boolean

  constructor(locator: Locator, negated = false) {
    this.#locator = locator
    this.#negated = negated
  }

  get not(): LocatorAssertions {
    return new LocatorAssertions(this.#locator, !this.#negated)
  }

  toBeVisible(options: Timeout = {}): Promise<void> {
    return this.#nodes('be visible', options, (nodes) => ({ pass: nodes.length > 0, saw: LocatorAssertions.#count(nodes) }))
  }

  toBeHidden(options: Timeout = {}): Promise<void> {
    return this.#nodes('be hidden', options, (nodes) => ({ pass: nodes.length === 0, saw: LocatorAssertions.#count(nodes) }))
  }

  toHaveCount(count: number, options: Timeout = {}): Promise<void> {
    return this.#nodes(`have ${count} element${count === 1 ? '' : 's'}`, options, (nodes) => ({ pass: nodes.length === count, saw: LocatorAssertions.#count(nodes) }))
  }

  toHaveText(expected: TextMatch, options: Timeout & { readonly exact?: boolean } = {}): Promise<void> {
    return this.#one(`have text ${LocatorAssertions.#text(expected)}`, options, async (n, source) => {
      const text = await Locator.text(source, n)
      return { pass: Locator.matches(text, expected, options.exact ?? typeof expected === 'string'), saw: `text ${JSON.stringify(text)}` }
    })
  }

  toContainText(expected: TextMatch, options: Timeout = {}): Promise<void> {
    return this.#one(`contain text ${LocatorAssertions.#text(expected)}`, options, async (n, source) => {
      const text = await Locator.text(source, n)
      return { pass: Locator.matches(text, expected), saw: `text ${JSON.stringify(text)}` }
    })
  }

  toHaveValue(expected: TextMatch, options: Timeout = {}): Promise<void> {
    return this.#one(`have value ${LocatorAssertions.#text(expected)}`, options, (n) => ({ pass: Locator.matches(n.value ?? '', expected, typeof expected === 'string'), saw: `value ${JSON.stringify(n.value ?? null)}` }))
  }

  toHaveState(state: string, options: Timeout = {}): Promise<void> {
    return this.#one(`be ${state}`, options, (n) => ({ pass: (n.states ?? []).includes(state), saw: `states [${(n.states ?? []).join(', ')}]` }))
  }

  toBeChecked(options: Timeout = {}): Promise<void> {
    return this.toHaveState('checked', options)
  }

  toBeDisabled(options: Timeout = {}): Promise<void> {
    return this.toHaveState('disabled', options)
  }

  toBeEnabled(options: Timeout = {}): Promise<void> {
    return this.not.toHaveState('disabled', options)
  }

  toBeFocused(options: Timeout = {}): Promise<void> {
    return this.toHaveState('focused', options)
  }

  #nodes(what: string, options: Timeout, check: (nodes: readonly InspectNode[], source: Source) => Check | Promise<Check>): Promise<void> {
    return LocatorAssertions.poll(`${this.#locator.describe()} to ${this.#negated ? 'not ' : ''}${what}`, this.#timeout(options), this.#negated, async () => {
      const { nodes, source } = await this.#locator.resolve()
      return check(nodes, source)
    })
  }

  #one(what: string, options: Timeout, check: (node: InspectNode, source: Source) => Check | Promise<Check>): Promise<void> {
    return this.#nodes(what, options, (nodes, source) => {
      if (nodes.length === 1) return check(nodes[0]!, source)
      return { pass: null, saw: nodes.length === 0 ? 'no element' : `${nodes.length} elements:\n${nodes.slice(0, 10).map((n) => `  - ${Locator.line(n)}`).join('\n')}` }
    })
  }

  #timeout(options: Timeout): number {
    return options.timeout ?? this.#locator.scope.acde.timeout
  }

  static async poll(what: string, timeout: number, negated: boolean, attempt: () => Promise<Check>): Promise<void> {
    let saw = ''
    await Poll.until(
      timeout,
      async () => {
        const check = await attempt()
        saw = check.saw
        return check.pass === null ? null : check.pass !== negated || null
      },
      () => new AssertionError(`expected ${what} within ${timeout} ms; saw ${saw}`),
    )
  }

  static #count(nodes: readonly InspectNode[]): string {
    if (nodes.length === 0) return 'no element'
    return `${nodes.length} element${nodes.length === 1 ? '' : 's'}: ${nodes.slice(0, 5).map((n) => Locator.line(n)).join('; ')}`
  }

  static #text(t: TextMatch): string {
    return t instanceof RegExp ? String(t) : JSON.stringify(t)
  }
}

export class WindowAssertions {
  readonly #window: AppWindow
  readonly #negated: boolean

  constructor(window: AppWindow, negated = false) {
    this.#window = window
    this.#negated = negated
  }

  get not(): WindowAssertions {
    return new WindowAssertions(this.#window, !this.#negated)
  }

  toBeOpen(options: Timeout = {}): Promise<void> {
    return LocatorAssertions.poll(`${this.#window.describe()} to ${this.#negated ? 'not ' : ''}be open`, options.timeout ?? this.#window.acde.timeout, this.#negated, async () => {
      const open = await this.#window.isOpen()
      return { pass: open, saw: open ? 'it open' : 'no such window' }
    })
  }

  toHaveTitle(expected: TextMatch, options: Timeout = {}): Promise<void> {
    return LocatorAssertions.poll(`${this.#window.describe()} to ${this.#negated ? 'not ' : ''}have title ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)}`, options.timeout ?? this.#window.acde.timeout, this.#negated, async () => {
      const window = await this.#window.find()
      return { pass: window !== null && Locator.matches(window.title ?? '', expected, typeof expected === 'string'), saw: window === null ? 'no such window' : `title ${JSON.stringify(window.title)}` }
    })
  }
}

export function expect(target: Locator): LocatorAssertions
export function expect(target: AppWindow): WindowAssertions
export function expect(target: Locator | AppWindow): LocatorAssertions | WindowAssertions {
  return target instanceof Locator ? new LocatorAssertions(target) : new WindowAssertions(target)
}
