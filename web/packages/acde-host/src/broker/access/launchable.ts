import type { AppManifest, AppRegistry } from '../../apps'
import type { PageBridge } from '../../bridge'
import { process } from '../../sys/process'
import { CapabilityCheck } from './capabilities'
import { Tiers, type WebTier } from './tier'

export interface LaunchableHost {
  apps(): AppRegistry
  hosted(): boolean
  standalone(): boolean
  bridge(): PageBridge
  refresh(): unknown
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
    })
  }

  available(app: AppManifest): boolean {
    return !this.capabilities.missing(app, this.#host.apps().origin(app.id)).length
  }

  unsupported(id: string): Error | null {
    const app = this.#host.apps().get(id)
    return app ? this.capabilities.refusal(app, this.#host.apps().origin(app.id)) : null
  }

  tier(app: AppManifest | null): WebTier {
    if (!app) return { ...Tiers.DESKTOP, capabilities: this.capabilities.snapshot(null, { level: Tiers.DESKTOP.level, system: true }) }
    const origin = this.#host.apps().origin(app.id)
    const tier = Tiers.app(app, origin)
    const refused = { ...tier.refused, ...this.capabilities.refusedModules(app, origin) }
    return { ...tier, refused, capabilities: this.capabilities.snapshot(app, origin) }
  }

  app(appId: string): AppManifest {
    const apps = this.#host.apps()
    const app = apps.get(appId) ?? (this.#host.refresh(), apps.get(appId))
    if (!app) throw this.#missing(appId)
    const origin = apps.origin(app.id)
    const shellRefusal = Tiers.refusal(app, origin)
    if (shellRefusal) throw Object.assign(new Error(shellRefusal), { status: 403, code: 'shell_module' })
    const refusal = this.capabilities.refusal(app, origin)
    if (refusal) throw refusal
    return app
  }

  #missing(appId: string): Error {
    const refusal = this.#host.apps().refusal(appId)
    if (refusal) return Object.assign(new Error(`${appId}: ${refusal}`), { status: 409, code: 'api_level' })
    return Object.assign(new Error(`no app ${appId}`), { status: 404 })
  }
}
