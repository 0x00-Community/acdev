import type { McpServer } from '@modelcontextprotocol/server'
import { resolve } from 'node:path'
import * as z from 'zod'
import * as Probe from '../driver/probe/index.ts'
import * as Wait from '../driver/wait/index.ts'
import * as Evidence from '../evidence/index.ts'
import { guestJournal } from '../evidence/guest.ts'
import * as Explain from '../explain/index.ts'
import * as Timeline from '../timeline/index.ts'
import type { PageToolsHost } from '../mcppage.ts'

const LOOK = { readOnlyHint: true, openWorldHint: false }
const KEEPS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const JSON_ANSWER = z.boolean().optional().describe('the whole answer as JSON')

type WaitArgs = {
  readonly condition: Wait.Condition['kind']
  readonly web?: string | undefined
  readonly app?: string | undefined
  readonly window?: string | undefined
  readonly match?: string | undefined
  readonly text?: string | undefined
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly ref?: string | undefined
  readonly selector?: string | undefined
  readonly quiet?: number | undefined
  readonly focused?: boolean | undefined
  readonly gone?: boolean | undefined
  readonly timeout_ms?: number | undefined
}

export function waitArgs(given: WaitArgs): Wait.WaitArgs {
  const byPage = given.app !== undefined || given.window !== undefined
  const positional: Record<Wait.Condition['kind'], (string | undefined)[]> = {
    page: [given.web],
    window: [given.match],
    element: [given.text],
    stable: [],
    'network-idle': [],
    eval: byPage ? [given.code] : [given.web, given.code],
    service: [given.name],
  }
  const named = { web: given.web, app: given.app, window: given.window, ref: given.ref, selector: given.selector }
  const flags = new Map<string, string>(Object.entries(named).filter((e): e is [string, string] => e[1] !== undefined))
  if (given.condition === 'eval' && !byPage) flags.delete('web')
  if (given.quiet !== undefined) flags.set('quiet', String(given.quiet))
  if (given.timeout_ms !== undefined) flags.set('timeout', String(given.timeout_ms))
  if (given.focused) flags.set('focused', '')
  if (given.gone) flags.set('gone', '')
  const args = [given.condition, ...positional[given.condition].filter((a): a is string => a !== undefined)]
  return Wait.fromArgs(args, flags)
}

export function registerChecks(server: McpServer, host: PageToolsHost): void {
  server.registerTool(
    'wait',
    {
      description: 'Wait until a condition holds, without a fixed delay, asking again from every 100 ms up to every 500 ms. '
        + 'Conditions: page (web answers; a page not there yet is waited for), window (match: a ref, app id or title; '
        + 'focused; gone waits for it to go, and gone without match until every window is closed), element (text in a '
        + 'name or value; gone; window), stable (the element tree, or with ref or selector one element\'s place and text, '
        + 'did not change for quiet ms; window), network-idle (no request open for quiet ms; web), eval (code turns true '
        + 'in web, or in the page of app or window), service (name is listed by acde:services; web). Answers with the '
        + 'value it ended on as JSON (what eval gave, {count, texts} of element, the texts stable watched, the window); '
        + 'past timeout_ms (default 30000) it is an error with the last value and what was seen.',
      inputSchema: z.object({
        condition: z.enum(Wait.KINDS as [Wait.Condition['kind'], ...Wait.Condition['kind'][]]),
        web: z.string().optional().describe('page / eval: the web; network-idle, service: the page to look in'),
        app: z.string().optional().describe('eval: the page of this app'),
        window: z.string().optional().describe('eval: the page of this window (ref or title); element, stable: look only there'),
        match: z.string().optional().describe('window: a ref (w3), an app id or a title'),
        text: z.string().optional().describe('element: the text'),
        code: z.string().optional().describe('eval: the expression'),
        name: z.string().optional().describe('service: the service name'),
        ref: z.string().optional().describe('stable: watch only this element (w3.12)'),
        selector: z.string().optional().describe('stable: watch only the elements of this CSS selector'),
        quiet: z.number().int().min(0).optional().describe('stable, network-idle: how long nothing may change (default 500)'),
        focused: z.boolean().optional().describe('window: and it has the focus'),
        gone: z.boolean().optional().describe('window, element: wait for it to go instead'),
        timeout_ms: z.number().int().min(0).max(600_000).optional().describe('default 30000'),
      }),
      annotations: LOOK,
    },
    (args) =>
      host.safe(async () => {
        const { condition, timeout } = waitArgs(args)
        try {
          const { ms, seen, value } = await (await host.acde()).waitFor(condition, timeout)
          return host.text(`${JSON.stringify(value ?? null)}\n\nwaited ${ms} ms for ${Wait.describe(condition)}: ${seen}`)
        } catch (error) {
          if (!(error instanceof Wait.WaitTimeout)) throw error
          throw new Error(`${error.message}\nlast value: ${JSON.stringify(error.value ?? null)}`)
        }
      }),
  )

  server.registerTool(
    'hit',
    {
      description: 'What lies under a screen point: the topmost window there and its part (page, title bar, desktop '
        + 'panel, native window), the point inside it, and on a page the element a click reaches (after '
        + 'pointer-events: none) with its parents and the pointer-events: none elements it passed through, as snapshot '
        + 'refs. A page that went away says so; ask again.',
      inputSchema: z.object({ x: z.number().describe('screen x'), y: z.number().describe('screen y'), json: JSON_ANSWER }),
      annotations: LOOK,
    },
    (args) =>
      host.safe(async () => {
        const hit = await (await host.acde()).hit(args.x, args.y)
        return host.text(args.json ? JSON.stringify(hit, null, 2) : Probe.hitText(hit))
      }),
  )

  server.registerTool(
    'render',
    {
      description: 'The path each page draws on: whether it rasters on the GPU (which adapter) or the CPU, who composes '
        + 'its glass, and one row per layer with a backdrop-filter (glass or frost, its glass group, the element, how it '
        + 'is drawn and why it is degraded: no-gpu, cpu-cannot-refract, group-full).',
      inputSchema: z.object({
        web: z.string().optional().describe('only that page'),
        window: z.string().optional().describe('only the page of that window (w3)'),
        json: JSON_ANSWER,
      }),
      annotations: LOOK,
    },
    (args) =>
      host.safe(async () => {
        const wanted = { ...(args.web !== undefined && { web: args.web }), ...(args.window !== undefined && { window: args.window }) }
        const answers = await Probe.renders(await host.acde(), wanted)
        return host.text(args.json ? JSON.stringify(answers, null, 2) : Probe.renderText(answers))
      }),
  )

  server.registerTool(
    'evidence',
    {
      description: 'Keep what the session shows now, for a failure: a new folder <output>/<UTC time>-<label> (never one '
        + 'that is there) with the screen, the webs, the element tree with every window, the console and the network '
        + 'requests, and in a session in the guest the journal since the given time. Run it right after a step fails.',
      inputSchema: z.object({
        label: z.string().optional().describe('part of the folder name (default evidence)'),
        since: z.string().optional().describe('the journal from: @<unix seconds>, an ISO time, or 5m / 30s ago (default 2m)'),
        output: z.string().optional().describe('the folder, relative to the working directory (default .acde/evidence)'),
      }),
      annotations: KEEPS,
    },
    (args) =>
      host.safe(async () => {
        const acde = await host.acde()
        const root = resolve(host.cwd, args.output ?? Evidence.DEFAULT_ROOT)
        const since = Evidence.since(args.since, new Date())
        const capture = { root, label: args.label ?? 'evidence', since, journal: acde.guest ? guestJournal : null, timeline: Timeline.since(acde) }
        const kept = await Evidence.keep(acde, capture)
        return host.text(Evidence.summary(kept))
      }),
  )

  server.registerTool(
    'explain',
    {
      description: 'Why the system agent decided an operation as it did, for the audit record with that id: the facts it '
        + 'worked from, every rule of the policy in order (its text, whether it hit and why), the action and the rule that '
        + 'chose it, and the model\'s review when a model decided. Only in a session in the guest started by acdev '
        + '(--session vm); a production system has no such explanation and refuses.',
      inputSchema: z.object({ id: z.string().min(1).describe('the audit record\'s id'), json: JSON_ANSWER }),
      annotations: LOOK,
    },
    (args) =>
      host.safe(async () => {
        const explained = await Explain.explain(await host.acde(), args.id)
        return host.text(args.json ? JSON.stringify(explained, null, 2) : Explain.text(args.id, explained))
      }),
  )

  server.registerTool(
    'timeline',
    {
      description: 'One time-ordered list of what happened, each line with its time, source and kind: in a session in '
        + 'the guest the guest journal (the session manager, the compositor, the desktop backend, page processes, with '
        + 'event= lines such as the launcher\'s call tracing), the pages\' console and network requests, and acdev\'s own '
        + 'steps (act, input, wait …). The guest clock is put on the host\'s by one round trip through acdevd; the '
        + 'offset and the round trip are in the header. Default: the last two minutes.',
      inputSchema: z.object({
        since: z.string().optional().describe('from: @<unix seconds>, an ISO time, or 5m / 30s ago (default 2m)'),
        until: z.string().optional().describe('to, in the same forms (default now)'),
        source: z.array(z.enum(Timeline.SOURCES)).optional().describe('only these sources'),
        kind: z.array(z.string()).optional().describe('only these kinds (call, invoke, log, error, fetch, act …)'),
        window: z.string().optional().describe('only events of this window (wN) or page (a web name or app id)'),
        json: JSON_ANSWER,
      }),
      annotations: LOOK,
    },
    (args) =>
      host.safe(async () => {
        const named = { since: args.since, until: args.until, source: args.source?.join(','), kind: args.kind?.join(','), window: args.window }
        const flags = new Map(Object.entries(named).filter((e): e is [string, string] => e[1] !== undefined))
        const { window, filter } = Timeline.fromFlags(flags, Evidence.since)
        const timeline = await Timeline.collect(await host.acde(), window, filter)
        return host.text(args.json ? Timeline.json(timeline) : Timeline.text(timeline))
      }),
  )
}
