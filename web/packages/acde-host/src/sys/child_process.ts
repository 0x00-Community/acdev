import { sys } from './natives'

export function spawnSync(command: string, args: readonly string[] = [], options: { timeout?: number; encoding?: string } = {}): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = sys().run([command, ...args], options.timeout ?? 0)
  return result.status === null && result.stderr && !result.stdout ? { ...result, error: new Error(result.stderr) } : result
}
