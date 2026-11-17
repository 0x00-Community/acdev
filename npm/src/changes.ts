import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { PackageManifest } from './manifest/index.ts'
import { AppPackage } from './package.ts'

export type Snapshot = ReadonlyMap<string, string>

export type Reload = 'none' | 'hot' | 'full'

export interface Served {
  readonly roots: readonly string[]
  readonly fixed: readonly string[]
}

export const HOT = new Set(['.css', '.js', '.mjs', '.map'])
export const IGNORED = new Set(['node_modules', '.git', '.acde'])
const PAGE = new Set(['.html', '.htm'])
const REFERENCES = [
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bstylesheet\b[^>]*>/gi,
]

export function served(dir: string, manifest: PackageManifest, whole: boolean): Served {
  const backends = (manifest.apps ?? []).map((app) => (app.backend ? fileOf(dir, manifest, app.backend.entry) : null))
    .filter((path): path is string => path !== null).map((path) => parentOf(posix(path)))
  const services = (manifest.services ?? []).map((service) => posix(service.module))
  const fixed = [...backends, ...services]
  if (whole) return { roots: ['.'], fixed }
  const desktops = (manifest.desktops ?? []).map((desktop) => desktop.entry)
  const assets = Object.values(manifest.assets ?? {}).flat()
  const tops = new Set([...desktops, ...assets, ...fixed].map((path) => posix(path).split('/')[0]!))
  const nested = tops.size > 0 && [...tops].every((top) => top !== '.' && isDir(join(dir, top)))
  return { roots: nested ? [...tops, 'package.json'] : ['.'], fixed }
}

export function snapshot(dir: string, roots: readonly string[]): Snapshot {
  const files = new Map<string, string>()
  const walk = (path: string): void => {
    let stat: Stats
    try {
      stat = statSync(path)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) if (!IGNORED.has(name)) walk(join(path, name))
      return
    }
    const key = posix(relative(dir, path))
    files.set(key, digest(key, readFileSync(path)))
  }
  for (const root of roots) walk(join(dir, root))
  return files
}

export function changed(before: Snapshot, after: Snapshot): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort()
}

export function reload(before: Snapshot, after: Snapshot, fixed: readonly string[]): Reload {
  const paths = changed(before, after)
  if (paths.length === 0) return 'none'
  const inFixed = (path: string) => fixed.some((place) => path === place || path.startsWith(`${place}/`))
  const hot = (path: string) => HOT.has(extname(path).toLowerCase()) && !inFixed(path)
  return paths.every(hot) ? 'hot' : 'full'
}

export function page(html: string): string {
  return REFERENCES.reduce((text, pattern) => text.replace(pattern, ''), html)
}

function digest(path: string, data: Buffer): string {
  const html = PAGE.has(extname(path).toLowerCase())
  return createHash('sha256').update(html ? page(data.toString('utf8')) : data).digest('hex')
}

function fileOf(dir: string, manifest: PackageManifest, url: string): string | null {
  const file = url.startsWith('/') ? AppPackage.asset(dir, manifest, url) : join(dir, url)
  if (file === null || !existsSync(file)) return null
  const rel = relative(dir, file)
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel
}

function parentOf(path: string): string {
  const parent = dirname(path)
  return parent === '.' ? path : parent
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
