import type { AppManifest, AppRegistry } from '../../apps'
import type { PageBridge } from '../../bridge'
import { process } from '../../sys/process'
import { CapabilityCheck } from './capabilities'
import type { Permissions } from './approval/permissions'
import { Tiers, type WebTier } from './tier'

export interface LaunchableHost {
  apps(): AppRegistry
  hosted(): boolean
  standalone(): boolean
  bridge(): PageBridge
  refresh(): unknown
  permissions(): Permissions
}

export class Launchable {
  readonly #host: LaunchableHost
  readonly capabilities: CapabilityCheck

  constructor(host: LaunchableHost) {
    this.#host = host
    this.capabilities = new CapabilityCheck({
      platform: process.platform,
      mode: () => (!host.hosted() ? 'session' : host.standalone() ? 'standalone' : 'desktop'),
      running: (service) => host.bridge().services.running(service),
      present: (capability) => host.bridge().present(capability),
      denied: (app, origin, capability) => host.permissions().permit(app, origin, capability) === 'denied',
    })
  }

  available(app: AppManifest): boolean {
    const origin = this.#host.apps().origin(app.id)
    if (origin.level >= 1) return !this.capabilities.missing(app, origin).length
    return this.#host.bridge().available(app.capabilities)
  }

  runsHere(app: AppManifest): boolean {
    return this.#host.apps().origin(app.id).level >= 1 || !(app.capabilities.slots && this.#host.hosted())
  }

  shown(app: AppManifest): boolean {
    return this.available(app) && this.runsHere(app)
  }

  unsupported(id: string): Error | null {
    const app = this.#host.apps().get(id)
    if (!app) return null
    const origin = this.#host.apps().origin(app.id)
    if (origin.level >= 1) return this.capabilities.refusal(app, origin)
    return this.available(app) && !this.runsHere(app) ? Launchable.#unsupported(app) : null
  }

  tier(app: AppManifest | null): WebTier {
    if (!app) return { ...Tiers.DESKTOP, capabilities: this.capabilities.snapshot(null, { level: Tiers.DESKTOP.level, system: true }) }
    const origin = this.#host.apps().origin(app.id)
    const tier = Tiers.app(app, origin)
    const refused = origin.level >= 1 ? { ...tier.refused, ...this.capabilities.refusedModules(app, origin) } : tier.refused
    const permits = this.#host.permissions().permits(app, origin)
    return { ...tier, refused, capabilities: this.capabilities.snapshot(app, origin), permits }
  }

  app(appId: string): AppManifest {
    const apps = this.#host.apps()
    const app = apps.get(appId) ?? (this.#host.refresh(), apps.get(appId))
    if (!app) throw this.#missing(appId)
    const origin = apps.origin(app.id)
    const shellRefusal = Tiers.refusal(app, origin)
    if (shellRefusal) throw Object.assign(new Error(shellRefusal), { status: 403, code: 'shell_module' })
    if (origin.level >= 1) {
      const refusal = this.capabilities.refusal(app, origin)
      if (refusal) throw refusal
      return app
    }
    if (!this.available(app)) throw Object.assign(new Error(`${app.label}: the system service it needs is not running`), { status: 503 })
    if (!this.runsHere(app)) throw Launchable.#unsupported(app)
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
