import type { AcdePage } from './page'

export interface AcdeModules {
  readonly fs: NonNullable<AcdePage['fs']>
  readonly office: NonNullable<AcdePage['office']>
  readonly terminal: NonNullable<AcdePage['terminal']>
  readonly network: NonNullable<AcdePage['network']>
  readonly system: NonNullable<AcdePage['system']>
  readonly display: NonNullable<AcdePage['display']>
  readonly audio: NonNullable<AcdePage['audio']>
  readonly input: NonNullable<AcdePage['input']>
  readonly power: NonNullable<AcdePage['power']>
  readonly devices: NonNullable<AcdePage['devices']>
  readonly windows: NonNullable<AcdePage['windows']>
  readonly apps: NonNullable<AcdePage['apps']>
  readonly desktop: NonNullable<AcdePage['desktop']>
  readonly desktops: NonNullable<AcdePage['desktops']>
  readonly session: NonNullable<AcdePage['session']>
  readonly open: NonNullable<AcdePage['open']>
  readonly openPath: NonNullable<AcdePage['openPath']>
  readonly handlers: NonNullable<AcdePage['handlers']>
  readonly setDefault: NonNullable<AcdePage['setDefault']>
  readonly window: NonNullable<AcdePage['window']>
}

export function load<K extends keyof AcdeModules>(name: K): Promise<AcdeModules[K] | null>
export function load(name: string): Promise<unknown>
