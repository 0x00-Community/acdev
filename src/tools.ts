import { resolve } from 'node:path'
import type { InspectAction } from '@dopame/acde-api'
import { Acde, type ActResult, type Web } from './driver/acde.ts'

export class Tools {
  static readonly COMMANDS = new Set(['webs', 'eval', 'shot', 'inspect', 'act'])

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
          console.log((await acde.snapshot({ ...(flags.has('window') && { window: flags.get('window')! }), ...(flags.has('find') && { find: flags.get('find')! }), ...(flags.has('all') && { all: true }) })).text)
          return 0
        case 'act':
          return Tools.#acted(await acde.act(args[0]!, args[1]! as InspectAction, args[2]))
        default:
          throw new Error(`no tool ${command}`)
      }
    } finally {
      await acde.close()
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
