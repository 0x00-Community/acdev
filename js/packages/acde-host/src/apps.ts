import { Manifest } from '@dopame/acde-app/manifest'
import type { AppManifest } from '@dopame/acde-app/manifest'
import type { Packages } from './packages'
import { Level, Log } from './log'

export type { AppManifest, Capabilities } from '@dopame/acde-app/manifest'

export class AppRegistry {
  static readonly SYSTEM_APP = { system: true, display: true, audio: true, power: true, input: true, devices: true }

  readonly #apps = new Map<string, AppManifest>()

  constructor(packages: Pick<Packages, 'packages'>) {
    this.reload(packages)
  }

  reload(packages: Pick<Packages, 'packages'>): boolean {
    const before = JSON.stringify(this.list())
    this.#apps.clear()
    for (const pkg of packages.packages) {
      const system = (pkg.manifest.desktops ?? []).length > 0
      for (const raw of pkg.manifest.apps ?? []) {
        const parsed = Manifest.app(raw)
        const app = system && typeof parsed !== 'string' ? { ...parsed, capabilities: { ...AppRegistry.SYSTEM_APP, ...parsed.capabilities } } : parsed
        if (typeof app === 'string') Log.write(Level.Warn, 'acde_host', `${pkg.dir}/package.json: ${app}`)
        else if (this.#apps.has(app.id)) Log.write(Level.Warn, 'acde_host', `app ${app.id} in ${pkg.dir} is already defined; the first one stays`)
        else this.#apps.set(app.id, app)
      }
    }
    return JSON.stringify(this.list()) !== before
  }

  get(id: string): AppManifest | null {
    return this.#apps.get(id) ?? null
  }

  list(): AppManifest[] {
    return [...this.#apps.values()]
  }
}
