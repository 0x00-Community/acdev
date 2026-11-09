import { Manifest } from '@dopame/acde-api/manifest'
import type { AppManifest } from '@dopame/acde-api/manifest'
import type { Packages } from './packages'
import { Level, Log } from './log'

export type { AppManifest, Capabilities } from '@dopame/acde-api/manifest'

type Installed = Pick<Packages, 'packages'> & Partial<Pick<Packages, 'refused'>>

export class AppRegistry {
  readonly #apps = new Map<string, AppManifest>()
  readonly #refused = new Map<string, string>()

  constructor(packages: Installed) {
    this.reload(packages)
  }

  reload(packages: Installed): boolean {
    const before = JSON.stringify(this.list())
    this.#apps.clear()
    this.#refused.clear()
    for (const pkg of packages.packages) {
      for (const raw of pkg.manifest.apps ?? []) {
        const app = Manifest.app(raw)
        if (typeof app === 'string') Log.write(Level.Warn, 'acde_host', `${pkg.dir}/package.json: ${app}`)
        else if (this.#apps.has(app.id)) Log.write(Level.Warn, 'acde_host', `app ${app.id} in ${pkg.dir} is already defined; the first one stays`)
        else this.#apps.set(app.id, app)
      }
    }
    for (const pkg of packages.refused ?? []) {
      for (const raw of pkg.manifest.apps ?? []) {
        const id = (raw as { id?: unknown } | null)?.id
        if (typeof id === 'string' && !this.#apps.has(id) && !this.#refused.has(id)) this.#refused.set(id, pkg.reason)
      }
    }
    return JSON.stringify(this.list()) !== before
  }

  get(id: string): AppManifest | null {
    return this.#apps.get(id) ?? null
  }

  refusal(id: string): string | null {
    return this.#refused.get(id) ?? null
  }

  list(): AppManifest[] {
    return [...this.#apps.values()]
  }
}
