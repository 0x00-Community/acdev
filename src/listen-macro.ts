import { join } from 'node:path'

export function listenBundle(): string {
  const built = Bun.spawnSync([process.execPath, 'build', join(import.meta.dir, 'listen.ts'), '--target=node', '--format=esm', '--minify-syntax'], { stdout: 'pipe', stderr: 'pipe' })
  if (built.exitCode !== 0) throw new Error(`bundling src/listen.ts failed: ${built.stderr.toString()}`)
  return built.stdout.toString()
}
