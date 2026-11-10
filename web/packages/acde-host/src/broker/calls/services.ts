import { Manifest } from '@dopame/acde-api/manifest'
import type { AppManifest } from '../../apps'
import type { PageBridge } from '../../bridge'
import { Tiers, type WebTier } from '../access/tier'
import type { ServiceShape } from '../types'
import { Web } from '../web'

type Builtins = Record<'inspect' | 'session' | 'desktops', Record<string, (...args: never[]) => unknown>>

export interface ServicesHost {
  readonly bridge: PageBridge
  builtins(): Builtins
}

export class ServiceCalls {
  static readonly SYNC = ['session.own'] as const
  static readonly #LOCAL = new Set(['fs', 'terminal', 'network', 'office'])
  static readonly #FUNCTION_KEYS = ['length', 'name', 'prototype', 'caller', 'arguments']
  readonly #host: ServicesHost

  constructor(host: ServicesHost) {
    this.#host = host
  }

  shapes(app: AppManifest | null, tier: WebTier = Tiers.LEGACY): Record<string, ServiceShape> {
    const shapes: Record<string, ServiceShape> = {}
    const caps = app?.capabilities ?? null
    for (const [service, target] of Object.entries(this.#host.bridge.value)) {
      if (ServiceCalls.#LOCAL.has(service) || (app && !this.#allowed(app, service))) continue
      shapes[service] = this.#shape(service, target)
    }
    for (const [service, api] of Object.entries(this.#host.builtins())) {
      if (!caps || (service === 'inspect' ? tier.shell.includes('inspect') : caps[service])) shapes[service] = this.#shape(service, api)
    }
    return shapes
  }

  call(web: Web, service: string, method: string, args: unknown[]): unknown {
    const desktop = web.kind === 'desktop'
    const caps = web.app?.capabilities ?? null
    if (service === 'inspect' || service === 'session' || service === 'desktops') {
      if (!desktop && !(service === 'inspect' ? web.shell('inspect') : caps?.[service])) throw Web.refused(web, `acde.${service}`)
      const call = (this.#host.builtins()[service] as Record<string, (...a: unknown[]) => unknown>)[method]
      if (!call) throw new Error(`acde.${service} has no ${method}`)
      return call(...args)
    }
    if (web.app && !this.#allowed(web.app, service)) throw Web.refused(web, `acde.${service}`)
    const target = this.#host.bridge.value[service] as Record<string, (...a: unknown[]) => unknown> | ((...a: unknown[]) => unknown) | undefined
    if (!target) throw Object.assign(new Error(`acde.${service} is not running`), { status: 503 })
    if (method === '' && typeof target === 'function') return target(...args)
    const fn = (target as Record<string, (...a: unknown[]) => unknown>)[method]
    if (typeof fn !== 'function') throw new Error(`acde.${service} has no ${method}`)
    return fn.apply(target, args)
  }

  #shape(service: string, target: unknown): ServiceShape {
    const methods = new Set<string>()
    const values: Record<string, unknown> = {}
    for (let o = target as object | null; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Object.getOwnPropertyNames(o)) {
        if (key === 'constructor' || methods.has(key) || key in values) continue
        if (o === target && typeof target === 'function' && ServiceCalls.#FUNCTION_KEYS.includes(key)) continue
        let value: unknown
        try {
          value = (target as Record<string, unknown>)[key]
        } catch {
          continue
        }
        if (typeof value === 'function') methods.add(key)
        else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) values[key] = value
      }
    }
    const sync: Record<string, unknown> = {}
    for (const name of [...ServiceCalls.SYNC, ...this.#host.bridge.services.sync]) {
      const [owner, method] = name.split('.') as [string, string]
      if (owner !== service || !methods.has(method)) continue
      try {
        sync[method] = (target as Record<string, () => unknown>)[method]!()
      } catch {
        sync[method] = null
      }
    }
    return { methods: [...methods], values, sync, callable: typeof target === 'function' }
  }

  #allowed(app: AppManifest, namespace: string): boolean {
    const name = this.#host.bridge.services.capability.get(namespace) ?? namespace
    return app.services.includes(name) || (Manifest.CAPABILITIES.has(name) && !!app.capabilities[name])
  }
}
