export interface MimeSource {
  readonly globs2: string | null
  readonly subclasses: string | null
}

interface Glob {
  readonly weight: number
  readonly mime: string
  readonly pattern: string
  readonly literal: boolean
  readonly cs: boolean
  readonly test: (name: string) => boolean
}

const WILDCARD = /[*?[]/

function matcher(pattern: string, caseSensitive: boolean): (name: string) => boolean {
  const fold = (text: string) => (caseSensitive ? text : text.toLowerCase())
  const wanted = fold(pattern)
  if (!WILDCARD.test(pattern)) return (name) => fold(name) === wanted
  if (wanted.startsWith('*') && !WILDCARD.test(wanted.slice(1))) {
    const suffix = wanted.slice(1)
    return (name) => fold(name).endsWith(suffix)
  }
  let source = ''
  for (let i = 0; i < wanted.length; i++) {
    const c = wanted[i]!
    if (c === '*') source += '.*'
    else if (c === '?') source += '.'
    else if (c === '[') {
      const end = wanted.indexOf(']', i + 2)
      if (end < 0) source += '\\['
      else {
        const body = wanted.slice(i + 1, end)
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`.replace(/\\/g, '\\\\')
        i = end
      }
    } else source += c.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  const re = new RegExp(`^${source}$`, 's')
  return (name) => re.test(fold(name))
}

export class MimeDb {
  readonly #globs: readonly Glob[]
  readonly #parents: ReadonlyMap<string, readonly string[]>

  private constructor(globs: readonly Glob[], parents: ReadonlyMap<string, readonly string[]>) {
    this.#globs = globs
    this.#parents = parents
  }

  static parse(sources: readonly MimeSource[]): MimeDb | null {
    if (!sources.some((s) => s.globs2 !== null)) return null
    const globs: Glob[] = []
    const cleared = new Set<string>()
    const parents = new Map<string, string[]>()
    for (const source of sources) {
      const here: Glob[] = []
      const clearing = new Set<string>()
      for (const line of (source.globs2 ?? '').split('\n')) {
        if (!line || line.startsWith('#')) continue
        const [weight, mime, pattern, flags] = line.split(':')
        if (!weight || !mime || pattern === undefined || pattern === '') continue
        if (cleared.has(mime)) continue
        if (pattern === '__NOGLOBS__') {
          clearing.add(mime)
          continue
        }
        const literal = !WILDCARD.test(pattern)
        const cs = (flags ?? '').split(',').includes('cs')
        here.push({ weight: Number(weight) || 50, mime, pattern, literal, cs, test: matcher(pattern, cs) })
      }
      globs.push(...here)
      for (const mime of clearing) cleared.add(mime)
      for (const line of (source.subclasses ?? '').split('\n')) {
        const [child, parent] = line.trim().split(/\s+/)
        if (!child || !parent || child.startsWith('#')) continue
        const list = parents.get(child) ?? []
        if (!list.includes(parent)) list.push(parent)
        parents.set(child, list)
      }
    }
    return new MimeDb(globs, parents)
  }

  candidates(name: string): string[] {
    const matched = this.#globs.filter((g) => g.test(name))
    const literal = matched.filter((g) => g.literal)
    const pool = literal.length ? literal : matched
    if (!pool.length) return []
    const rank = (g: Glob) => [g.weight, g.pattern.length, g.cs ? 1 : 0] as const
    const better = (a: readonly number[], b: readonly number[]) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!
    const top = pool.map(rank).sort(better)[0]!
    return [...new Set(pool.filter((g) => better(rank(g), top) === 0).map((g) => g.mime))]
  }

  isText(mime: string): boolean {
    const seen = new Set<string>()
    const walk = (m: string): boolean => {
      if (m === 'text/plain' || m.startsWith('text/')) return true
      if (seen.has(m)) return false
      seen.add(m)
      return (this.#parents.get(m) ?? []).some(walk)
    }
    return walk(mime)
  }
}
