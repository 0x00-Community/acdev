import type { Broker, BrokerShell } from './broker'
import { readdirSync, readFileSync, renameSync, writeFileSync } from './sys/fs'
import { join } from './sys/path'
import { pathToFileURL } from './sys/url'
import { unref } from './sys/timers'

interface DebugApi {
  readonly broker: Broker
  readonly shell: BrokerShell
  isolate(name: string, code: string): Promise<unknown>
  stats(reset?: boolean): Promise<Record<string, unknown>>
  sleep(ms: number): Promise<void>
  readText(path: string): string
  readDir(path: string): string[]
}

export class DebugDir {
  static readonly POLL_MS = 300

  static watch(dir: string, broker: Broker): void {
    const api: DebugApi = {
      broker,
      shell: broker.shell,
      isolate: (name, code) => broker.debugEval(name, code),
      stats: (reset) => broker.debugStats(reset),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      readText: (path) => readFileSync(path, 'utf8'),
      readDir: (path) => readdirSync(path),
    }
    let busy = false
    unref(setInterval(async () => {
      if (busy) return
      busy = true
      try {
        for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
          const file = join(dir, name)
          const ran = `${file}.done`
          renameSync(file, ran)
          let out: unknown
          try {
            const module = (await import(`${pathToFileURL(ran).href}?${Date.now()}`)) as { default: (api: DebugApi) => unknown }
            out = { value: await module.default(api) }
          } catch (error) {
            out = { error: (error as Error)?.stack ?? String(error) }
          }
          writeFileSync(file.replace(/\.mjs$/, '.out'), JSON.stringify(out, null, 2))
        }
      } catch {
      } finally {
        busy = false
      }
    }, DebugDir.POLL_MS))
  }
}
