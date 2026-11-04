import type { HostNative } from '../native'

export let host: HostNative = null as unknown as HostNative
export let G: Record<PropertyKey, any> = globalThis as never

export function bindHost(global: object, native: HostNative): void {
  G = global as never
  host = native
}

export let report: (error: unknown) => void = (error) => host.reportError(error)

export function setReport(fn: (error: unknown) => void): void {
  report = fn
}

export function hidden(target: object, name: PropertyKey, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false })
}

export function globals(global: object, values: Record<string, unknown>): void {
  for (const name of Object.keys(values)) hidden(global, name, values[name])
}

export function queueTask(fn: () => void): void {
  ;(G['setTimeout'] as (f: () => void, ms: number) => void)(fn, 0)
}

export function tag(cls: { prototype: object; name: string }, name = cls.name): void {
  Object.defineProperty(cls.prototype, Symbol.toStringTag, { value: name, configurable: true })
}
