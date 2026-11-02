import { Manifest } from '@dopame/acde-app/manifest'
import type { AppManifest } from '@dopame/acde-app/manifest'
import type { Packages } from './packages'
import { process } from './sys/process'

export type { AppBackend, AppManifest, Capabilities } from '@dopame/acde-app/manifest'

export class AppRegistry {
  readonly #apps = new Map<string, AppManifest>()
  readonly #report: (line: string) => void

  constructor(packages: Pick<Packages, 'packages'>, report: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {
    this.#report = report
    this.reload(packages)
  }

  reload(packages: Pick<Packages, 'packages'>): boolean {
    const before = JSON.stringify(this.list())
    const report = this.#report
    this.#apps.clear()
    for (const pkg of packages.packages) {
      for (const raw of pkg.manifest.apps ?? []) {
        const app = Manifest.app(raw)
        if (typeof app === 'string') report(`acde-host: ${pkg.dir}/package.json: ${app}`)
        else if (this.#apps.has(app.id)) report(`acde-host: app ${app.id} in ${pkg.dir} is already defined; the first one stays`)
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
