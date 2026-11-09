export declare const NODE_MINIMUM: readonly [number, number]
export declare function runtime(): 'bun' | 'node'
export declare function installDir(env?: Record<string, string | undefined>): string
export declare function installed(root?: string): boolean
export declare function which(name: string, env?: Record<string, string | undefined>): string | null
export declare function acdertCheckouts(root?: string): string[]
export declare function requireAcdert(root?: string): string
export declare function nodeAtLeast(version: string): boolean
export declare function runtimes(env?: Record<string, string | undefined>): { bun: string | null; node: string | null }
export declare function cliFile(root?: string): string
export declare function cliRuntime(root?: string): string
export declare function cliEnv(exe: string, env?: Record<string, string | undefined>): Record<string, string | undefined>
export declare function run(args: readonly string[], exe?: string): Promise<number>
