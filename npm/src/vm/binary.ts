import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface CrateBinary {
  readonly crate: string
  readonly name: string
  readonly variable: string
  readonly shared?: string
}

function sharedTargets(root: string, shared: string): string[] {
  const out: string[] = []
  for (let dir = root; dirname(dir) !== dir; dir = dirname(dir)) out.push(join(dir, 'logs', 'cargo-target', shared))
  return out
}

export function crateDir(root: string, crate: string): string {
  return join(root, '..', 'crates', crate)
}

export function crateVersion(root: string, crate: string): string | null {
  const manifest = join(crateDir(root, crate), 'Cargo.toml')
  if (!existsSync(manifest)) return null
  return /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(manifest, 'utf8'))?.[1] ?? null
}

export function crateBinary(root: string, wanted: CrateBinary, env: NodeJS.ProcessEnv = process.env): string {
  const given = env[wanted.variable]
  if (given) {
    if (!existsSync(given)) throw new Error(`${wanted.variable}=${given}: no such file`)
    return given
  }
  const crate = crateDir(root, wanted.crate)
  const file = process.platform === 'win32' ? `${wanted.name}.exe` : wanted.name
  const configured = env['CARGO_TARGET_DIR'] || null
  const targets = [...(configured ? [configured] : []), ...(wanted.shared ? sharedTargets(root, wanted.shared) : []), join(crate, 'target')]
  const found = targets.map((dir) => join(dir, 'release', file)).find((path) => existsSync(path))
  if (found) return found
  if (!existsSync(join(crate, 'Cargo.toml'))) throw new Error(`vm: no ${wanted.name}: set ${wanted.variable} to the ${wanted.name} binary`)
  const made = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', join(crate, 'Cargo.toml')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
  })
  const built = join(configured ?? join(crate, 'target'), 'release', file)
  if (made.status !== 0 || !existsSync(built)) throw new Error(`vm: building ${wanted.name} failed (cargo exited ${made.status})`)
  return built
}
