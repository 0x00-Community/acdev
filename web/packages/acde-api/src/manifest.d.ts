import type { IconName } from './validate'

export type { IconName }

export interface PackageManifest {
  readonly desktops?: readonly DesktopManifest[]
  readonly apps?: readonly AppManifest[]
  readonly assets?: Readonly<Record<string, readonly string[]>>
  readonly services?: readonly ServiceManifest[]
}

export interface DesktopManifest {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly entry: string
  readonly services?: readonly string[]
  readonly heapMb?: number
}

export interface AppManifest {
  readonly id: string
  readonly label: string
  readonly icon: IconName | (string & {})
  readonly entry: string
  readonly capabilities?: Capabilities
  readonly heapMb?: number
  readonly size?: readonly [number, number]
  readonly multiple?: boolean
  readonly frame?: boolean
  readonly mimeTypes?: readonly string[]
  readonly backend?: AppBackend
}

export interface AppBackend {
  readonly entry: string
  readonly port?: number
}

export interface Capabilities {
  readonly fs?: boolean | { readonly roots: readonly string[] }
  readonly terminal?: boolean
  readonly office?: boolean
  readonly launch?: boolean
  readonly slots?: boolean
  readonly open?: boolean | readonly string[]
  readonly openFiles?: boolean
  readonly session?: boolean
  readonly desktops?: boolean
  readonly [service: string]: unknown
}

export interface ServiceManifest {
  readonly name: string
  readonly module: string
}
