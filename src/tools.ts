import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DevClient } from './ipc.ts'
import { Sessions, type Session } from './sessions.ts'

interface Web {
  readonly name: string
  readonly app: string | null
  readonly kind: string
  readonly window: number
  readonly title: string | null
}

export class Tools {
  static readonly COMMANDS = new Set(['webs', 'eval', 'shot', 'inspect', 'act'])

  static async run(command: string, args: readonly string[], flags: ReadonlyMap<string, string>): Promise<number> {
    const session = Sessions.pick(Sessions.list(), process.cwd(), Tools.#pid(flags.get('session')))
    const client = await Tools.#connect(session)
    try {
      switch (command) {
        case 'webs':
          return Tools.#webs(await client.request('webs'))
        case 'eval':
          return Tools.#eval(await client.request('eval', { web: args[0]!, code: args[1] === '-' ? await Bun.stdin.text() : args[1]! }))
        case 'shot':
          return Tools.#shot(args[0]!, flags.get('output'), await client.request('shot', { web: args[0]! }))
        case 'inspect':
          return Tools.#text(await client.request('snapshot', { ...(flags.has('window') && { window: flags.get('window') }), ...(flags.has('find') && { find: flags.get('find') }), ...(flags.has('all') && { all: true }) }))
        case 'act':
          return Tools.#text(await client.request('act', { ref: args[0]!, action: args[1]!, ...(args[2] !== undefined && { arg: args[2] }) }))
        default:
          throw new Error(`no tool ${command}`)
      }
    } finally {
      client.close()
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

  static #pid(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`--session ${value}: the process id of an acde dev`)
    return pid
  }

  static async #connect(session: Session): Promise<DevClient> {
    try {
      return await DevClient.connect(session.endpoint)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        Sessions.remove(session.pid)
        throw new Error(`acde dev ${session.pid} is gone (nothing answers on ${session.endpoint})`)
      }
      throw error
    }
  }

  static #webs(result: unknown): number {
    const webs = (result as { webs?: Web[] } | null)?.webs
    if (!Array.isArray(webs)) throw new Error(`acdert answered webs with ${JSON.stringify(result)}`)
    console.log(Tools.table(webs))
    return 0
  }

  static #eval(result: unknown): number {
    console.log(JSON.stringify((result as { value?: unknown } | null)?.value ?? null, null, 2))
    return 0
  }

  static #shot(web: string, output: string | undefined, result: unknown): number {
    const png = (result as { png?: unknown } | null)?.png
    if (typeof png !== 'string') throw new Error(`acdert answered shot with no png`)
    const file = resolve(output ?? Tools.fileFor(web))
    writeFileSync(file, Buffer.from(png, 'base64'))
    console.log(file)
    return 0
  }

  static #text(result: unknown): number {
    const answer = result as { text?: unknown; ok?: unknown } | null
    if (typeof answer?.text !== 'string') throw new Error(`acdert answered with ${JSON.stringify(result)}`)
    console.log(answer.text)
    return answer.ok === false ? 1 : 0
  }
}
