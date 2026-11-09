import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { which } from 'acde/launcher'
import { up } from './paths.ts'

export type PmName = 'bun' | 'npm' | 'pnpm' | 'yarn'

export class PackageManager {
  static readonly NAMES: readonly PmName[] = ['bun', 'npm', 'pnpm', 'yarn']
  static readonly LOCKS: readonly (readonly [string, PmName])[] = [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ]
  static readonly RUNTIMES: Readonly<Record<string, PmName>> = { node: 'npm', bun: 'bun' }

  readonly name: PmName

  constructor(name: PmName) {
    this.name = name
  }

  static named(name: string): PackageManager {
    if (!(PackageManager.NAMES as readonly string[]).includes(name)) throw new Error(`package manager ${JSON.stringify(name)}: one of ${PackageManager.NAMES.join(', ')}`)
    return new PackageManager(name as PmName)
  }

  static invoking(): PackageManager {
    const agent = process.env['npm_config_user_agent']?.split(/[/ ]/, 1)[0] ?? ''
    if ((PackageManager.NAMES as readonly string[]).includes(agent)) return new PackageManager(agent as PmName)
    const runtime = process.env['ACDE_HOST_RUNTIME'] || (process.versions['bun'] ? 'bun' : 'node')
    return new PackageManager(PackageManager.RUNTIMES[runtime] ?? 'npm')
  }

  static of(dir: string): PackageManager {
    const name = up(dir, (at): PmName | null => {
      for (const [file, name] of PackageManager.LOCKS) if (existsSync(join(at, file))) return name
      const pkg = join(at, 'package.json')
      if (!existsSync(pkg)) return null
      const field = (JSON.parse(readFileSync(pkg, 'utf8')) as { packageManager?: unknown }).packageManager
      const named = typeof field === 'string' ? field.split('@', 1)[0]! : ''
      return (PackageManager.NAMES as readonly string[]).includes(named) ? (named as PmName) : null
    })
    return name ? new PackageManager(name) : PackageManager.invoking()
  }

  get runtime(): 'bun' | 'node' {
    return this.name === 'bun' ? 'bun' : 'node'
  }

  version(): string | null {
    if (this.name === 'bun' && process.versions['bun']) return process.versions['bun']
    const bin = which(this.name)
    if (!bin) return null
    const out = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: /\.(cmd|bat)$/i.test(bin) })
    const version = out.status === 0 ? out.stdout.trim().replace(/^v/, '') : ''
    return /^\d+\.\d+\.\d+/.test(version) ? version : null
  }

  get install(): string[] {
    return [this.#bin(), 'install']
  }

  run(script: string): string[] {
    if (this.name === 'pnpm' || this.name === 'yarn') return [this.name, script]
    return [this.name, 'run', script]
  }

  exec(pkg: string, args: readonly string[]): string[] {
    if (this.name === 'bun') return [this.#bin(), 'x', '--bun', pkg, ...args]
    if (this.name === 'npm') return [which('npx') ?? 'npx', '--yes', pkg, ...args]
    return [this.#bin(), 'dlx', pkg, ...args]
  }

  #bin(): string {
    if (this.name === 'bun' && process.versions['bun']) return process.execPath
    const found = which(this.name)
    if (!found) throw new Error(`${this.name} is not on PATH`)
    return found
  }

  static manifest(dir: string, dep: string): string | null {
    const file = up(dir, (at) => existsSync(join(at, 'node_modules', dep, 'package.json')) && join(at, 'node_modules', dep, 'package.json'))
    return file && realpathSync(file)
  }

  static bin(dir: string, name: string, deps: ReadonlySet<string>): string | null {
    for (const dep of deps) {
      const manifest = PackageManager.manifest(dir, dep)
      if (!manifest) continue
      const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; bin?: unknown }).bin
      const rel = typeof bin === 'string' ? (dep.split('/').pop() === name ? bin : null) : bin && typeof bin === 'object' ? (bin as Record<string, unknown>)[name] : null
      if (typeof rel === 'string') return join(dirname(manifest), rel)
    }
    const link = up(dir, (at) => {
      const link = join(at, 'node_modules', '.bin', name)
      return existsSync(link) && lstatSync(link).isSymbolicLink() && link
    })
    return link && realpathSync(link)
  }
}
