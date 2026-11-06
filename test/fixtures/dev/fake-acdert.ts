import { appendFileSync } from 'node:fs'
import net from 'node:net'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const legacy = process.env['FAKE_ACDERT_LEGACY'] === '1'

function record(entry: object): void {
  appendFileSync(process.env['FAKE_ACDERT_LOG']!, `${JSON.stringify(entry)}\n`)
}

record({ argv: process.argv.slice(2), path: process.env['ACDE_PATH'] ?? null })
const socket = net.connect(process.env['ACDE_DEV']!)
const send = (message: object) => socket.write(`${JSON.stringify(message)}\n`)
socket.on('connect', () => send({ type: 'hello', ...(!legacy && { role: 'runtime' }), pid: process.pid }))
socket.on('close', () => process.exit(0))
socket.setEncoding('utf8')
let buffer = ''
socket.on('data', (chunk: string) => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>
    buffer = buffer.slice(at + 1)
    record({ got: message })
    if (message['type'] === 'quit') process.exit(0)
    if (message['type'] === 'request' && !legacy) answer(message)
  }
})
process.on('SIGTERM', () => process.exit(0))

function answer(m: Record<string, unknown>): void {
  const ok = (result: unknown) => send({ type: 'response', id: m['id'], ok: true, result })
  const fail = (error: string) => send({ type: 'response', id: m['id'], ok: false, error })
  switch (m['op']) {
    case 'webs':
      return void ok({ webs: [{ name: 'desktop', app: null, kind: 'desktop', window: 0, title: 'Desk' }, { name: 'alpha#7', app: 'alpha', kind: 'app', window: 7, title: 'Alpha' }] })
    case 'eval':
      return void (m['web'] === 'nope' ? fail('no web "nope"') : ok({ value: { web: m['web'], code: m['code'] } }))
    case 'shot':
      return void ok({ png: PNG, width: 1, height: 1 })
    case 'snapshot':
      return void ok({ text: `snapshot ${JSON.stringify({ window: m['window'] ?? null, find: m['find'] ?? null, all: m['all'] ?? false })}`, windows: [], trees: {} })
    case 'act':
      return void ok({ ok: m['action'] !== 'fail', text: `${m['action']} ${m['ref']} ${JSON.stringify(m['arg'] ?? null)}` })
    case 'slow':
      return
    default:
      return void fail(`no op ${String(m['op'])}`)
  }
}
