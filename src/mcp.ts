import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod'
import type { InspectAction } from '@dopame/acde-api'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Approvals } from './approvals.ts'
import { Doctor } from './doctor.ts'
import { ACTIONS, Acde, type ActResult, type DevPage } from './driver/acde.ts'
import { Poll } from './driver/poll.ts'
import { Sessions } from './sessions.ts'
import { Format } from './driver/format.ts'
import { PageTools } from './mcppage.ts'
import { Versions } from './versions.ts'

const ACTION = z.enum(ACTIONS as [InspectAction, ...InspectAction[]])
const ARG = z.union([z.string(), z.number(), z.array(z.string())])

const INSTRUCTIONS = [
  `acde: see and drive the desktop and apps of an acde dev session (acdert runs them; no browser, no devtools).`,
  `- A session: the acde dev whose projects hold the working directory is used. If none runs, call start (it runs acde `
    + `dev here and keeps its output for logs); sessions lists them and pins one.`,
  `- Look with snapshot: windows first (w0 is the desktop, w1, w2 … the others), then the focused window's elements, `
    + `one per line with a ref like [w3.12]. find narrows to elements whose name or value contains a text; window `
    + `picks a window; all lists every window not marked [minimized] and keeps elements hidden by opacity: 0 or `
    + `visibility (marked transparent / invisible).`,
  `- Act with act / run on those refs (click, type, settext, key "ctrl+a backspace", scroll, …). The answer waits for `
    + `the page to settle and ends with what changed in the window, so another snapshot is rarely needed. A ref stays `
    + `the same while its element lives (moved, retexted or restyled); when the page replaces the element it gets a `
    + `new ref and the old one answers "element N is gone".`,
  `- Elements scrolled out of view are left out unless offscreen is set; act scrolls an element into view before using `
    + `it. query finds elements by CSS selector (also [data-testid=…]) and gives refs act takes.`,
  `- open launches an app by id or name. screenshot shows a window's pixels, or target "screen" the whole screen with `
    + `every window (snapshot cannot tell colour, layout or overlap). eval runs JavaScript in a page and returns JSON. `
    + `wait_for waits for a text to appear or go.`,
  `- console has the pages' console.* lines and uncaught errors, network their fetch / XHR / WebSocket / EventSource `
    + `requests and the images, stylesheets and fonts they load (status, size, time, error); both answer next, pass it `
    + `as since to read only newer entries. emulate switches the colour scheme or reduced motion. logs is the raw `
    + `output of an acde dev that start ran.`,
  `- act drag moves an element onto another ref (pointer drags and HTML5 drag and drop, also into another window); act `
    + `select picks options of a <select> by value or text.`,
  `- route fakes the response (or a failure) of a page's fetch / XHR whose URL matches, so a test or an agent can try `
    + `states the backend does not give; unroute takes them away. clipboard reads or writes the clipboard the pages `
    + `see (headless sessions only, unless the user agrees to system: true).`,
  `- input sends raw mouse / keyboard events at page coordinates (act click takes modifiers like "shift" as its `
    + `arg). clock takes over a page's time (install, pause_at, fast_forward, run_for …) to test timers without `
    + `waiting. dialog answers the next alert / confirm / prompt beforehand and lists those shown. resize sets a `
    + `page's size.`,
  `- start {headless: true} runs without a window on screen (same pages, same input, screenshots still work). A page's `
    + `folder, open or save chooser then needs choose_folder, choose_files or choose_save_file first.`,
  `- An app that needs the user's approval for a capability (terminal, network, camera, microphone, launch, slots, a `
    + `shared folder) opens no window until its prompt is answered: webs is then empty and says what waits. `
    + `permissions lists the prompts and the decisions, answer allows or denies a prompt, revoke takes a decision `
    + `back.`,
].join('\n')

const ANSWER = 'the answer tool allows or denies it'
const NAMING = 'name one with prompt, or with app and capability'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface Result {
  [key: string]: unknown
  content: Content[]
  isError?: boolean
}

export interface McpOptions {
  readonly session?: number
  readonly cwd?: string
}

export class Mcp {
  static readonly DELISTED_MS = 2_000

  readonly server: McpServer
  readonly #cwd: string
  #pinned: number | undefined
  #attached: Acde | null = null
  #launched: Acde | null = null

  constructor(options: McpOptions = {}) {
    this.#cwd = options.cwd ?? process.cwd()
    this.#pinned = options.session
    this.server = new McpServer({ name: 'acde', version: Versions.acde() }, { instructions: INSTRUCTIONS })
    this.#register()
  }

  static async serve(options: McpOptions = {}): Promise<number> {
    const mcp = new Mcp(options)
    const transport = new StdioServerTransport()
    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => resolve()
    })
    const signals: [NodeJS.Signals, () => void][] = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
      .map((signal) => [signal, () => void transport.close()])
    for (const [signal, handler] of signals) process.on(signal, handler)
    try {
      await mcp.server.connect(transport)
      await closed
    } finally {
      for (const [signal, handler] of signals) process.off(signal, handler)
      await mcp.close()
    }
    return 0
  }

  async close(): Promise<void> {
    await Promise.all([this.#attached?.close(), this.#launched?.close()])
    this.#attached = null
    this.#launched = null
  }

  #register(): void {
    const s = this.server
    const look = { readOnlyHint: true, openWorldHint: false }
    const drive = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

    s.registerTool(
      'sessions',
      {
        description: 'List the running acde dev sessions (pid, desktop or app, project directories) and which one the '
          + 'tools use. Pass use to pin a session by pid.',
        inputSchema: z.object({ use: z.number().int().positive().optional().describe('pid of the acde dev to use from '
          + 'now on') }),
        annotations: look,
      },
      (args) => this.#safe(async () => this.#sessions(args.use)),
    )

    s.registerTool(
      'doctor',
      {
        description: 'Check this machine for acde dev, one line per check (ok, warn, error, skip) with a fix for '
          + 'what is wrong: acde on PATH, Bun and Node.js, acdert (found, runs, pairs with this acde, and its own '
          + 'check of the GPU and its files), running sessions and approvals they wait for, the project, the agent '
          + 'skill. Call it first when acde dev or start does not come up.',
        inputSchema: z.object({
          dir: z.string().optional().describe('the project directory to check, relative to the working directory '
            + '(default: the working directory)'),
          online: z.boolean().optional().describe('also ask pkgs.dopame.ai whether a newer acde is out'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      (args) => this.#safe(async () => {
        const checks = await Doctor.run({ ...(args.dir !== undefined && { dir: args.dir }), online: args.online === true })
        return Mcp.#text(Doctor.format(checks))
      }),
    )

    s.registerTool(
      'doctor_fix',
      {
        description: 'Check this machine as doctor does, then fix what acde may fix without asking: install the acde '
          + 'skill, add .acde/ to .gitignore, make the sessions directory again. What downloads, installs or stops '
          + 'something (the acde installer again for a missing or mismatched acdert, the project\'s install, stopping '
          + 'a session that does not answer) is skipped here and named: that needs the user, who runs acde doctor '
          + '--fix in a terminal (it asks) or agrees to acde doctor --fix --yes. Approvals, GPU drivers and the '
          + 'project\'s code are never touched. Answers what it did, then the checks again.',
        inputSchema: z.object({
          dir: z.string().optional().describe('the project directory, inside the working directory (default: the '
            + 'working directory)'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (args) => this.#safe(async () => {
        const dir = resolve(args.dir ?? '.')
        if (!Doctor.inside(Doctor.real(dir), Doctor.real(process.cwd())))
          throw new Error(`${dir} is not inside the working directory ${process.cwd()}`)
        const options = { dir }
        const lines: string[] = []
        await Doctor.fix(await Doctor.run(options), {
          yes: false, output: 'capture', say: (line) => lines.push(line), confirm: null,
          allowing: 'the user runs acde doctor --fix in a terminal, or agrees to acde doctor --fix --yes',
        })
        const after = await Doctor.run(options)
        return Mcp.#text(`${lines.join('\n')}\n\n${Doctor.format(after)}`)
      }),
    )

    s.registerTool(
      'start',
      {
        description: 'Run acde dev (build, start acdert, rebuild and reload on change) and use that session. Without '
          + 'dirs it runs the project in the working directory. Its output is kept for logs. Stops when this server '
          + 'stops.',
        inputSchema: z.object({
          dirs: z.array(z.string()).optional().describe('project directories, relative to the working directory '
            + '(default: the working directory)'),
          desktop: z.string().optional().describe('a desktop id or a desktop project directory: run every project '
            + 'inside that desktop'),
          app: z.string().optional().describe('with one project holding several apps, which one to open'),
          headless: z.boolean().optional().describe('no host window on screen; pages, input and screenshots work the '
            + 'same'),
        }),
        annotations: drive,
      },
      (args) => this.#safe(async () => this.#start(args)),
    )

    s.registerTool(
      'stop',
      {
        description: 'Stop the acde dev that start ran.',
        inputSchema: z.object({}),
        annotations: { ...drive, destructiveHint: true },
      },
      () => this.#safe(async () => this.#stop()),
    )

    s.registerTool(
      'webs',
      {
        description: 'The pages acdert runs: NAME (app#window, or desktop), KIND, APP, WINDOW number, TITLE.',
        inputSchema: z.object({}),
        annotations: look,
      },
      () => this.#safe(async () => Mcp.#text(await Mcp.#webs(await this.#acde()))),
    )

    s.registerTool(
      'permissions',
      {
        description: 'The approval prompts that wait (id, app, capability, why it is asked) and the decisions made '
          + '(app, capability, granted or denied). An app that waits for an approval has no window yet.',
        inputSchema: z.object({}),
        annotations: look,
      },
      () => this.#safe(async () => Mcp.#text(Format.permissions(await (await this.#acde()).permissions()))),
    )

    s.registerTool(
      'answer',
      {
        description: 'Allow or deny an approval prompt that waits. To allow, name the app and the capability, so '
          + 'that what is granted is stated in the call. To deny: the prompt id, or app and capability, or, with '
          + 'neither, the only one waiting (several are listed, not guessed). The decision is kept for the app until '
          + 'revoke takes it back. It stands in for the user\'s own answer: allow only what the user asked for or '
          + 'agreed to, and tell them what you allowed.',
        inputSchema: z.object({
          allow: z.boolean().describe('true grants the capability, false denies it'),
          prompt: z.number().int().positive().optional().describe('the id permissions shows'),
          app: z.string().optional().describe('the app id, together with capability'),
          capability: z.string().optional().describe('the capability asked for (network, fs.downloads, …), together '
            + 'with app'),
        }),
        annotations: { ...drive, destructiveHint: true },
      },
      (args) =>
        this.#safe(async () => {
          if (args.prompt !== undefined && (args.app !== undefined || args.capability !== undefined))
            throw new Error('answer: give prompt, or app and capability, not both')
          if (args.allow && (args.app === undefined || args.capability === undefined))
            throw new Error('answer: to allow, name the app and the capability (permissions lists what waits)')
          const wanted = {
            ...(args.prompt !== undefined && { prompt: args.prompt }),
            ...(args.app !== undefined && { app: args.app }),
            ...(args.capability !== undefined && { capability: args.capability }),
          }
          return Mcp.#text(await Approvals.answer(await this.#acde(), wanted, args.allow, NAMING))
        }),
    )

    s.registerTool(
      'revoke',
      {
        description: 'Take back a decision about an app and a capability (as permissions lists them), so the app is '
          + 'asked again the next time it needs it.',
        inputSchema: z.object({
          app: z.string().describe('the app id'),
          capability: z.string().describe('the capability the decision is about'),
        }),
        annotations: { ...drive, destructiveHint: true },
      },
      (args) =>
        this.#safe(async () => Mcp.#text(await Approvals.revoke(await this.#acde(), args.app, args.capability))),
    )

    s.registerTool(
      'snapshot',
      {
        description: 'The desktop as text, in a fixed English format: one line per window, top first '
          + '(- window "Notes" [app=notes] [focused] [w1]; the desktop is - desktop), and under the focused window (or '
          + 'window / ref) its elements indented two spaces, one per line: - button "Save" [pressed] [w1.52]. Notes in '
          + 'parentheses say what is left out, such as (no changes) or (windows unchanged) with diff. Elements outside '
          + 'the visible area are not listed; scroll to reach them.',
        inputSchema: z.object({
          window: z.string().optional().describe('a window ref (w3) to list instead of the focused one'),
          ref: z.string().optional().describe('an element ref (w3.12): list only what is under it'),
          find: z.string().optional().describe('only elements whose name or value contains this text '
            + '(case-insensitive), with their ancestors, in every window not marked [minimized]'),
          all: z.boolean().optional().describe('list every window not marked [minimized], and keep elements hidden by '
            + 'opacity: 0 or visibility (marked transparent / invisible); display: none, aria-hidden and inert '
            + 'stay out'),
          diff: z.boolean().optional().describe('only what changed since the last snapshot of that window (+ added, ~ '
            + 'changed, - gone)'),
          limit: z.number().int().min(20).max(3000).optional().describe('most elements per window (default 600)'),
          offscreen: z.boolean().optional().describe('also list elements scrolled out of view'),
        }),
        annotations: look,
      },
      (args) => this.#safe(async () => Mcp.#text((await (await this.#acde()).snapshot(args)).text)),
    )

    s.registerTool(
      'act',
      {
        description:
          'Do one thing to a ref from snapshot. Element refs (w3.12): click, double, right, hover, scroll (arg: '
            + 'pixels, default 400), type (arg: text, appended through the input method), settext (arg: text, replaces '
            + 'the value), key (arg: keys like "ctrl+a backspace" or "Enter"), focus, drag (arg: the ref to drop on, '
            + 'an element or a window, also in another window), select (arg: an option\'s value or text of a <select>, '
            + 'or a list of them for a multiple one). Window refs (w3): focus, restore, minimize, fill, fullscreen, '
            + 'close, key. Real input is injected; the answer waits for the page to settle and lists what changed. '
            + 'Closing the only window of a session that runs a single app ends that session; the answer says so.',
        inputSchema: z.object({
          ref: z.string().describe('w3 or w3.12'),
          action: ACTION,
          arg: ARG.optional().describe('text for type / settext, keys for key, pixels for scroll, the target ref for '
            + 'drag, option(s) for select'),
        }),
        annotations: drive,
      },
      (args) => this.#safe(async () =>
        Mcp.#acted(await (await this.#acde()).act(args.ref, args.action, args.arg ?? null))),
    )

    s.registerTool(
      'run',
      {
        description: 'Do several act steps in order, stopping at the first that fails; the answer lists what each did '
          + 'and what changed.',
        inputSchema: z.object({
          steps: z.array(z.object({ ref: z.string(), action: ACTION, arg: ARG.optional() })).min(1),
        }),
        annotations: drive,
      },
      (args) => this.#safe(async () => Mcp.#acted(await (await this.#acde()).run(args.steps))),
    )

    s.registerTool(
      'open',
      {
        description: 'Open an app (by id or name; native programs too where the session has them) and wait for its '
          + 'window; answers with the new window and its elements.',
        inputSchema: z.object({ app: z.string().describe('app id (ledger) or name') }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          const window = await (await this.#acde()).open(args.app)
          const info = await window.info()
          const title = info.title ? ` ${JSON.stringify(info.title)}` : ''
          return Mcp.#text(`opened ${args.app}: ${info.ref}${title}\n\n${await window.snapshot()}`)
        }),
    )

    s.registerTool(
      'screenshot',
      {
        description: "A PNG in device pixels of one window's page (the desktop's includes its panels), or of the whole "
          + "screen with every window composed (target screen). Default: the focused window.",
        inputSchema: z.object({
          target: z.string().optional().describe('screen, a window ref (w3), a web name (ledger#1048576), an app id, '
            + 'or desktop'),
          path: z.string().optional().describe('also write the PNG to this file (relative to the working directory)'),
        }),
        annotations: look,
      },
      (args) =>
        this.#safe(async () => {
          const acde = await this.#acde()
          const path = args.path === undefined ? {} : { path: resolve(this.#cwd, args.path) }
          const web = args.target === 'screen' ? 'screen' : await this.#web(acde, args.target)
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

    s.registerTool(
      'eval',
      {
        description: "Evaluate JavaScript in a page (a promise is awaited) and answer its value as JSON. The page's "
          + "own globals and DOM are there; acde: modules are imported with import(). Default: the focused window's "
          + "page.",
        inputSchema: z.object({
          code: z.string().describe('an expression, or statements whose last expression is the value'),
          target: z.string().optional().describe('a window ref (w3), a web name, an app id, or desktop'),
        }),
        annotations: { ...drive, destructiveHint: true },
      },
      (args) =>
        this.#safe(async () => {
          const acde = await this.#acde()
          const value = await acde.evaluate(await this.#web(acde, args.target), args.code)
          return Mcp.#text(JSON.stringify(value, null, 2) ?? 'null')
        }),
    )

    s.registerTool(
      'wait_for',
      {
        description: 'Wait until an element whose name or value contains text is shown (or, with gone, until none is), '
          + 'in a window or any visible one; answers with the matching elements.',
        inputSchema: z.object({
          text: z.string().min(1),
          gone: z.boolean().optional().describe('wait for it to disappear instead'),
          window: z.string().optional().describe('a window ref (w3); default: every visible window'),
          timeout_ms: z.number().int().min(0).max(120_000).optional().describe('default 5000'),
        }),
        annotations: look,
      },
      (args) => this.#safe(async () => this.#waitFor(args)),
    )

    s.registerTool(
      'query',
      {
        description: 'Find elements by CSS selector in a window (default: the focused one), or under an element ref; '
          + 'one line per element as snapshot prints it (role, name, value, a heading\'s level, states, ref), then '
          + 'its tag ([hidden] when not rendered). The refs work with act.',
        inputSchema: z.object({
          selector: z.string().min(1).describe('a CSS selector, e.g. form input[type=email] or [data-testid="save"]'),
          window: z.string().optional().describe('a window ref (w3)'),
          ref: z.string().optional().describe('an element ref (w3.12): search only under it'),
          limit: z.number().int().min(1).max(3000).optional().describe('most elements (default 600)'),
        }),
        annotations: look,
      },
      (args) =>
        this.#safe(async () => Mcp.#text(Format.matches(await (await this.#acde()).query(args), args.selector))),
    )

    s.registerTool(
      'console',
      {
        description: "The pages' console.* lines and uncaught errors / unhandled rejections, oldest first, with the "
          + "page each came from. next is what to pass as since to read only newer ones.",
        inputSchema: z.object({
          web: z.string().optional().describe('only this page: a web name, an app id, or desktop'),
          level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'errors']).optional().describe('errors: '
            + 'console.error and uncaught errors'),
          since: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(5000).optional().describe('the newest this many (default 500)'),
        }),
        annotations: look,
      },
      (args) => this.#safe(async () => Mcp.#entries(await (await this.#acde()).console(args), Format.console)),
    )

    s.registerTool(
      'network',
      {
        description: "The pages' requests (fetch, XHR, WebSocket, EventSource, and loads of images, stylesheets "
          + 'and fonts): method, status (ERR when it failed, ... while open), URL, kind, response size, time, '
          + 'error, page. next is what to pass as since.',
        inputSchema: z.object({
          web: z.string().optional().describe('only this page: a web name, an app id, or desktop'),
          failed: z.boolean().optional().describe('only failed requests and status 400 or more'),
          since: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(5000).optional().describe('the newest this many (default 500)'),
        }),
        annotations: look,
      },
      (args) => this.#safe(async () => Mcp.#entries(await (await this.#acde()).network(args), Format.request)),
    )

    s.registerTool(
      'emulate',
      {
        description: 'Switch the colour scheme (prefers-color-scheme) or reduced motion (prefers-reduced-motion) for '
          + 'every page; system goes back to what the system says.',
        inputSchema: z.object({
          colorScheme: z.enum(['light', 'dark', 'system']).optional(),
          reducedMotion: z.enum(['reduce', 'no-preference', 'system']).optional(),
        }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          const state = await (await this.#acde()).emulate({
            ...(args.colorScheme !== undefined
              && { colorScheme: args.colorScheme === 'system' ? null : args.colorScheme }),
            ...(args.reducedMotion !== undefined
              && { reducedMotion: args.reducedMotion === 'system' ? null : args.reducedMotion === 'reduce' }),
          })
          const scheme = `${state.colorScheme}${state.emulated ? ' (emulated)' : ''}`
          return Mcp.#text(`colour scheme ${scheme}, reduced motion ${state.reducedMotion ? 'on' : 'off'}`)
        }),
    )

    s.registerTool(
      'choose_folder',
      {
        description: 'Answer the next folder chooser a page opens (showDirectoryPicker) without showing it: a folder, '
          + 'or cancel. Without a host window (headless) a chooser fails unless answered first.',
        inputSchema: z.object({
          path: z.string().optional().describe('the folder, relative to the working directory'),
          cancel: z.boolean().optional().describe('answer as if the user cancelled'),
        }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          if ((args.path === undefined) === (args.cancel !== true))
            throw new Error('choose_folder: give a path, or cancel: true')
          const folder = args.cancel ? null : resolve(this.#cwd, args.path!)
          await (await this.#acde()).chooseFolder(folder)
          return Mcp.#text(folder === null
            ? 'the next folder chooser will be cancelled'
            : `the next folder chooser will answer ${folder}`)
        }),
    )

    s.registerTool(
      'choose_files',
      {
        description: 'Answer the next file chooser a page opens (showOpenFilePicker, <input type=file>) without '
          + 'showing it: one or more files, or cancel. Without a host window (headless) a chooser fails unless '
          + 'answered first.',
        inputSchema: z.object({
          paths: z.array(z.string()).min(1).optional().describe('the files, relative to the working directory'),
          cancel: z.boolean().optional().describe('answer as if the user cancelled'),
        }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          if ((args.paths === undefined) === (args.cancel !== true))
            throw new Error('choose_files: give paths, or cancel: true')
          const files = args.cancel ? null : args.paths!.map((path) => resolve(this.#cwd, path))
          await (await this.#acde()).chooseFiles(files)
          return Mcp.#text(files === null
            ? 'the next file chooser will be cancelled'
            : `the next file chooser will answer ${files.join(', ')}`)
        }),
    )

    s.registerTool(
      'choose_save_file',
      {
        description: 'Answer the next save chooser a page opens (showSaveFilePicker) without showing it: the file to '
          + 'save to, or cancel. Without a host window (headless) a chooser fails unless answered first.',
        inputSchema: z.object({
          path: z.string().optional().describe('the file, relative to the working directory'),
          cancel: z.boolean().optional().describe('answer as if the user cancelled'),
        }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          if ((args.path === undefined) === (args.cancel !== true))
            throw new Error('choose_save_file: give a path, or cancel: true')
          const file = args.cancel ? null : resolve(this.#cwd, args.path!)
          await (await this.#acde()).chooseSaveFile(file)
          return Mcp.#text(file === null
            ? 'the next save chooser will be cancelled'
            : `the next save chooser will answer ${file}`)
        }),
    )

    s.registerTool(
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
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          const url = args.regex ? new RegExp(args.url) : args.url
          const response = args.abort !== undefined && args.abort !== false
            ? { abort: args.abort }
            : {
              ...(args.status !== undefined && { status: args.status }),
              ...(args.headers && { headers: args.headers }),
              ...(args.body !== undefined && { body: args.body }),
              ...(args.json !== undefined && { json: args.json }),
            }
          const id = await (await this.#acde()).route(url, response, {
            ...(args.method && { method: args.method }),
            ...(args.target && { web: args.target }),
            ...(args.times && { times: args.times }),
          })
          const answers = 'abort' in response
            ? `fails (${response.abort === true ? 'aborted' : response.abort})`
            : `${args.status ?? 200}`
          const times = args.times ? `, ${args.times} time${args.times === 1 ? '' : 's'}` : ''
          const target = url instanceof RegExp ? String(url) : url
          return Mcp.#text(`route ${id}: ${args.method ?? 'any method'} ${target} → ${answers}${times}`)
        }),
    )

    s.registerTool(
      'unroute',
      {
        description: 'Take a route away by id, or all of them.',
        inputSchema: z.object({ id: z.number().int().optional().describe('the id route answered; leave out to remove '
          + 'every route') }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          const done = await (await this.#acde()).unroute(args.id)
          return Mcp.#text(`removed ${done.removed} route${done.removed === 1 ? '' : 's'}, ${done.left} left`)
        }),
    )

    s.registerTool(
      'pointer',
      {
        description: 'Move the pointer to a point on the screen, as a real move: hover effects and screen edge events '
          + '(a desktop that shows its Dock at an edge) follow. Coordinates are logical pixels of the screen (a host '
          + 'window: its content area); to hover an element use act hover on its ref instead.',
        inputSchema: z.object({ x: z.number().describe('screen x'), y: z.number().describe('screen y') }),
        annotations: drive,
      },
      (args) =>
        this.#safe(async () => {
          const at = await (await this.#acde()).pointer(args.x, args.y)
          return Mcp.#text(`the pointer is at ${at.x}, ${at.y}`)
        }),
    )

    s.registerTool(
      'clipboard',
      {
        description: 'Read the clipboard the pages see, or write text to it first. A headless session keeps a '
          + 'clipboard of its own; with a window on screen it is the user\'s system clipboard, which may hold their '
          + 'private data, so there it needs system: true (ask the user first).',
        inputSchema: z.object({
          text: z.string().optional().describe('write this first'),
          system: z.boolean().optional()
            .describe('allow touching the user\'s system clipboard (sessions with a window)'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) =>
        this.#safe(async () => {
          const acde = await this.#acde()
          if (!acde.session.headless && args.system !== true) {
            throw new Error(`clipboard: acde dev ${acde.session.pid} has a window on screen, so its clipboard is the `
              + 'user\'s system clipboard; ask the user, then call again with system: true (or use a session started '
              + 'with headless: true)')
          }
          if (args.text !== undefined) await acde.setClipboard(args.text)
          return Mcp.#text(JSON.stringify(await acde.clipboard()))
        }),
    )

    PageTools.register(s, {
      page: async (target) => {
        const acde = await this.#acde()
        return { acde, web: await this.#web(acde, target) }
      },
      safe: (work) => this.#safe(work),
      text: (text) => Mcp.#text(text),
      acted: (result) => Mcp.#acted(result),
    })

    s.registerTool(
      'logs',
      {
        description: 'Output of the acde dev that start ran and of its acdert: builds, reloads, page console.* (target '
          + 'js), page errors ([app#window] page error: …), app backends ([app#backend]). Answers the last lines, or '
          + 'those from since on; next is what to pass as since to read only newer ones.',
        inputSchema: z.object({
          tail: z.number().int().min(1).max(5000).optional().describe('how many lines (default 100)'),
          since: z.number().int().min(1).optional().describe('only lines from this number on (the next of an earlier '
            + 'answer)'),
          grep: z.string().optional().describe('only lines matching this regular expression (case-insensitive)'),
        }),
        annotations: look,
      },
      (args) => this.#safe(async () => this.#logs(args)),
    )
  }

  async #acde(): Promise<Acde> {
    const launched = this.#launched
    if (launched && (this.#pinned === undefined || this.#pinned === launched.session.pid)) {
      if (!launched.closed) return launched
      this.#launched = null
      this.#pinned = undefined
      const last = launched.logs!.tail(30).text
      throw new Error(`the acde dev started here (pid ${launched.session.pid}) stopped; last output:\n${last}`)
    }
    const attached = this.#attached
    if (attached && !attached.closed && (this.#pinned === undefined || this.#pinned === attached.session.pid))
      return attached
    const stopped = attached?.closed ? attached.session.pid : undefined
    await attached?.close()
    this.#attached = null
    if (stopped !== undefined) await Mcp.#delisted(stopped)
    try {
      this.#attached = await Acde.attach({
        cwd: this.#cwd,
        ...(this.#pinned !== undefined && { session: this.#pinned }),
      })
    } catch (error) {
      if (stopped === undefined) throw error
      throw new Error(`acde dev ${stopped} stopped; ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.#attached
  }

  static async #delisted(pid: number): Promise<void> {
    const listed = () => Sessions.list().some((session) => session.pid === pid)
    for (const until = Date.now() + Mcp.DELISTED_MS; listed() && Date.now() < until;) await sleep(20)
  }

  async #web(acde: Acde, target: string | undefined): Promise<string> {
    if (target !== undefined && !/^w\d+$/.test(target)) return target
    const windows = await acde.windows()
    const window = target === undefined
      ? (windows.find((w) => w.focus && !w.hidden) ?? windows.find((w) => w.kind === 'desktop'))
      : windows.find((w) => w.ref === target)
    if (!window) throw new Error(target === undefined ? 'no window to show' : `no window ${target}`)
    if (window.kind === 'native')
      throw new Error(`${window.ref} is a native window; screenshot and eval reach pages only`)
    return (await acde.webOf(window.id)).name
  }

  #sessions(use: number | undefined): Result {
    const sessions = Sessions.list()
    if (use !== undefined) {
      if (!sessions.some((s) => s.pid === use)) {
        const running = sessions.length ? `; running: ${sessions.map((s) => s.pid).join(', ')}` : ''
        throw new Error(`no acde dev with pid ${use}${running}`)
      }
      this.#pinned = use
    }
    if (!sessions.length) return Mcp.#text(`no acde dev is running; start runs one here (${this.#cwd})`)
    const current = this.#pinned ?? this.#current()
    const lines = sessions.map((s) =>
      `${s.pid === current ? '*' : ' '} ${Sessions.describe(s)}`
        + `${s.pid === this.#launched?.session.pid ? '  [started here]' : ''}`)
    const note = current === undefined
      ? `(several sessions and none holds ${this.#cwd}: pass use)`
      : '(* is the one the tools use)'
    return Mcp.#text(`${lines.join('\n')}\n${note}`)
  }

  #current(): number | undefined {
    try {
      return Sessions.pick(Sessions.list(), this.#cwd).pid
    } catch {
      return undefined
    }
  }

  async #start(args: {
    dirs?: string[] | undefined
    desktop?: string | undefined
    app?: string | undefined
    headless?: boolean | undefined
  }): Promise<Result> {
    if (this.#launched && !this.#launched.closed)
      throw new Error(`acde dev ${this.#launched.session.pid} started here is running; stop it first`)
    const acde = await Acde.launch({
      cwd: this.#cwd,
      ...(args.dirs !== undefined && { dirs: args.dirs }),
      ...(args.desktop !== undefined && { desktop: args.desktop }),
      ...(args.app !== undefined && { app: args.app }),
      ...(args.headless === true && { headless: true }),
    })
    this.#launched = acde
    this.#pinned = acde.session.pid
    const runs = acde.session.desktop ? `desktop ${acde.session.desktop}` : `app ${acde.session.apps.join(', ')}`
    const what = `${runs}${args.headless ? ' without a window (headless)' : ''}`
    const webs = await Mcp.#webs(acde)
    return Mcp.#text(`acde dev ${acde.session.pid} runs ${what} (${acde.session.dirs.join(', ')})\n\n${webs}`)
  }

  async #stop(): Promise<Result> {
    const launched = this.#launched
    if (!launched) throw new Error('start did not run an acde dev here')
    await launched.close()
    this.#launched = null
    if (this.#pinned === launched.session.pid) this.#pinned = undefined
    return Mcp.#text(`stopped acde dev ${launched.session.pid}`)
  }

  async #waitFor(args: {
    text: string
    gone?: boolean | undefined
    window?: string | undefined
    timeout_ms?: number | undefined
  }): Promise<Result> {
    const acde = await this.#acde()
    const timeout = args.timeout_ms ?? Acde.TIMEOUT_MS
    let last = ''
    await Poll.until(
      timeout,
      async () => {
        const snapshot = await acde.snapshot({
          find: args.text,
          ...(args.window !== undefined && { window: args.window }),
        })
        last = snapshot.text
        const shown = Object.keys(snapshot.trees).length > 0
        return shown !== (args.gone === true) || null
      },
      () => `waited ${timeout} ms: ${JSON.stringify(args.text)} ${args.gone ? 'is still shown' : 'did not appear'}`
        + `\n\n${last}`,
    )
    return Mcp.#text(args.gone ? `${JSON.stringify(args.text)} is gone` : last)
  }

  #logs(args: { tail?: number | undefined; since?: number | undefined; grep?: string | undefined }): Result {
    const launched = this.#launched
    if (!launched?.logs) {
      throw new Error('logs has the output of an acde dev that start ran; this session was started elsewhere, '
        + 'its output is in that terminal')
    }
    const grep = args.grep === undefined ? undefined : new RegExp(args.grep, 'i')
    const slice = args.since !== undefined
      ? launched.logs.since(args.since, { limit: args.tail ?? 5000, ...(grep && { grep }) })
      : launched.logs.tail(args.tail ?? 100, grep ? { grep } : {})
    const dropped = slice.dropped ? ` (${slice.dropped} older lines were dropped)` : ''
    const head = `next: ${slice.next}${dropped}${launched.closed ? ' (acde dev has exited)' : ''}`
    return Mcp.#text(slice.lines.length ? `${head}\n${slice.text}` : `${head}\n(no lines)`)
  }

  async #safe(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work()
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text }], isError: true }
    }
  }

  static async #webs(acde: Acde): Promise<string> {
    const webs = await acde.webs()
    const waiting = webs.length === 0 ? await Approvals.waiting(acde, ANSWER) : []
    return [Format.webs(webs), ...waiting].join('\n')
  }

  static #entries<T>(page: DevPage<T>, line: (entry: T) => string): Result {
    const head = `next: ${page.next}${page.dropped ? ` (${page.dropped} older entries were dropped)` : ''}`
    return Mcp.#text(page.entries.length ? `${head}\n${page.entries.map(line).join('\n')}` : `${head}\n(nothing)`)
  }

  static #acted(result: ActResult): Result {
    return { content: [{ type: 'text', text: result.text }], ...(!result.ok && { isError: true }) }
  }

  static #text(text: string): Result {
    return { content: [{ type: 'text', text }] }
  }
}
