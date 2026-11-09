import type { AppManifest, AppRegistry } from '../../apps'
import { Tiers } from './tier'

export interface LaunchableHost {
  apps(): AppRegistry
  hosted(): boolean
  services(app: AppManifest): boolean
  refresh(): unknown
}

export class Launchable {
  readonly #host: LaunchableHost

  constructor(host: LaunchableHost) {
    this.#host = host
  }

  available(app: AppManifest): boolean {
    return this.#host.services(app)
  }

  runsHere(app: AppManifest): boolean {
    return !(app.capabilities.slots && this.#host.hosted())
  }

  shown(app: AppManifest): boolean {
    return this.available(app) && this.runsHere(app)
  }

  unsupported(id: string): Error | null {
    const app = this.#host.apps().get(id)
    return app && this.available(app) && !this.runsHere(app) ? Launchable.#unsupported(app) : null
  }

  app(appId: string): AppManifest {
    const apps = this.#host.apps()
    const app = apps.get(appId) ?? (this.#host.refresh(), apps.get(appId))
    if (!app) throw this.#missing(appId)
    if (!this.available(app)) throw Object.assign(new Error(`${app.label}: the system service it needs is not running`), { status: 503 })
    if (!this.runsHere(app)) throw Launchable.#unsupported(app)
    const shellRefusal = Tiers.refusal(app, apps.origin(app.id))
    if (shellRefusal) throw Object.assign(new Error(shellRefusal), { status: 403, code: 'shell_module' })
    return app
  }

  #missing(appId: string): Error {
    const refusal = this.#host.apps().refusal(appId)
    if (refusal) return Object.assign(new Error(`${appId}: ${refusal}`), { status: 409, code: 'api_level' })
    return Object.assign(new Error(`no app ${appId}`), { status: 404 })
  }

  static #unsupported(app: AppManifest): Error {
    return Object.assign(new Error(`${app.label} cannot run in a host window (it needs slots)`), { status: 404, code: 'unsupported_app' })
  }
}
