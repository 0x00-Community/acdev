export declare const NODE_MAJOR: number
export declare function runtime(): 'bun' | 'node'
export declare function installDir(env?: Record<string, string | undefined>): string
export declare function installed(root?: string): boolean
export declare function acdertCheckouts(root?: string): string[]
export declare function requireAcdert(root?: string): Promise<string>
export declare function findAcdert(needed: boolean, root?: string): Promise<string | null | undefined>
export declare function cliFile(root?: string): string
export declare function cliRuntime(root?: string): string
export declare function findBun(): Promise<string>
export declare function cliEnv(exe: string, env?: Record<string, string | undefined>): Record<string, string | undefined>
export declare function run(args: readonly string[]): Promise<number>
