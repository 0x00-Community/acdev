import { mkdirSync } from './sys/fs'
import { xdgHome } from './sys/os'
import { join } from './sys/path'
import { pathToFileURL } from './sys/url'
import type { ServiceFactory, ServiceInstance, ServiceProcess, ShellModule, SpawnOptions } from '@dopame/acde-api'
import { SHELL_MODULES } from '@dopame/acde-api/manifest'
import type { Native } from './native'
import type { InstalledDesktop, InstalledService } from './packages'
import { process, stopGroup } from './sys/process'
import { Level, Log } from './log'
import { sys } from './sys/natives'

interface Running {
  readonly name: string
  readonly instance: ServiceInstance
  readonly namespaces: readonly string[]
  readonly processes: Set<number>
}

class Processes {
  static readonly STOP_MS = 3000

  static spawn(service: string, processes: Set<number>, argv: readonly string[], options: SpawnOptions = {}): ServiceProcess {
    const native = sys()
    if (!native.spawn || !native.write || !native.endInput) throw new Error('spawn: this acde cannot start processes')
    const pid = native.spawn(
      argv,
      {
        cwd: options.cwd,
        env: { ...options.env },
        prefix: `[${service}] `,
        stdin: true,
        onStdout: options.onLine ? (line) => options.onLine!(line) : undefined,
      },
      (code, signal) => {
        processes.delete(pid)
        options.onExit?.(code, signal)
      },
    )
    processes.add(pid)
    return {
      pid,
      write: (text) => native.write!(pid, text),
      end: () => native.endInput!(pid),
      kill: (signal = 'SIGTERM') => native.kill(-pid, signal),
    }
  }

  static stop(processes: Set<number>): void {
    for (const pid of [...processes]) stopGroup(pid, () => processes.has(pid), Processes.STOP_MS)
  }
}

export class DesktopServices {
  static readonly RESERVED: ReadonlySet<string> = new Set([
    ...['windows', 'apps', 'window', 'open', 'desktop', 'desktops', 'session', 'debug', 'inspect'],
    ...['packages', 'launch', 'openPath', 'handlers', 'setDefault', 'capabilities'],
  ])

  readonly #running: Running[] = []
  readonly capability = new Map<string, string>()
  readonly sync = new Set<string>()
  inspect: object | null = null
  shell: { module(name: ShellModule, service: string): object | null; release(service: string): void } | null = null

  async start(desktop: InstalledDesktop, native: Native, value: Record<string, unknown>, before: Promise<unknown> = Promise.resolve()): Promise<void> {
    const state = xdgHome('state')
    const owner = desktop.package.name.replace(/^@/, '').replace(/[^\w.-]+/g, '-')
    const started = await Promise.all(
      desktop.services.map(async (service) => {
        const log = (line: string) => Log.write(Level.Warn, 'acde_host', `[${service.name}] ${line}`)
        const processes = new Set<number>()
        const spawn = (argv: readonly string[], options?: SpawnOptions) => Processes.spawn(service.name, processes, argv, options)
        try {
          const module = (await import(pathToFileURL(join(desktop.package.dir, service.module)).href)) as { default?: ServiceFactory }
          if (typeof module.default !== 'function') throw new Error(`${service.module} has no default export function`)
          const dir = join(state, 'acde', owner, service.name)
          mkdirSync(dir, { recursive: true })
          const context = {
            name: service.name,
            package: desktop.package.dir,
            state: dir,
            native: native as unknown as Record<string, unknown>,
            env: process.env,
            log,
            spawn,
            import: ((specifier: string) => this.#import(service, specifier)) as never,
            ...(this.inspect ? { inspect: this.inspect as never } : {}),
          }
          return { name: service.name, log, processes, instance: await module.default(context) }
        } catch (error) {
          log(`not started: ${(error as Error).stack ?? error}`)
          Processes.stop(processes)
          this.shell?.release(service.name)
          return null
        }
      }),
    )
    await before
    for (const { name, log, instance, processes } of started.filter((s) => s !== null)) {
      const namespaces = Object.keys(instance.api ?? {}).filter((ns) => {
        if (!(ns in value) && !DesktopServices.RESERVED.has(ns)) return true
        log(`acde.${ns} is taken; left out`)
        return false
      })
      for (const ns of namespaces) {
        value[ns] = instance.api[ns]
        this.capability.set(ns, name)
      }
      for (const sync of instance.sync ?? []) if (namespaces.includes(sync.split('.')[0]!)) this.sync.add(sync)
      this.#running.push({ name, instance, namespaces, processes })
    }
  }

  running(name: string): boolean {
    return this.#running.some((service) => service.name === name)
  }

  async #import(service: InstalledService, specifier: string): Promise<object> {
    const name = String(specifier).replace(/^acde:/, '') as ShellModule
    if (!SHELL_MODULES.includes(name)) {
      throw new TypeError(`import(${specifier}): a service imports shell modules (${SHELL_MODULES.map((m) => `acde:${m}`).join(', ')})`)
    }
    if (!service.modules.includes(name)) {
      throw new TypeError(`acde:${name} is a shell module: list it in the modules of service ${JSON.stringify(service.name)} in the desktop manifest`)
    }
    const value = this.shell?.module(name, service.name)
    if (!value) throw new TypeError(`acde:${name} is not available to services here`)
    return { [name]: value, default: value }
  }

  async stop(value: Record<string, unknown>): Promise<void> {
    for (const running of this.#running.splice(0).reverse()) {
      for (const ns of running.namespaces) {
        delete value[ns]
        this.capability.delete(ns)
      }
      try {
        await running.instance.close?.()
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `[${running.name}] close: ${(error as Error).message}`)
      }
      Processes.stop(running.processes)
      this.shell?.release(running.name)
    }
    this.sync.clear()
  }
}
