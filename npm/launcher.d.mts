export declare const NODE_MINIMUM: readonly [number, number]
export declare const BUN_MINIMUM: readonly [number, number]
export declare function packageRoot(): string
export declare function runtime(): 'bun' | 'node'
export declare function installDir(env?: Record<string, string | undefined>): string
export declare function installed(root?: string): boolean
export declare function which(name: string, env?: Record<string, string | undefined>): string | null
export declare function libexecBeside(name: string, root?: string): string | null
export declare function runtimeBeside(root?: string): string | null
export interface FoundRuntime {
  readonly path: string | null
  readonly from: 'ACDEV_RUNTIME' | 'install' | null
  readonly problem?: string
}
export declare function findRuntime(root?: string, env?: Record<string, string | undefined>): FoundRuntime
export declare function requireRuntime(root?: string, env?: Record<string, string | undefined>): string
export declare function atLeast(version: string, minimum: readonly [number, number]): boolean
export declare function runtimes(env?: Record<string, string | undefined>): { bun: string | null; node: string | null }
export declare function cliFile(root?: string): string
export declare function cliRuntime(root?: string): string
export declare function cliEnv(
  exe: string,
  env?: Record<string, string | undefined>,
  platform?: NodeJS.Platform,
): Record<string, string | undefined>
export declare function run(args: readonly string[], exe?: string): Promise<number>
export declare const acdertBeside: typeof runtimeBeside
export declare const findAcdert: typeof findRuntime
export declare const requireAcdert: typeof requireRuntime
export type FoundAcdert = FoundRuntime
