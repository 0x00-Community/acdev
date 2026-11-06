export declare const TARGETS: readonly string[]
export declare function target(): string
export declare function runtime(): 'bun' | 'deno' | 'node'
export declare function bunPackage(target?: string): string | undefined
export declare function acdertPackage(target?: string): string
export declare function fetchPackage(pkg: string, version: string, file: string): Promise<string>
export declare function findBun(): Promise<string>
export declare function acdertCheckouts(root?: string): string[]
export declare function requireAcdert(root?: string): Promise<string>
export declare function findAcdert(needed: boolean, root?: string): Promise<string | null | undefined>
export declare function cliFile(): string
export declare function cliEnv(bun: string, env?: Record<string, string | undefined>): Record<string, string | undefined>
export declare function run(args: readonly string[]): Promise<number>
