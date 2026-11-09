/// <reference path="./app-modules.d.ts" />
/// <reference path="./shell-modules.d.ts" />
import type * as Page from './page'
import type { AppModules } from './app'

export type * from './app'
export { API_LEVEL } from './level'

export interface ShellModules extends AppModules, Page.ShellModuleTypes {}

export function load<K extends keyof ShellModules>(name: K): Promise<ShellModules[K] | null>
export function load(name: string): Promise<unknown>
