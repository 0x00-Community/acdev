/// <reference path="./app-modules.d.ts" />
import type * as Page from './page'

export type * from './manifest'
export type * from './page'
export type * from './service'
export type * from './config'
export { API_LEVEL } from './level'

export interface AppModules {
  readonly fs: Page.AcdeFs
  readonly office: Page.AcdeOffice
  readonly terminal: Page.AcdeTerminals
  readonly network: Page.AcdeNetwork
  readonly launch: Page.AcdeLaunch
  readonly apps: Page.AcdeAppList
  readonly open: Page.AcdeOpen
  readonly openPath: Page.AcdeOpenFiles['openPath']
  readonly handlers: Page.AcdeOpenFiles['handlers']
  readonly window: Page.AcdeWindow
}

export function load<K extends keyof AppModules>(name: K): Promise<AppModules[K] | null>
export function load(name: string): Promise<unknown>
