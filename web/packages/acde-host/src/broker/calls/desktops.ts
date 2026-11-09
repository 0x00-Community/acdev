import type { ForeignSession } from '../../foreign'
import { Level, Log } from '../../log'
import { Packages, type InstalledDesktop } from '../../packages'

export interface DesktopsHost {
  packages(): Packages
  standalone(): boolean
  current(): InstalledDesktop
  handOff(session: ForeignSession): void
  replace(next: InstalledDesktop): Promise<void>
}

export class DesktopCalls {
  readonly #host: DesktopsHost

  constructor(host: DesktopsHost) {
    this.#host = host
  }

  readonly api = {
    list: () => {
      const packages = this.#host.packages()
      return {
        desktops: [
          ...packages.desktops().map((d) => ({ kind: d.kind, id: d.id, name: d.name, description: d.description, package: d.package.name })),
          ...packages.sessions().map((s) => ({ kind: s.kind, id: s.id, name: s.name, description: s.description, package: null })),
        ],
        current: this.#host.current().id,
      }
    },
    choose: async (id: string, remember = false): Promise<void> => {
      const next = this.#host.packages().find(String(id))
      if (!next) throw Object.assign(new Error(`no desktop ${id}`), { status: 404 })
      if (next.kind === 'session' && this.#host.standalone()) throw Object.assign(new Error(`acdert app: ${id} is not an acde desktop`), { status: 409 })
      if (remember) Packages.remember(next.id)
      if (next.kind === 'session') return this.#host.handOff(next)
      if (next.id === this.#host.current().id) return
      Log.write(Level.Info, 'acde_host', `switching to desktop ${next.id}`)
      await this.#host.replace(next)
    },
  }
}
