import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { packageRoot } from 'acde/launcher'
import { up } from '../paths.ts'

interface Config {
  readonly file: string
  readonly extends: readonly string[]
  readonly baseUrl: string | null
  readonly paths: Readonly<Record<string, readonly string[]>> | null
}

export class TestTsconfig {
  static readonly MODULES: Readonly<Record<string, string>> = {
    'acde/test': join(packageRoot(), 'src', 'e2e', 'index.ts'),
    'acde/driver': join(packageRoot(), 'src', 'driver', 'index.ts'),
  }

  static nearest(project: string): string | null {
    return up(resolve(project), (dir) => {
      const file = join(dir, 'tsconfig.json')
      return existsSync(file) && statSync(file).isFile() && file
    })
  }

  static build(project: string): object {
    const base = TestTsconfig.nearest(project)
    const own = base === null ? {} : TestTsconfig.paths(base)
    const paths = { ...own, ...Object.fromEntries(Object.entries(TestTsconfig.MODULES).map(([name, file]) => [name, [file]])) }
    return { ...(base !== null && { extends: base }), compilerOptions: { paths } }
  }

  static paths(file: string): Record<string, string[]> {
    let paths: { readonly map: Readonly<Record<string, readonly string[]>>; readonly dir: string } | null = null
    let baseUrl: string | null = null
    for (const config of TestTsconfig.#chain(file, new Set())) {
      if (paths === null && config.paths !== null) paths = { map: config.paths, dir: dirname(config.file) }
      if (baseUrl === null && config.baseUrl !== null) baseUrl = resolve(dirname(config.file), config.baseUrl)
    }
    if (paths === null) return {}
    const from = baseUrl ?? paths.dir
    return Object.fromEntries(Object.entries(paths.map).map(([name, targets]) => [name, targets.map((target) => resolve(from, target))]))
  }

  static #chain(file: string, seen: Set<string>): Config[] {
    if (seen.has(file)) return []
    seen.add(file)
    const config = TestTsconfig.#read(file)
    if (config === null) return []
    const parents = config.extends.map((spec) => TestTsconfig.#extended(spec, dirname(file))).filter((parent): parent is string => parent !== null)
    return [config, ...parents.reverse().flatMap((parent) => TestTsconfig.#chain(parent, seen))]
  }

  static #read(file: string): Config | null {
    let json: unknown
    try {
      json = Bun.JSONC.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    if (typeof json !== 'object' || json === null) return null
    const record = json as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
    const extended = typeof record.extends === 'string' ? [record.extends] : Array.isArray(record.extends) ? record.extends.filter((e): e is string => typeof e === 'string') : []
    const options = record.compilerOptions ?? {}
    const paths = typeof options.paths === 'object' && options.paths !== null ? TestTsconfig.#pathMap(options.paths as Record<string, unknown>) : null
    return { file, extends: extended, baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl : null, paths }
  }

  static #pathMap(raw: Record<string, unknown>): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(raw)
        .map(([name, targets]) => [name, Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : []] as const)
        .filter(([, targets]) => targets.length > 0),
    )
  }

  static #extended(spec: string, dir: string): string | null {
    if (spec.startsWith('.') || isAbsolute(spec)) {
      const path = resolve(dir, spec)
      for (const candidate of [path, `${path}.json`, join(path, 'tsconfig.json')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      return null
    }
    for (const candidate of [spec, `${spec}.json`, `${spec}/tsconfig.json`]) {
      try {
        return Bun.resolveSync(candidate, dir)
      } catch {}
    }
    return null
  }
}
