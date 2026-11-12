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
    dirs: { type: 'string', default: '' },
  },
})
const WPT = values.wpt!
const WORKERS = Number(values.workers)
const FIRST = Number(values.first)
const ONLY = (values.dirs ? values.dirs.split(',') : readFileSync(join(HERE, 'suites'), 'utf8').split('\n').filter(Boolean)).map((d) => d.replace(/\/+$/, '') + '/')

type Meta = { timeout?: string; script_metadata?: [string, string][] }
export type Test = {
  url: string
  file: string
  long: boolean
  skip?: 'worker' | 'server' | 'https' | 'manual-variant'
  flags: string[]
}

const manifest = await Bun.file(values.manifest!).json()
const tests: Test[] = []
const wrappers = new Map<string, string>()

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

function skipReason(url: string, file: string): Test['skip'] {
  const path = url.split('?')[0]!
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

walk(manifest.items.testharness, '', (file, entry) => {
  if (!ONLY.some((d) => file.startsWith(d))) return
  if (generatedFiles.has(file)) return
  if (!existsSync(join(WPT, file))) return
  const flags = flagsOf(file)
  for (const variant of entry.slice(1) as [string | null, Meta][]) {
    const url = '/' + (variant[0] ?? file)
    const meta = variant[1] ?? {}
    const skip = skipReason(url, file)
    const generated = variant[0] !== null && variant[0].split('?')[0] !== file
    if (generated && !skip) {
      const html = wrapperFor(file, url, meta)
      if (html === null) {
        tests.push({ url, file, long: meta.timeout === 'long', skip: 'manual-variant', flags })
        continue
      }
      wrappers.set(url.split('?')[0]!.slice(1), html)
    }
    tests.push({ url, file, long: meta.timeout === 'long' || (meta.script_metadata ?? []).some(([k, v]) => k === 'timeout' && v === 'long'), skip, flags })
  }
})

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
  writeFileSync(join(app, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: `wpt${n}`, label: `wpt${n}`, icon: 'app', backend: false }) + '\n')
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: `wpt${n}`, private: true, type: 'module' }) + '\n')
  writeFileSync(join(app, 'index.html'), '<!doctype html><meta charset=utf-8><title>wpt runner</title><p>idle</p>\n')
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
const count = (pred: (t: Test) => boolean) => tests.filter(pred).length
const sha = (await Bun.$`git -C ${WPT} rev-parse HEAD`.text()).trim()
writeFileSync(join(WORK, 'wpt-sha'), sha + '\n')
console.log(`wpt ${sha.slice(0, 10)}: ${tests.length} test urls, ${count((t) => !t.skip)} to run; skipped worker ${count((t) => t.skip === 'worker')}, server ${count((t) => t.skip === 'server')}, https ${count((t) => t.skip === 'https')}, other ${count((t) => t.skip === 'manual-variant')}; ${wrappers.size} wrappers (${written} written); ${WORKERS} apps in ${WORK}`)
