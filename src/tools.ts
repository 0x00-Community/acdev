import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { InspectAction } from '@dopame/acde-api'
import { ACTIONS, Acde, type ConsoleLevel, type DevPage } from './driver/acde.ts'
import { Format } from './driver/format.ts'
import { DevClient } from './ipc.ts'
import { slug } from './paths.ts'
import { Runtime } from './runtime.ts'
import { Sessions } from './sessions.ts'

export class Tools {
  static readonly COMMANDS = new Set(['webs', 'eval', 'shot', 'inspect', 'act', 'console', 'network', 'screen', 'stop'])
  static readonly FOLLOW_MS = 500
  static readonly ENDED_MS = 2_000
  static readonly STOP_MS = 10_000
  static readonly LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'errors'])

  static async run(command: string, args: readonly string[], flags: ReadonlyMap<string, string>): Promise<number> {
    const session = Tools.pid(flags.get('session'))
    if (command === 'act' && !ACTIONS.includes(args[1] as InspectAction))
      throw new Error(`act: ${args[1]} is not an action (${ACTIONS.join(', ')}) (acde act --help)`)
    const level = flags.get('level')
    if (command === 'console' && level !== undefined && !Tools.LEVELS.has(level))
      throw new Error(`console: --level ${level}: one of ${[...Tools.LEVELS].join(', ')} (acde console --help)`)
    if (command === 'stop') return await Tools.#stop(session)
    const acde = await Acde.attach(session === undefined ? {} : { session })
    try {
      switch (command) {
        case 'webs':
          console.log(Format.webs(await acde.webs()))
          return 0
        case 'eval': {
          const code = args[1] === '-' ? await Runtime.readStdin() : args[1]!
          console.log(JSON.stringify((await acde.evaluate(args[0]!, code)) ?? null, null, 2))
          return 0
        }
        case 'shot': {
          const path = resolve(flags.get('output') ?? `${slug(args[0]!)}.png`)
          console.log((await acde.screenshot(args[0]!, { path })).path)
          return 0
        }
        case 'inspect': {
          const find = flags.get('find')
          const snapshot = await acde.snapshot({
            ...(flags.has('window') && { window: flags.get('window')! }),
            ...(find !== undefined && { find }),
            ...(flags.has('all') && { all: true }),
            ...(flags.has('offscreen') && { offscreen: true }),
          })
          if (find === undefined) {
            console.log(snapshot.text)
            return 0
          }
          const found = Format.found(snapshot, find)
          if (found.length) {
            console.log(found.join('\n'))
            return 0
          }
          const hint = flags.has('offscreen') ? '' : '; elements scrolled out of view need --offscreen'
          console.error(`acde: no element's name or value contains ${JSON.stringify(find.trim())}${hint}`)
          return 1
        }
        case 'act': {
          const result = await acde.act(args[0]!, args[1] as InspectAction, args[2]).catch(async (error: unknown) => {
            if (args[1] !== 'close' || !(await Tools.#ended(acde))) throw error
            return null
          })
          if (result === null) {
            console.log(`closed ${args[0]}; acdert exited with it, so acde dev ${acde.session.pid} ended`)
            return 0
          }
          console.log(result.text)
          return result.ok ? 0 : 1
        }
        case 'console': {
          const options = {
            ...(flags.has('web') && { web: flags.get('web')! }),
            ...(level !== undefined && { level: level as ConsoleLevel | 'errors' }),
          }
          const read = (since: number) => acde.console({ ...options, ...(since && { since }) })
          return await Tools.#follow(flags.has('follow'), read, Format.console)
        }
        case 'network': {
          const options = {
            ...(flags.has('web') && { web: flags.get('web')! }),
            ...(flags.has('failed') && { failed: true }),
          }
          const read = (since: number) => acde.network({ ...options, ...(since && { since }) })
          return await Tools.#follow(flags.has('follow'), read, Format.request)
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

  static async #ended(acde: Acde): Promise<boolean> {
    for (const until = Date.now() + Tools.ENDED_MS; !acde.closed && Date.now() < until;) await sleep(20)
    return acde.closed
  }

  static async #stop(pid: number | undefined): Promise<number> {
    const session = Sessions.pick(Sessions.list(), process.cwd(), pid)
    const link = await DevClient.connect(session.endpoint).catch(() => null)
    if (!link) {
      Sessions.remove(session.pid)
      throw new Error(`acde dev ${session.pid} is gone (nothing answers on ${session.endpoint})`)
    }
    link.send({ type: 'quit' })
    await Promise.race([link.closed, sleep(Tools.STOP_MS)])
    link.close()
    const until = Date.now() + Tools.STOP_MS
    while (Sessions.alive(session.pid) && Date.now() < until) await sleep(50)
    if (Sessions.alive(session.pid)) {
      try {
        process.kill(session.pid, 'SIGTERM')
      } catch {}
      console.error(`acde: acde dev ${session.pid} did not end within ${Tools.STOP_MS / 1000} s of quit; ended it`)
    }
    Sessions.remove(session.pid)
    console.log(`acde: stopped acde dev ${session.pid}`)
    return 0
  }

  static async #follow<T>(
    follow: boolean,
    read: (since: number) => Promise<DevPage<T>>,
    line: (entry: T) => string,
  ): Promise<number> {
    let since = 0
    for (;;) {
      const page = await read(since)
      if (page.dropped) console.log(`… ${page.dropped} older entries were dropped`)
      for (const entry of page.entries) console.log(line(entry))
      since = page.next
      if (!follow) return 0
      await sleep(Tools.FOLLOW_MS)
    }
  }

  static pid(value: string): number
  static pid(value: string | undefined): number | undefined
  static pid(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`--session ${value}: the process id of an acde dev`)
    return pid
  }
}
