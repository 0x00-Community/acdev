/// <reference path="./modules/app-modules.d.ts" />
import type * as Page from './types/page'
import type { AcdeCapabilities } from './types/capabilities'

export type * from './types/manifest'
export type * from './types/page'
export type * from './types/service'
export type * from './types/config'
export type * from './types/capabilities'
export { API_LEVEL } from './runtime/level'
export { PLATFORM_SUPPORT, RUNNING_MODES, platformSupport } from './runtime/platforms'
export { SHARED_PLACES, type PlaceCapability, type SharedPlace } from './runtime/places'

export interface AppModules {
  readonly fs: Page.AcdeFs
  readonly office: Page.AcdeOffice
  readonly terminal: Page.AcdeTerminals
  readonly network: Page.AcdeNetwork
  readonly system: Page.AcdeSystem
  readonly bluetooth: Page.AcdeBluetooth
  readonly audio: Page.AcdeAudio
  readonly devices: Page.AcdeDevices
  readonly power: Page.AcdePower
  readonly launch: Page.AcdeLaunch
  readonly apps: Page.AcdeAppList
  readonly open: Page.AcdeOpen
  readonly openPath: Page.AcdeOpenFiles['openPath']
  readonly handlers: Page.AcdeOpenFiles['handlers']
  readonly window: Page.AcdeWindow
  readonly capabilities: AcdeCapabilities
}

export function load<K extends keyof AppModules>(name: K): Promise<AppModules[K] | null>
export function load(name: string): Promise<unknown>
