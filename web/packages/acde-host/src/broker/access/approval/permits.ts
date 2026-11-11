import type { CaptureNative } from '@dopame/acde-dom'
import { FileAccess } from '../files'
import { Permissions, type Permit } from './permissions'

export class Permits {
  static readonly MODULES: Readonly<Record<string, readonly string[]>> = { launch: ['launch', 'slots'], terminal: ['terminal'], network: ['network'] }
  readonly #permits: Map<string, Permit>
  readonly #label: string

  constructor(permits: Readonly<Record<string, Permit>> | undefined, label: string) {
    this.#permits = new Map(Object.entries(permits ?? {}))
    this.#label = label
  }

  permit(capability: string): Permit {
    return this.#permits.get(capability) ?? 'granted'
  }

  set(capability: string, permit: Permit): void {
    this.#permits.set(capability, permit)
  }

  usable(module: string): boolean {
    const gates = Permits.MODULES[module]
    if (!gates) return true
    const declared = gates.filter((name) => this.#permits.has(name))
    return !declared.length || declared.some((name) => this.permit(name) === 'granted')
  }

  reason(module: string): string {
    const name = (Permits.MODULES[module] ?? [module]).find((gate) => this.#permits.has(gate)) ?? module
    return this.permit(name) === 'denied'
      ? `acde:${module}: "${name}" is denied by the user`
      : `acde:${module}: "${name}" waits for approval; ask for it with acde:capabilities request("${name}")`
  }

  guard<T extends object>(module: string, value: T): T {
    if (module === 'fs' || module === 'office') {
      return FileAccess.guard(value, (capability) => this.#permits.get(capability) ?? null, this.#label, module === 'office')
    }
    if (!Permits.MODULES[module] || module === 'launch') return value
    return new Proxy(value, {
      get: (target, key, receiver) => {
        const member = Reflect.get(target, key, receiver) as unknown
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          if (!this.usable(module)) throw Permissions.error(this.#label, module)
          return (member as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  }

  capture(native: CaptureNative): CaptureNative {
    const allowed = (kind: string) => this.permit(kind === 'audioinput' || kind === 'microphone' ? 'microphone' : 'camera') === 'granted'
    return {
      devices: (full) => native.devices(full),
      permission: (kind) => (allowed(kind) ? native.permission(kind) : 'denied'),
      open: (kind, ...rest) =>
        allowed(kind) ? native.open(kind, ...rest) : Promise.reject(Permissions.error(this.#label, kind === 'audioinput' ? 'microphone' : 'camera')),
      close: (source) => native.close(source),
      onEnded: (callback) => native.onEnded(callback),
    }
  }
}
