export declare const NODE_MINIMUM: readonly [number, number]
export declare const BUN_MINIMUM: readonly [number, number]
export declare function packageRoot(): string
export declare function runtime(): 'bun' | 'node'
export declare function installDir(env?: Record<string, string | undefined>): string
export declare function installed(root?: string): boolean
export declare function which(name: string, env?: Record<string, string | undefined>): string | null
export declare function acdertBeside(root?: string): string | null
export interface FoundAcdert {
  readonly path: string | null
  readonly from: 'ACDERT' | 'install' | 'PATH' | null
  readonly problem?: string
}
export declare function findAcdert(root?: string, env?: Record<string, string | undefined>): FoundAcdert
export declare function requireAcdert(root?: string, env?: Record<string, string | undefined>): string
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
