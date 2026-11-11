import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { installDir, installed } from 'acde/launcher'
import { PackageManager } from './pm.ts'
import { Runtime } from './runtime.ts'

export interface SdkState {
  readonly section: 'dependencies' | 'devDependencies' | null
  readonly spec: string | null
  readonly version: string | null
  readonly paired: string
}

export class Sdk {
  static readonly NAME = '@dopame/acde-api'
  static readonly SECTIONS = ['devDependencies', 'dependencies'] as const
  static readonly DIST = 'https://pkgs.dopame.ai/acdert'
  static readonly ROOT = realpathSync(join(import.meta.dirname, '..'))

  static paired(): string {
    const { version } = JSON.parse(readFileSync(join(Sdk.dir(), 'package.json'), 'utf8')) as { version: string }
    return version
  }

  static url(version = Sdk.paired()): string {
    const base = (process.env['ACDERT_DIST'] || Sdk.DIST).replace(/\/+$/, '')
    return `${base}/${version}/acde-api-${version}.tar.gz`
  }

  static dir(): string {
    const lib = dirname(Sdk.ROOT)
    if (installed(Sdk.ROOT)) {
      const current = join(installDir(), 'current', 'lib')
      return existsSync(current) && realpathSync(current) === lib ? join(current, 'acde-api') : join(lib, 'acde-api')
    }
    const self = JSON.parse(readFileSync(join(Sdk.ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const spec = self.dependencies[Sdk.NAME] ?? ''
    if (!spec.startsWith('file:'))
      throw new Error(`acde's package.json: ${Sdk.NAME} is not a file: dependency (${spec})`)
    return realpathSync(resolve(Sdk.ROOT, spec.slice('file:'.length)))
  }

  static state(dir: string, pkg: Readonly<Record<string, unknown>>): SdkState {
    const paired = Sdk.paired()
    for (const section of Sdk.SECTIONS) {
      const spec = (pkg[section] as Record<string, unknown> | undefined)?.[Sdk.NAME]
      if (typeof spec === 'string') return { section, spec, version: Sdk.versionOf(dir, spec), paired }
    }
    return { section: null, spec: null, version: null, paired }
  }

  static versionOf(dir: string, spec: string): string | null {
    const tarball = /\/acde-api-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/.exec(spec)
    if (tarball) return tarball[1]!
    const installed = join(dir, 'node_modules', '@dopame', 'acde-api', 'package.json')
    if (!existsSync(installed)) return null
    const { version } = JSON.parse(readFileSync(installed, 'utf8')) as { version?: unknown }
    return typeof version === 'string' ? version : null
  }

  static warning(state: SdkState): string | null {
    if (state.spec === null || state.version === state.paired) return null
    const has = state.version === null ? state.spec : `${state.version} (${state.spec})`
    return `package.json: ${Sdk.NAME} is ${has}, but this acde pairs with ${state.paired}: run acde sdk update`
  }

  static show(dir: string, pkg: Readonly<Record<string, unknown>>): string[] {
    const state = Sdk.state(dir, pkg)
    const project = state.spec === null ? 'none' : `${state.version ?? 'unknown version'} (${state.spec})`
    const warning = Sdk.warning(state)
    return [
      `project: ${project}`,
      `this acde: ${state.paired} (${Sdk.url(state.paired)})`,
      ...(warning ? [warning] : state.spec === null ? ['run acde sdk update to add it'] : ['up to date']),
    ]
  }

  static async update(dir: string): Promise<string> {
    const file = join(dir, 'package.json')
    if (!existsSync(file)) throw new Error(`sdk: no package.json in ${dir}`)
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string> | unknown>
    const state = Sdk.state(dir, pkg)
    const section = state.section ?? 'devDependencies'
    const url = Sdk.url(state.paired)
    const deps = { ...((pkg[section] as Record<string, string> | undefined) ?? {}), [Sdk.NAME]: url }
    pkg[section] = deps
    const indent = /^\{\n(\s+)"/.exec(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))?.[1] ?? '  '
    writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`)
    const pm = PackageManager.of(dir)
    const code = await Runtime.spawn(pm.install, { cwd: dir, stdio: 'inherit' }).exited
    if (code !== 0) throw new Error(`sdk: ${pm.name} install exited with ${code}; package.json now names ${url}`)
    return `acde: ${Sdk.NAME} is ${state.paired} (${url}), installed with ${pm.name}`
  }
}
