import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { InspectAction } from '@acde/api'
import { ACTIONS, Acde } from '../driver/acde.ts'
import { Format } from '../driver/format.ts'
import { Poll } from '../driver/poll.ts'
import type { PageToolsHost } from '../mcppage.ts'
import type { Result } from '../mcp.ts'
import { Tools } from '../tools.ts'

const ACTION = z.enum(ACTIONS as [InspectAction, ...InspectAction[]])
const ARG = z.union([z.string(), z.number(), z.array(z.string())])
const LOOK = { readOnlyHint: true, openWorldHint: false }
const DRIVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export function registerInspecting(server: McpServer, host: PageToolsHost): void {
  server.registerTool(
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
      annotations: LOOK,
    },
    (args) => host.safe(async () => host.text((await (await host.acde()).snapshot(args)).text)),
  )

  server.registerTool(
    'act',
    {
      description:
        'Do one thing to a ref from snapshot. Element refs (w3.12): click, double, right, hover, scroll (arg: '
          + 'pixels, default 400), type (arg: text, appended through the input method), settext (arg: text, replaces '
          + 'the value), key (arg: keys like "ctrl+a backspace" or "Enter"), focus, drag (arg: the ref to drop on, '
          + 'an element or a window, also in another window), select (arg: an option\'s value or text of a <select>, '
          + 'or a list of them for a multiple one). Window refs (w3): focus, restore, minimize, fill, fullscreen, '
          + 'close, key, move (arg: screen "x,y", keeps the size), resize (arg: "WxH", keeps the place), raise '
          + '(to the front). Only a normal window moves or resizes; the desktop, a minimized, filled or full-screen '
          + 'window and a single-app window are refused with the reason. drag holds the button 150 ms, moves in '
          + 'steps and rests a frame before letting go; to place a window exactly, use move. Real input is '
          + 'injected; the answer waits for the page to settle and lists what changed. '
          + 'Closing the only window of a session that runs a single app ends that session; the answer says so.',
      inputSchema: z.object({
        ref: z.string().describe('w3 or w3.12'),
        action: ACTION,
        arg: ARG.optional().describe('text for type / settext, keys for key, pixels for scroll, the target ref for '
          + 'drag, option(s) for select, screen "x,y" for move, "WxH" for resize'),
      }),
      annotations: DRIVE,
    },
    (args) => host.safe(async () =>
      host.acted(await (await host.acde()).act(args.ref, args.action, args.arg ?? null))),
  )

  server.registerTool(
    'run',
    {
      description: 'Do several act steps in order, stopping at the first that fails; the answer lists what each did '
        + 'and what changed.',
      inputSchema: z.object({
        steps: z.array(z.object({ ref: z.string(), action: ACTION, arg: ARG.optional() })).min(1),
      }),
      annotations: DRIVE,
    },
    (args) => host.safe(async () => host.acted(await (await host.acde()).run(args.steps))),
  )

  server.registerTool(
    'open',
    {
      description: 'Open an app (by id or name; native programs too where the session has them) and wait for its '
        + 'window; answers with the new window and its elements. With path (a file or folder) or url (http, https) it opens '
        + 'that as the desktop does (acde:open): with its default app, or with app.',
      inputSchema: z.object({
        app: z.string().optional().describe('app id (ledger) or name'),
        path: z.string().optional().describe('a file or folder: absolute (the guest\'s in a guest session), or relative to '
          + 'the working directory on the host'),
        url: z.string().optional().describe('an http or https link'),
      }),
      annotations: DRIVE,
    },
    (args) =>
      host.safe(async () => {
        const acde = await host.acde()
        if (args.path !== undefined || args.url !== undefined) {
          const given = { ...(args.app && { name: args.app }), ...(args.path && { path: args.path }), ...(args.url && { url: args.url }) }
          const result = await acde.openWith(Tools.located(given, acde.guest, host.cwd))
          return host.acted(result)
        }
        if (!args.app) throw new Error('open: give app, path or url')
        const window = await acde.open(args.app)
        const info = await window.info()
        const title = info.title ? ` ${JSON.stringify(info.title)}` : ''
        return host.text(`opened ${args.app}: ${info.ref}${title}\n\n${await window.snapshot()}`)
      }),
  )

  server.registerTool(
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
      annotations: LOOK,
    },
    (args) => host.safe(async () => waitFor(host, args)),
  )

  server.registerTool(
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
      annotations: LOOK,
    },
    (args) =>
      host.safe(async () => host.text(Format.matches(await (await host.acde()).query(args), args.selector))),
  )

}

async function waitFor(host: PageToolsHost, args: {
  text: string
  gone?: boolean | undefined
  window?: string | undefined
  timeout_ms?: number | undefined
}): Promise<Result> {
  const acde = await host.acde()
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
  return host.text(args.gone ? `${JSON.stringify(args.text)} is gone` : last)
}