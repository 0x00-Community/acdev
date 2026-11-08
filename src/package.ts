import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Manifest, type Findings, type PackageManifest } from '@dopame/acde-api/manifest'
import { Project } from './app.ts'

export interface Built {
  readonly dir: string
  readonly id: string
  readonly desktops: readonly string[]
  readonly apps: readonly string[]
}

export class AppPackage {
  readonly dir: string
  readonly name: string
  readonly manifest: PackageManifest | null
  readonly project: Project | null

  constructor(dir: string) {
    this.dir = realpathSync(resolve(dir))
    const file = join(this.dir, 'package.json')
    const json = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; acde?: { apps?: unknown } }) : {}
    const configured = Project.CONFIGS.some((name) => existsSync(join(this.dir, name)))
    this.manifest = !configured && Array.isArray(json.acde?.apps) ? (json.acde as PackageManifest) : null
    this.project = this.manifest ? null : new Project(this.dir)
    this.name = this.project?.name ?? (typeof json.name === 'string' ? json.name : basename(this.dir))
  }

  static packagesDir(): string {
    const set = process.env['XDG_DATA_HOME']
    return join(set && isAbsolute(set) ? set : join(homedir(), '.local', 'share'), 'acde', 'packages')
  }

  static check(dir: string, manifest: PackageManifest): Findings {
    const assets = Object.entries(manifest.assets ?? {})
    const resolveUrl = (url: string) =>
      assets
        .filter(([prefix]) => url.startsWith(prefix))
        .sort(([a], [b]) => b.length - a.length)
        .slice(0, 1)
        .some(([prefix, dirs]) => dirs.some((d) => AppPackage.#isFile(join(dir, d, url.slice(prefix.length)))))
    const findings = Manifest.check(manifest, (d) => AppPackage.#isDir(join(dir, d)), resolveUrl)
    for (const desktop of manifest.desktops ?? []) {
      if (!AppPackage.#isFile(join(dir, desktop.entry))) findings.errors.push(`desktop ${JSON.stringify(desktop.id)}: no entry ${desktop.entry}`)
    }
    for (const service of manifest.services ?? []) {
      if (!AppPackage.#isFile(join(dir, service.module))) findings.errors.push(`service ${JSON.stringify(service.name)}: no module ${service.module}`)
    }
    return findings
  }

  get kind(): string {
    return this.project ? `${this.project.config.type} (${this.project.from})` : 'package'
  }

  check(): Findings {
    if (this.manifest) return AppPackage.check(this.dir, this.manifest)
    return { errors: this.project!.check(), warnings: [] }
  }

  async build(out: string): Promise<Built> {
    if (this.manifest) {
      AppPackage.#throw(this.check())
      const apps = (this.manifest.apps ?? []).map((app) => app.id)
      return { dir: this.dir, id: this.name.replace(/^@[^/]*\//, ''), desktops: (this.manifest.desktops ?? []).map((d) => d.id), apps }
    }
    const built = await this.project!.build(out)
    AppPackage.#throw(AppPackage.check(out, built.acde))
    return { dir: out, id: this.project!.id, desktops: (built.acde.desktops ?? []).map((d) => d.id), apps: built.acde.apps.map((app) => app.id) }
  }

  install(built: Built): string {
    const dest = join(AppPackage.packagesDir(), built.id)
    mkdirSync(dirname(dest), { recursive: true })
    if (this.manifest) {
      if (existsSync(dest) || AppPackage.#isLink(dest)) {
        if (!AppPackage.#isLink(dest)) throw new Error(`${dest} exists and is not a link`)
        rmSync(dest)
      }
      symlinkSync(this.dir, dest)
      return dest
    }
    const next = `${dest}.new-${process.pid}`
    rmSync(next, { recursive: true, force: true })
    cpSync(built.dir, next, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    renameSync(next, dest)
    return dest
  }

  static #throw(findings: Findings): void {
    for (const warning of findings.warnings) console.error(`warning: ${warning}`)
    if (findings.errors.length > 0) throw new Error(findings.errors.join('\n'))
  }

  static #isFile(path: string): boolean {
    return existsSync(path) && statSync(path).isFile()
  }

  static #isDir(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory()
  }

  static #isLink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }
}
