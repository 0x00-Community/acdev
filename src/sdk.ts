import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { installDir, installed } from 'acde/launcher'
import { up } from './paths.ts'
import { Pkgs } from './pkgs.ts'
import { PackageManager } from './pm.ts'
import { Runtime } from './runtime.ts'

export interface SdkState {
  readonly section: 'dependencies' | 'devDependencies' | null
  readonly spec: string | null
  readonly version: string | null
  readonly installed: string | null
  readonly paired: string
}

export class Sdk {
  static readonly NAME = '@dopame/acde-api'
  static readonly SECTIONS = ['devDependencies', 'dependencies'] as const
  static readonly DIST = Pkgs.ACDERT
  static readonly ROOT = realpathSync(join(import.meta.dirname, '..'))
  static readonly NPMRC = 'allow-remote=root'
  static readonly LOCKS = [
    'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock',
  ]

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
      if (typeof spec === 'string') {
        return { section, spec, version: Sdk.versionOf(dir, spec), installed: Sdk.installed(dir), paired }
      }
    }
    return { section: null, spec: null, version: null, installed: null, paired }
  }

  static installed(dir: string): string | null {
    const file = up(dir, (at) => {
      const found = join(at, 'node_modules', '@dopame', 'acde-api', 'package.json')
      return existsSync(found) && found
    })
    if (!file) return null
    try {
      const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
      return typeof version === 'string' ? version : null
    } catch {
      return null
    }
  }

  static allowRemote(dir: string): boolean {
    const file = join(dir, '.npmrc')
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (/^\s*allow-remote\s*=/m.test(text)) return false
    writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${Sdk.NPMRC}\n`)
    return true
  }

  static versionOf(dir: string, spec: string): string | null {
    const tarball = /\/acde-api-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/.exec(spec)
    if (tarball) return tarball[1]!
    const installed = join(dir, 'node_modules', '@dopame', 'acde-api', 'package.json')
    if (!existsSync(installed)) return null
    const { version } = JSON.parse(readFileSync(installed, 'utf8')) as { version?: unknown }
    return typeof version === 'string' ? version : null
  }

  static warning(state: SdkState, pm = 'npm'): string | null {
    if (state.spec === null) return null
    if (state.version !== state.paired) {
      const has = state.version === null ? state.spec : `${state.version} (${state.spec})`
      return `package.json: ${Sdk.NAME} is ${has}, but this acde pairs with ${state.paired}: run acde sdk update`
    }
    if (state.installed === null || state.installed === state.version) return null
    return `package.json names ${Sdk.NAME} ${state.version}, but ${state.installed} is installed: run ${pm} install`
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
    const before = readFileSync(file, 'utf8')
    const pkg = JSON.parse(before) as Record<string, Record<string, string> | unknown>
    const state = Sdk.state(dir, pkg)
    const section = state.section ?? 'devDependencies'
    const url = Sdk.url(state.paired)
    const deps = { ...((pkg[section] as Record<string, string> | undefined) ?? {}), [Sdk.NAME]: url }
    pkg[section] = deps
    const pm = PackageManager.of(dir)
    const kept = Sdk.#keep(dir, [...Sdk.LOCKS, '.npmrc'])
    const indent = /^\{\n(\s+)"/.exec(before.replace(/\r\n/g, '\n'))?.[1] ?? '  '
    writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`)
    const npmrc = pm.name === 'npm' && Sdk.allowRemote(dir)
    const code = await Runtime.spawn(pm.install, { cwd: dir, stdio: 'inherit' }).exited
    if (code !== 0) {
      writeFileSync(file, before)
      Sdk.#restore(dir, kept)
      const was = state.spec === null ? `no ${Sdk.NAME}` : `${Sdk.NAME} ${state.version ?? state.spec}`
      const locks = Object.keys(kept).filter((name) => name !== '.npmrc' && kept[name] !== null)
      const back = ['package.json', ...locks].join(' and ')
      throw new Error(`sdk: ${pm.name} install exited with ${code}, so the update to ${state.paired} was undone: `
        + `${back} are as before (${was}); node_modules may be half updated: run ${pm.name} install to match them`)
    }
    const added = npmrc ? `; .npmrc now has ${Sdk.NPMRC} (npm 12 refuses URL dependencies without it)` : ''
    return `acde: ${Sdk.NAME} is ${state.paired} (${url}), installed with ${pm.name}${added}`
  }

  static #keep(dir: string, names: readonly string[]): Record<string, string | null> {
    return Object.fromEntries(names.map((name) => {
      const file = join(dir, name)
      return [name, existsSync(file) ? readFileSync(file, 'latin1') : null]
    }))
  }

  static #restore(dir: string, kept: Readonly<Record<string, string | null>>): void {
    for (const [name, text] of Object.entries(kept)) {
      const file = join(dir, name)
      if (text === null) rmSync(file, { force: true })
      else writeFileSync(file, text, 'latin1')
    }
  }
}
