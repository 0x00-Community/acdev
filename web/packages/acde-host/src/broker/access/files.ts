import { Manifest } from '@dopame/acde-api/manifest'
import type { Capabilities } from '../../apps'

export type FsGrant = true | { readonly places: string[]; readonly paths: boolean } | null

export interface FileOrigin {
  readonly level: number
  readonly system?: boolean
}

export class FileAccess {
  static grant(caps: Capabilities | null, origin: FileOrigin | null): FsGrant {
    if (!caps) return true
    const fs = caps.fs
    if (!fs) return null
    const places = fs === true ? [] : Manifest.places(caps)
    return { places, paths: !!origin?.system && places.length > 0 }
  }

  static view(caps: Capabilities, origin: FileOrigin | null): 'roots' | 'url' | 'handle' {
    const fs = FileAccess.grant(caps, origin)
    if (fs === true) return 'roots'
    const paths = fs ? fs.paths : !!origin?.system
    return paths ? 'url' : 'handle'
  }
}
