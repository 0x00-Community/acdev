import type { InspectAction, InspectNode, InspectWindow } from '@dopame/acde-api'
import { ActError, type Acde, type ActResult, type ConsoleEntry, type ConsoleOptions, type DevPage, type NetworkOptions, type RequestEntry, type RouteOptions, type RouteResponse, type Shot, type UrlMatch, type WaitConsoleOptions, type WaitRequestOptions } from './acde.ts'
import { Locator, type RoleOptions, type Scope, type Source, type TextMatch, type TextOptions, type Timeout, type Tree } from './locator.ts'
import { Png } from './png.ts'
import { Poll } from './poll.ts'
import { Screenshots, type Capture, type ScreenshotOptions } from './screenshot.ts'

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
    if (window === null) return { window: null, source: { nodes: [], children: async () => [], query: async () => [] } }
    return { window, source: await AppWindow.source(this.acde, window.ref) }
  }

  static async source(acde: Acde, ref: string): Promise<Source> {
    const snapshot = await acde.snapshot({ window: ref, limit: 3000, offscreen: true })
    return {
      nodes: snapshot.trees[ref] ?? [],
      children: async (node: InspectNode) => {
        if (!('tag' in node)) return node.children ?? []
        const under = (await acde.snapshot({ ref: node.ref, limit: 3000, offscreen: true })).trees[ref] ?? []
        return under.length === 1 && under[0]!.ref === node.ref ? (under[0]!.children ?? []) : under
      },
      query: async (selector: string, within: InspectNode | null, attributes?: readonly string[]) =>
        (await acde.query({ window: ref, selector, limit: 3000, ...(within && { ref: within.ref }), ...(attributes?.length && { attributes }) })).nodes.filter((n) => n.visible),
    }
  }

  getByRole(role: string, options: RoleOptions = {}): Locator {
    return new Locator(this, [{ kind: 'role', role, options }])
  }

  getByText(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this, [{ kind: 'text', text, options }])
  }

  locator(selector: string): Locator {
    return new Locator(this, [{ kind: 'css', selector }])
  }

  getByTestId(id: string): Locator {
    return this.locator(Locator.testId(id))
  }

  getByLabel(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this, [{ kind: 'label', text, options }])
  }

  getByPlaceholder(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this, [{ kind: 'attr', name: 'placeholder', text, options }])
  }

  getByTitle(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this, [{ kind: 'attr', name: 'title', text, options }])
  }

  getByAltText(text: TextMatch, options: TextOptions = {}): Locator {
    return new Locator(this, [{ kind: 'attr', name: 'alt', text, options }])
  }

  async route(url: UrlMatch, response: RouteResponse, options: Omit<RouteOptions, 'web'> = {}): Promise<number> {
    return this.acde.route(url, response, { ...options, web: await this.web() })
  }

  async waitForRequest(url: UrlMatch, options: Omit<WaitRequestOptions, 'web'> = {}): Promise<RequestEntry> {
    return this.acde.waitForRequest(url, { ...options, web: await this.web() })
  }

  async waitForConsole(text: string | RegExp, options: Omit<WaitConsoleOptions, 'web'> = {}): Promise<ConsoleEntry> {
    return this.acde.waitForConsole(text, { ...options, web: await this.web() })
  }

  async console(options: Omit<ConsoleOptions, 'web'> = {}): Promise<DevPage<ConsoleEntry>> {
    return this.acde.console({ ...options, web: await this.web() })
  }

  async network(options: Omit<NetworkOptions, 'web'> = {}): Promise<DevPage<RequestEntry>> {
    return this.acde.network({ ...options, web: await this.web() })
  }

  async snapshot(options: { readonly find?: string; readonly diff?: boolean } = {}): Promise<string> {
    return (await this.acde.snapshot({ window: (await this.info()).ref, ...options })).text
  }

  async web(): Promise<string> {
    return (await this.acde.webOf((await this.info()).id)).name
  }

  async evaluate<T = unknown>(code: string): Promise<NoInfer<T>> {
    return this.acde.evaluate<T>(await this.web(), code)
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Shot> {
    if (!options.mask?.length) return this.acde.screenshot(await this.web(), options.path === undefined ? {} : { path: options.path })
    const image = await Screenshots.window(await this.capture(), options.mask)
    const png = Screenshots.save(image, options.path)
    return { png, width: image.width, height: image.height, path: options.path ?? null }
  }

  async capture(): Promise<Capture> {
    const window = await this.info()
    const shot = await this.acde.screenshot((await this.acde.webOf(window.id)).name)
    const image = Png.decode(shot.png)
    return { image, window, scale: window.rect[2] > 0 ? image.width / window.rect[2] : 1 }
  }

  async rects(): Promise<readonly (readonly [number, number, number, number])[]> {
    const window = await this.find()
    return window ? [window.rect] : []
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
    return this.acde.trace.step(`${this.describe()}.${action === 'key' ? 'press' : action}(${arg === null ? '' : JSON.stringify(arg)})`, async () => {
      const result = await this.acde.act((await this.info()).ref, action, arg)
      if (!result.ok) throw new ActError(`${this.describe()}: ${action}`, result)
      return result
    }, (result) => result.text.split('\n')[0] ?? '')
  }
}
