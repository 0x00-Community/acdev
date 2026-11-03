import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { install, packagesDir, Project } from './app.ts'
import { Manifest, type Findings, type PackageManifest } from './manifest.ts'

export interface Built {
  readonly dir: string
  readonly id: string
  readonly desktops: readonly string[]
  readonly apps: readonly string[]
}

export class AppPackage {
  static readonly TEMPLATES = join(import.meta.dir, '../templates')
  static readonly API = join(import.meta.dir, '../../acde-api')
  static readonly KINDS = ['app', 'desktop'] as const

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

  static create(dir: string, kind: (typeof AppPackage.KINDS)[number], id = basename(resolve(dir)), label = id, api = process.env['ACDE_API'] || `file:${AppPackage.API}`): AppPackage {
    if (existsSync(dir) && readdirSync(dir).some((name) => name !== '.git')) throw new Error(`${dir} is not empty`)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`id ${JSON.stringify(id)}: lowercase letters, digits and -`)
    const from = join(AppPackage.TEMPLATES, kind)
    const copy = (rel: string) => {
      for (const name of readdirSync(join(from, rel))) {
        const source = join(from, rel, name)
        if (statSync(source).isDirectory()) {
          copy(join(rel, name))
          continue
        }
        const file = join(dir, rel, name === 'gitignore' ? '.gitignore' : name)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, readFileSync(source, 'utf8').replaceAll('{{id}}', id).replaceAll('{{label}}', label).replaceAll('{{api}}', api))
      }
    }
    copy('')
    return new AppPackage(dir)
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
    if (!this.manifest) return install(built.dir, built.id)
    const link = join(packagesDir(), built.id)
    mkdirSync(dirname(link), { recursive: true })
    if (existsSync(link) || AppPackage.#isLink(link)) {
      if (!AppPackage.#isLink(link)) throw new Error(`${link} exists and is not a link`)
      rmSync(link)
    }
    symlinkSync(this.dir, link)
    return link
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
