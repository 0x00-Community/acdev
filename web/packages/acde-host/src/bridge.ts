import type { Native, NativeOffice } from './native'
import { OfficePage } from './office'
import type { InstalledDesktop } from './packages'
import { DesktopServices } from './services'
import { Level, Log } from './log'

interface NativeNetwork {
  state(): Promise<unknown>
  networks(scan?: boolean): Promise<unknown>
  connect(ssid: string, password?: string): Promise<void>
  activate(iface: string): Promise<void>
  disconnect(iface: string): Promise<void>
  setWifiEnabled(on: boolean): Promise<void>
  watch(callback: (state: unknown) => void): void
}

export class PageBridge {
  readonly #closers: (() => unknown)[] = []
  readonly value: Record<string, unknown> = {}
  readonly services = new DesktopServices()

  available(caps: { fs?: unknown; terminal?: unknown; office?: unknown }): boolean {
    return (!caps.fs || !!this.value['fs']) && (!caps.terminal || !!this.value['terminal']) && (!caps.office || !!this.value['office'])
  }

  async start(native: Native, desktop: InstalledDesktop): Promise<void> {
    const system = this.#open(native)
    await Promise.all([system, this.services.start(desktop, native as unknown as Record<string, unknown>, this.value, system)])
  }

  async startDesktop(desktop: InstalledDesktop, native: Native): Promise<void> {
    await this.services.stop(this.value)
    await this.services.start(desktop, native as unknown as Record<string, unknown>, this.value)
  }

  async #open(native: Native): Promise<void> {
    const optional = async <T>(name: string, open: () => Promise<T> | T): Promise<T | null> => {
      try {
        return await open()
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `${name} unavailable: ${(error as Error).message}`)
        return null
      }
    }
    const Network = (native as { Network?: { open(): Promise<NativeNetwork> } }).Network
    const [terminal, network] = await Promise.all([
      native.Terminals ? optional('terminal', () => new native.Terminals!()) : null,
      Network ? optional('network', () => Network.open()) : null,
    ])
    const fs = native.Finder ? await optional('fs', () => new native.Finder!()) : null
    if (fs) this.value['fs'] = fs
    const office = native.Office && fs ? await optional('office', () => new native.Office!(fs)) : null
    if (office) {
      this.value['office'] = PageBridge.#office(office)
      this.#closers.unshift(() => office.close())
    }
    if (terminal) {
      this.value['terminal'] = terminal
      this.#closers.unshift(() => terminal.closeAll())
    }
    if (network) this.value['network'] = network
  }

  static #office(office: NativeOffice): Record<string, unknown> {
    return {
      server: () => office.server(),
      state: (root?: string, dir?: string, path?: string) => office.state(root, dir, path),
      status: async (key: string) => office.status(key),
      save: (body: unknown) => office.save(body),
      new: (body: unknown) => office.new(body),
      editorPage: async (setup: { api: string; config: unknown }, theme: 'light' | 'dark') => OfficePage.write(setup, theme),
    }
  }

  async close(): Promise<void> {
    await this.services.stop(this.value)
    for (const close of this.#closers.splice(0)) await close()
  }
}
