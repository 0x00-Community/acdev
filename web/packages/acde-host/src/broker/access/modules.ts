import type { NativeWindow } from '@dopame/acde-api'
import type { ShellModule } from '@dopame/acde-api/manifest'
import type { NativeApps } from '../../launcher'
import { Level, Log } from '../../log'
import { WINDOW_EVENTS, WINDOWS_EVENT_NAMES, type RawShellEvent } from '../../native'
import { Notices } from '../../notices'
import type { BrokerShell } from '../types'

export interface ServiceModulesHost {
  readonly shell: BrokerShell
  readonly natives: NativeApps
  session(): object
  desktops(): object
  inspect(): object
  setDefault(mime: string, handler: string): unknown
  apps(): unknown
  refresh(): unknown
  install(dir: string): unknown
  rows(): NativeWindow[]
  windows(method: string, args: unknown[]): Promise<unknown>
}

export class ServiceModules {
  static readonly #WINDOW_EVENTS: ReadonlySet<string> = new Set(WINDOW_EVENTS)
  static readonly #WINDOW_CALLS = ['kill', 'focus', 'hide', 'show', 'requestState', 'invokeMenu', 'stats', 'animate', 'shortcut', 'unshortcut'] as const
  readonly #host: ServiceModulesHost
  readonly #notices = new Map<string, Notices>()

  constructor(host: ServiceModulesHost) {
    this.#host = host
  }

  emit(event: Readonly<Record<string, unknown>> | RawShellEvent): void {
    const type = String(event.type)
    const name = type === 'appschanged' ? 'apps:changed' : ServiceModules.#WINDOW_EVENTS.has(type) ? `windows:${type.slice('window'.length)}` : null
    if (name) for (const notices of this.#notices.values()) notices.emit(name, event)
  }

  release(service: string): void {
    this.#notices.delete(service)
  }

  static #promised<T extends object>(api: T, plain: readonly string[] = []): T {
    const wrap = (name: string, member: unknown) =>
      typeof member !== 'function' || plain.includes(name) ? member : async (...args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(api, args)
    return Object.fromEntries(Object.entries(api).map(([name, member]) => [name, wrap(name, member)])) as T
  }

  #listeners(service: string): Notices {
    const notices = this.#notices.get(service) ?? new Notices()
    this.#notices.set(service, notices)
    return notices
  }

  module(name: ShellModule, service: string): object | null {
    const host = this.#host
    switch (name) {
      case 'session':
        return ServiceModules.#promised(host.session(), ['own'])
      case 'desktops':
        return ServiceModules.#promised(host.desktops())
      case 'inspect':
        return ServiceModules.#promised(host.inspect())
      case 'setDefault':
        return async (mime: string, handler: string) => host.setDefault(String(mime), String(handler))
      case 'desktop':
        return { apps: async () => ({ apps: host.apps() }) }
      case 'packages':
        return {
          on: this.#listeners(service).for('apps', ['changed']),
          refresh: async () => host.refresh(),
          install: async (dir: string) => host.install(String(dir)),
          natives: async () => host.natives.list(),
          runNative: async (id: string) => {
            const file = host.natives.file(String(id))
            if (!file) throw Object.assign(new Error(`no native app ${String(id)}`), { status: 404 })
            return host.shell.launch(['gio', 'launch', file])
          },
        }
      case 'windows': {
        const call = (method: string) => (...args: unknown[]) => host.windows(method, args)
        const failed = (method: string) => (error: Error) => Log.write(Level.Warn, 'acde_host', `[${service}] windows.${method}: ${error.message}`)
        return {
          on: this.#listeners(service).for('windows', WINDOWS_EVENT_NAMES),
          list: () => host.rows(),
          launch: call('launch'),
          close: (id: number) => void call('close')(id).catch(failed('close')),
          ...Object.fromEntries(ServiceModules.#WINDOW_CALLS.map((method) => [method, call(method)])),
        }
      }
    }
    return null
  }
}
