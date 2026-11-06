import type { Native } from './native'
import { sys } from './sys/natives'
import type { InstalledDesktop } from './packages'
import { DesktopServices } from './services'
import { Level, Log } from './log'
import { process } from './sys/process'

export class PageBridge {
  readonly #closers: (() => unknown)[] = []
  readonly value: Record<string, unknown> = {}
  readonly services = new DesktopServices()
  #office = false

  available(caps: { fs?: unknown; terminal?: unknown; office?: unknown }): boolean {
    return (!caps.fs || !!this.value['fs']) && (!caps.terminal || process.platform !== 'win32') && (!caps.office || this.#office)
  }

  async start(native: Native, desktop: InstalledDesktop): Promise<void> {
    const system = this.#open(native)
    await Promise.all([system, this.services.start(desktop, native, this.value, system)])
  }

  async startDesktop(desktop: InstalledDesktop, native: Native): Promise<void> {
    await this.services.stop(this.value)
    await this.services.start(desktop, native, this.value)
  }

  async #open(native: Native): Promise<void> {
    try {
      if (native.Finder) this.value['fs'] = new native.Finder()
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `fs unavailable: ${(error as Error).message}`)
    }
    const failed = sys().openOffice?.()
    if (failed === null) {
      this.#office = true
      this.#closers.unshift(() => sys().closeOffice?.())
    } else if (failed === undefined) Log.write(Level.Debug, 'acde_host', `office: none on ${process.platform}, apps that need it are unavailable`)
    else Log.write(Level.Warn, 'acde_host', `office unavailable: ${failed}`)
  }

  async close(): Promise<void> {
    await this.services.stop(this.value)
    for (const close of this.#closers.splice(0)) await close()
  }
}
