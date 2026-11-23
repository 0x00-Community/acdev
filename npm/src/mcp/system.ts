import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { PageToolsHost } from '../mcppage.ts'
import { Sessions, type Session } from '../sessions.ts'

const DRIVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export function clipboardRefusal(session: Session, system: boolean): string | null {
  if (system || session.headless || Sessions.isGuest(session)) return null
  return `clipboard: acdev dev ${session.pid} has a window on screen, so its clipboard is the user's system clipboard; `
    + 'ask the user, then call again with system: true (or use a session started with headless: true; the session in '
    + 'the guest, --session vm, uses the guest\'s own clipboard)'
}

export function registerMachine(server: McpServer, host: PageToolsHost): void {
  server.registerTool(
    'emulate',
    {
      description: 'Switch the colour scheme (prefers-color-scheme) for every page; system goes back to what the '
        + 'system says.',
      inputSchema: z.object({
        colorScheme: z.enum(['light', 'dark', 'system']).optional(),
      }),
      annotations: DRIVE,
    },
    (args) =>
      host.safe(async () => {
        const state = await (await host.acde()).emulate({
          ...(args.colorScheme !== undefined
            && { colorScheme: args.colorScheme === 'system' ? null : args.colorScheme }),
        })
        const scheme = `${state.colorScheme}${state.emulated ? ' (emulated)' : ''}`
        return host.text(`colour scheme ${scheme}`)
      }),
  )

  server.registerTool(
    'pointer',
    {
      description: 'Move the pointer to a point on the screen, as a real move: hover effects and screen edge events '
        + '(a desktop that shows its Dock at an edge) follow. Coordinates are logical pixels of the screen (a host '
        + 'window: its content area); to hover an element use act hover on its ref instead.',
      inputSchema: z.object({ x: z.number().describe('screen x'), y: z.number().describe('screen y') }),
      annotations: DRIVE,
    },
    (args) =>
      host.safe(async () => {
        const at = await (await host.acde()).pointer(args.x, args.y)
        return host.text(`the pointer is at ${at.x}, ${at.y}`)
      }),
  )

  server.registerTool(
    'clipboard',
    {
      description: 'Read the clipboard the pages see, or write text to it first. A headless session keeps a '
        + 'clipboard of its own, and the session in the guest (--session vm) uses the guest\'s own clipboard; with a '
        + 'window on screen it is the user\'s system clipboard, which may hold their private data, so there it needs '
        + 'system: true (ask the user first).',
      inputSchema: z.object({
        text: z.string().optional().describe('write this first'),
        system: z.boolean().optional()
          .describe('allow touching the user\'s system clipboard (host sessions with a window; not needed headless or in the guest)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      host.safe(async () => {
        const acde = await host.acde()
        const refused = clipboardRefusal(acde.session, args.system === true)
        if (refused) throw new Error(refused)
        if (args.text !== undefined) await acde.setClipboard(args.text)
        return host.text(JSON.stringify(await acde.clipboard()))
      }),
  )
}
