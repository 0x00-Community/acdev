import type { ShellModule } from '@dopame/acde-api/manifest'
import type { NativeApps } from '../../launcher'
import type { AnimateOptions, BrokerShell } from '../types'

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
  windows(): unknown
  hide(id: number, hidden: boolean): void
  close(id: number): unknown
  kill(id: number): unknown
}

export class ServiceModules {
  readonly #host: ServiceModulesHost

  constructor(host: ServiceModulesHost) {
    this.#host = host
  }

  module(name: ShellModule): object | null {
    const host = this.#host
    switch (name) {
      case 'session':
        return host.session()
      case 'desktops':
        return host.desktops()
      case 'inspect':
        return host.inspect()
      case 'setDefault':
        return (mime: string, handler: string) => host.setDefault(String(mime), String(handler))
      case 'desktop':
        return { apps: async () => ({ apps: host.apps() }) }
      case 'packages':
        return {
          refresh: () => host.refresh(),
          install: (dir: string) => host.install(String(dir)),
          natives: () => host.natives.list(),
          runNative: (id: string) => {
            const file = host.natives.file(String(id))
            if (!file) throw Object.assign(new Error(`no native app ${String(id)}`), { status: 404 })
            return host.shell.launch(['gio', 'launch', file])
          },
        }
      case 'windows':
        return {
          list: () => host.windows(),
          focus: (id: number) => host.shell.focus(Number(id)),
          hide: (id: number) => host.hide(Number(id), true),
          show: (id: number) => host.hide(Number(id), false),
          close: (id: number) => host.close(Number(id)),
          kill: (id: number) => host.kill(Number(id)),
          stats: () => host.shell.stats(),
          animate: (id: number, options: AnimateOptions) => host.shell.animate(Number(id), options ?? {}),
        }
    }
    return null
  }
}
