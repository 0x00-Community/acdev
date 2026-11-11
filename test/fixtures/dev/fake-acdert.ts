import { appendFileSync, chmodSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { isAbsolute } from 'node:path'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { Png } from '../../../src/driver/png.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const ADD_DELAY_MS = 300

interface Node {
  ref: string
  role: string
  name?: string
  value?: string
  level?: number
  states?: string[]
  rect?: [number, number, number, number]
  children?: Node[]
}

interface Win {
  ref: string
  id: number
  kind: 'desktop' | 'web'
  app: string | null
  title: string | null
  rect: [number, number, number, number]
  focus: boolean
  hidden: boolean
}

const windows: Win[] = [
  { ref: 'w0', id: 0, kind: 'desktop', app: null, title: null, rect: [0, 0, 16, 12], focus: false, hidden: false },
  { ref: 'w1', id: 7, kind: 'web', app: 'alpha', title: 'Alpha', rect: [4, 2, 8, 6], focus: true, hidden: false },
]
const WINDOWLESS = !!process.env['FAKE_ACDERT_WINDOWLESS']
let pageless = Number(process.env['FAKE_ACDERT_PAGELESS_SHOTS'] ?? 0)
const held = process.env['FAKE_ACDERT_WAITS'] || WINDOWLESS ? windows.splice(0) : []
const tasks: { name: string; done: boolean }[] = []
let draft = ''
let priority = 'low'
let clipboard = ''
const routes: { id: number; url: unknown; status: number; times: number | null }[] = []
let nextRoute = 1
const prompts = [
  { id: 1, app: 'alpha', label: 'Alpha', capability: 'launch', reason: 'launch' },
  { id: 2, app: 'beta', label: 'Beta', capability: 'fs.documents', reason: 'request' },
]
if (WINDOWLESS) prompts.length = 0
const decisions: { app: string; label: string; capability: string; decision: 'granted' | 'denied' }[] = []
const ATTRIBUTES: Record<string, Record<string, string>> = {
  'w1.2': { placeholder: 'What needs doing?' },
  'w1.3': { title: 'Add a task' },
}
const consoleLog: object[] = [
  { seq: 1, time: 10, web: 'alpha#7', app: 'alpha', kind: 'console', level: 'log', text: 'alpha ready' },
]
const requests: object[] = []
let dark = false
let reduced = false

function page<T extends { seq: number; web: string; app: string | null }>(
  all: T[], m: Record<string, unknown>, keep: (e: T) => boolean = () => true,
) {
  const since = Number(m['since'] ?? 0)
  const inWeb = (e: T) => m['web'] === undefined || e.web === m['web'] || e.app === m['web']
  const entries = all.filter((e) => e.seq >= since && inWeb(e) && keep(e))
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
  const tags: Record<string, string> = {
    textbox: 'input', button: 'button', list: 'ul', listitem: 'li', checkbox: 'input', text: 'span', heading: 'h1',
  }
  const pick = (role: string) => all.filter((n) => n.role === role)
  const selector = String(m['selector'])
  const has = (name: string) => all.filter((n) => ATTRIBUTES[n.ref]?.[name] !== undefined)
  const found =
    selector === '[data-testid="add"]' ? pick('button')
    : selector === 'li' ? pick('listitem')
    : selector === 'input[type=checkbox]' ? pick('checkbox')
    : selector === '.ghost' ? [{ ref: 'w1.99', role: 'generic' }]
    : selector === '[placeholder]' ? has('placeholder')
    : selector === '[title]' ? has('title')
    : selector === 'h1' ? pick('heading')
    : selector === '*' ? all
    : []
  const attributes = Array.isArray(m['attributes']) ? (m['attributes'] as string[]) : []
  const attributesOf = (ref: string) => Object.fromEntries(attributes.map((a) => [a, ATTRIBUTES[ref]?.[a] ?? null]))
  return {
    window: m['window'] ?? 'w1',
    count: found.length,
    nodes: found.map(({ children: _c, ...n }) => ({
      ...n,
      tag: tags[n.role] ?? 'div',
      visible: n.ref !== 'w1.99',
      ...(attributes.length && { attributes: attributesOf(n.ref) }),
    })),
  }
}

function picture(win: Win): Buffer {
  const [, , width, height] = win.rect
  const data = new Uint8Array(width * height * 4).fill(255)
  for (let i = 0; i < Math.min(tasks.length, width); i++) data.set([255, 0, 0, 255], i * 4)
  return Png.encode({ width, height, data })
}

function record(entry: object): void {
  appendFileSync(process.env['FAKE_ACDERT_LOG']!, `${JSON.stringify(entry)}\n`)
}

function tree(win: Win): Node[] {
  if (win.kind === 'desktop') return [{ ref: 'w0.1', role: 'button', name: 'Start' }]
  if (win.app !== 'alpha') return [{ ref: `${win.ref}.1`, role: 'heading', name: win.title ?? '', level: 1 }]
  return [
    { ref: 'w1.2', role: 'textbox', name: 'New task', value: draft, rect: [4, 3, 4, 1] },
    { ref: 'w1.3', role: 'button', name: 'Add', rect: [8, 3, 2, 1], ...(draft ? {} : { states: ['disabled'] }) },
    { ref: 'w1.6', role: 'combobox', name: 'Priority', value: priority, rect: [4, 4, 4, 1] },
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
          {
            ref: `w1.${12 + i * 3}`,
            role: 'checkbox',
            name: `Done: ${t.name}`,
            ...(t.done ? { states: ['checked'] } : {}),
          },
        ],
      })),
    },
    { ref: 'w1.5', role: 'text', name: `${tasks.length} tasks`, rect: [4, 6, 8, 1] },
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
  const asked = { window: m['window'] ?? null, find: m['find'] ?? null, all: m['all'] ?? false }
  const text = `snapshot ${JSON.stringify(asked)}`
  if (m['tree'] === false) return { text, windows, trees: {} }
  const wanted =
    typeof m['window'] === 'string' ? windows.filter((w) => w.ref === m['window'])
    : m['all'] || m['find'] ? windows.filter((w) => !w.hidden)
    : windows.filter((w) => w.focus)
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
  if (action === 'select') {
    const values = Array.isArray(arg) ? arg : [arg]
    if (ref !== 'w1.6') return { ok: false, text: 'not a <select>' }
    if (values.length !== 1 || !['low', 'high'].includes(String(values[0])))
      return { ok: false, text: `no option ${JSON.stringify(values)}` }
    priority = String(values[0])
    return { ok: true, text: `selected ${JSON.stringify([priority])}` }
  }
  if (action === 'drag') {
    const from = /^w1\.(\d+)$/.exec(ref)
    const to = /^w1\.(\d+)$/.exec(String(arg ?? ''))
    const index = (m: RegExpExecArray | null) =>
      m && Number(m[1]) >= 10 && (Number(m[1]) - 10) % 3 === 0 ? (Number(m[1]) - 10) / 3 : -1
    const [a, b] = [index(from), index(to)]
    if (a < 0 || b < 0 || !tasks[a] || !tasks[b]) return { ok: false, text: `cannot drag ${ref} onto ${String(arg)}` }
    tasks.splice(b, 0, ...tasks.splice(a, 1))
    return { ok: true, text }
  }
  if (ref === 'w1.2' && action === 'settext') draft = String(arg ?? '')
  if (ref === 'w1.2' && action === 'type') draft += String(arg ?? '')
  if (ref === 'w1.3' && action === 'click') {
    if (!draft) return { ok: false, text: 'w1.3 is disabled' }
    const name = draft
    draft = ''
    setTimeout(() => {
      tasks.push({ name, done: false })
      const boom = name === 'boom'
      consoleLog.push({
        seq: consoleLog.length + 1,
        time: 20,
        web: 'alpha#7',
        app: 'alpha',
        kind: boom ? 'error' : 'console',
        level: boom ? 'error' : 'info',
        text: boom ? 'Error: boom' : `added ${name}`,
      })
      const route = [...routes].reverse().find((r) => r.url === '/api/tasks' && r.times !== 0)
      if (route && route.times !== null) route.times--
      requests.push({
        seq: requests.length + 1,
        time: 20,
        web: 'alpha#7',
        app: 'alpha',
        id: requests.length + 1,
        kind: 'fetch',
        method: 'POST',
        url: 'http://acde.local/api/tasks',
        requestBytes: name.length,
        status: route ? route.status : boom ? 500 : 201,
        statusText: '',
        responseBytes: 2,
        ms: 3,
        error: null,
        done: true,
        ...(route && { mocked: true }),
      })
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
  windows.push({
    ref: `w${windows.length}`, id: 8, kind: 'web', app: 'beta', title: 'Beta',
    rect: [2, 2, 3, 3], focus: true, hidden: false,
  })
  return { ok: true, text: 'opened beta' }
}

function webs() {
  const names: Record<number, string> = { 0: 'desktop', 7: 'alpha#7', 8: 'beta#8' }
  return windows.map((w) => ({
    name: names[w.id]!,
    app: w.app,
    kind: w.kind === 'desktop' ? 'desktop' : 'app',
    window: w.id,
    title: w.kind === 'desktop' ? 'Desk' : w.title,
  }))
}

if (process.argv[2] === '--version') {
  const level = process.env['FAKE_ACDERT_LEVEL'] ?? String(API_LEVEL)
  console.log(level === 'none' ? 'acdert 0.0.5' : `acdert 0.0.0 (contract level ${level})`)
  process.exit(0)
}

const DOCTOR = process.env['FAKE_ACDERT_DOCTOR']
if (process.argv[2] === '--help') {
  console.log('usage: acdert [app <id> | desktop <id|dir>] [options]')
  if (DOCTOR) console.log('       acdert doctor [--json]')
  process.exit(0)
}
if (process.argv[2] === 'doctor' && DOCTOR) {
  if (DOCTOR === 'garbage') {
    console.error('acdert doctor: it broke')
    process.exit(3)
  }
  const gpu = DOCTOR === 'gpu'
    ? { id: 'gpu', title: 'gpu', status: 'error', summary: 'no usable Metal driver was found', fix: 'update the GPU driver' }
    : { id: 'gpu', title: 'gpu', status: 'ok', summary: 'Fake GPU (Metal, integrated GPU): drew a test frame in 1 ms', fix: null }
  const host = { id: 'host', title: 'host files', status: 'ok', summary: '/fake/app/dist', fix: null }
  console.log(JSON.stringify({ acdert: '0.0.0', level: API_LEVEL, platform: process.platform, exe: process.argv[1], checks: [host, gpu] }))
  process.exit(gpu.status === 'error' ? 1 : 0)
}
if (process.env['FAKE_ACDERT_FAILS']) {
  console.error('web layer unavailable: fake acdert has no GPU')
  process.exit(1)
}

const ISOLATION = [
  'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'ACDE_STORAGE', 'ACDE_SIZE', 'ACDE_COLOR_SCHEME', 'ACDE_REDUCED_MOTION', 'ACDE_AUTOSTART',
]
record({
  argv: process.argv.slice(2),
  path: process.env['ACDE_PATH'] ?? null,
  headless: process.env['ACDE_HEADLESS'] ?? null,
  env: Object.fromEntries(ISOLATION.map((k) => [k, process.env[k] ?? null])),
})
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
setTimeout(() => {
  server.listen(endpoint, () => {
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600)
  })
}, Number(process.env['FAKE_ACDERT_LISTEN_MS'] ?? 0))
process.on('SIGTERM', () => process.exit(0))

function answer(m: Record<string, unknown>, send: (message: object) => void): void {
  const ok = (result: unknown) => send({ type: 'response', id: m['id'], ok: true, result })
  const fail = (error: string) => send({ type: 'response', id: m['id'], ok: false, error })
  switch (m['op']) {
    case 'webs':
      return void ok({ webs: webs() })
    case 'eval':
      return void (m['web'] === 'nope' ? fail('no web "nope"') : ok({ value: { web: m['web'], code: m['code'] } }))
    case 'shot': {
      if (pageless > 0) {
        pageless--
        return void fail('window 7 has no page')
      }
      const win = windows.find((w) => webs().some((x) => x.name === m['web'] && x.window === w.id))
      if (!win) return void ok({ png: PNG, width: 1, height: 1 })
      return void ok({ png: picture(win).toString('base64'), width: win.rect[2], height: win.rect[3] })
    }
    case 'snapshot':
      return void ok(snapshot(m))
    case 'act':
      if (m['action'] === process.env['FAKE_ACDERT_DIES_ON']) process.exit(1)
      if (m['action'] === process.env['FAKE_ACDERT_HANGS_ON']) return
      if (m['ref'] === 'w1' && m['action'] === 'close' && process.argv[2] === 'app') {
        if (process.env['FAKE_ACDERT_CLOSE'] !== 'answers') process.exit(0)
        setTimeout(() => process.exit(0), 150)
        return void ok({ ok: true, text: 'closing w1' })
      }
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
      return void ok(page(consoleLog as never[], m, (e: { level: string }) =>
        m['level'] === undefined || (m['level'] === 'errors' ? e.level === 'error' : e.level === m['level'])))
    case 'network':
      return void ok(page(requests as never[], m, (e: { status: number }) => !m['failed'] || e.status >= 400))
    case 'screen':
      writeFileSync(String(m['path']), Buffer.from(PNG, 'base64'))
      return void ok({ width: 1, height: 1, path: m['path'] })
    case 'choose': {
      const kinds = ['folder', 'open', 'save'].filter((kind) => m[kind] !== undefined)
      if (kinds.length !== 1) return void fail('choose: give exactly one of folder, open or save')
      const kind = kinds[0]!
      const answer = m[kind]
      const path = (value: unknown) => typeof value === 'string' && isAbsolute(value)
      const paths = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(path)
      const valid = answer === null || (kind === 'open' ? paths(answer) : path(answer))
      if (valid) return void ok({ [kind]: answer })
      return void fail(`choose: ${kind} is not an absolute path, a list of them for open, or null to cancel`)
    }
    case 'emulate':
      if (m['colorScheme'] !== undefined) dark = m['colorScheme'] === 'dark'
      if (m['reducedMotion'] !== undefined) reduced = m['reducedMotion'] === true
      return void ok({
        colorScheme: dark ? 'dark' : 'light',
        emulated: m['colorScheme'] !== null && m['colorScheme'] !== undefined,
        reducedMotion: reduced,
      })
    case 'route': {
      const regex = typeof (m['url'] as { regex?: unknown } | undefined)?.regex === 'string'
      if (typeof m['url'] !== 'string' && !regex) return void fail('route: url is a glob or { regex, flags }')
      const id = nextRoute++
      const times = typeof m['times'] === 'number' ? m['times'] : null
      routes.push({ id, url: m['url'], status: Number(m['status'] ?? 200), times })
      return void ok({ id })
    }
    case 'unroute': {
      const before = routes.length
      if (m['route'] === undefined) routes.length = 0
      else routes.splice(0, routes.length, ...routes.filter((r) => r.id !== m['route']))
      return void ok({ removed: before - routes.length, left: routes.length })
    }
    case 'permissions':
      return void ok({ pending: prompts, decisions })
    case 'answer': {
      const at = prompts.findIndex((p) => p.id === m['prompt'])
      if (at < 0 || typeof m['allow'] !== 'boolean') {
        return void fail('answer: prompt is a prompt id and allow is true or false')
      }
      const [prompt] = prompts.splice(at, 1)
      decisions.push({ ...prompt!, decision: m['allow'] ? 'granted' : 'denied' })
      if (prompt!.reason === 'launch' && m['allow']) windows.push(...held.splice(0))
      return void ok({ prompt: m['prompt'], allow: m['allow'] })
    }
    case 'revoke': {
      if (typeof m['app'] !== 'string' || typeof m['capability'] !== 'string') {
        return void fail('revoke: app is an app id and capability is the approved capability (as in permissions)')
      }
      const at = decisions.findIndex((d) => d.app === m['app'] && d.capability === m['capability'])
      if (at >= 0) decisions.splice(at, 1)
      return void ok({ app: m['app'], capability: m['capability'], revoked: at >= 0 })
    }
    case 'drop': {
      const files = m['files']
      if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === 'string' && isAbsolute(f))) {
        return void fail('drop: files is a list of absolute paths')
      }
      const target = webs().find((w) => w.name === (m['web'] ?? 'desktop') || w.app === m['web'])
      if (!target) return void fail(`drop: no web ${JSON.stringify(m['web'])}`)
      return void ok({ web: target.name, window: target.window, files })
    }
    case 'pointer':
      if (typeof m['x'] !== 'number' || typeof m['y'] !== 'number') {
        return void fail('pointer: x and y are numbers in screen coordinates')
      }
      return void ok({ x: m['x'], y: m['y'] })
    case 'clipboard':
      if (typeof m['text'] === 'string') clipboard = m['text']
      return void ok({ text: clipboard })
    case 'slow':
      return
    default:
      return void fail(`no op ${String(m['op'])}`)
  }
}
