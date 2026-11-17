import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CrateBinary {
  readonly crate: string
  readonly name: string
  readonly variable: string
}

export function crateBinary(root: string, wanted: CrateBinary, env: NodeJS.ProcessEnv = process.env): string {
  const given = env[wanted.variable]
  if (given) {
    if (!existsSync(given)) throw new Error(`${wanted.variable}=${given}: no such file`)
    return given
  }
  const crate = join(root, '..', 'crates', wanted.crate)
  const target = env['CARGO_TARGET_DIR'] || join(crate, 'target')
  const built = join(target, 'release', process.platform === 'win32' ? `${wanted.name}.exe` : wanted.name)
  if (existsSync(built)) return built
  if (!existsSync(join(crate, 'Cargo.toml'))) throw new Error(`vm: no ${wanted.name}: set ${wanted.variable} to the ${wanted.name} binary`)
  const made = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', join(crate, 'Cargo.toml')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
  })
  if (made.status !== 0 || !existsSync(built)) throw new Error(`vm: building ${wanted.name} failed (cargo exited ${made.status})`)
  return built
}
