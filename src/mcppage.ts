import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { Acde, type ActResult } from './driver/acde.ts'
import { Clock } from './driver/clock.ts'
import { Poll } from './driver/poll.ts'
import type { Result } from './mcp.ts'

export interface PageToolsHost {
  page(target: string | undefined): Promise<{ readonly acde: Acde; readonly web: string }>
  safe(work: () => Promise<Result>): Promise<Result>
  text(text: string): Result
  acted(result: ActResult): Result
}

const TARGET = 'a window ref (w3), a web name, an app id, or desktop'
const CHANGES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
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
          + 'hold a key or a button that long). Moves are a frame apart. '
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
        description: "Answer a page's next alert / confirm / prompt before it comes (acdert has no dialog to click: "
          + 'without an answer confirm is false and prompt null), or list the dialogs it showed and how they were '
          + 'answered.',
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
