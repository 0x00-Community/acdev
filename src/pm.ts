import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type PmName = 'bun' | 'npm' | 'pnpm' | 'yarn' | 'deno'

export class PackageManager {
  static readonly NAMES: readonly PmName[] = ['bun', 'npm', 'pnpm', 'yarn', 'deno']
  static readonly LOCKS: readonly (readonly [string, PmName])[] = [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['deno.lock', 'deno'],
  ]
  static readonly RUNTIMES: Readonly<Record<string, PmName>> = { node: 'npm', deno: 'deno', bun: 'bun' }

  constructor(readonly name: PmName) {}

  static named(name: string): PackageManager {
    if (!(PackageManager.NAMES as readonly string[]).includes(name)) throw new Error(`package manager ${JSON.stringify(name)}: one of ${PackageManager.NAMES.join(', ')}`)
    return new PackageManager(name as PmName)
  }

  static invoking(): PackageManager {
    const agent = process.env['npm_config_user_agent']?.split(/[/ ]/, 1)[0] ?? ''
    if ((PackageManager.NAMES as readonly string[]).includes(agent)) return new PackageManager(agent as PmName)
    return new PackageManager(PackageManager.RUNTIMES[process.env['ACDE_HOST_RUNTIME'] ?? ''] ?? 'bun')
  }

  static of(dir: string): PackageManager {
    for (let at = dir; ; at = dirname(at)) {
      for (const [file, name] of PackageManager.LOCKS) if (existsSync(join(at, file))) return new PackageManager(name)
      const pkg = join(at, 'package.json')
      if (existsSync(pkg)) {
        const field = (JSON.parse(readFileSync(pkg, 'utf8')) as { packageManager?: unknown }).packageManager
        const name = typeof field === 'string' ? field.split('@', 1)[0]! : ''
        if ((PackageManager.NAMES as readonly string[]).includes(name)) return new PackageManager(name as PmName)
      }
      if (dirname(at) === at) return PackageManager.invoking()
    }
  }

  get install(): string[] {
    return [this.#bin(), 'install']
  }

  run(script: string): string[] {
    if (this.name === 'deno') return ['deno', 'task', script]
    if (this.name === 'pnpm' || this.name === 'yarn') return [this.name, script]
    return [this.name, 'run', script]
  }

  #bin(): string {
    if (this.name === 'bun') return process.execPath
    const found = Bun.which(this.name)
    if (!found) throw new Error(`${this.name} is not on PATH`)
    return found
  }

  static bin(dir: string, name: string, deps: ReadonlySet<string>): string | null {
    for (const dep of deps) {
      let manifest: string
      try {
        manifest = Bun.resolveSync(`${dep}/package.json`, dir)
      } catch {
        continue
      }
      const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; bin?: unknown }).bin
      const rel = typeof bin === 'string' ? (dep.split('/').pop() === name ? bin : null) : bin && typeof bin === 'object' ? (bin as Record<string, unknown>)[name] : null
      if (typeof rel === 'string') return join(dirname(manifest), rel)
    }
    for (let at = dir; ; at = dirname(at)) {
      const link = join(at, 'node_modules', '.bin', name)
      if (existsSync(link) && lstatSync(link).isSymbolicLink()) return realpathSync(link)
      if (dirname(at) === at) return null
    }
  }
}
