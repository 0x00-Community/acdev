import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DevtoolsBrowser } from './devtools-browser.ts'
import { Acde } from './driver/acde.ts'

export interface Endpoint {
  readonly port: number
  readonly token?: string
}

export interface GuestPort {
  readonly port: number
  readonly web: string | null
  readonly app: string | null
}

export interface Target {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

export interface Browser {
  readonly name: string
  readonly path: string
}

export interface Lookup {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly exists: (path: string) => boolean
  readonly home: string
}

export interface DevtoolsOptions {
  readonly window?: string
  readonly session?: number | 'vm'
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly say: (line: string) => void
  readonly lookup?: Lookup
  readonly launch?: (browser: Browser, url: string) => unknown
}

export interface PresentOptions {
  readonly address: 'always' | 'fallback'
  readonly lookup?: Lookup
  readonly launch?: (browser: Browser, url: string) => unknown
}

export class Devtools {
  static readonly FRONTEND = 'devtools://devtools/bundled/devtools_app.html'
  static readonly NONE = 'none'
  static readonly LIST_MS = 10_000

  static endpoint(answer: unknown): Endpoint {
    const { port, token } = (answer ?? {}) as { port?: unknown; token?: unknown }
    if (!Number.isInteger(port)) throw new Error('acdev runtime answered devtools without a port')
    return typeof token === 'string' && token ? { port: port as number, token } : { port: port as number }
  }

  static ports(answer: unknown): GuestPort[] {
    const listed = (answer as { ports?: unknown } | null)?.ports
    if (!Array.isArray(listed)) return [{ port: Devtools.endpoint(answer).port, web: null, app: null }]
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
    const ports = listed
      .map((item) => item as { port?: unknown; web?: unknown; app?: unknown } | null)
      .filter((item) => Number.isInteger(item?.port))
      .map((item) => ({ port: item!.port as number, web: text(item!.web), app: text(item!.app) }))
    if (!ports.length) throw new Error('the session in the guest answered devtools without a port')
    return ports
  }

  static portFor(ports: readonly GuestPort[], wanted: readonly string[]): GuestPort {
    const found = ports.length === 1 ? ports[0] : ports.find((p) => wanted.some((w) => w === p.web || w === p.app))
    if (found) return found
    const listed = ports.map((p) => `  ${p.web ?? '?'}  ${p.app ?? 'desktop'}  port ${p.port}`).join('\n')
    throw new Error(`no DevTools port for ${wanted[0] ?? 'the focused page'}; the guest serves:\n${listed}`)
  }

  static through(targets: readonly Target[], port: number): Target[] {
    return targets.map((target) => {
      const socket = new URL(target.webSocketDebuggerUrl)
      socket.host = `127.0.0.1:${port}`
      return { ...target, webSocketDebuggerUrl: socket.toString() }
    })
  }

  static async targets(endpoint: Endpoint, fetcher: typeof fetch = fetch): Promise<Target[]> {
    const { token } = endpoint
    const query = token ? `?token=${encodeURIComponent(token)}` : ''
    const response = await fetcher(`http://127.0.0.1:${endpoint.port}/json/list${query}`, {
      ...(token && { headers: { authorization: `Bearer ${token}` } }),
      signal: AbortSignal.timeout(Devtools.LIST_MS),
    })
    if (!response.ok) throw new Error(`the DevTools endpoint answered /json/list with ${response.status}`)
    const list = (await response.json()) as unknown
    if (!Array.isArray(list)) throw new Error('the DevTools endpoint answered /json/list without a list')
    return list.filter((item): item is Target =>
      typeof item?.id === 'string' && typeof item?.webSocketDebuggerUrl === 'string')
  }

  static pick(targets: readonly Target[], wanted: readonly string[], named: string | null): Target {
    const found = wanted.map((id) => targets.find((target) => target.id === id)).find((target) => target)
      ?? (named === null ? undefined : Devtools.#named(targets, named))
    if (found) return found
    const listed = targets.map((t) => `  ${t.id}  ${t.type}  ${t.title || t.url}`).join('\n')
    const what = named === null ? 'the focused page' : named
    const which = listed ? `; the targets are:\n${listed}` : ' (the list is empty)'
    throw new Error(`no DevTools target for ${what}${which}`)
  }

  static #named(targets: readonly Target[], named: string): Target | undefined {
    const wanted = named.toLowerCase()
    const titles = (target: Target) => [target.title ?? '', (target.title ?? '').replace(/ \([^()]*\)$/, '')]
      .map((t) => t.toLowerCase())
    const services = (target: Target) => (target.title ?? '').replace(/^services:\s*/i, '').split(',')
      .map((s) => s.trim().toLowerCase())
    return targets.find((target) => titles(target).includes(wanted))
      ?? targets.find((target) => target.type === 'service'
        && (wanted === 'services' || wanted === 'service' || services(target).includes(wanted)))
  }

  static url(target: Target, endpoint: Endpoint): string {
    const socket = new URL(target.webSocketDebuggerUrl)
    if (endpoint.token && !socket.searchParams.has('token')) socket.searchParams.set('token', endpoint.token)
    const ws = `${socket.host}${socket.pathname}${socket.search}`
    return `${Devtools.FRONTEND}?ws=${encodeURIComponent(ws)}`
  }

  static lookup(): Lookup {
    return { platform: process.platform, env: process.env, exists: existsSync, home: homedir() }
  }

  static browser(lookup: Lookup = Devtools.lookup()): Browser | null {
    const chosen = lookup.env['ACDEV_BROWSER']
    if (chosen === Devtools.NONE) return null
    if (chosen) return { name: chosen, path: chosen }
    const found = Devtools.candidates(lookup).find((browser) => lookup.exists(browser.path))
    return found ?? null
  }

  static candidates({ platform, env, home }: Lookup): Browser[] {
    if (platform === 'win32') {
      const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']]
        .filter((root): root is string => !!root)
      const under = (name: string, ...parts: string[]) => roots.map((root) => ({ name, path: join(root, ...parts) }))
      return [
        ...under('Microsoft Edge', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ...under('Google Chrome', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    }
    if (platform === 'darwin') {
      const apps = (name: string) => ['/Applications', join(home, 'Applications')]
        .map((dir) => ({ name, path: join(dir, `${name}.app`, 'Contents', 'MacOS', name) }))
      return [...apps('Google Chrome'), ...apps('Microsoft Edge')]
    }
    const names = [
      'google-chrome', 'google-chrome-stable', 'chrome', 'chromium', 'chromium-browser', 'microsoft-edge',
      'microsoft-edge-stable',
    ]
    const dirs = (env['PATH'] ?? '').split(delimiter).filter(Boolean)
    return names.flatMap((name) => dirs.map((dir) => ({ name, path: join(dir, name) })))
  }

  static async run(options: DevtoolsOptions): Promise<number> {
    const acde = await Acde.attach({
      ...(options.session !== undefined && { session: options.session }),
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      ...(options.env !== undefined && { env: options.env }),
      say: options.say,
    })
    let wanted: string[]
    let answer: unknown
    try {
      answer = await acde.devtools()
      wanted = await Devtools.#wanted(acde, options.window ?? null)
    } finally {
      await acde.close()
    }
    const present: PresentOptions = {
      address: 'always',
      ...(options.lookup !== undefined && { lookup: options.lookup }),
      ...(options.launch !== undefined && { launch: options.launch }),
    }
    if (options.session === 'vm') return await Devtools.#guest(Devtools.portFor(Devtools.ports(answer), wanted), wanted, options, present)
    const endpoint = Devtools.endpoint(answer)
    const target = Devtools.pick(await Devtools.targets(endpoint), wanted, options.window ?? null)
    await Devtools.present(target, endpoint, present)
    return 0
  }

  static async #guest(chosen: GuestPort, wanted: readonly string[], options: DevtoolsOptions, present: PresentOptions): Promise<number> {
    const { Forward } = await import('./vm/forward.ts')
    const forward = await Forward.open(chosen.port)
    try {
      const endpoint = { port: forward.port }
      const targets = Devtools.through(await Devtools.targets(endpoint), forward.port)
      await Devtools.present(Devtools.pick(targets, wanted, options.window ?? null), endpoint, present)
    } catch (error) {
      forward.close()
      throw error
    }
    options.say(`acdev: DevTools reaches port ${chosen.port} in the guest through 127.0.0.1:${forward.port}; Ctrl+C stops it`)
    await forward.closed
    return 0
  }

  /**
   * Opens DevTools on a target in Chrome or Edge, or prints the address to paste. With `address: 'always'` the address
   * goes to stdout every time (acde devtools); with `'fallback'` only when no browser opened it (F12 in acde dev).
   */
  static async present(target: Target, endpoint: Endpoint, options: PresentOptions): Promise<void> {
    const url = Devtools.url(target, endpoint)
    const lookup = options.lookup ?? Devtools.lookup()
    const browser = Devtools.browser(lookup)
    const title = target.title || target.url || target.id
    const paste = 'paste the address above into the address bar of Chrome or Edge on this machine'
    if (options.address === 'always') console.log(url)
    const fallback = (why: string) => {
      if (options.address === 'fallback') console.log(url)
      console.error(`acdev: DevTools for ${title}: ${why}; ${paste}`)
    }
    if (!browser) {
      const off = lookup.env['ACDEV_BROWSER'] === Devtools.NONE
      return fallback(off ? 'ACDEV_BROWSER=none: no browser opened' : 'no Chrome or Edge found (ACDEV_BROWSER names one)')
    }
    let how: unknown
    try {
      how = await (options.launch ?? ((chosen: Browser, address: string) => DevtoolsBrowser.open(chosen, address, lookup)))(
        browser, url)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return fallback(`could not open it in ${browser.name} (${why})`)
    }
    console.error(how === 'focused'
      ? `acdev: brought DevTools for ${title} to the front in ${browser.name}`
      : `acdev: opened DevTools for ${title} in ${browser.name}`)
  }

  static async #wanted(acde: Acde, named: string | null): Promise<string[]> {
    const webs = await acde.webs()
    if (named !== null) {
      const web = webs.find((w) => w.name === named) ?? webs.find((w) => w.app === named)
        ?? webs.find((w) => String(w.window) === named) ?? webs.find((w) => w.title === named)
        ?? webs.find((w) => w.title?.toLowerCase() === named.toLowerCase())
      return web ? [named, web.name, String(web.window)] : [named]
    }
    const windows = await acde.windows()
    const focused = windows.find((w) => w.focus && w.kind === 'web') ?? windows.find((w) => w.kind === 'desktop')
    const web = webs.find((w) => w.window === focused?.id) ?? webs[0]
    if (!web) throw new Error('the session has no page to open DevTools on')
    return [web.name, String(web.window)]
  }
}
