import { appendFileSync, chmodSync, writeFileSync } from 'node:fs'
import net from 'node:net'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const ADD_DELAY_MS = 300

interface Node {
  ref: string
  role: string
  name?: string
  value?: string
  states?: string[]
  children?: Node[]
}

interface Win {
  ref: string
  id: number
  kind: 'desktop' | 'web'
  app: string | null
  title: string | null
  focus: boolean
  hidden: boolean
}

const windows: Win[] = [
  { ref: 'w0', id: 0, kind: 'desktop', app: null, title: null, focus: false, hidden: false },
  { ref: 'w1', id: 7, kind: 'web', app: 'alpha', title: 'Alpha', focus: true, hidden: false },
]
const tasks: { name: string; done: boolean }[] = []
let draft = ''
const consoleLog: object[] = [{ seq: 1, time: 10, web: 'alpha#7', app: 'alpha', kind: 'console', level: 'log', text: 'alpha ready' }]
const requests: object[] = []
let dark = false
let reduced = false

function page<T extends { seq: number; web: string; app: string | null }>(all: T[], m: Record<string, unknown>, keep: (e: T) => boolean = () => true) {
  const since = Number(m['since'] ?? 0)
  const entries = all.filter((e) => e.seq >= since && (m['web'] === undefined || e.web === m['web'] || e.app === m['web']) && keep(e))
  return { entries, next: all.length + 1, dropped: 0 }
}

function byRef(nodes: Node[], ref: string): Node | null {
  for (const n of nodes) {
    if (n.ref === ref) return n
    const found = byRef(n.children ?? [], ref)
    if (found) return found
  }
  return null
}

function query(m: Record<string, unknown>) {
  const nodes = tree(windows.find((w) => w.ref === (m['window'] ?? 'w1'))!)
  const within = typeof m['ref'] === 'string' ? byRef(nodes, m['ref']) : null
  const all: Node[] = []
  const walk = (list: Node[]) => list.forEach((n) => (all.push(n), walk(n.children ?? [])))
  walk(within ? (within.children ?? []) : nodes)
  const tags: Record<string, string> = { textbox: 'input', button: 'button', list: 'ul', listitem: 'li', checkbox: 'input', text: 'span' }
  const pick = (role: string) => all.filter((n) => n.role === role)
  const selector = String(m['selector'])
  const found =
    selector === '[data-testid="add"]' ? pick('button') : selector === 'li' ? pick('listitem') : selector === 'input[type=checkbox]' ? pick('checkbox') : selector === '.ghost' ? [{ ref: 'w1.99', role: 'generic' }] : []
  return { window: m['window'] ?? 'w1', count: found.length, nodes: found.map(({ children: _c, ...n }) => ({ ...n, tag: tags[n.role] ?? 'div', visible: n.ref !== 'w1.99' })) }
}

function record(entry: object): void {
  appendFileSync(process.env['FAKE_ACDERT_LOG']!, `${JSON.stringify(entry)}\n`)
}

function tree(win: Win): Node[] {
  if (win.kind === 'desktop') return [{ ref: 'w0.1', role: 'button', name: 'Start' }]
  if (win.app !== 'alpha') return [{ ref: `${win.ref}.1`, role: 'heading', name: win.title ?? '' }]
  return [
    { ref: 'w1.2', role: 'textbox', name: 'New task', value: draft },
    { ref: 'w1.3', role: 'button', name: 'Add', ...(draft ? {} : { states: ['disabled'] }) },
    {
      ref: 'w1.4',
      role: 'list',
      name: 'Tasks',
      children: tasks.map((t, i) => ({
        ref: `w1.${10 + i * 3}`,
        role: 'listitem',
        name: t.name,
        children: [
          { ref: `w1.${11 + i * 3}`, role: 'text', name: t.name },
          { ref: `w1.${12 + i * 3}`, role: 'checkbox', name: `Done: ${t.name}`, ...(t.done ? { states: ['checked'] } : {}) },
        ],
      })),
    },
    { ref: 'w1.5', role: 'text', name: `${tasks.length} tasks` },
  ]
}

function find(nodes: Node[], needle: string): Node[] {
  const walk = (n: Node): Node | null => {
    if ([n.name, n.value].some((s) => s?.toLowerCase().includes(needle))) return n
    const children = (n.children ?? []).map(walk).filter((c): c is Node => c !== null)
    return children.length ? { ...n, children } : null
  }
  return nodes.map(walk).filter((n): n is Node => n !== null)
}

function snapshot(m: Record<string, unknown>) {
  const text = `snapshot ${JSON.stringify({ window: m['window'] ?? null, find: m['find'] ?? null, all: m['all'] ?? false })}`
  if (m['tree'] === false) return { text, windows, trees: {} }
  const wanted = typeof m['window'] === 'string' ? windows.filter((w) => w.ref === m['window']) : m['all'] || m['find'] ? windows.filter((w) => !w.hidden) : windows.filter((w) => w.focus)
  const trees: Record<string, Node[]> = {}
  if (typeof m['ref'] === 'string') {
    const w = windows.find((x) => (m['ref'] as string).startsWith(`${x.ref}.`))!
    const node = byRef(tree(w), m['ref'])
    return { text, windows, trees: { [w.ref]: node ? [node] : [] } }
  }
  for (const w of wanted) {
    const nodes = typeof m['find'] === 'string' ? find(tree(w), m['find'].toLowerCase()) : tree(w)
    if (typeof m['find'] !== 'string' || nodes.length) trees[w.ref] = nodes
  }
  return { text, windows, trees }
}

function act(ref: string, action: string, arg: unknown): { ok: boolean; text: string } {
  const text = `${action} ${ref} ${JSON.stringify(arg ?? null)}`
  if (action === 'fail') return { ok: false, text }
  if (ref === 'w1.2' && action === 'settext') draft = String(arg ?? '')
  if (ref === 'w1.2' && action === 'type') draft += String(arg ?? '')
  if (ref === 'w1.3' && action === 'click') {
    if (!draft) return { ok: false, text: 'w1.3 is disabled' }
    const name = draft
    draft = ''
    setTimeout(() => {
      tasks.push({ name, done: false })
      consoleLog.push({ seq: consoleLog.length + 1, time: 20, web: 'alpha#7', app: 'alpha', kind: name === 'boom' ? 'error' : 'console', level: name === 'boom' ? 'error' : 'info', text: name === 'boom' ? 'Error: boom' : `added ${name}` })
      requests.push({ seq: requests.length + 1, time: 20, web: 'alpha#7', app: 'alpha', id: requests.length + 1, kind: 'fetch', method: 'POST', url: 'http://acde.local/api/tasks', requestBytes: name.length, status: name === 'boom' ? 500 : 201, statusText: '', responseBytes: 2, ms: 3, error: null, done: true })
    }, ADD_DELAY_MS)
  }
  const checkbox = /^w1\.(\d+)$/.exec(ref)
  if (checkbox && action === 'click' && Number(checkbox[1]) >= 12 && (Number(checkbox[1]) - 12) % 3 === 0) {
    const task = tasks[(Number(checkbox[1]) - 12) / 3]
    if (task) task.done = !task.done
  }
  const win = windows.find((w) => w.ref === ref)
  if (win && action === 'close') windows.splice(windows.indexOf(win), 1)
  return { ok: true, text }
}

function open(name: string): { ok: boolean; text: string } {
  if (name !== 'beta') return { ok: false, text: `no app ${name}` }
  for (const w of windows) w.focus = false
  windows.push({ ref: `w${windows.length}`, id: 8, kind: 'web', app: 'beta', title: 'Beta', focus: true, hidden: false })
  return { ok: true, text: 'opened beta' }
}

function webs() {
  const names: Record<number, string> = { 0: 'desktop', 7: 'alpha#7', 8: 'beta#8' }
  return windows.map((w) => ({ name: names[w.id]!, app: w.app, kind: w.kind === 'desktop' ? 'desktop' : 'app', window: w.id, title: w.kind === 'desktop' ? 'Desk' : w.title }))
}

const ISOLATION = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'ACDE_STORAGE', 'ACDE_SIZE', 'ACDE_COLOR_SCHEME', 'ACDE_REDUCED_MOTION', 'ACDE_AUTOSTART']
record({ argv: process.argv.slice(2), path: process.env['ACDE_PATH'] ?? null, headless: process.env['ACDE_HEADLESS'] ?? null, env: Object.fromEntries(ISOLATION.map((k) => [k, process.env[k] ?? null])) })
console.error('[alpha#7] js: fake acdert is up')
const endpoint = process.env['ACDE_DEV']!
const server = net.createServer((socket) => {
  const send = (message: object) => socket.write(`${JSON.stringify(message)}\n`)
  let owner = false
  socket.on('error', () => undefined)
  socket.on('close', () => owner && process.exit(0))
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>
      buffer = buffer.slice(at + 1)
      record({ got: message })
      if (message['type'] === 'hello' && message['role'] === 'dev') owner = true
      if (message['type'] === 'quit') process.exit(0)
      if (message['type'] === 'request') answer(message, send)
    }
  })
})
setTimeout(() => server.listen(endpoint, () => chmodSync(endpoint, 0o600)), Number(process.env['FAKE_ACDERT_LISTEN_MS'] ?? 0))
process.on('SIGTERM', () => process.exit(0))

function answer(m: Record<string, unknown>, send: (message: object) => void): void {
  const ok = (result: unknown) => send({ type: 'response', id: m['id'], ok: true, result })
  const fail = (error: string) => send({ type: 'response', id: m['id'], ok: false, error })
  switch (m['op']) {
    case 'webs':
      return void ok({ webs: webs() })
    case 'eval':
      return void (m['web'] === 'nope' ? fail('no web "nope"') : ok({ value: { web: m['web'], code: m['code'] } }))
    case 'shot':
      return void ok({ png: PNG, width: 1, height: 1 })
    case 'snapshot':
      return void ok(snapshot(m))
    case 'act':
      return void ok(act(String(m['ref']), String(m['action']), m['arg']))
    case 'run': {
      const said: string[] = []
      for (const step of m['steps'] as { ref: string; action: string; text: unknown }[]) {
        const done = act(step.ref, step.action, step.text)
        said.push(done.text)
        if (!done.ok) return void ok({ ok: false, text: said.join('\n') })
      }
      return void ok({ ok: true, text: said.join('\n') })
    }
    case 'open':
      return void ok(open(String(m['name'])))
    case 'query':
      return void ok(query(m))
    case 'console':
      return void ok(page(consoleLog as never[], m, (e: { level: string }) => m['level'] === undefined || (m['level'] === 'errors' ? e.level === 'error' : e.level === m['level'])))
    case 'network':
      return void ok(page(requests as never[], m, (e: { status: number }) => !m['failed'] || e.status >= 400))
    case 'screen':
      writeFileSync(String(m['path']), Buffer.from(PNG, 'base64'))
      return void ok({ width: 1, height: 1, path: m['path'] })
    case 'choose':
      return void (m['folder'] === null || (typeof m['folder'] === 'string' && m['folder'].startsWith('/')) ? ok({ folder: m['folder'] }) : fail('choose: folder is an absolute path, or null to cancel'))
    case 'emulate':
      if (m['colorScheme'] !== undefined) dark = m['colorScheme'] === 'dark'
      if (m['reducedMotion'] !== undefined) reduced = m['reducedMotion'] === true
      return void ok({ colorScheme: dark ? 'dark' : 'light', emulated: m['colorScheme'] !== null && m['colorScheme'] !== undefined, reducedMotion: reduced })
    case 'slow':
      return
    default:
      return void fail(`no op ${String(m['op'])}`)
  }
}
