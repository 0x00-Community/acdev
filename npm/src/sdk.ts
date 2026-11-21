import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { installDir, installed } from 'acdev/launcher'
import { up } from './paths.ts'
import { Output } from './output.ts'
import { PackageManager } from './pm.ts'
import { Runtime, type Child } from './runtime.ts'

export interface SdkState {
  readonly section: 'dependencies' | 'devDependencies' | null
  readonly spec: string | null
  readonly version: string | null
  readonly installed: string | null
  readonly paired: string
}

export class Sdk {
  static readonly NAME = '@acde/api'
  static readonly SECTIONS = ['devDependencies', 'dependencies'] as const
  static readonly ROOT = realpathSync(join(import.meta.dirname, '..'))
  static readonly SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  static readonly PREFIX_MS = 30_000
  static readonly LOCKS = [
    'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock',
  ]

  static paired(): string {
    const { version } = JSON.parse(readFileSync(join(Sdk.dir(), 'package.json'), 'utf8')) as { version: string }
    return version
  }

  static spec(): string {
    return `file:${Sdk.dir()}`
  }

  static dir(): string {
    const given = process.env['ACDEV_SDK']
    if (given) return realpathSync(resolve(given))
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
      throw new Error(`acdev's package.json: ${Sdk.NAME} is not a file: dependency (${spec})`)
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
      const found = join(at, 'node_modules', '@acde', 'api', 'package.json')
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

  static path(dir: string, spec: string): string | null {
    if (!spec.startsWith('file:')) return null
    const at = resolve(dir, spec.slice('file:'.length))
    return existsSync(at) ? realpathSync(at) : at
  }

  static versionOf(dir: string, spec: string): string | null {
    const tarball = /\/acde-api-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/.exec(spec)
    if (tarball) return tarball[1]!
    const path = Sdk.path(dir, spec)
    const installed = join(path ?? join(dir, 'node_modules', '@acde', 'api'), 'package.json')
    if (!existsSync(installed)) return null
    const { version } = JSON.parse(readFileSync(installed, 'utf8')) as { version?: unknown }
    return typeof version === 'string' ? version : null
  }

  static warning(state: SdkState, pm: () => string, dir = ''): string | null {
    if (state.spec === null) return null
    const path = Sdk.path(dir, state.spec)
    const mine = Sdk.dir()
    if (path === null || path !== (existsSync(mine) ? realpathSync(mine) : mine)) {
      return `package.json: ${Sdk.NAME} is ${state.spec}, but this acdev's SDK is ${Sdk.spec()}: run acdev sdk update`
    }
    if (state.version !== state.paired) {
      const has = state.version === null ? state.spec : `${state.version} (${state.spec})`
      return `package.json: ${Sdk.NAME} is ${has}, but this acdev pairs with ${state.paired}: run acdev sdk update`
    }
    if (state.installed === null || state.installed === state.version) return null
    return `package.json names ${Sdk.NAME} ${state.version}, but ${state.installed} is installed: run ${pm()} install`
  }

  static show(dir: string, pkg: Readonly<Record<string, unknown>>): string[] {
    const state = Sdk.state(dir, pkg)
    const project = state.spec === null ? 'none' : `${state.version ?? 'unknown version'} (${state.spec})`
    const warning = Sdk.warning(state, () => PackageManager.of(dir).name, dir)
    return [
      `project: ${project}`,
      `this acdev: ${state.paired} (${Sdk.spec()})`,
      ...(warning ? [warning] : state.spec === null ? ['run acdev sdk update to add it'] : ['up to date']),
    ]
  }

  static async update(given: string): Promise<string> {
    if (!existsSync(join(given, 'package.json'))) throw new Error(`sdk: no package.json in ${given}`)
    const dir = realpathSync(given)
    const file = join(dir, 'package.json')
    const before = readFileSync(file, 'utf8')
    const pkg = JSON.parse(before) as Record<string, Record<string, string> | unknown>
    const state = Sdk.state(dir, pkg)
    const section = state.section ?? 'devDependencies'
    const spec = Sdk.spec()
    const deps = { ...((pkg[section] as Record<string, string> | undefined) ?? {}), [Sdk.NAME]: spec }
    pkg[section] = deps
    const pm = PackageManager.of(dir)
    const install = Sdk.#install(pm)
    const config = pm.name === 'npm' ? realpathSync(await Sdk.#prefix(install[0]!, dir)) : dir
    const places = [...new Set([dir, ...(pm.at === null ? [] : [realpathSync(pm.at)]), config])]
    const kept = Sdk.#keep([file, ...places.flatMap((at) => [
      ...(at === dir ? [] : ['package.json']), ...Sdk.LOCKS, '.npmrc',
    ].map((name) => join(at, name)))])
    const indent = /^\{\n(\s+)"/.exec(before.replace(/\r\n/g, '\n'))?.[1] ?? '  '
    let signal: NodeJS.Signals | null = null
    let child: Child | null = null
    const stops = Sdk.SIGNALS.map((name) => [name, () => {
      const first = signal === null
      signal ??= name
      if (!child) return
      if (!first) Runtime.killTree(child)
      else if (process.platform !== 'win32') child.kill(name === 'SIGINT' ? 'SIGTERM' : name)
    }] as const)
    for (const [name, stop] of stops) process.on(name, stop)
    let ran = false
    let failure: string | null = null
    try {
      writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`)
      child = Runtime.spawn(install, { cwd: dir, stdio: 'inherit' })
      const code = await child.exited.catch((error: unknown) => {
        failure = `${pm.name} install did not start (${Output.message(error)})`
        return null
      })
      ran = code !== null
      if (code !== null && code !== 0) failure = `${pm.name} install exited with ${code}`
    } catch (error) {
      failure = Output.message(error)
    } finally {
      for (const [name, stop] of stops) process.off(name, stop)
    }
    if (signal === null && failure === null) {
      return `acdev: ${Sdk.NAME} is ${state.paired} (${spec}), installed with ${pm.name}`
    }
    const failed = Sdk.#restore(kept)
    const was = state.spec === null ? `no ${Sdk.NAME}` : `${Sdk.NAME} ${state.version ?? state.spec}`
    const back = [...kept].filter(([path, text]) => text !== null && !failed.has(path)
      && (path === file || Sdk.LOCKS.includes(basename(path)))).map(([path]) => Sdk.#shown(dir, path))
    const cause = signal === null ? failure! : `interrupted (${signal})`
    const same = back.length > 0 ? `${back.join(' and ')} are as before (${was})` : ''
    const undone = failed.size === 0 ? `so the update to ${state.paired} was undone: ${same}`
      : `and the update to ${state.paired} could not be undone completely: could not put back `
        + `${[...failed].map(([path, why]) => `${Sdk.#shown(dir, path)} (${why})`).join(', ')}`
        + `${same && `; ${same}`}`
    const rerun = ran ? `; node_modules may be half updated: run ${pm.name} install to match them` : ''
    const message = `sdk: ${cause}, ${undone}${rerun}`
    throw signal === null ? new Error(message) : new SdkInterrupted(message)
  }

  static #install(pm: PackageManager): string[] {
    try {
      return pm.install
    } catch (error) {
      throw new Error(`sdk: ${Output.message(error)}, and this project installs with ${pm.name}: nothing was changed`)
    }
  }

  static async #prefix(npm: string, dir: string): Promise<string> {
    const ran = await Runtime.capture([npm, 'prefix'], { cwd: dir, timeout: Sdk.PREFIX_MS })
    const prefix = ran.code === 0 ? ran.stdout.trim() : ''
    if (prefix && existsSync(prefix)) return prefix
    const why = ran.error ?? (ran.timedOut ? `no answer within ${Sdk.PREFIX_MS / 1000} s` : ran.stderr.trim() || `exit ${ran.code}`)
    throw new Error(`sdk: npm prefix (where npm keeps this project's lock file and .npmrc) failed: ${why}; nothing was changed`)
  }

  static #shown(dir: string, path: string): string {
    return relative(dir, path) || path
  }

  static #keep(paths: readonly string[]): Map<string, string | null> {
    return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path, 'latin1') : null]))
  }

  static #restore(kept: ReadonlyMap<string, string | null>): Map<string, string> {
    const failed = new Map<string, string>()
    for (const [path, text] of kept) {
      try {
        const now = existsSync(path) ? readFileSync(path, 'latin1') : null
        if (now === text) continue
        if (text === null) rmSync(path, { recursive: true, force: true })
        else writeFileSync(path, text, 'latin1')
      } catch (error) {
        failed.set(path, Output.message(error))
      }
    }
    return failed
  }
}

export class SdkInterrupted extends Error {}
