import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, posix, relative, sep } from 'node:path'

const KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const REFERENCE = /^references\/[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*\.md$/
const SITE = /^https?:\/\/docs\.dopame\.ai(\/|$)/
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
const MAX_COMPATIBILITY = 500
const MAX_SKILL_LINES = 500

export interface Heading {
  readonly depth: number
  readonly text: string
  readonly slug: string
  readonly line: number
}

export interface Link {
  readonly target: string
  readonly line: number
}

export interface Page {
  readonly prose: readonly { readonly text: string; readonly line: number }[]
  readonly headings: readonly Heading[]
  readonly links: readonly Link[]
}

export function frontmatter(text: string): { fields: Map<string, string>; body: string; problems: string[] } {
  const fields = new Map<string, string>()
  const problems: string[] = []
  const lines = text.split('\n')
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  if (end < 0) return { fields, body: text, problems: ['no frontmatter (a --- block at the very top)'] }
  let map = ''
  for (const [index, line] of lines.slice(1, end).entries()) {
    const entry = /^( {2})?([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line)
    if (!entry) {
      problems.push(`frontmatter line ${index + 2}: write "key: value" on one line (no block scalars, lists or comments)`)
      continue
    }
    const [, indent, key, raw = ''] = entry as unknown as [string, string | undefined, string, string | undefined]
    const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw)
    const value = quoted ? quoted[1]! : raw
    if (indent) {
      if (!map) problems.push(`frontmatter line ${index + 2}: an indented key outside a map`)
      else fields.set(`${map}.${key}`, value)
    } else {
      map = raw === '' ? key : ''
      fields.set(key, value)
    }
  }
  return { fields, body: lines.slice(end + 1).join('\n'), problems }
}

export function slug(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

export function parse(text: string, firstLine = 1): Page {
  const prose: { text: string; line: number }[] = []
  const headings: Heading[] = []
  const links: Link[] = []
  const seen = new Map<string, number>()
  let fence = ''
  for (const [index, raw] of text.split('\n').entries()) {
    const line = index + firstLine
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = ''
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    const plain = raw.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length))
    prose.push({ text: plain, line })
    const heading = /^(#{1,6}) +(.+?)\s*$/.exec(raw)
    if (heading) {
      const base = slug(heading[2]!)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      headings.push({ depth: heading[1]!.length, text: heading[2]!, slug: count ? `${base}-${count}` : base, line })
    }
    for (const link of plain.matchAll(/\]\(([^)\s]+)\)/g)) links.push({ target: link[1]!, line })
  }
  return { prose, headings, links }
}

function files(root: string, dir = root): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const file = join(dir, name)
    return lstatSync(file).isDirectory() ? files(root, file) : [relative(root, file).split(sep).join('/')]
  })
}

export function skillProblems(dir: string): string[] {
  const problems: string[] = []
  const main = join(dir, 'SKILL.md')
  if (!existsSync(main)) return [`${dir}: no SKILL.md`]
  const all = files(dir)
  const pages = new Map<string, Page>()
  const text = readFileSync(main, 'utf8')
  const { fields, body, problems: bad } = frontmatter(text)
  for (const problem of bad) problems.push(`SKILL.md: ${problem}`)
  const lines = text.split('\n').length
  pages.set('SKILL.md', parse(body, lines - body.split('\n').length + 1))

  for (const key of fields.keys()) {
    if (!KEYS.has(key.split('.')[0]!)) problems.push(`SKILL.md: frontmatter key ${key} is not in the Agent Skills format`)
  }
  const name = fields.get('name') ?? ''
  if (!NAME.test(name) || name.length > MAX_NAME) {
    problems.push(`SKILL.md: name ${JSON.stringify(name)}: 1 to ${MAX_NAME} of a-z, 0-9 and single hyphens between them`)
  } else if (name !== basename(dir)) problems.push(`SKILL.md: name ${name} is not its directory's name, ${basename(dir)}`)
  const description = fields.get('description') ?? ''
  if (description.length < 1 || description.length > MAX_DESCRIPTION) {
    problems.push(`SKILL.md: description is ${description.length} characters; 1 to ${MAX_DESCRIPTION}`)
  }
  if ((fields.get('compatibility') ?? '').length > MAX_COMPATIBILITY) {
    problems.push(`SKILL.md: compatibility is over ${MAX_COMPATIBILITY} characters`)
  }
  if (lines > MAX_SKILL_LINES) {
    problems.push(`SKILL.md: ${lines} lines; keep it to ${MAX_SKILL_LINES} and move detail into references/`)
  }

  for (const path of all) {
    if (path.split('/').some((segment) => segment.startsWith('.'))) problems.push(`${path}: a dotfile`)
    if (lstatSync(join(dir, path)).isSymbolicLink()) problems.push(`${path}: a symbolic link`)
    if (!path.startsWith('references/')) continue
    if (!REFERENCE.test(path)) {
      problems.push(`${path}: a reference is references/<group>/<page>.md, both in lowercase-kebab-case`)
      continue
    }
    const source = readFileSync(join(dir, path), 'utf8')
    const page = parse(source)
    pages.set(path, page)
    if (source.includes('\r')) problems.push(`${path}: CRLF line endings`)
    if (!source.endsWith('\n') || source.endsWith('\n\n')) problems.push(`${path}: end with exactly one newline`)
    const [first, second] = source.split('\n')
    if (!/^# \S/.test(first ?? '') || second !== '') {
      problems.push(`${path}:1: start with "# Title" and an empty line (no frontmatter): the title of the docs page`)
    }
    for (const heading of page.headings) {
      if (heading.depth === 1 && heading.line !== 1) problems.push(`${path}:${heading.line}: a second "# " heading`)
    }
    for (const { text: prose, line } of page.prose) {
      if (/^\s*:::/.test(prose)) problems.push(`${path}:${line}: a ::: directive (docs-site syntax)`)
      if (/^(import|export) /.test(prose)) problems.push(`${path}:${line}: an MDX import or export`)
      if (/<\/?[A-Za-z][^>]*>/.test(prose)) {
        problems.push(`${path}:${line}: an HTML or JSX tag outside code; put it in backticks or write Markdown`)
      }
    }
  }

  const linked = new Set<string>()
  for (const [path, page] of pages) {
    for (const { target, line } of page.links) {
      const at = `${path}:${line}: link ${target}`
      if (SITE.test(target)) problems.push(`${at}: link the reference file, not the docs site built from it`)
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      if (target.startsWith('/')) {
        problems.push(`${at}: a path from the site root; write the file's relative path`)
        continue
      }
      const [file = '', anchor] = target.split('#') as [string, string | undefined]
      const to = file ? posix.normalize(posix.join(posix.dirname(path), file)) : path
      if (to.startsWith('..')) {
        problems.push(`${at}: leaves the skill directory`)
        continue
      }
      if (!all.includes(to)) {
        problems.push(`${at}: no such file`)
        continue
      }
      if (path === 'SKILL.md') linked.add(to)
      const there = pages.get(to)
      if (anchor !== undefined && there && !there.headings.some((heading) => heading.slug === anchor)) {
        problems.push(`${at}: ${to} has no heading with the anchor #${anchor}`)
      }
    }
  }
  for (const path of pages.keys()) {
    if (path !== 'SKILL.md' && !linked.has(path)) {
      problems.push(`${path}: SKILL.md does not link it (agents find references only through SKILL.md)`)
    }
  }
  return problems
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(dirname(import.meta.dirname), 'skills', 'acde')
  const problems = skillProblems(dir)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log(`${dir}: a valid skill`)
}
