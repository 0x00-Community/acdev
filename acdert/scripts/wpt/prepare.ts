import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

const HERE = import.meta.dir
const STATE = process.env.WPT_STATE ?? join(HERE, '..', '..', 'logs', 'wpt')
const { values } = parseArgs({
  options: {
    wpt: { type: 'string', default: process.env.WPT_DIR ?? join(STATE, 'checkout') },
    manifest: { type: 'string', default: join(STATE, 'MANIFEST.json') },
    workers: { type: 'string', default: '3' },
    first: { type: 'string', default: '1' },
    'serve-port': { type: 'string', default: '18000' },
  },
})
const SERVE_PORT = Number(values['serve-port'])
const WPT = values.wpt!
const WORKERS = Number(values.workers)
const FIRST = Number(values.first)

export type Kind = 'testharness' | 'reftest' | 'crashtest'
export type Unhosted = 'https' | 'print' | 'websocket'
export type Reference = { url: string; relation: '==' | '!=' }
export type Fuzzy = { ref: string | null; maxDifference: [number, number]; totalPixels: [number, number] }
export type Test = {
  url: string
  file: string
  kind: Kind
  long: boolean
  unhosted?: Unhosted
  flags: string[]
  references?: Reference[]
  fuzzy?: Fuzzy[]
  viewport?: [number, number]
}
export type NotApplicable = { dir: string; reason: string }

export function notApplicable(): NotApplicable[] {
  return readFileSync(join(HERE, 'not-applicable'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [dir, reason] = line.split('\t')
      return { dir: dir!.replace(/^\/+|\/+$/g, ''), reason: reason ?? '' }
    })
}

type Meta = { timeout?: string; script_metadata?: [string, string][]; fuzzy?: [[string, string] | null, [[number, number], [number, number]]][]; viewport_size?: [number, number] }
type Variant = [string | null, Meta] | [string | null, [string, '==' | '!='][], Meta]

const manifest = await Bun.file(values.manifest!).json()
const tests: Test[] = []
const excluded = new Map<string, number>()
const na = notApplicable()
const naOf = (file: string) => na.find((n) => file === n.dir || file.startsWith(`${n.dir}/`))

function walk(node: Record<string, unknown>, prefix: string, visit: (path: string, entry: unknown[]) => void) {
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) visit(prefix + key, value)
    else walk(value as Record<string, unknown>, `${prefix}${key}/`, visit)
  }
}

function unhostedReason(url: string, file: string, kind: Kind | 'print-reftest'): Unhosted | undefined {
  if (kind === 'print-reftest') return 'print'
  if (/\.(https|h2)\./.test(url.split('?')[0]!) || /\.(https|h2)\./.test(file)) return 'https'
  if (file.startsWith('websockets/')) return 'websocket'
  return undefined
}

function flagsOf(file: string): string[] {
  let text = ''
  try {
    text = readFileSync(join(WPT, file), 'utf8')
  } catch {
    return ['unreadable']
  }
  const flags: string[] = []
  if (/testdriver(-actions)?\.js|test_driver\./.test(text)) flags.push('testdriver')
  if (/\.py\b/.test(text)) flags.push('py-handler')
  if (/<iframe|createElement\(\s*["']iframe/.test(text)) flags.push('iframe')
  if (/window\.open\(/.test(text)) flags.push('window-open')
  return flags
}

const generatedFiles = new Set<string>()
walk(manifest.items.testharness, '', (file, entry) => {
  for (const variant of entry.slice(1) as [string | null, Meta][]) {
    const path = variant[0]?.split('?')[0]
    if (path && path !== file) generatedFiles.add(path)
  }
})

const isLong = (meta: Meta) => meta.timeout === 'long' || (meta.script_metadata ?? []).some(([k, v]) => k === 'timeout' && v === 'long')

for (const kind of ['testharness', 'reftest', 'print-reftest', 'crashtest'] as const) {
  walk(manifest.items[kind] ?? {}, '', (file, entry) => {
    const off = naOf(file)
    if (off) {
      excluded.set(off.dir, (excluded.get(off.dir) ?? 0) + entry.length - 1)
      return
    }
    if (kind === 'testharness' && generatedFiles.has(file)) return
    if (!existsSync(join(WPT, file))) return
    const flags = flagsOf(file)
    for (const variant of entry.slice(1) as Variant[]) {
      const url = '/' + (variant[0] ?? file)
      const refs = variant.length === 3 ? variant[1] : null
      const meta = (variant.length === 3 ? variant[2] : variant[1]) ?? {}
      const unhosted = unhostedReason(url, file, kind)
      const base: Test = { url, file, kind: kind === 'print-reftest' ? 'reftest' : kind, long: isLong(meta), flags, ...(unhosted && { unhosted }) }
      if (refs) {
        base.references = refs.map(([ref, relation]) => ({ url: ref, relation }))
        if (meta.fuzzy?.length)
          base.fuzzy = meta.fuzzy.map(([pair, [diff, total]]) => ({ ref: pair ? pair[1] : null, maxDifference: diff, totalPixels: total }))
        if (meta.viewport_size) base.viewport = meta.viewport_size
      }
      tests.push(base)
    }
  })
}

const WORK = join(STATE, 'work')
const HARNESS = Object.fromEntries(['testharnessreport.js', 'testdriver-vendor.js'].map((own) => [`/resources/${own}`, join(HERE, 'harness', own)]))
mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'serve.json'), JSON.stringify({ wpt: WPT, http: SERVE_PORT }) + '\n')
for (let n = FIRST; n < FIRST + WORKERS; n++) {
  const app = join(WORK, `app${n}`)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: `wpt${n}`, label: `wpt${n}`, icon: 'app', entry: '/', frame: false, size: [800, 600] }) + '\n')
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: `wpt${n}`, private: true, type: 'module' }) + '\n')
  writeFileSync(join(app, 'server.ts'), `import { proxy } from ${JSON.stringify(join(HERE, 'proxy.ts'))}\nproxy(${SERVE_PORT}, ${JSON.stringify(HARNESS)})\n`)
}

writeFileSync(join(STATE, 'tests.json'), JSON.stringify(tests))
writeFileSync(join(STATE, 'not-applicable.json'), JSON.stringify(Object.fromEntries(excluded)))
const count = (pred: (t: Test) => boolean) => tests.filter(pred).length
const sha = (await Bun.$`git -C ${WPT} rev-parse HEAD`.text()).trim()
writeFileSync(join(WORK, 'wpt-sha'), sha + '\n')
const kinds = (['testharness', 'reftest', 'crashtest'] as const).map((k) => `${k} ${count((t) => t.kind === k && !t.unhosted)}`).join(', ')
const unhosted = (['websocket', 'https', 'print'] as const).map((r) => `${r} ${count((t) => t.unhosted === r)}`).join(', ')
console.log(`wpt ${sha.slice(0, 10)}: ${tests.length} applicable test urls; to run: ${kinds}; the runner cannot host yet: ${unhosted}; not applicable: ${na.length} directories; ${WORKERS} apps in ${WORK}, wptserve on ${SERVE_PORT}`)
