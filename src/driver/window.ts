import type { InspectAction, InspectWindow } from '@dopame/acde-api'
import { ActError, type Acde, type ActResult, type Shot } from './acde.ts'
import { Locator, type FilterOptions, type RoleOptions, type Scope, type TextMatch, type TextOptions, type Timeout, type Tree } from './locator.ts'
import { Poll } from './poll.ts'

export interface WindowMatch {
  readonly ref?: string
  readonly id?: number
  readonly app?: string
  readonly title?: TextMatch
}

export class AppWindow implements Scope {
  readonly acde: Acde
  readonly match: WindowMatch

  constructor(acde: Acde, match: WindowMatch) {
    if (Object.values(match).every((v) => v === undefined)) throw new Error('a window match needs ref, id, app or title')
    this.acde = acde
    this.match = match
  }

  describe(): string {
    const m = this.match
    if (m.ref === 'w0') return 'desktop'
    const parts = [m.ref && `ref ${m.ref}`, m.id !== undefined && `id ${m.id}`, m.app && `app ${JSON.stringify(m.app)}`, m.title !== undefined && `title ${m.title instanceof RegExp ? String(m.title) : JSON.stringify(m.title)}`].filter(Boolean)
    return `window(${parts.join(', ')})`
  }

  toString(): string {
    return this.describe()
  }

  static pick(windows: readonly InspectWindow[], match: WindowMatch): InspectWindow[] {
    return windows.filter(
      (w) =>
        (match.ref === undefined || w.ref === match.ref) &&
        (match.id === undefined || w.id === match.id) &&
        (match.app === undefined || w.app === match.app) &&
        (match.title === undefined || Locator.matches(w.title ?? undefined, match.title)),
    )
  }

  async find(): Promise<InspectWindow | null> {
    const found = AppWindow.pick(await this.acde.windows(), this.match)
    if (found.length > 1) throw new Error(`${this.describe()} matches ${found.length} windows (${found.map((w) => `${w.ref} ${JSON.stringify(w.title)}`).join(', ')}); match by ref or id`)
    return found[0] ?? null
  }

  async info(options: Timeout = {}): Promise<InspectWindow> {
    const ms = options.timeout ?? this.acde.timeout
    return Poll.until(ms, () => this.find(), () => `${this.describe()}: no such window (waited ${ms} ms)`)
  }

  async isOpen(): Promise<boolean> {
    return (await this.find()) !== null
  }

  async waitFor(options: Timeout & { readonly state?: 'open' | 'closed' } = {}): Promise<void> {
    if (options.state !== 'closed') {
      await this.info(options)
      return
    }
    const ms = options.timeout ?? this.acde.timeout
    await Poll.until(ms, async () => ((await this.find()) === null ? true : null), () => `${this.describe()}: still open after ${ms} ms`)
  }

  async tree(): Promise<Tree> {
    const window = await this.find()
    if (window === null) return { window: null, nodes: [] }
    const snapshot = await this.acde.snapshot({ window: window.ref, limit: 3000 })
    return { window, nodes: snapshot.trees[window.ref] ?? [] }
  }

  getByRole(role: string, options: RoleOptions = {}): Locator {
    return new Locator(this, [{ kind: 'role', role, options }])
  }

  getByText(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this, [{ kind: 'text', text, options }])
  }

  locator(options: FilterOptions = {}): Locator {
    return new Locator(this, [{ kind: 'filter', options }])
  }

  async snapshot(options: { readonly find?: string; readonly diff?: boolean } = {}): Promise<string> {
    return (await this.acde.snapshot({ window: (await this.info()).ref, ...options })).text
  }

  async web(): Promise<string> {
    return (await this.acde.webOf((await this.info()).id)).name
  }

  async evaluate<T = unknown>(code: string): Promise<T> {
    return this.acde.evaluate<T>(await this.web(), code)
  }

  async screenshot(options: { readonly path?: string } = {}): Promise<Shot> {
    return this.acde.screenshot(await this.web(), options)
  }

  press(keys: string): Promise<ActResult> {
    return this.#act('key', keys)
  }

  focus(): Promise<ActResult> {
    return this.#act('focus')
  }

  minimize(): Promise<ActResult> {
    return this.#act('minimize')
  }

  restore(): Promise<ActResult> {
    return this.#act('restore')
  }

  async close(): Promise<ActResult> {
    const window = await this.info()
    const result = await this.#act('close')
    await new AppWindow(this.acde, { id: window.id }).waitFor({ state: 'closed' })
    return result
  }

  async #act(action: InspectAction, arg: string | null = null): Promise<ActResult> {
    const result = await this.acde.act((await this.info()).ref, action, arg)
    if (!result.ok) throw new ActError(`${this.describe()}: ${action}`, result)
    return result
  }
}
