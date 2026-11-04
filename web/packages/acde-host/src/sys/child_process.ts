import { sys } from './natives'

export function spawnSync(command: string, args: readonly string[], timeoutMs: number): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = sys().run([command, ...args], timeoutMs)
  return result.status === null && result.stderr && !result.stdout ? { ...result, error: new Error(result.stderr) } : result
}
