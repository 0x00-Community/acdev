import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

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
    if (this.name === 'pnpm' || this.name === 'yarn') return [this.name, script]
    return [this.name, 'run', script]
  }

  exec(pkg: string, args: readonly string[]): string[] {
    if (this.name === 'bun') return [this.#bin(), 'x', '--bun', pkg, ...args]
    if (this.name === 'npm') return [PackageManager.which('npx') ?? 'npx', '--yes', pkg, ...args]
    return [this.#bin(), 'dlx', pkg, ...args]
  }

  #bin(): string {
    if (this.name === 'bun' && process.versions['bun']) return process.execPath
    const found = PackageManager.which(this.name)
    if (!found) throw new Error(`${this.name} is not on PATH`)
    return found
  }

  static which(name: string): string | null {
    const windows = process.platform === 'win32'
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!dir) continue
      for (const ext of windows ? ['.exe', '.cmd', ''] : ['']) {
        const file = join(dir, name + ext)
        if (existsSync(file)) return file
      }
    }
    return null
  }

  static manifest(dir: string, dep: string): string | null {
    for (let at = dir; ; at = dirname(at)) {
      const file = join(at, 'node_modules', dep, 'package.json')
      if (existsSync(file)) return realpathSync(file)
      if (dirname(at) === at) return null
    }
  }

  static bin(dir: string, name: string, deps: ReadonlySet<string>): string | null {
    for (const dep of deps) {
      const manifest = PackageManager.manifest(dir, dep)
      if (!manifest) continue
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
