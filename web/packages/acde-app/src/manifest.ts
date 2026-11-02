import type { AppManifest as AppEntry, Capabilities, PackageManifest } from '@dopame/acde-api'

export type { Capabilities, PackageManifest } from '@dopame/acde-api'

export type AppManifest = Required<Omit<AppEntry, 'backend' | 'size'>> & { readonly backend: AppBackend | null; readonly size: readonly [number, number] | null }

export interface AppBackend {
  readonly entry: string
  readonly port: number
}

export interface Findings {
  readonly errors: string[]
  readonly warnings: string[]
}

export class Manifest {
  static readonly HEAP_MB = 256
  static readonly MIN_HEAP_MB = 32
  static readonly CAPABILITIES: ReadonlySet<string> = new Set(['fs', 'terminal', 'office', 'launch', 'slots', 'open', 'openFiles', 'session', 'desktops'])
  static readonly #MIME = /^[\w.+-]+\/([\w.+-]+|\*)$/

  static heapMb(value: unknown, fallback: number): number {
    const mb = Number(value)
    return Number.isFinite(mb) && mb >= Manifest.MIN_HEAP_MB ? mb : fallback
  }

  static app(raw: unknown): AppManifest | string {
    const incomplete = 'an app needs id, label, icon and entry'
    if (typeof raw !== 'object' || raw === null) return incomplete
    const field = (key: string) => (raw as Record<string, unknown>)[key]
    const text = (key: string) => (typeof field(key) === 'string' && field(key) ? (field(key) as string) : null)
    const id = text('id'), label = text('label'), icon = text('icon'), entry = text('entry')
    if (!id || !label || !icon || !entry || !/^[\w-]+$/.test(id) || !entry.startsWith('/')) return incomplete
    const backend = Manifest.#backend(field('backend'))
    if (typeof backend === 'string') return `app ${id}: ${backend}`
    if (entry.endsWith('/') && !backend) return `app ${id}: an entry ending in / is a page the backend renders: it needs a backend`
    const capabilities = typeof field('capabilities') === 'object' && field('capabilities') !== null ? (field('capabilities') as Capabilities) : {}
    const types = field('mimeTypes')
    if (types !== undefined && (!Array.isArray(types) || types.some((t) => typeof t !== 'string' || !Manifest.#MIME.test(t)))) return `app ${id}: mimeTypes must be MIME types (type/subtype, or type/* for all of a type)`
    const mimeTypes = (types as string[] | undefined) ?? []
    const size = Manifest.#size(field('size'))
    if (size === undefined) return `app ${id}: size must be [width, height] in whole logical pixels`
    return { id, label, icon, entry, capabilities, heapMb: Manifest.heapMb(field('heapMb'), Manifest.HEAP_MB), multiple: field('multiple') === true, frame: field('frame') !== false, mimeTypes, backend, size }
  }

  static check(manifest: PackageManifest, isDir: (path: string) => boolean, resolve: (url: string) => boolean): Findings {
    const findings: Findings = { errors: [], warnings: [] }
    const { errors, warnings } = findings
    const apps = manifest.apps ?? []
    if (apps.length === 0 && (manifest.desktops ?? []).length === 0) errors.push('acde.apps is empty: no app')
    for (const [prefix, dirs] of Object.entries(manifest.assets ?? {})) {
      if (!prefix.startsWith('/') || !prefix.endsWith('/')) errors.push(`assets ${JSON.stringify(prefix)}: a prefix is /…/`)
      for (const dir of dirs.filter((d) => !isDir(d))) errors.push(`assets ${JSON.stringify(prefix)}: no directory ${JSON.stringify(dir)}`)
    }
    const seen = new Set<string>()
    for (const raw of apps) {
      const app = Manifest.app(raw)
      if (typeof app === 'string') {
        errors.push(app)
        continue
      }
      const at = `app ${JSON.stringify(app.id)}`
      if (seen.has(app.id)) errors.push(`${at}: twice`)
      seen.add(app.id)
      if (!app.entry.endsWith('/') && !resolve(app.entry)) errors.push(`${at}: entry ${JSON.stringify(app.entry)} is in no assets directory`)
      if (app.backend && !resolve(app.backend.entry)) errors.push(`${at}: backend.entry ${JSON.stringify(app.backend.entry)} is in no assets directory`)
      if (raw.heapMb !== undefined && Manifest.heapMb(raw.heapMb, 0) === 0) warnings.push(`${at}: heapMb below ${Manifest.MIN_HEAP_MB} is ignored (${Manifest.HEAP_MB} then)`)
      for (const name of Object.keys(app.capabilities).filter((k) => !Manifest.CAPABILITIES.has(k))) {
        warnings.push(`${at}: capability ${JSON.stringify(name)} is not acde's: a desktop service of that name must be running`)
      }
    }
    return findings
  }

  static #size(raw: unknown): readonly [number, number] | null | undefined {
    if (raw === undefined || raw === null) return null
    return Array.isArray(raw) && raw.length === 2 && raw.every((n) => Number.isInteger(n) && n > 0) ? [raw[0], raw[1]] : undefined
  }

  static #backend(raw: unknown): AppBackend | null | string {
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'backend must be an object {entry, port?}'
    const { entry, port = 3000 } = raw as { entry?: unknown; port?: unknown }
    if (typeof entry !== 'string' || !entry.startsWith('/') || entry.startsWith('//') || /[\s\0?#]/.test(entry) || !/\.m?js$/.test(entry)) return 'backend.entry must be a same-origin URL of a .js module under the assets (/app/<id>/backend/server.js)'
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return 'backend.port must be a port number (0 to 65535)'
    return { entry, port }
  }
}
