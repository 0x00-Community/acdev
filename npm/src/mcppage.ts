import type { McpServer } from '@modelcontextprotocol/server'
import { resolve } from 'node:path'
import * as z from 'zod'
import { Acde, type ActResult, type DevPage } from './driver/acde.ts'
import * as Call from './driver/call/index.ts'
import * as Confirms from './driver/confirms/index.ts'
import { Clock } from './driver/clock.ts'
import { Format } from './driver/format.ts'
import { Poll } from './driver/poll.ts'
import { Screenshots } from './driver/screenshot.ts'
import type { RouteOptions, RouteResponse } from './driver/types.ts'
import type { Result } from './mcp.ts'
import { Tools } from './tools.ts'

export interface PageToolsHost {
  page(target: string | undefined): Promise<{ readonly acde: Acde; readonly web: string }>
  safe(work: () => Promise<Result>): Promise<Result>
  text(text: string): Result
  acted(result: ActResult): Result
  acde(): Promise<Acde>
  web(acde: Acde, target: string | undefined): Promise<string>
  readonly cwd: string
}

const TARGET = 'a window ref (w3), a web name, an app id, or desktop'
const CHANGES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
type RouteArgs = {
  readonly method?: string | undefined
  readonly target?: string | undefined
  readonly times?: number | undefined
  readonly status?: number | undefined
  readonly headers?: Record<string, string> | undefined
  readonly body?: string | undefined
  readonly json?: unknown
  readonly abort?: boolean | string | undefined
}
const SINCE = z.union([z.number().int().min(1), z.record(z.string(), z.number().int().min(1))]).optional().describe('the next of the last '
  + 'answer: a number, or in a guest session without web the object of each page process\'s next')
const LOOK = { readOnlyHint: true, openWorldHint: false }
const DRIVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const CLOCK_ACTIONS = [
  'install', 'pause_at', 'fast_forward', 'run_for', 'resume', 'set_fixed_time', 'set_system_time', 'state',
] as const

export class PageTools {
  static register(server: McpServer, host: PageToolsHost): void {
    server.registerTool(
      'input',
      {
        description: 'Raw mouse and keyboard input to a page, in its own CSS pixels (getBoundingClientRect '
          + 'coordinates): move, down / up (button left | right | middle), wheel (dx, dy), keydown / keyup (key like '
          + '"Shift", "Control", "a", "ArrowDown"), text (typed through the input method), wait (ms, up to 10000: '
          + 'hold a key or a button that long). Moves are a frame apart; a move right after a down waits 150 ms and an '
          + 'up right after a move a frame (a title-bar drag needs the button still down when the window asks to '
          + 'move), unless a wait is already there. '
          + 'For clicks on an element act is simpler; act click also takes modifiers as its arg ("shift", '
          + '"ctrl+shift").',
        inputSchema: z.object({
          events: z
            .array(
              z.object({
                type: z.enum(['move', 'down', 'up', 'wheel', 'keydown', 'keyup', 'text', 'wait']),
                x: z.number().optional(),
                y: z.number().optional(),
                button: z.enum(['left', 'right', 'middle']).optional(),
                dx: z.number().optional(),
                dy: z.number().optional(),
                key: z.string().optional(),
                text: z.string().optional(),
                ms: z.number().optional(),
              }),
            )
            .min(1),
          target: z.string().optional().describe(TARGET),
        }),
        annotations: CHANGES,
      },
      (args) =>
        host.safe(async () => {
          const { acde, web } = await host.page(args.target)
          return host.acted(await acde.input(web, args.events as never))
        }),
    )

    server.registerTool(
      'clock',
      {
        description: "Control a page's time for testing time-based behaviour: install (optionally at a time) takes "
          + "over Date, performance.now and the page's timers; pause_at pauses at a time; fast_forward jumps ahead "
          + 'firing each due timer once; run_for advances firing every timer on the way; resume lets time flow; '
          + 'set_fixed_time pins Date; set_system_time moves Date only; state shows it. Times are ISO strings or ms '
          + 'since 1970, durations ms or "mm:ss" / "hh:mm:ss".',
        inputSchema: z.object({
          action: z.enum(CLOCK_ACTIONS),
          time: z.union([z.string(), z.number()]).optional(),
          duration: z.union([z.string(), z.number()]).optional(),
          target: z.string().optional().describe(TARGET),
        }),
        annotations: CHANGES,
      },
      (args) =>
        host.safe(async () => {
          const { acde, web } = await host.page(args.target)
          return host.text(JSON.stringify(await acde.clock(web, PageTools.clockRequest(args)), null, 2))
        }),
    )

    server.registerTool(
      'dialog',
      {
        description: "Answer a page's next alert / confirm / prompt before it comes (acdev runtime has no dialog to "
          + 'click: without an answer confirm is false and prompt null), or list the dialogs it showed and how they '
          + 'were answered.',
        inputSchema: z.object({
          accept: z.boolean().optional().describe('answer the next one: true accepts (OK), false dismisses (Cancel); '
            + 'leave out to only list'),
          text: z.string().optional().describe("a prompt's answer"),
          target: z.string().optional().describe(TARGET),
        }),
        annotations: CHANGES,
      },
      (args) =>
        host.safe(async () => {
          const { acde, web } = await host.page(args.target)
          if (args.accept !== undefined || args.text !== undefined) {
            const answer = { accept: args.accept !== false, ...(args.text !== undefined && { text: args.text }) }
            await acde.answerDialog(web, answer)
          }
          return host.text(JSON.stringify(await acde.dialogs({ web }), null, 2))
        }),
    )

    server.registerTool(
      'appearance',
      {
        description: 'Show or set dark or light, the glass level and reduced transparency. In the guest session it is the system '
          + 'setting (the desktop, its apps and the lock page follow); in a host session only this session\'s pages. Leave all out to read.',
        inputSchema: z.object({
          scheme: z.enum(['light', 'dark']).optional(),
          glassLevel: z.number().int().min(0).max(2).optional().describe('0 clear, 1 medium, 2 tinted'),
          reducedTransparency: z.boolean().optional().describe('true makes glass and materials opaque'),
        }),
        annotations: CHANGES,
      },
      (args) =>
        host.safe(async () => {
          const change = {
            ...(args.scheme && { scheme: args.scheme }),
            ...(args.glassLevel !== undefined && { glass: Tools.GLASS[args.glassLevel]! }),
            ...(args.reducedTransparency !== undefined && { reducedTransparency: args.reducedTransparency }),
          }
          return host.text(Tools.appearanceLine(await (await host.acde()).appearance(change)))
        }),
    )

    server.registerTool(
      'resize',
      {
        description: 'Resize a window so its page (without the title bar) is width x height CSS pixels; an app that '
          + "fills the screen resizes the host window. Answers the page's innerWidth and innerHeight after it.",
        inputSchema: z.object({
          width: z.number().int().min(1),
          height: z.number().int().min(1),
          target: z.string().optional().describe(TARGET),
        }),
        annotations: CHANGES,
      },
      (args) =>
        host.safe(async () => {
          const { acde, web } = await host.page(args.target)
          await acde.resize(web, args.width, args.height)
          const size = await Poll.until(Acde.TIMEOUT_MS, async () => {
            const [w, h] = await acde.evaluate<[number, number]>(web, '[innerWidth, innerHeight]')
            return w === args.width && h === args.height ? [w, h] : null
          }, () => `resize: the page did not become ${args.width}x${args.height}`)
          return host.text(JSON.stringify({ innerWidth: size[0], innerHeight: size[1] }))
        }),
    )
    server.registerTool(
      'screenshot',
      {
        description: "A PNG in device pixels of one window's page, or of the whole screen with every window composed "
          + '(target screen). Default: the focused window. The desktop\'s page has no panels it pinned (a Dock, a menu '
          + 'bar): they are layers of their own, so take screen to see the desktop as shown.',
        inputSchema: z.object({
          target: z.string().optional().describe('screen, a window ref (w3), a web name (ledger#1048576), an app id, '
            + 'or desktop'),
          path: z.string().optional().describe('also write the PNG to this file (relative to the working directory)'),
          ref: z.string().optional().describe('only this element or window (w3.12, w3), cut from the screen, or from target when it is that '
            + 'element\'s window; an element out of view is an error'),
          rect: z.array(z.number()).length(4).optional().describe('only this area [x, y, width, height] in logical pixels: of the window '
            + '(from its top left), or of the screen with target screen; past the edge is an error'),
        }),
        annotations: LOOK,
      },
      (args) =>
        host.safe(async () => {
          const acde = await host.acde()
          if (args.ref !== undefined || args.rect !== undefined) return await PageTools.#cropped(host, acde, args)
          const path = args.path === undefined ? {} : { path: resolve(host.cwd, args.path) }
          const web = args.target === 'screen' ? 'screen' : await host.web(acde, args.target)
          const shot = web === 'screen' ? await acde.screen(path) : await acde.screenshot(web, path)
          const written = shot.path ? `, written to ${shot.path}` : ''
          return {
            content: [
              { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: `${web}: ${shot.width}x${shot.height}${written}` },
            ],
          }
        }),
    )

    server.registerTool(
      'eval',
      {
        description: "Evaluate JavaScript in a page (a promise is awaited) and answer its value as JSON. The page's "
          + "own globals and DOM are there; acde: modules are imported with import(). Default: the focused window's "
          + "page.",
        inputSchema: z.object({
          code: z.string().describe('an expression, or statements whose last expression is the value'),
          target: z.string().optional().describe('a window ref (w3), a web name, an app id, or desktop'),
        }),
        annotations: { ...DRIVE, destructiveHint: true },
      },
      (args) =>
        host.safe(async () => {
          const acde = await host.acde()
          const value = await acde.evaluate(await host.web(acde, args.target), args.code)
          return host.text(JSON.stringify(value, null, 2) ?? 'null')
        }),
    )

    server.registerTool(
      'route',
      {
        description: 'Fake what a page gets for its fetch / XHR to a URL (instead of the app\'s files, its backend or '
          + 'the network), or make those requests fail. Later routes win; each answers id for unroute. WebSocket and '
          + 'EventSource are not routed.',
        inputSchema: z.object({
          url: z.string().describe('a glob: ** is anything, * anything but /; one starting with / matches path and '
            + 'query ("/api/todos*"), others the whole URL ("https://api.example.com/**")'),
          regex: z.boolean().optional().describe('url is a regular expression instead of a glob'),
          method: z.string().optional().describe('only this HTTP method'),
          target: z.string().optional().describe('only this page: a web name, an app id or desktop'),
          times: z.number().int().min(1).optional().describe('remove the route after this many requests'),
          status: z.number().int().min(200).max(599).optional().describe('HTTP status (default 200)'),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional().describe('the response body as text'),
          json: z.unknown().optional().describe('the response body as JSON (sets content-type)'),
          abort: z.union([z.boolean(), z.string()]).optional().describe('fail the request instead (true, or the error '
            + 'text)'),
        }),
        annotations: DRIVE,
      },
      (args) =>
        host.safe(async () => {
          const url = args.regex ? new RegExp(args.url) : args.url
          const response = PageTools.#response(args)
          const id = await (await host.acde()).route(url, response, PageTools.#routing(args))
          return host.text(`route ${id}: ${PageTools.#routed(args, url, response)}`)
        }),
    )

    server.registerTool(
      'unroute',
      {
        description: 'Take a route away by id, or all of them.',
        inputSchema: z.object({ id: z.number().int().optional().describe('the id route answered; leave out to remove '
          + 'every route') }),
        annotations: DRIVE,
      },
      (args) =>
        host.safe(async () => {
          const done = await (await host.acde()).unroute(args.id)
          return host.text(`removed ${done.removed} route${done.removed === 1 ? '' : 's'}, ${done.left} left`)
        }),
    )

    server.registerTool(
      'call',
      {
        description: 'Call the session manager (manager) or the Dopame backend (desktop) of a session in the guest '
          + '(--session vm) and answer the result as JSON; a session on this machine has neither and is refused. '
          + 'manager lets through apps.list, windows.screenshot, lock.status, the state methods of session, '
          + 'approvals.pending and approvals.show; desktop goes over the backend\'s debug connection, which decides '
          + 'what it may call (look.lock, state methods such as state.watch and desks.list, test.*) and refuses the '
          + 'sensitive ones (waiting.answer, grants.*, secrets.*). An error comes back as it was, with its code.',
        inputSchema: z.object({
          target: z.enum(Call.TARGETS as [Call.CallTarget, ...Call.CallTarget[]]),
          method: z.string().min(1).describe('the method, like approvals.pending or look.lock'),
          params: z.unknown().optional().describe('the parameters as JSON, like {"accent": "#d0249f"}'),
        }),
        annotations: DRIVE,
      },
      (args) =>
        host.safe(async () => {
          const result = await (await host.acde()).call(args.target, args.method, args.params)
          return host.text(JSON.stringify(result ?? null, null, 2))
        }),
    )

    server.registerTool(
      'approvals',
      {
        description: 'The system confirms that wait for the person in a session in the guest (--session vm): id, '
          + 'operation, and whether an agent or the person asked. With show, puts that one on the screen as the system '
          + 'confirm page (after the one showing now, if any). Answer it with act on the confirm window (mode '
          + 'confirm in snapshot): allow, deny, or type the password, as the person would; nothing answers for them. '
          + 'A session on this machine has no system agent and is refused.',
        inputSchema: z.object({ show: z.string().min(1).optional().describe('the id of the confirm to show') }),
        annotations: DRIVE,
      },
      (args) =>
        host.safe(async () => {
          const acde = await host.acde()
          return host.text(args.show ? await Confirms.show(acde, args.show) : Confirms.listed(await Confirms.pending(acde)))
        }),
    )

    server.registerTool(
      'console',
      {
        description: "The pages' console.* lines and uncaught errors / unhandled rejections, oldest first, with the "
          + "page each came from. next is what to pass as since to read only newer ones.",
        inputSchema: z.object({
          web: z.string().optional().describe('only this page: a web name, an app id, or desktop'),
          level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'errors']).optional().describe('errors: '
            + 'console.error and uncaught errors'),
          since: SINCE,
          limit: z.number().int().min(1).max(5000).optional().describe('the newest this many (default 500)'),
        }),
        annotations: LOOK,
      },
      (args) => host.safe(async () => PageTools.#entries(host, await (await host.acde()).console(args), Format.console)),
    )

    server.registerTool(
      'network',
      {
        description: "The pages' requests (fetch, XHR, WebSocket, EventSource, and loads of images, stylesheets "
          + 'and fonts): method, status (ERR when it failed, ... while open), URL, kind, response size, time, '
          + 'error, page. next is what to pass as since.',
        inputSchema: z.object({
          web: z.string().optional().describe('only this page: a web name, an app id, or desktop'),
          failed: z.boolean().optional().describe('only failed requests and status 400 or more'),
          since: SINCE,
          limit: z.number().int().min(1).max(5000).optional().describe('the newest this many (default 500)'),
        }),
        annotations: LOOK,
      },
      (args) => host.safe(async () => PageTools.#entries(host, await (await host.acde()).network(args), Format.request)),
    )

  }

  static #response(args: RouteArgs): RouteResponse {
    if (args.abort !== undefined && args.abort !== false) return { abort: args.abort }
    return {
      ...(args.status !== undefined && { status: args.status }),
      ...(args.headers && { headers: args.headers }),
      ...(args.body !== undefined && { body: args.body }),
      ...(args.json !== undefined && { json: args.json }),
    }
  }

  static #routing(args: RouteArgs): RouteOptions {
    return { ...(args.method && { method: args.method }), ...(args.target && { web: args.target }), ...(args.times && { times: args.times }) }
  }

  static #routed(args: RouteArgs, url: string | RegExp, response: RouteResponse): string {
    const answers = 'abort' in response ? `fails (${response.abort === true ? 'aborted' : response.abort})` : `${args.status ?? 200}`
    const times = args.times ? `, ${args.times} time${args.times === 1 ? '' : 's'}` : ''
    return `${args.method ?? 'any method'} ${String(url)} → ${answers}${times}`
  }

  static #entries<T>(host: PageToolsHost, page: DevPage<T>, line: (entry: T) => string): Result {
    const next = page.cursor ? JSON.stringify(page.cursor) : String(page.next)
    const failed = (page.failed ?? []).map((f) => `\n(${f})`).join('')
    const head = `next: ${next}${page.dropped ? ` (${page.dropped} older entries were dropped)` : ''}${failed}`
    return host.text(page.entries.length ? `${head}\n${page.entries.map(line).join('\n')}` : `${head}\n(nothing)`)
  }

  static async #cropped(host: PageToolsHost, acde: Acde, args: { target?: string; path?: string; ref?: string; rect?: number[] }): Promise<Result> {
    const flags = new Map<string, string>()
    if (args.ref !== undefined) flags.set('ref', args.ref)
    if (args.rect !== undefined) flags.set('rect', args.rect.join(','))
    const region = Tools.region('screenshot', flags)!
    const screen = args.target === 'screen' || (args.target === undefined && args.ref !== undefined)
    const web = screen ? null : await host.web(acde, args.target)
    const image = await Tools.crop(acde, web, region)
    const path = args.path === undefined ? undefined : resolve(host.cwd, args.path)
    const png = Screenshots.save(image, path)
    const written = path ? `, written to ${path}` : ''
    const what = 'ref' in region ? region.ref : `[${region.rect.join(', ')}]`
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${what} in ${web ?? 'screen'}: ${image.width}x${image.height}${written}` },
      ],
    }
  }

  static clockRequest(args: {
    readonly action: (typeof CLOCK_ACTIONS)[number]
    readonly time?: string | number | undefined
    readonly duration?: string | number | undefined
  }): Record<string, unknown> {
    const need = <T>(value: T | undefined, what: string): T => {
      if (value === undefined) throw new Error(`clock ${args.action}: give ${what}`)
      return value
    }
    const action = args.action.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
    switch (args.action) {
      case 'install':
        return args.time === undefined ? { action } : { action, time: Clock.time(args.time) }
      case 'pause_at':
      case 'set_fixed_time':
      case 'set_system_time':
        return { action, time: Clock.time(need(args.time, 'time')) }
      case 'fast_forward':
      case 'run_for':
        return { action, ms: Clock.duration(need(args.duration, 'duration')) }
      default:
        return { action }
    }
  }
}
