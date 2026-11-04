import type { Native } from './native'
import type { InstalledDesktop } from './packages'
import { DesktopServices } from './services'
import { Level, Log } from './log'

export class PageBridge {
  readonly #closers: (() => unknown)[] = []
  readonly value: Record<string, unknown> = {}
  readonly services = new DesktopServices()
  #office = false

  available(caps: { fs?: unknown; terminal?: unknown; office?: unknown }): boolean {
    return (!caps.fs || !!this.value['fs']) && (!caps.terminal || !!this.value['terminal']) && (!caps.office || this.#office)
  }

  async start(native: Native, desktop: InstalledDesktop, office: { openOffice(): string | null; closeOffice(): void }): Promise<void> {
    const system = this.#open(native, office)
    await Promise.all([system, this.services.start(desktop, native, this.value, system)])
  }

  async startDesktop(desktop: InstalledDesktop, native: Native): Promise<void> {
    await this.services.stop(this.value)
    await this.services.start(desktop, native, this.value)
  }

  async #open(native: Native, office: { openOffice(): string | null; closeOffice(): void }): Promise<void> {
    const optional = async <T>(name: string, open: () => Promise<T> | T): Promise<T | null> => {
      try {
        return await open()
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `${name} unavailable: ${(error as Error).message}`)
        return null
      }
    }
    const { Terminals, Network } = native
    const [terminal, network] = await Promise.all([
      Terminals ? optional('terminal', () => new Terminals()) : null,
      Network ? optional('network', () => Network.open()) : null,
    ])
    const fs = native.Finder ? await optional('fs', () => new native.Finder!()) : null
    if (fs) this.value['fs'] = fs
    const failed = office.openOffice()
    if (failed === null) {
      this.#office = true
      this.#closers.unshift(() => office.closeOffice())
    } else Log.write(Level.Warn, 'acde_host', `office unavailable: ${failed}`)
    if (terminal) {
      this.value['terminal'] = terminal
      this.#closers.unshift(() => terminal.closeAll())
    }
    if (network) this.value['network'] = network
  }

  async close(): Promise<void> {
    await this.services.stop(this.value)
    for (const close of this.#closers.splice(0)) await close()
  }
}
