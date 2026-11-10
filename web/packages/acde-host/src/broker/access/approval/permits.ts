import type { CaptureNative } from '@dopame/acde-dom'
import { FileAccess } from '../files'
import { Permissions, type Approval } from './permissions'

export class Permits {
  static readonly MODULES: Readonly<Record<string, readonly string[]>> = { launch: ['launch', 'slots'], terminal: ['terminal'], network: ['network'] }
  readonly #approvals: Map<string, Approval>
  readonly #label: string

  constructor(approvals: Readonly<Record<string, Approval>> | undefined, label: string) {
    this.#approvals = new Map(Object.entries(approvals ?? {}))
    this.#label = label
  }

  approval(capability: string): Approval {
    return this.#approvals.get(capability) ?? 'granted'
  }

  set(capability: string, approval: Approval): void {
    this.#approvals.set(capability, approval)
  }

  usable(module: string): boolean {
    const gates = this.#gates(module)
    return !gates.length || gates.some((name) => this.approval(name) === 'granted')
  }

  reason(module: string): string {
    const reasons = this.#gates(module).flatMap((name) => {
      const approval = this.approval(name)
      return approval === 'granted' ? [] : [Permissions.reason(name, approval)]
    })
    return `acde:${module}: ${reasons.join('; ')}`
  }

  guard<T extends object>(module: string, value: T): T {
    if (module === 'fs' || module === 'office') {
      return FileAccess.guard(value, (capability) => this.#approvals.get(capability) ?? null, this.#label, module === 'office')
    }
    if (!Permits.MODULES[module] || module === 'launch') return value
    return new Proxy(value, {
      get: (target, key, receiver) => {
        const member = Reflect.get(target, key, receiver) as unknown
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          if (!this.usable(module)) throw this.#error(this.#gates(module)[0] ?? module)
          return (member as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  }

  capture(native: CaptureNative): CaptureNative {
    const gate = (kind: string) => (kind === 'audioinput' || kind === 'microphone' ? 'microphone' : 'camera')
    const allowed = (kind: string) => this.approval(gate(kind)) === 'granted'
    return {
      devices: (full) => native.devices(full),
      permission: (kind) => (allowed(kind) ? native.permission(kind) : 'denied'),
      open: (kind, ...rest) => (allowed(kind) ? native.open(kind, ...rest) : Promise.reject(this.#error(gate(kind)))),
      close: (source) => native.close(source),
      onEnded: (callback) => native.onEnded(callback),
    }
  }

  #gates(module: string): string[] {
    return (Permits.MODULES[module] ?? []).filter((name) => this.#approvals.has(name))
  }

  #error(capability: string): Error {
    const approval = this.approval(capability)
    return Permissions.error(this.#label, capability, approval === 'granted' ? 'denied' : approval)
  }
}
