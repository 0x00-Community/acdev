import { resolve } from 'node:path'
import type { InspectAction } from '@dopame/acde-api'
import { Acde, type ActResult, type ConsoleEntry, type ConsoleLevel, type DevPage, type RequestEntry, type Web } from './driver/acde.ts'

export class Tools {
  static readonly COMMANDS = new Set(['webs', 'eval', 'shot', 'inspect', 'act', 'console', 'network', 'screen'])
  static readonly FOLLOW_MS = 500
  static readonly LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'errors'])

  static async run(command: string, args: readonly string[], flags: ReadonlyMap<string, string>): Promise<number> {
    const session = Tools.pid(flags.get('session'))
    const acde = await Acde.attach(session === undefined ? {} : { session })
    try {
      switch (command) {
        case 'webs':
          console.log(Tools.table(await acde.webs()))
          return 0
        case 'eval':
          console.log(JSON.stringify((await acde.evaluate(args[0]!, args[1] === '-' ? await Bun.stdin.text() : args[1]!)) ?? null, null, 2))
          return 0
        case 'shot':
          console.log((await acde.screenshot(args[0]!, { path: resolve(flags.get('output') ?? Tools.fileFor(args[0]!)) })).path)
          return 0
        case 'inspect':
          console.log((await acde.snapshot({ ...(flags.has('window') && { window: flags.get('window')! }), ...(flags.has('find') && { find: flags.get('find')! }), ...(flags.has('all') && { all: true }), ...(flags.has('offscreen') && { offscreen: true }) })).text)
          return 0
        case 'act':
          return Tools.#acted(await acde.act(args[0]!, args[1]! as InspectAction, args[2]))
        case 'console': {
          const level = flags.get('level')
          if (level !== undefined && !Tools.LEVELS.has(level)) throw new Error(`--level ${level}: one of ${[...Tools.LEVELS].join(', ')}`)
          const options = { ...(flags.has('web') && { web: flags.get('web')! }), ...(level !== undefined && { level: level as ConsoleLevel | 'errors' }) }
          return await Tools.#follow(flags.has('follow'), (since) => acde.console({ ...options, ...(since && { since }) }), Tools.consoleLine)
        }
        case 'network': {
          const options = { ...(flags.has('web') && { web: flags.get('web')! }), ...(flags.has('failed') && { failed: true }) }
          return await Tools.#follow(flags.has('follow'), (since) => acde.network({ ...options, ...(since && { since }) }), Tools.requestLine)
        }
        case 'screen':
          console.log((await acde.screen({ path: resolve(flags.get('output') ?? 'screen.png') })).path)
          return 0
        default:
          throw new Error(`no tool ${command}`)
      }
    } finally {
      await acde.close()
    }
  }

  static consoleLine(e: ConsoleEntry): string {
    const kind = e.kind === 'console' ? e.level : e.kind === 'error' ? 'ERROR' : 'REJECT'
    return `${String(e.seq).padStart(4)} ${kind.padEnd(6)} ${e.web}  ${e.text}`
  }

  static requestLine(e: RequestEntry): string {
    const status = e.error !== null ? 'ERR' : e.status === null ? '...' : String(e.status)
    const size = e.responseBytes === null ? '' : ` ${e.responseBytes} B`
    const ms = e.ms === null ? '' : ` ${Math.round(e.ms)} ms`
    return `${String(e.seq).padStart(4)} ${e.method.padEnd(6)} ${status.padEnd(3)} ${e.url}  (${e.kind}${size}${ms}${e.error !== null ? `; ${e.error}` : ''}) ${e.web}`
  }

  static async #follow<T>(follow: boolean, read: (since: number) => Promise<DevPage<T>>, line: (entry: T) => string): Promise<number> {
    let since = 0
    for (;;) {
      const page = await read(since)
      if (page.dropped) console.log(`… ${page.dropped} older entries were dropped`)
      for (const entry of page.entries) console.log(line(entry))
      since = page.next
      if (!follow) return 0
      await Bun.sleep(Tools.FOLLOW_MS)
    }
  }

  static table(webs: readonly Web[]): string {
    const rows = [['NAME', 'KIND', 'APP', 'WINDOW', 'TITLE'], ...webs.map((w) => [w.name, w.kind, w.app ?? '-', String(w.window), w.title ?? ''])]
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
    return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n')
  }

  static fileFor(web: string): string {
    return `${web.replace(/[<>:"/\\|?*\s]+/g, '-')}.png`
  }

  static pid(value: string): number
  static pid(value: string | undefined): number | undefined
  static pid(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`--session ${value}: the process id of an acde dev`)
    return pid
  }

  static #acted(result: ActResult): number {
    console.log(result.text)
    return result.ok ? 0 : 1
  }
}
