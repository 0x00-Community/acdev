import {
  API_LEVEL,
  Manifest,
  SHELL_MODULES,
  platformSupport,
  type CapabilityState,
  type CapabilityStatus,
  type RunningMode,
  type WindowFeatures,
} from '@dopame/acde-api/manifest'
import type { AppManifest, AppOrigin } from '../../apps'

export interface CapabilityHost {
  readonly platform: string
  mode(): RunningMode
  running(service: string): boolean
  present(capability: string): boolean
}

export interface CapabilitySnapshot {
  readonly level: number
  readonly platform: string
  readonly mode: RunningMode
  readonly window: WindowFeatures
  readonly statuses: readonly CapabilityStatus[]
}

export class CapabilityCheck {
  static readonly REASONS: Readonly<Record<CapabilityState, string>> = {
    available: 'available',
    'not-declared': 'not declared in the manifest',
    unsupported: 'unsupported on this platform',
    'service-not-running': 'service not running',
    'shell-only': 'shell only',
    denied: 'denied by the user',
  }
  static readonly #MODULES = ['fs', 'terminal', 'network', 'office'] as const
  static readonly #SHELL: ReadonlySet<string> = new Set(SHELL_MODULES)
  static readonly #NO_FEATURES: WindowFeatures = { backdrop: 'unsupported' }
  readonly #host: CapabilityHost

  constructor(host: CapabilityHost) {
    this.#host = host
  }

  status(name: string, app: AppManifest | null, origin: AppOrigin): CapabilityStatus {
    const system = Manifest.CAPABILITIES.has(name)
    const declared = !app || (system ? !!app.capabilities[name] : app.services.includes(name) || !!app.capabilities[name])
    const third = !!app && origin.level >= 1 && !origin.system && CapabilityCheck.#SHELL.has(name)
    const state: CapabilityState = third
      ? 'shell-only'
      : !declared
        ? 'not-declared'
        : system
          ? this.#supported(name) ? 'available' : 'unsupported'
          : this.#host.running(name) ? 'available' : 'service-not-running'
    return {
      name,
      kind: system ? 'system' : 'service',
      state,
      reason: CapabilityCheck.REASONS[state],
      optional: !!app && app.optional.includes(name),
    }
  }

  declared(app: AppManifest | null): string[] {
    if (!app) return [...Manifest.CAPABILITIES]
    const names = Object.keys(app.capabilities).filter((name) => !!app.capabilities[name])
    return [...new Set([...names, ...app.services])]
  }

  statuses(app: AppManifest | null, origin: AppOrigin): CapabilityStatus[] {
    return [...new Set([...Manifest.CAPABILITIES, ...this.declared(app)])].map((name) => this.status(name, app, origin))
  }

  missing(app: AppManifest, origin: AppOrigin): CapabilityStatus[] {
    return this.declared(app)
      .map((name) => this.status(name, app, origin))
      .filter((status) => !status.optional && status.state !== 'available')
  }

  refusal(app: AppManifest, origin: AppOrigin): Error | null {
    const missing = this.missing(app, origin)
    if (!missing.length) return null
    const names = missing.map((status) => `"${status.name}" (${status.reason})`).join(', ')
    const stopped = missing.some((status) => status.state === 'service-not-running')
    const error = new Error(`${app.label} needs ${names}`)
    return Object.assign(error, stopped ? { status: 503, code: 'service_not_running' } : { status: 404, code: 'unsupported_app' })
  }

  refusedModules(app: AppManifest, origin: AppOrigin): Record<string, string> {
    const refused: Record<string, string> = {}
    for (const name of CapabilityCheck.#MODULES) {
      const status = this.status(name, app, origin)
      if (status.state !== 'available' && status.state !== 'not-declared') refused[`acde:${name}`] = `acde:${name}: "${name}" is ${status.reason}`
    }
    return refused
  }

  snapshot(app: AppManifest | null, origin: AppOrigin): CapabilitySnapshot {
    const mode = this.#host.mode()
    const row = platformSupport(this.#host.platform, mode)
    return { level: API_LEVEL, platform: this.#host.platform, mode, window: row?.window ?? CapabilityCheck.#NO_FEATURES, statuses: this.statuses(app, origin) }
  }

  #supported(name: string): boolean {
    const row = platformSupport(this.#host.platform, this.#host.mode())
    return !!row && !row.unsupported.includes(name) && this.#host.present(name)
  }

  static module(snapshot: CapabilitySnapshot): object {
    const known = new Map(snapshot.statuses.map((status) => [status.name, status]))
    const get = (name: string): CapabilityStatus => {
      const key = String(name)
      const found = known.get(key)
      if (found) return { ...found }
      return { name: key, kind: 'service', state: 'not-declared', reason: CapabilityCheck.REASONS['not-declared'], optional: false }
    }
    return Object.freeze({
      level: snapshot.level,
      platform: snapshot.platform,
      mode: snapshot.mode,
      window: Object.freeze({ ...snapshot.window }),
      get,
      list: (): CapabilityStatus[] => snapshot.statuses.map((status) => ({ ...status })),
      request: async (name: string): Promise<CapabilityStatus> => get(name),
    })
  }
}
