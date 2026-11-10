import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Manifest, type AppManifest } from '@dopame/acde-api/manifest'
import { E2E_FILE, SKIPPED } from './paths.ts'

export interface AcdeImport {
  readonly name: string
  readonly line: number
  readonly dynamic: boolean
}

export interface ImportOwner {
  readonly app: AppManifest
  readonly system: boolean
  readonly entries: readonly string[]
}

export interface ImportFindings {
  readonly errors: string[]
  readonly notes: string[]
}

interface Specifier {
  readonly spec: string
  readonly line: number
  readonly dynamic: boolean
}

interface Token {
  readonly kind: 'id' | 'str' | 'punct'
  readonly value: string
  readonly line: number
}

export class Imports {
  static readonly SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?)$/i
  static readonly #EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
  static readonly #MARKUP = /\.(?:html?|vue|svelte|astro)$/i
  static readonly #SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  static readonly #SRC = /\bsrc\s*=\s*(["'])([^"']+)\1/i
  static readonly #BEFORE_REGEX = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield',
    'await',
  ])
  static readonly #CLAUSE = /^(?:[\w$]+|[{},*])$/

  static scan(text: string, file = ''): AcdeImport[] {
    return Imports.#specifiers(text, file)
      .filter((found) => found.spec.startsWith('acde:'))
      .map(({ spec, line, dynamic }) => ({ name: spec.slice('acde:'.length), line, dynamic }))
  }

  static check(dir: string, owners: readonly ImportOwner[], root: (url: string) => string | null): ImportFindings {
    const errors = new Set<string>()
    const notes = new Set<string>()
    const cache = new Map<string, Specifier[]>()
    const read = (file: string) => {
      let found = cache.get(file)
      if (!found) cache.set(file, (found = Imports.#specifiers(readFileSync(file, 'utf8'), file)))
      return found
    }
    for (const { app, system, entries } of owners) {
      const required = { ...app, capabilities: Imports.#without(app) }
      for (const file of Imports.#reach(entries, read, root)) {
        const at = relative(dir, file).split(sep).join('/')
        for (const { spec, line } of read(file).filter((found) => found.spec.startsWith('acde:'))) {
          const name = spec.slice('acde:'.length)
          const where = `${at}:${line}: app ${JSON.stringify(app.id)}`
          const rule = Manifest.importRule(name, app, { system })
          if (!rule.allowed) {
            errors.add(`${where}: ${rule.reason}`)
            continue
          }
          if (rule.unverified) notes.add(`${where}: ${rule.unverified}`)
          const strict = Manifest.importRule(name, required, { system })
          if (!strict.allowed && strict.missing) {
            errors.add(`${where}: acde:${name} is optional (${JSON.stringify(strict.missing)} is in optional): ` +
              `reach it with load('${name}') from @dopame/acde-api instead of importing it`)
          }
        }
      }
    }
    return { errors: [...errors], notes: [...notes] }
  }

  static sources(dir: string): string[] {
    const files: string[] = []
    const walk = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name)) continue
        const path = join(at, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && Imports.SOURCE.test(entry.name) && !Imports.#skipped(entry.name)) files.push(path)
      }
    }
    walk(dir)
    return files
  }

  static #skipped(name: string): boolean {
    return /\.d\.[cm]?ts$/.test(name) || E2E_FILE.test(name) || /\.html?$/i.test(name)
  }

  static #without(app: AppManifest): AppManifest['capabilities'] {
    const capabilities: Record<string, unknown> = { ...app.capabilities }
    for (const name of app.optional) delete capabilities[name]
    return capabilities as AppManifest['capabilities']
  }

  static #reach(
    entries: readonly string[], read: (file: string) => Specifier[], root: (url: string) => string | null,
  ): string[] {
    const seen = new Set<string>()
    const queue = entries.filter((file) => Imports.#isFile(file))
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const { spec } of read(file)) {
        const next = Imports.#resolve(spec, file, root)
        if (next && !seen.has(next) && Imports.SOURCE.test(next)) queue.push(next)
      }
    }
    return [...seen]
  }

  static #resolve(spec: string, from: string, root: (url: string) => string | null): string | null {
    const clean = spec.replace(/[?#].*$/s, '')
    let base: string | null = null
    if (clean.startsWith('./') || clean.startsWith('../')) base = resolve(dirname(from), clean)
    else if (clean.startsWith('/') && !clean.startsWith('//')) base = root(clean)
    if (!base) return null
    const swapped = /\.[cm]?jsx?$/.test(base)
      ? ['.ts', '.tsx', '.mts', '.cts'].map((ext) => base.replace(/\.[cm]?jsx?$/, ext))
      : []
    const candidates = [
      base,
      ...swapped,
      ...Imports.#EXTENSIONS.map((ext) => base + ext),
      ...Imports.#EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    ]
    return candidates.find((file) => Imports.#isFile(file)) ?? null
  }

  static #isFile(path: string): boolean {
    return existsSync(path) && statSync(path).isFile()
  }

  static #specifiers(text: string, file: string): Specifier[] {
    if (!Imports.#MARKUP.test(file)) return Imports.#code(text)
    const found: Specifier[] = []
    const lineAt = (index: number) => text.slice(0, index).split('\n').length
    const blank = (part: string) => part.replace(/[^\n]/g, ' ')
    let kept = ''
    let last = 0
    if (/\.astro$/i.test(file)) {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
      if (front) {
        kept = text.slice(0, front[0].length)
        last = front[0].length
      }
    }
    for (const match of text.slice(last).matchAll(Imports.#SCRIPT)) {
      const start = last + match.index
      const src = Imports.#SRC.exec(match[1]!)
      if (src) found.push({ spec: Imports.#relative(src[2]!), line: lineAt(start), dynamic: false })
      const bodyAt = start + match[0].indexOf('>') + 1
      kept += blank(text.slice(kept.length, bodyAt)) + match[2]!
    }
    kept += blank(text.slice(kept.length))
    return [...found, ...Imports.#code(kept)].sort((a, b) => a.line - b.line)
  }

  static #relative(url: string): string {
    return /^(?:\.{1,2}\/|\/|[a-z][\w+.-]*:)/i.test(url) ? url : `./${url}`
  }

  static #code(text: string): Specifier[] {
    const tokens = Imports.#tokens(text)
    const found: Specifier[] = []
    const at = (i: number) => tokens[i]
    const is = (i: number, kind: Token['kind'], value?: string) =>
      at(i)?.kind === kind && (value === undefined || at(i)!.value === value)
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token.kind !== 'id' || (token.value !== 'import' && token.value !== 'export')) continue
      if (is(i - 1, 'punct', '.')) continue
      if (token.value === 'import' && is(i + 1, 'punct', '(')) {
        if (is(i + 2, 'str') && (is(i + 3, 'punct', ')') || is(i + 3, 'punct', ',')))
          found.push({ spec: at(i + 2)!.value, line: token.line, dynamic: true })
        continue
      }
      if (is(i + 1, 'id', 'type') && !is(i + 2, 'id', 'from') && !is(i + 2, 'punct', ',')) continue
      if (token.value === 'import' && is(i + 1, 'str')) {
        found.push({ spec: at(i + 1)!.value, line: token.line, dynamic: false })
        continue
      }
      let j = i + 1
      const clause = (k: number) => at(k)!.kind !== 'str' && Imports.#CLAUSE.test(at(k)!.value) &&
        !is(k, 'id', 'import') && !is(k, 'id', 'export')
      while (at(j) && !(is(j, 'id', 'from') && is(j + 1, 'str')) && clause(j)) j++
      if (is(j, 'id', 'from') && is(j + 1, 'str'))
        found.push({ spec: at(j + 1)!.value, line: token.line, dynamic: false })
    }
    return found
  }

  static #tokens(text: string): Token[] {
    const tokens: Token[] = []
    let line = 1
    let i = 0
    const push = (kind: Token['kind'], value: string, at: number) => tokens.push({ kind, value, line: at })
    const regexAllowed = () => {
      const prev = tokens[tokens.length - 1]
      if (!prev) return true
      if (prev.kind === 'punct') return !/^[)\]}]$/.test(prev.value)
      return prev.kind === 'id' && Imports.#BEFORE_REGEX.has(prev.value)
    }
    while (i < text.length) {
      const c = text[i]!
      if (c === '\n') {
        line++
        i++
      } else if (/\s/.test(c)) {
        i++
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        const stop = end < 0 ? text.length : end + 2
        line += text.slice(i, stop).split('\n').length - 1
        i = stop
      } else if (c === '"' || c === "'") {
        let value = ''
        let j = i + 1
        while (j < text.length && text[j] !== c && text[j] !== '\n') {
          if (text[j] === '\\') j++
          else value += text[j]
          j++
        }
        push('str', value, line)
        i = j + 1
      } else if (c === '`') {
        const start = line
        let j = i + 1
        let plain = true
        let depth = 0
        while (j < text.length && (depth > 0 || text[j] !== '`')) {
          if (text[j] === '\\') j++
          else if (text[j] === '$' && text[j + 1] === '{') {
            plain = false
            depth++
            j++
          } else if (text[j] === '}' && depth > 0) depth--
          else if (text[j] === '\n') line++
          j++
        }
        push(plain ? 'str' : 'punct', plain ? text.slice(i + 1, j) : '`', start)
        i = j + 1
      } else if (c === '/' && regexAllowed()) {
        let j = i + 1
        let inClass = false
        while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
          if (text[j] === '\\') j++
          else if (text[j] === '[') inClass = true
          else if (text[j] === ']') inClass = false
          j++
        }
        j++
        while (j < text.length && /[a-z]/i.test(text[j]!)) j++
        push('punct', '/re/', line)
        i = j
      } else if (/[\w$]/.test(c)) {
        let j = i
        while (j < text.length && /[\w$]/.test(text[j]!)) j++
        push('id', text.slice(i, j), line)
        i = j
      } else {
        push('punct', c, line)
        i++
      }
    }
    return tokens
  }
}
