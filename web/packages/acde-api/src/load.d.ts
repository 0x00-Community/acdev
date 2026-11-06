import type { AcdePage } from './page'

export type AcdeModules = { readonly [K in keyof AcdePage as string extends K ? never : number extends K ? never : K]-?: NonNullable<AcdePage[K]> }

export function load<K extends keyof AcdeModules>(name: K): Promise<AcdeModules[K] | null>
export function load(name: string): Promise<unknown>
