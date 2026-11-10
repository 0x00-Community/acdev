import { Manifest } from '@dopame/acde-api/manifest'
import type { Capabilities } from '../../apps'
import { Permissions, type Permit } from './approval/permissions'

export type FsGrant = true | string[] | { readonly places: string[]; readonly paths: boolean } | null

export interface FileOrigin {
  readonly level: number
  readonly system?: boolean
}

export class FileAccess {
  static grant(caps: Capabilities | null, origin: FileOrigin | null): FsGrant {
    if (!caps) return true
    const fs = caps.fs
    if (!fs) return null
    if (FileAccess.legacy(caps, origin)) return fs === true ? true : [...fs.roots]
    const places = fs === true ? [] : Manifest.places(caps)
    return { places, paths: !!origin?.system && places.length > 0 }
  }

  static legacy(caps: Capabilities, origin: FileOrigin | null): boolean {
    return !origin || origin.level < 1 || (!!origin.system && caps.fs === true)
  }

  static deprecated(caps: Capabilities | null, origin: FileOrigin | null): boolean {
    return !!caps && caps.fs === true && !!origin && origin.level >= 1 && !!origin.system
  }

  static guard<T extends object>(fs: T, permit: (capability: string) => Permit | null, label: string): T {
    const blocked = (root: unknown): string | null => {
      const capability = typeof root === 'string' ? `fs.${root}` : ''
      const state = Manifest.place(capability) ? permit(capability) : null
      return state && state !== 'granted' ? capability : null
    }
    const visible = (roots: unknown) => (Array.isArray(roots) ? roots.filter((root: { place?: unknown }) => !blocked(root?.place)) : roots)
    return new Proxy(fs, {
      get: (target, key, receiver) => {
        const member = Reflect.get(target, key, receiver) as unknown
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          const capability = blocked(args[0])
          if (capability) return Promise.reject(Permissions.error(label, capability))
          const result = (member as (...a: unknown[]) => unknown).apply(target, args)
          return key === 'roots' ? Promise.resolve(result).then(visible) : result
        }
      },
    })
  }
}
