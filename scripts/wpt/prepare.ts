import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  },
})
const WPT = values.wpt!
const WORKERS = Number(values.workers)
const FIRST = Number(values.first)

export type Kind = 'testharness' | 'reftest' | 'crashtest'
export type Unhosted = 'worker' | 'server' | 'https' | 'print' | 'manual-variant'
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
const wrappers = new Map<string, string>()
const excluded = new Map<string, number>()
const na = notApplicable()
const naOf = (file: string) => na.find((n) => file === n.dir || file.startsWith(`${n.dir}/`))

function walk(node: Record<string, unknown>, prefix: string, visit: (path: string, entry: unknown[]) => void) {
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) visit(prefix + key, value)
    else walk(value as Record<string, unknown>, `${prefix}${key}/`, visit)
  }
}

const headersCache = new Map<string, boolean>()
function dirHeaders(dir: string): boolean {
  if (!headersCache.has(dir)) headersCache.set(dir, existsSync(join(WPT, dir, '__dir__.headers')))
  return headersCache.get(dir)!
}

function unhostedReason(url: string, file: string, kind: Kind | 'print-reftest'): Unhosted | undefined {
  const path = url.split('?')[0]!
  if (kind === 'print-reftest') return 'print'
  if (/\.(any\.)?(worker|sharedworker|serviceworker)(-module)?\.html$|shadowrealm|\.worker\.html$/.test(path)) return 'worker'
  if (/\.(https|h2)\./.test(path) || /\.(https|h2)\./.test(file)) return 'https'
  if (/\.(sub|www)\./.test(file) || /\.py$/.test(file) || existsSync(join(WPT, `${file}.headers`)) || dirHeaders(dirname(file))) return 'server'
  if (file.startsWith('websockets/') || file.startsWith('eventsource/')) return 'server'
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

function wrapperFor(file: string, url: string, meta: Meta): string | null {
  const path = url.split('?')[0]!
  const metas: string[] = []
  const scripts: string[] = []
  for (const [key, value] of meta.script_metadata ?? []) {
    if (key === 'timeout' && value === 'long') metas.push('<meta name="timeout" content="long">')
    if (key === 'title') metas.push(`<title>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>`)
    if (key === 'script') scripts.push(`<script src="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></script>`)
  }
  const src = `/${file}`
  const head = `<!doctype html>\n<meta charset=utf-8>\n${metas.join('\n')}\n`
  const harness = '<script src="/resources/testharness.js"></script>\n<script src="/resources/testharnessreport.js"></script>\n'
  if (path.endsWith('.any.html'))
    return `${head}<script>\nself.GLOBAL = { isWindow: function() { return true; }, isWorker: function() { return false; }, isShadowRealm: function() { return false; } };\n</script>\n${harness}${scripts.join('\n')}\n<div id=log></div>\n<script src="${src}"></script>\n`
  if (path.endsWith('.any.window-module.html')) return `${head}${harness}${scripts.join('\n')}\n<div id=log></div>\n<script type=module src="${src}"></script>\n`
  if (path.endsWith('.window.html')) return `${head}${harness}${scripts.join('\n')}\n<div id=log></div>\n<script src="${src}"></script>\n`
  return null
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
      if (kind === 'testharness') {
        const generated = variant[0] !== null && variant[0].split('?')[0] !== file
        if (generated && !unhosted) {
          const html = wrapperFor(file, url, meta)
          if (html === null) {
            tests.push({ ...base, unhosted: 'manual-variant' })
            continue
          }
          wrappers.set(url.split('?')[0]!.slice(1), html)
        }
      }
      tests.push(base)
    }
  })
}

const exclude = join(WPT, '.git', 'info', 'exclude')
const patterns = ['*.any.html', '*.any.window-module.html', '*.window.html']
const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
const missing = patterns.filter((p) => !current.split('\n').includes(p))
if (missing.length) writeFileSync(exclude, current.replace(/\n?$/, '\n') + missing.join('\n') + '\n')
let written = 0
for (const [path, html] of wrappers) {
  const target = join(WPT, path)
  if (existsSync(target) && readFileSync(target, 'utf8') === html) continue
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, html)
  written++
}

const WORK = join(STATE, 'work')
for (let n = FIRST; n < FIRST + WORKERS; n++) {
  const app = join(WORK, `app${n}`)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'public', 'resources'), { recursive: true })
  writeFileSync(join(app, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: `wpt${n}`, label: `wpt${n}`, icon: 'app', backend: false, frame: false, size: [800, 600] }) + '\n')
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: `wpt${n}`, private: true, type: 'module' }) + '\n')
  writeFileSync(join(app, 'index.html'), '<!doctype html><meta charset=utf-8><meta name=wpt-runner content=idle><title>wpt runner</title><p>idle</p>\n')
  for (const name of readdirSync(WPT)) {
    if (name.startsWith('.') || name === 'resources' || name === '_venv3' || name === 'index.html') continue
    if (!lstatSync(join(WPT, name)).isDirectory()) continue
    symlinkSync(join(WPT, name), join(app, 'public', name))
  }
  for (const name of readdirSync(join(WPT, 'resources'))) {
    if (name === 'testharnessreport.js' || name === 'testdriver-vendor.js') continue
    symlinkSync(join(WPT, 'resources', name), join(app, 'public', 'resources', name))
  }
  for (const own of ['testharnessreport.js', 'testdriver-vendor.js']) symlinkSync(join(HERE, 'harness', own), join(app, 'public', 'resources', own))
}

writeFileSync(join(STATE, 'tests.json'), JSON.stringify(tests))
writeFileSync(join(STATE, 'not-applicable.json'), JSON.stringify(Object.fromEntries(excluded)))
const count = (pred: (t: Test) => boolean) => tests.filter(pred).length
const sha = (await Bun.$`git -C ${WPT} rev-parse HEAD`.text()).trim()
writeFileSync(join(WORK, 'wpt-sha'), sha + '\n')
const kinds = (['testharness', 'reftest', 'crashtest'] as const).map((k) => `${k} ${count((t) => t.kind === k && !t.unhosted)}`).join(', ')
const unhosted = (['worker', 'server', 'https', 'print', 'manual-variant'] as const).map((r) => `${r} ${count((t) => t.unhosted === r)}`).join(', ')
console.log(`wpt ${sha.slice(0, 10)}: ${tests.length} applicable test urls; to run: ${kinds}; the runner cannot host yet: ${unhosted}; not applicable: ${[...excluded.values()].reduce((a, b) => a + b, 0)} in ${excluded.size} dirs; ${wrappers.size} wrappers (${written} written); ${WORKERS} apps in ${WORK}`)
