import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { InspectNode } from '@dopame/acde-api'
import type { Acde } from './acde.ts'
import { Locator, type Source, type TextMatch, type Timeout } from './locator.ts'
import { Png, type Image } from './png.ts'
import { Poll } from './poll.ts'
import { Screenshots, type Capturable } from './screenshot.ts'
import type { AppWindow } from './window.ts'

export interface ScreenshotAssertion extends Timeout {
  readonly maxDiffPixels?: number
  readonly maxDiffPixelRatio?: number
  readonly threshold?: number
  readonly mask?: readonly Capturable[]
}

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
      const text = await Locator.content(source, n)
      return { pass: Locator.matches(text, expected, options.exact ?? typeof expected === 'string'), saw: `text ${JSON.stringify(text)}` }
    })
  }

  toContainText(expected: TextMatch, options: Timeout = {}): Promise<void> {
    return this.#one(`contain text ${LocatorAssertions.#text(expected)}`, options, async (n, source) => {
      const text = await Locator.content(source, n)
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

  toHaveAttribute(name: string, expected?: TextMatch, options: Timeout = {}): Promise<void> {
    const want = expected === undefined ? `have attribute ${name}` : `have attribute ${name} ${LocatorAssertions.#text(expected)}`
    return this.#nodes(want, options, async (nodes, source) => {
      if (nodes.length !== 1) return { pass: null, saw: nodes.length === 0 ? 'no element' : `${nodes.length} elements` }
      const value = await LocatorAssertions.#attribute(source, nodes[0]!, name)
      if (value === undefined) return { pass: null, saw: 'an element CSS cannot reach' }
      return { pass: value !== null && (expected === undefined || Locator.matches(value, expected, typeof expected === 'string')), saw: value === null ? `no ${name}` : `${name}=${JSON.stringify(value)}` }
    })
  }

  toHaveScreenshot(name?: string | ScreenshotAssertion, options: ScreenshotAssertion = {}): Promise<void> {
    const [file, opts] = typeof name === 'object' ? [undefined, name] : [name, options]
    if (this.#negated) throw new Error('toHaveScreenshot cannot be negated')
    const locator = this.#locator
    return LocatorAssertions.screenshot(locator.scope.acde, locator.describe(), file, opts, () => locator.screenshot({ ...(opts.mask && { mask: opts.mask }), timeout: opts.timeout ?? locator.scope.acde.timeout }).then((shot) => Png.decode(shot.png)))
  }

  #nodes(what: string, options: Timeout, check: (nodes: readonly InspectNode[], source: Source) => Check | Promise<Check>): Promise<void> {
    const sentence = `${this.#locator.describe()} to ${this.#negated ? 'not ' : ''}${what}`
    return this.#locator.scope.acde.trace.step(`expect ${sentence}`, () =>
      LocatorAssertions.poll(sentence, this.#timeout(options), this.#negated, async () => {
        const { nodes, source } = await this.#locator.resolve()
        return check(nodes, source)
      }),
    )
  }

  static async #attribute(source: Source, node: InspectNode, name: string): Promise<string | null | undefined> {
    const parent = await LocatorAssertions.#parentOf(source, node)
    const found = await source.query('*', parent, [name])
    return found.find((n) => n.ref === node.ref)?.attributes?.[name]
  }

  static async #parentOf(source: Source, node: InspectNode): Promise<InspectNode | null> {
    const walk = (list: readonly InspectNode[], parent: InspectNode | null): InspectNode | null | undefined => {
      for (const n of list) {
        if (n.ref === node.ref) return parent
        const below = walk(n.children ?? [], n)
        if (below !== undefined) return below
      }
      return undefined
    }
    return walk(source.nodes, null) ?? null
  }

  static async screenshot(acde: Acde, target: string, name: string | undefined, options: ScreenshotAssertion, take: () => Promise<Image>): Promise<void> {
    const { path, label } = Screenshots.baseline(name)
    const context = Screenshots.context
    const update = context?.update ?? false
    const ci = context?.ci ?? !!process.env['CI']
    const ms = options.timeout ?? acde.timeout
    return acde.trace.step(`expect ${target} to match screenshot ${label}`, async () => {
      const expected = update ? null : Screenshots.read(path)
      if (!expected && !update && ci) throw new AssertionError(`expected ${target} to match screenshot ${path}, but there is no such file (CI is set, so acde does not write it; run acde test --update-screenshots and commit it)`)
      const deadline = Date.now() + ms
      let previous: Image | null = null
      let why = ''
      let failed: { readonly actual: Image; readonly diff: Image | null } | null = null
      for (;;) {
        const actual = await take()
        const stable = previous !== null && Png.same(previous, actual)
        const late = Date.now() >= deadline
        previous = actual
        if (stable || late) {
          if (!expected) {
            if (!stable) {
              why = `the picture kept changing for ${ms} ms, so no baseline was written`
              failed = { actual, diff: null }
              break
            }
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, Png.encode(actual))
            console.log(`acde: ${update ? 'updated' : 'wrote'} screenshot ${path}`)
            return
          }
          if (actual.width !== expected.width || actual.height !== expected.height) {
            why = `the size is ${actual.width}×${actual.height}, the baseline ${expected.width}×${expected.height}`
            failed = { actual, diff: null }
          } else {
            const diff = Png.diff(actual, expected, { ...(options.threshold !== undefined && { threshold: options.threshold }) })
            const allowed = Math.max(options.maxDiffPixels ?? 0, Math.floor((options.maxDiffPixelRatio ?? 0) * actual.width * actual.height))
            if (diff.pixels <= allowed) return
            why = `${diff.pixels} ${diff.pixels === 1 ? 'pixel differs' : 'pixels differ'} (${((diff.pixels / (actual.width * actual.height)) * 100).toFixed(2)}%, allowed ${allowed})`
            failed = { actual, diff: diff.image }
          }
          if (late) break
        }
        if (Date.now() >= deadline) break
        await sleep(Poll.INTERVAL_MS)
      }
      const dir = context?.results ?? dirname(path)
      mkdirSync(dir, { recursive: true })
      const stem = join(dir, Screenshots.slug(label))
      const files = [`${stem}-actual.png`]
      writeFileSync(files[0]!, Png.encode(failed!.actual))
      if (expected) {
        files.push(`${stem}-expected.png`)
        writeFileSync(files[1]!, Png.encode(expected))
      }
      if (failed!.diff) {
        files.push(`${stem}-diff.png`)
        writeFileSync(files[files.length - 1]!, Png.encode(failed!.diff))
      }
      throw new AssertionError(`expected ${target} to match screenshot ${path}: ${why}\n  ${files.join('\n  ')}`)
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
    return this.#poll('be open', options, async () => {
      const open = await this.#window.isOpen()
      return { pass: open, saw: open ? 'it open' : 'no such window' }
    })
  }

  toHaveTitle(expected: TextMatch, options: Timeout = {}): Promise<void> {
    return this.#poll(`have title ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)}`, options, async () => {
      const window = await this.#window.find()
      return { pass: window !== null && Locator.matches(window.title ?? '', expected, typeof expected === 'string'), saw: window === null ? 'no such window' : `title ${JSON.stringify(window.title)}` }
    })
  }

  toHaveScreenshot(name?: string | ScreenshotAssertion, options: ScreenshotAssertion = {}): Promise<void> {
    const [file, opts] = typeof name === 'object' ? [undefined, name] : [name, options]
    if (this.#negated) throw new Error('toHaveScreenshot cannot be negated')
    const window = this.#window
    return LocatorAssertions.screenshot(window.acde, window.describe(), file, opts, async () => Png.decode((await window.screenshot({ ...(opts.mask && { mask: opts.mask }) })).png))
  }

  #poll(what: string, options: Timeout, attempt: () => Promise<Check>): Promise<void> {
    const sentence = `${this.#window.describe()} to ${this.#negated ? 'not ' : ''}${what}`
    return this.#window.acde.trace.step(`expect ${sentence}`, () => LocatorAssertions.poll(sentence, options.timeout ?? this.#window.acde.timeout, this.#negated, attempt))
  }
}

export function expect(target: Locator): LocatorAssertions
export function expect(target: AppWindow): WindowAssertions
export function expect(target: Locator | AppWindow): LocatorAssertions | WindowAssertions
export function expect(target: Locator | AppWindow): LocatorAssertions | WindowAssertions {
  return target instanceof Locator ? new LocatorAssertions(target) : new WindowAssertions(target)
}
